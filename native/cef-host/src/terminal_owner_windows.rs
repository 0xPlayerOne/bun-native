//! Windows guard: create suspended, assign the owned process handle to a private
//! kill-on-close Job, then resume. No numeric PID registration or name lookup.
use std::{
    ffi::OsStr,
    io::{self},
    os::windows::ffi::OsStrExt,
    ptr,
};
use windows_sys::Win32::{
    Foundation::*,
    Storage::FileSystem::*,
    System::{JobObjects::*, Threading::*, IO::*},
};

struct Handle(HANDLE);
impl Drop for Handle {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.0);
        }
    }
}
struct Pipe(Handle);
impl Pipe {
    fn write_all(&mut self, bytes: &[u8]) -> io::Result<()> {
        let event = Handle(unsafe { CreateEventW(ptr::null(), 1, 0, ptr::null()) });
        if event.0.is_null() {
            return Err(io::Error::last_os_error());
        }
        let mut operation: OVERLAPPED = unsafe { std::mem::zeroed() };
        operation.hEvent = event.0;
        let status = unsafe {
            WriteFile(
                self.0 .0,
                bytes.as_ptr(),
                bytes.len() as u32,
                ptr::null_mut(),
                &mut operation,
            )
        };
        if status == 0 && unsafe { GetLastError() } != ERROR_IO_PENDING {
            return Err(io::Error::last_os_error());
        }
        let timely = unsafe { WaitForSingleObject(event.0, 5000) } == WAIT_OBJECT_0;
        if !timely {
            unsafe {
                CancelIoEx(self.0 .0, &operation);
            }
        }
        let mut written = 0;
        let success = unsafe { GetOverlappedResult(self.0 .0, &operation, &mut written, 1) } != 0;
        if !timely || !success || written as usize != bytes.len() {
            return Err(io::ErrorKind::BrokenPipe.into());
        }
        Ok(())
    }
}
struct PendingRead {
    pipe: HANDLE,
    event: Handle,
    operation: Box<OVERLAPPED>,
    byte: Box<u8>,
    pending: bool,
}
impl PendingRead {
    fn new(pipe: HANDLE) -> io::Result<Self> {
        let event = Handle(unsafe { CreateEventW(ptr::null(), 1, 0, ptr::null()) });
        if event.0.is_null() {
            return Err(io::Error::last_os_error());
        }
        let mut operation: Box<OVERLAPPED> = Box::new(unsafe { std::mem::zeroed() });
        operation.hEvent = event.0;
        let mut byte = Box::new(0);
        let status = unsafe { ReadFile(pipe, &mut *byte, 1, ptr::null_mut(), &mut *operation) };
        if status == 0 && unsafe { GetLastError() } != ERROR_IO_PENDING {
            return Err(io::Error::last_os_error());
        }
        Ok(Self {
            pipe,
            event,
            operation,
            byte,
            pending: true,
        })
    }
    fn wait(&mut self, timeout: u32) -> io::Result<u8> {
        if unsafe { WaitForSingleObject(self.event.0, timeout) } != WAIT_OBJECT_0 {
            return Err(io::ErrorKind::TimedOut.into());
        }
        self.finish()
    }
    fn finish(&mut self) -> io::Result<u8> {
        let mut read = 0;
        let success =
            unsafe { GetOverlappedResult(self.pipe, &*self.operation, &mut read, 1) } != 0;
        self.pending = false;
        if !success || read != 1 {
            return Err(io::ErrorKind::BrokenPipe.into());
        }
        Ok(*self.byte)
    }
}
impl Drop for PendingRead {
    fn drop(&mut self) {
        if self.pending {
            unsafe {
                CancelIoEx(self.pipe, &*self.operation);
            }
            let _ = self.finish();
        }
    }
}
fn wide(value: &OsStr) -> Vec<u16> {
    value.encode_wide().chain(Some(0)).collect()
}
fn quote(value: &OsStr) -> Vec<u16> {
    let mut result = vec![b'"' as u16];
    let mut slashes = 0;
    for c in value.encode_wide() {
        if c == b'\\' as u16 {
            slashes += 1;
            continue;
        }
        result.extend(std::iter::repeat_n(
            b'\\' as u16,
            slashes * if c == b'"' as u16 { 2 } else { 1 },
        ));
        slashes = 0;
        if c == b'"' as u16 {
            result.push(b'\\' as u16);
        }
        result.push(c);
    }
    result.extend(std::iter::repeat_n(b'\\' as u16, slashes * 2));
    result.push(b'"' as u16);
    result
}
fn command() -> io::Result<(Vec<u16>, Vec<u16>)> {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    if args.is_empty()
        || args.len() > 257
        || args[0].is_empty()
        || !std::path::Path::new(&args[0]).is_absolute()
        || args.iter().any(|a| a.len() > 16384)
        || args.iter().map(|a| a.len()).sum::<usize>() > 81920
    {
        return Err(io::ErrorKind::InvalidInput.into());
    }
    let mut line = Vec::new();
    for arg in &args {
        if !line.is_empty() {
            line.push(b' ' as u16);
        }
        line.extend(quote(arg));
    }
    if line.len() >= 32767 {
        return Err(io::ErrorKind::InvalidInput.into());
    }
    line.push(0);
    Ok((wide(&args[0]), line))
}
pub fn run() -> io::Result<()> {
    // The private pipe name comes only from the trusted backend's bounded
    // per-terminal lease. Never print it or forward it to application commands.
    let endpoint = std::env::var_os("BUNLY_TERMINAL_CONTROL").ok_or(io::ErrorKind::InvalidInput)?;
    if !endpoint
        .to_string_lossy()
        .starts_with(r"\\.\pipe\bunly-terminal-")
    {
        return Err(io::ErrorKind::InvalidInput.into());
    }
    let endpoint = wide(&endpoint);
    unsafe {
        std::env::remove_var("BUNLY_TERMINAL_CONTROL");
    }
    let raw = unsafe {
        CreateFileW(
            endpoint.as_ptr(),
            GENERIC_READ | GENERIC_WRITE,
            0,
            ptr::null(),
            OPEN_EXISTING,
            FILE_FLAG_OVERLAPPED,
            ptr::null_mut(),
        )
    };
    if raw == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    let mut control = Pipe(Handle(raw));
    let mut started = false;
    let result = supervise(&mut control, &mut started);
    if let Err(error) = &result {
        let reason = if error.raw_os_error() == Some(ERROR_ACCESS_DENIED as i32) {
            1
        } else {
            2
        };
        let _ = control.write_all(&[if started { 3 } else { 4 }, reason]);
    }
    result
}
fn supervise(control: &mut Pipe, started: &mut bool) -> io::Result<()> {
    let (executable, mut line) = command()?;
    // A desktop guard must already be inside the GUI-owned outer Job. Nested
    // terminal Jobs add explicit close ownership without weakening that Job.
    let mut in_job = 0;
    if unsafe { IsProcessInJob(GetCurrentProcess(), ptr::null_mut(), &mut in_job) } == 0
        || in_job == 0
    {
        return Err(io::ErrorKind::PermissionDenied.into());
    }
    control.write_all(&[66, 84, 79, 2])?;
    // The backend destroys this private pipe at its absolute admission deadline.
    let mut admission = PendingRead::new(control.0 .0)?;
    let admit = admission.wait(5000)?;
    drop(admission);
    if admit != 0 {
        return Err(io::ErrorKind::InvalidData.into());
    }
    let job = Handle(unsafe { CreateJobObjectW(ptr::null(), ptr::null()) });
    if job.0.is_null() {
        return Err(io::Error::last_os_error());
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
    {
        return Err(io::Error::last_os_error());
    }
    let mut startup: STARTUPINFOW = unsafe { std::mem::zeroed() };
    startup.cb = std::mem::size_of_val(&startup) as u32;
    startup.dwFlags = STARTF_USESTDHANDLES;
    unsafe {
        startup.hStdInput = windows_sys::Win32::System::Console::GetStdHandle(
            windows_sys::Win32::System::Console::STD_INPUT_HANDLE,
        );
        startup.hStdOutput = windows_sys::Win32::System::Console::GetStdHandle(
            windows_sys::Win32::System::Console::STD_OUTPUT_HANDLE,
        );
        startup.hStdError = windows_sys::Win32::System::Console::GetStdHandle(
            windows_sys::Win32::System::Console::STD_ERROR_HANDLE,
        );
    }
    // No control/Job handle is inheritable. Only console standard handles pass.
    let mut process: PROCESS_INFORMATION = unsafe { std::mem::zeroed() };
    if unsafe {
        CreateProcessW(
            executable.as_ptr(),
            line.as_mut_ptr(),
            ptr::null(),
            ptr::null(),
            1,
            CREATE_SUSPENDED,
            ptr::null(),
            ptr::null(),
            &startup,
            &mut process,
        )
    } == 0
    {
        return Err(io::Error::last_os_error());
    }
    let child = Handle(process.hProcess);
    let thread = Handle(process.hThread);
    if unsafe { AssignProcessToJobObject(job.0, child.0) } == 0 {
        unsafe {
            TerminateProcess(child.0, 125);
            WaitForSingleObject(child.0, INFINITE);
        }
        return Err(io::Error::last_os_error());
    }
    *started = true;
    if unsafe { ResumeThread(thread.0) } == u32::MAX {
        return Err(io::Error::last_os_error());
    }
    drop(thread);
    control.write_all(&[1])?;
    let mut pending = PendingRead::new(control.0 .0)?;
    let status =
        unsafe { WaitForMultipleObjects(2, [child.0, pending.event.0].as_ptr(), 0, INFINITE) };
    if status != WAIT_OBJECT_0 {
        if status != WAIT_OBJECT_0 + 1 {
            return Err(io::Error::last_os_error());
        }
        let signal = pending.finish().unwrap_or(0);
        // TERM/KILL/EOF terminate the owned Job; other POSIX signals are rejected.
        if signal != 0 && signal != 9 && signal != 15 {
            return Err(io::ErrorKind::InvalidInput.into());
        }
    }
    drop(pending);
    if unsafe { TerminateJobObject(job.0, 1) } == 0 {
        return Err(io::Error::last_os_error());
    }
    if unsafe { WaitForSingleObject(child.0, 5000) } != WAIT_OBJECT_0 {
        return Err(io::ErrorKind::TimedOut.into());
    }
    let mut code = 0;
    if unsafe { GetExitCodeProcess(child.0, &mut code) } == 0 {
        return Err(io::Error::last_os_error());
    }
    let mut receipt = vec![2, 0];
    receipt.extend_from_slice(&code.to_le_bytes());
    control.write_all(&receipt)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn command_line_preserves_empty_quotes_and_trailing_backslashes() {
        for (value, expected) in [
            ("", "\"\""),
            ("a b", "\"a b\""),
            ("a\"b", "\"a\\\"b\""),
            ("a\\", "\"a\\\\\""),
        ] {
            assert_eq!(
                String::from_utf16(&quote(OsStr::new(value))).unwrap(),
                expected
            );
        }
    }
}
