//! One application Bun process; blocking pipes are serviced off the CEF UI thread.
use std::{io::{BufRead,BufReader,Read,Write},process::{Child,Command,Stdio},sync::{Mutex,OnceLock,mpsc::{sync_channel,SyncSender},atomic::{AtomicBool,Ordering}},thread,time::{Duration,Instant}};
use serde_json::{Value,json};
static CHILD:OnceLock<Mutex<Child>>=OnceLock::new();
static OUTPUT:OnceLock<SyncSender<Value>>=OnceLock::new();
static STOPPING:AtomicBool=AtomicBool::new(false);
#[cfg(windows)] static JOB:OnceLock<usize>=OnceLock::new();
pub fn emit(value:Value){
    if let Some(tx)=OUTPUT.get(){if tx.try_send(value).is_err()&&!STOPPING.load(Ordering::SeqCst){crate::host::fail("Application event queue unavailable or full");}}
}
pub fn start()->Result<(),String>{
    let paths=crate::PATHS.get().ok_or("missing runtime paths")?;
    let mut command=Command::new(&paths.bun);
    command.arg(&paths.entry).current_dir(&paths.resources).env("BUNLY_NATIVE_STDIO","1").stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::inherit());
    #[cfg(unix)]{use std::os::unix::process::CommandExt;command.process_group(0);}
    let mut child=command.spawn().map_err(|e|e.to_string())?;
    #[cfg(windows)]{
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::{Foundation::CloseHandle,System::JobObjects::*};
        unsafe{
            let job=CreateJobObjectW(std::ptr::null(),std::ptr::null());
            if job.is_null(){let _=child.kill();return Err("CreateJobObjectW failed".into());}
            let mut limits:JOBOBJECT_EXTENDED_LIMIT_INFORMATION=std::mem::zeroed();limits.BasicLimitInformation.LimitFlags=JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if SetInformationJobObject(job,JobObjectExtendedLimitInformation,&limits as *const _ as *const _,std::mem::size_of_val(&limits) as u32)==0||AssignProcessToJobObject(job,child.as_raw_handle() as _)==0{CloseHandle(job);let _=child.kill();return Err("Cannot isolate Bun process tree".into());}
            let _=JOB.set(job as usize);
        }
    }
    let mut input=child.stdin.take().ok_or("missing child stdin")?;
    let output=child.stdout.take().ok_or("missing child stdout")?;
    CHILD.set(Mutex::new(child)).map_err(|_|"Bun already running")?;
    let(tx,rx)=sync_channel::<Value>(256);OUTPUT.set(tx).map_err(|_|"channel already active")?;
    thread::spawn(move||{
        while !STOPPING.load(Ordering::SeqCst){
            match rx.recv_timeout(Duration::from_millis(100)){
                Ok(value)=>{let mut bytes=serde_json::to_vec(&value).unwrap_or_default();bytes.push(b'\n');if input.write_all(&bytes).and_then(|_|input.flush()).is_err(){if !STOPPING.load(Ordering::SeqCst){crate::host::fail("Bun input closed");}break;}},
                Err(std::sync::mpsc::RecvTimeoutError::Timeout)=>{},Err(_)=>break
            }
        }
    });
    thread::spawn(move||{
        let mut reader=BufReader::new(output);let mut last_id=0_u64;
        loop{
            let mut bytes=Vec::new();
            let read=(&mut reader).take(65537).read_until(b'\n',&mut bytes);
            if matches!(read,Ok(0)){if !STOPPING.load(Ordering::SeqCst){crate::host::fail("Bun backend exited before native shutdown");}break;}
            if read.is_err()||bytes.len()>65536||bytes.last()!=Some(&b'\n'){crate::host::fail("Malformed or excessive application protocol output");break;}
            let Ok(value)=serde_json::from_slice::<Value>(&bytes)else{crate::host::fail("Application stdout must contain protocol frames only");break;};
            let id=value.get("id").and_then(Value::as_u64).unwrap_or(0);
            if value.get("v").and_then(Value::as_u64)!=Some(1)||id<=last_id||id>9_007_199_254_740_991{crate::host::fail("Invalid protocol version or request sequence");break;}
            last_id=id;crate::host::enqueue(value);
        }
    });
    emit(json!({"v":1,"event":"ready","abi":1,"cef":"154.0.34","host":"native-owner-bun-process"}));
    Ok(())
}
pub fn stop(){
    emit(json!({"v":1,"event":"shutdown"}));
    if let Some(child)=CHILD.get(){
        if let Ok(mut child)=child.lock(){
            let end=Instant::now()+Duration::from_secs(2);
            while Instant::now()<end{if matches!(child.try_wait(),Ok(Some(_))){break;}thread::sleep(Duration::from_millis(10));}
            #[cfg(unix)] unsafe{libc::kill(-(child.id() as i32),libc::SIGKILL);}
            let _=child.kill();let _=child.wait();
        }
    }
    STOPPING.store(true,Ordering::SeqCst);
    #[cfg(windows)]if let Some(job)=JOB.get(){unsafe{windows_sys::Win32::Foundation::CloseHandle(*job as _);}}
}
