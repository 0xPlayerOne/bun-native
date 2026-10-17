//! One application process. Pipe I/O never blocks CEF's UI thread.
use serde_json::{json, Value};
use std::{
    io::{BufRead, BufReader, Read, Write},
    process::{Child, Command, Stdio},
    sync::{atomic::{AtomicBool, Ordering}, mpsc::{sync_channel, SyncSender}, Mutex, OnceLock},
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};
static CHILD: OnceLock<Mutex<Child>> = OnceLock::new();
static OUTPUT: OnceLock<Mutex<Option<SyncSender<Value>>>> = OnceLock::new();
static THREADS: OnceLock<Mutex<Vec<JoinHandle<()>>>> = OnceLock::new();
static STOPPING: AtomicBool = AtomicBool::new(false);
#[cfg(windows)] static JOB: OnceLock<usize> = OnceLock::new();
fn expected_exit() -> bool { STOPPING.load(Ordering::SeqCst) || crate::host::QUITTING.load(Ordering::SeqCst) }
pub fn emit(value: Value) {
    let failed = OUTPUT.get().and_then(|slot| slot.lock().ok())
        .and_then(|slot| slot.as_ref().map(|tx| tx.try_send(value).is_err())).unwrap_or(false);
    if failed && !expected_exit() { crate::host::fail("Application event queue unavailable or full"); }
}
pub fn start() -> Result<(), String> {
    let paths = crate::PATHS.get().ok_or("missing runtime paths")?;
    let mut command = Command::new(&paths.bun);
    command.arg(&paths.entry).current_dir(&paths.resources).env("BUNLY_NATIVE_STDIO", "1")
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::inherit());
    #[cfg(unix)] { use std::os::unix::process::CommandExt; command.process_group(0); }
    let mut child = command.spawn().map_err(|e| e.to_string())?;
    #[cfg(windows)] {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::{Foundation::CloseHandle, System::JobObjects::*};
        // The bootstrap imports application code only after assignment and readiness.
        unsafe {
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if job.is_null() { let _ = child.kill(); let _ = child.wait(); return Err("CreateJobObjectW failed".into()); }
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits as *const _ as *const _, std::mem::size_of_val(&limits) as u32) == 0
                || AssignProcessToJobObject(job, child.as_raw_handle() as _) == 0 {
                CloseHandle(job); let _ = child.kill(); let _ = child.wait(); return Err("Cannot isolate Bun process tree".into());
            }
            let _ = JOB.set(job as usize);
        }
    }
    let mut input = child.stdin.take().ok_or("missing child stdin")?;
    let output = child.stdout.take().ok_or("missing child stdout")?;
    CHILD.set(Mutex::new(child)).map_err(|_| "Bun already running")?;
    let (tx, rx) = sync_channel::<Value>(256);
    OUTPUT.set(Mutex::new(Some(tx))).map_err(|_| "channel already active")?;
    let writer = thread::spawn(move || {
        // Blocking receipt has no fixed-rate idle timer. EOF closes the queue.
        while let Ok(value) = rx.recv() {
            let mut bytes = match serde_json::to_vec(&value) { Ok(b) => b, Err(_) => { crate::host::fail("Cannot serialize native event"); break; } };
            bytes.push(b'\n');
            if input.write_all(&bytes).and_then(|_| input.flush()).is_err() {
                if !expected_exit() { crate::host::fail("Bun input closed"); }
                break;
            }
        }
    });
    let reader = thread::spawn(move || {
        let mut reader = BufReader::new(output);
        let mut last_id = 0_u64;
        loop {
            let mut bytes = Vec::new();
            let read = (&mut reader).take(65537).read_until(b'\n', &mut bytes);
            if matches!(read, Ok(0)) { if !expected_exit() { crate::host::fail("Bun backend exited before native shutdown"); } break; }
            if STOPPING.load(Ordering::SeqCst) { break; }
            if read.is_err() || bytes.len() > 65536 || bytes.last() != Some(&b'\n') { crate::host::fail("Malformed or excessive application protocol output"); break; }
            let Ok(value) = serde_json::from_slice::<Value>(&bytes) else { crate::host::fail("Application stdout must contain protocol frames only"); break; };
            let id = value.get("id").and_then(Value::as_u64).unwrap_or(0);
            if value.get("v").and_then(Value::as_u64) != Some(1) || id <= last_id || id > 9_007_199_254_740_991 { crate::host::fail("Invalid protocol version or request sequence"); break; }
            last_id = id;
            crate::host::enqueue(value);
        }
    });
    THREADS.set(Mutex::new(vec![writer, reader])).map_err(|_| "thread owners already initialized")?;
    emit(json!({"v":1,"event":"ready","abi":1,"cef":"154.0.34","host":"native-owner-bun-process"}));
    Ok(())
}
pub fn stop() {
    if STOPPING.swap(true, Ordering::SeqCst) { return; }
    emit(json!({"v":1,"event":"shutdown"}));
    if let Some(slot) = OUTPUT.get() { if let Ok(mut slot) = slot.lock() { slot.take(); } }
    if let Some(child) = CHILD.get() {
        if let Ok(mut child) = child.lock() {
            let end = Instant::now() + Duration::from_secs(2);
            let mut code = None;
            while Instant::now() < end {
                code = child.try_wait().ok().flatten();
                if code.is_some() { break; }
                thread::sleep(Duration::from_millis(10));
            }
            // Dedicated owned process group; no process-name matching.
            #[cfg(unix)] unsafe { libc::kill(-(child.id() as i32), libc::SIGKILL); }
            #[cfg(windows)] if let Some(job) = JOB.get() { unsafe { windows_sys::Win32::System::JobObjects::TerminateJobObject(*job as _, 1); } }
            if code.is_none() { let _ = child.kill(); }
            let result = child.wait();
            if code.is_some_and(|status| !status.success()) || result.is_err() { crate::host::FAILED.store(true, Ordering::SeqCst); }
        }
    }
    if let Some(threads) = THREADS.get() { if let Ok(mut threads) = threads.lock() { for thread in threads.drain(..) { let _ = thread.join(); } } }
    #[cfg(windows)] if let Some(job) = JOB.get() { unsafe { windows_sys::Win32::Foundation::CloseHandle(*job as _); } }
}
