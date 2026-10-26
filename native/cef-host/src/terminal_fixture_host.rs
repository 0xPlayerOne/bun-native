//! Contributor-only native lifetime fixture. No CEF or credential-provider access.
#[allow(dead_code)]
mod terminal_runtime;
use std::{
    io::{BufRead, Write},
    process::{Command, Stdio},
};
fn run() -> Result<i32, Box<dyn std::error::Error>> {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    if args.len() != 4 {
        return Err("Expected Bun, backend fixture, owner, Python".into());
    }
    let owner = std::path::Path::new(&args[2]);
    let manifest = terminal_runtime::fingerprint(owner)?;
    let mut command = Command::new(&args[0]);
    command
        .arg(&args[1])
        .arg(&args[2])
        .arg(&args[3])
        .stdin(Stdio::piped())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit());
    // Exercise a high inherited fd like a live GUI, not just descriptor four.
    #[cfg(unix)]
    let occupied: Vec<_> = (0..32)
        .map(|_| std::fs::File::open("/dev/null"))
        .collect::<Result<_, _>>()?;
    #[cfg(unix)]
    let reader = terminal_runtime::lifetime::attach(&mut command)?;
    #[cfg(unix)]
    let fd = {
        use std::os::fd::AsRawFd;
        reader.as_raw_fd()
    };
    #[cfg(windows)]
    let fd = -1;
    command.env("BUNLY_FIXTURE_OWNER_CONFIG", serde_json::json!({"version":manifest.version,"protocol":manifest.protocol,"executable":owner,"sha256":manifest.sha256,"bytes":manifest.bytes,"platform":manifest.platform,"arch":manifest.arch,"hostFd":fd}).to_string());
    let mut child = command.spawn()?;
    #[cfg(unix)]
    drop(reader);
    #[cfg(unix)]
    drop(occupied);
    #[cfg(windows)]
    let _job = {
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::{Foundation::*, System::JobObjects::*};
        struct Job(HANDLE);
        impl Drop for Job {
            fn drop(&mut self) {
                unsafe {
                    CloseHandle(self.0);
                }
            }
        }
        let job = Job(unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) });
        if job.0.is_null() {
            let _ = child.kill();
            let _ = child.wait();
            return Err("Fixture Job creation failed".into());
        }
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        if unsafe {
            SetInformationJobObject(
                job.0,
                JobObjectExtendedLimitInformation,
                (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                std::mem::size_of_val(&limits) as u32,
            )
        } == 0
            || unsafe { AssignProcessToJobObject(job.0, child.as_raw_handle() as _) } == 0
        {
            let _ = child.kill();
            let _ = child.wait();
            return Err("Fixture Job assignment failed".into());
        }
        job
    };
    let mut input = child.stdin.take().ok_or("Fixture input missing")?;
    // Gate application code until the exact child handle is in the native Job.
    input.write_all(b"go\n")?;
    std::thread::spawn(move || {
        for line in std::io::stdin().lock().lines() {
            let Ok(line) = line else {
                break;
            };
            if line == "host-quit" {
                std::process::exit(0);
            }
            if writeln!(input, "{line}").is_err() {
                break;
            }
        }
    });
    let code = child.wait()?.code().unwrap_or(137);
    println!(
        "{}",
        serde_json::json!({"event":"backend-exited","code":code})
    );
    // Keep the native lifetime/outer Job live until the harness independently
    // observes backend-lease cleanup, then explicitly releases this fixture.
    loop {
        std::thread::park();
    }
}
fn main() {
    std::process::exit(run().unwrap_or(125));
}
