//! One application process. Pipe I/O never blocks CEF's UI thread.
use serde_json::{json, Value};
use std::{
    io::{BufRead, BufReader, Read},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Condvar, Mutex, OnceLock,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};
static CHILD: OnceLock<Mutex<Child>> = OnceLock::new();
static OUTPUT: OnceLock<Mutex<Option<crate::event_queue::EventSender>>> = OnceLock::new();
static OUTPUT_MONITOR: OnceLock<crate::event_queue::EventMonitor> = OnceLock::new();
static THREADS: OnceLock<Mutex<Vec<JoinHandle<()>>>> = OnceLock::new();
static HANDSHAKE: OnceLock<(Mutex<bool>, Condvar)> = OnceLock::new();
fn handshake() {
    if let Some((lock, wake)) = HANDSHAKE.get() {
        if let Ok(mut ready) = lock.lock() {
            *ready = true;
            wake.notify_all();
        }
    }
}
// Observe exit without reaping: keep the child's PID reserved until its owned
// process group has been terminated. Pipe EOF is not an exit notification because
// descendants may retain inherited output descriptors.
#[cfg(unix)]
fn exited_unreaped(pid: u32, blocking: bool) -> std::io::Result<bool> {
    if pid == 0 || pid > i32::MAX as u32 {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "Invalid child PID",
        ));
    }
    loop {
        let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
        let flags = libc::WEXITED | libc::WNOWAIT | if blocking { 0 } else { libc::WNOHANG };
        if unsafe { libc::waitid(libc::P_PID, pid as libc::id_t, &mut info, flags) } != 0 {
            let error = std::io::Error::last_os_error();
            if error.kind() == std::io::ErrorKind::Interrupted {
                continue;
            }
            return Err(error);
        }
        #[cfg(target_os = "macos")]
        let observed = info.si_pid;
        #[cfg(target_os = "linux")]
        let observed = unsafe { info.si_pid() };
        return Ok(observed == pid as i32);
    }
}
static STOPPING: AtomicBool = AtomicBool::new(false);
#[cfg(windows)]
static JOB: OnceLock<usize> = OnceLock::new();
fn expected_exit() -> bool {
    STOPPING.load(Ordering::SeqCst) || crate::host::QUITTING.load(Ordering::SeqCst)
}
pub fn emit(value: Value) {
    let failed = OUTPUT
        .get()
        .and_then(|slot| slot.lock().ok())
        .and_then(|slot| slot.as_ref().map(|tx| tx.try_send(value).is_err()))
        .unwrap_or(false);
    if failed && !expected_exit() {
        crate::host::fail("Application event queue unavailable or full");
    }
}
pub fn output_diagnostics() -> crate::event_queue::Snapshot {
    OUTPUT_MONITOR
        .get()
        .map(|monitor| monitor.snapshot())
        .unwrap_or_default()
}
pub fn start() -> Result<(), String> {
    let paths = crate::PATHS.get().ok_or("missing runtime paths")?;
    // Install the latch before either reader or child can deliver readiness.
    HANDSHAKE
        .set((Mutex::new(false), Condvar::new()))
        .map_err(|_| "Handshake already initialized")?;
    let mut command = Command::new(&paths.bun);
    command
        .arg(&paths.entry)
        .current_dir(&paths.resources)
        .env("BUNLY_NATIVE_STDIO", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut child = command.spawn().map_err(|e| e.to_string())?;
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::{Foundation::CloseHandle, System::JobObjects::*};
        // The bootstrap imports application code only after assignment and readiness.
        unsafe {
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if job.is_null() {
                let _ = child.kill();
                let _ = child.wait();
                return Err("CreateJobObjectW failed".into());
            }
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &limits as *const _ as *const _,
                std::mem::size_of_val(&limits) as u32,
            ) == 0
                || AssignProcessToJobObject(job, child.as_raw_handle() as _) == 0
            {
                CloseHandle(job);
                let _ = child.kill();
                let _ = child.wait();
                return Err("Cannot isolate Bun process tree".into());
            }
            let _ = JOB.set(job as usize);
        }
    }
    let mut input = child.stdin.take().ok_or("missing child stdin")?;
    let output = child.stdout.take().ok_or("missing child stdout")?;
    #[cfg(unix)]
    let child_pid = child.id();
    #[cfg(windows)]
    let process_handle = {
        use std::os::windows::io::AsRawHandle;
        child.as_raw_handle() as usize
    };
    CHILD
        .set(Mutex::new(child))
        .map_err(|_| "Bun already running")?;
    let supervisor = thread::spawn(move || {
        #[cfg(unix)]
        let result = exited_unreaped(child_pid, true);
        #[cfg(windows)]
        let result: Result<bool, std::io::Error> = {
            use windows_sys::Win32::{
                Foundation::WAIT_OBJECT_0,
                System::Threading::{WaitForSingleObject, INFINITE},
            };
            let status = unsafe { WaitForSingleObject(process_handle as _, INFINITE) };
            if status == WAIT_OBJECT_0 {
                Ok(true)
            } else {
                Err(std::io::Error::last_os_error())
            }
        };
        if !expected_exit() {
            crate::host::fail(if matches!(result, Ok(true)) {
                "Bun backend process exited before native shutdown"
            } else {
                "Bun process exit supervision failed"
            });
        }
    });
    let (tx, rx) = crate::event_queue::channel();
    OUTPUT_MONITOR
        .set(tx.monitor())
        .map_err(|_| "output accounting already active")?;
    OUTPUT
        .set(Mutex::new(Some(tx)))
        .map_err(|_| "channel already active")?;
    let writer = thread::spawn(move || {
        // Blocking receipt has no fixed-rate idle timer. EOF closes the queue.
        while let Ok(frame) = rx.recv() {
            if frame.write_to(&mut input).is_err() {
                if !expected_exit() {
                    crate::host::fail("Bun input closed");
                }
                break;
            }
        }
    });
    let reader = thread::spawn(move || {
        let mut reader = BufReader::new(output);
        let mut last_id = 0_u64;
        let mut negotiation = crate::handshake::Handshake::default();
        loop {
            let mut bytes = Vec::new();
            let read = (&mut reader).take(65537).read_until(b'\n', &mut bytes);
            if matches!(read, Ok(0)) {
                if !expected_exit() {
                    crate::host::fail("Bun backend exited before native shutdown");
                }
                break;
            }
            if STOPPING.load(Ordering::SeqCst) {
                break;
            }
            if read.is_err() || bytes.len() > 65536 || bytes.last() != Some(&b'\n') {
                crate::host::fail("Malformed or excessive application protocol output");
                break;
            }
            let Ok(value) = serde_json::from_slice::<Value>(&bytes) else {
                crate::host::fail("Application stdout must contain protocol frames only");
                break;
            };
            let id = value.get("id").and_then(Value::as_u64).unwrap_or(0);
            if value.get("v").and_then(Value::as_u64) != Some(1)
                || id <= last_id
                || id > 9_007_199_254_740_991
            {
                crate::host::fail("Invalid protocol version or request sequence");
                break;
            }
            last_id = id;
            match negotiation.accept(&value) {
                Ok(true) => {
                    // ABI negotiation uses immutable metadata only. Waiting for a
                    // GPU-busy UI queue must not consume the backend-start deadline.
                    handshake();
                    emit(json!({"v":1,"id":id,"ok":true,"value":{"abi":1,"cef":"156.0.7"}}));
                }
                Ok(false) => crate::host::enqueue(value, bytes.len()),
                Err(error) => {
                    crate::host::fail(error);
                    break;
                }
            }
        }
    });
    let startup = thread::spawn(|| {
        if let Some((lock, wake)) = HANDSHAKE.get() {
            let (ready, timeout) = wake
                .wait_timeout_while(
                    lock.lock().unwrap(),
                    crate::deadlines::current().startup(),
                    |ready| !*ready && !STOPPING.load(Ordering::SeqCst),
                )
                .unwrap();
            if timeout.timed_out() && !*ready && !expected_exit() {
                crate::host::fail("Bun startup handshake deadline exceeded");
            }
        }
    });
    THREADS
        .set(Mutex::new(vec![writer, reader, startup, supervisor]))
        .map_err(|_| "thread owners already initialized")?;
    emit(
        json!({"v":1,"event":"ready","abi":1,"cef":"156.0.7","host":"native-owner-bun-process","data":{"deadlineProfile":crate::deadlines::current().name(),"requestTimeoutMs":crate::deadlines::current().requests_ms()}}),
    );
    Ok(())
}
pub fn stop() {
    if STOPPING.swap(true, Ordering::SeqCst) {
        return;
    }
    handshake();
    emit(json!({"v":1,"event":"shutdown"}));
    if let Some(slot) = OUTPUT.get() {
        if let Ok(mut slot) = slot.lock() {
            slot.take();
        }
    }
    if let Some(child) = CHILD.get() {
        if let Ok(mut child) = child.lock() {
            let end = Instant::now() + crate::deadlines::current().backend_exit();
            let mut exited = false;
            #[cfg(unix)]
            let mut identity_reserved = true;
            while Instant::now() < end {
                #[cfg(unix)]
                match exited_unreaped(child.id(), false) {
                    Ok(value) => exited = value,
                    Err(_) => {
                        identity_reserved = false;
                        break;
                    }
                }
                #[cfg(windows)]
                {
                    exited = child.try_wait().ok().flatten().is_some();
                }
                if exited {
                    break;
                }
                thread::sleep(Duration::from_millis(10));
            }
            // Never reap before killing the owned process group: PID reuse must
            // not turn cleanup into a signal to an unrelated process group.
            #[cfg(unix)]
            if identity_reserved {
                unsafe {
                    libc::kill(-(child.id() as i32), libc::SIGKILL);
                }
            } else {
                crate::host::FAILED.store(true, Ordering::SeqCst);
            }
            #[cfg(windows)]
            if let Some(job) = JOB.get() {
                unsafe {
                    windows_sys::Win32::System::JobObjects::TerminateJobObject(*job as _, 1);
                }
            }
            if !exited {
                crate::host::FAILED.store(true, Ordering::SeqCst);
            }
            let result = child.wait();
            eprintln!(
                "{}",
                json!({"event":"bunly.backend.exit","pid":child.id(),"code":result.as_ref().ok().and_then(|s|s.code()),"forced":!exited})
            );
            if result.as_ref().is_ok_and(|status| !status.success()) || result.is_err() {
                crate::host::FAILED.store(true, Ordering::SeqCst);
            }
        }
    }
    if let Some(threads) = THREADS.get() {
        if let Ok(mut threads) = threads.lock() {
            for thread in threads.drain(..) {
                let _ = thread.join();
            }
        }
    }
    // Thread joins prove write/flush ownership ended. Do not infer empty output
    // merely from closing the sender while a writer might still retain a frame.
    let output = output_diagnostics();
    if output.frames != 0
        || output.ordinary_frames != 0
        || output.retained_wire_bytes != 0
        || output.ordinary_wire_bytes != 0
    {
        crate::host::FAILED.store(true, Ordering::SeqCst);
    }
    eprintln!(
        "{}",
        json!({"event":"bunly.native.output-drained","schema":1,
        "frames":output.frames,"ordinaryFrames":output.ordinary_frames,
        "retainedWireBytes":output.retained_wire_bytes,"ordinaryWireBytes":output.ordinary_wire_bytes})
    );
    #[cfg(windows)]
    if let Some(job) = JOB.get() {
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(*job as _);
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    #[test]
    fn exit_notification_preserves_child_identity_until_reaping() {
        let mut child = Command::new("/bin/sh")
            .args(["-c", "exit 23"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        assert!(exited_unreaped(child.id(), true).unwrap());
        assert!(exited_unreaped(child.id(), false).unwrap());
        assert_eq!(child.wait().unwrap().code(), Some(23));
        assert!(exited_unreaped(child.id(), false).is_err());
    }
    #[test]
    fn exit_observation_rejects_process_group_selectors() {
        assert!(exited_unreaped(0, false).is_err());
        assert!(exited_unreaped(u32::MAX, false).is_err());
    }
}
