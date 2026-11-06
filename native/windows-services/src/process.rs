//! Owned child processes: a job object that kills the whole tree when its
//! last handle closes, `CreateProcessW` with an explicit attribute list (the
//! job, the exact handles to inherit or a pseudo-console) and no shell, and
//! ConPTY pseudo-consoles.
#![allow(
    unsafe_code,
    reason = "the reviewed Win32 process calls of this boundary"
)]

use crate::wide::terminated;
use std::ffi::{OsStr, c_void};
use std::io;
use std::marker::PhantomData;
use std::mem::{size_of, size_of_val};
use std::os::windows::io::{AsRawHandle as _, BorrowedHandle, FromRawHandle as _, OwnedHandle};
use std::time::Duration;
use windows_sys::Win32::Foundation::{
    HANDLE, HANDLE_FLAG_INHERIT, INVALID_HANDLE_VALUE, SetHandleInformation, WAIT_FAILED,
    WAIT_OBJECT_0, WAIT_TIMEOUT,
};
use windows_sys::Win32::System::Console::{
    AttachConsole, COORD, CTRL_C_EVENT, ClosePseudoConsole, CreatePseudoConsole, FreeConsole,
    GenerateConsoleCtrlEvent, HPCON, ResizePseudoConsole, SetConsoleCtrlHandler,
};
use windows_sys::Win32::System::JobObjects::{
    CreateJobObjectW, JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JobObjectExtendedLimitInformation, SetInformationJobObject, TerminateJobObject,
};
use windows_sys::Win32::System::Threading::{
    CREATE_NO_WINDOW, CREATE_UNICODE_ENVIRONMENT, CreateEventW, CreateProcessW,
    DeleteProcThreadAttributeList, EXTENDED_STARTUPINFO_PRESENT, GetExitCodeProcess, INFINITE,
    InitializeProcThreadAttributeList, LPPROC_THREAD_ATTRIBUTE_LIST,
    PROC_THREAD_ATTRIBUTE_HANDLE_LIST, PROC_THREAD_ATTRIBUTE_JOB_LIST,
    PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, PROCESS_INFORMATION, STARTF_USESTDHANDLES, STARTUPINFOEXW,
    SetEvent, UpdateProcThreadAttribute, WaitForMultipleObjects,
};

pub use windows_sys::Win32::Foundation::{
    ERROR_ACCESS_DENIED, ERROR_BAD_EXE_FORMAT, ERROR_DIRECTORY, ERROR_ELEVATION_REQUIRED,
    ERROR_EXE_MACHINE_TYPE_MISMATCH, ERROR_FILE_NOT_FOUND, ERROR_FILENAME_EXCED_RANGE,
    ERROR_NO_SYSTEM_RESOURCES, ERROR_NOT_ENOUGH_MEMORY, ERROR_OUTOFMEMORY, ERROR_PATH_NOT_FOUND,
    ERROR_SHARING_VIOLATION,
};

fn handle(raw: HANDLE) -> io::Result<OwnedHandle> {
    if raw.is_null() || raw == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: a valid handle a Win32 call just returned, owned by the caller.
    Ok(unsafe { OwnedHandle::from_raw_handle(raw) })
}

fn check(ok: i32) -> io::Result<()> {
    if ok == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

/// A job object whose processes are all killed when its last handle closes,
/// including when the host exits or crashes.
pub struct Job(OwnedHandle);

impl Job {
    pub fn new() -> io::Result<Self> {
        // SAFETY: anonymous job with default security.
        let job = handle(unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) })?;
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        // A crashing child ends instead of waiting on an error-report dialog.
        limits.BasicLimitInformation.LimitFlags =
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION;
        // SAFETY: the struct matches the information class and outlives the call.
        check(unsafe {
            SetInformationJobObject(
                job.as_raw_handle(),
                JobObjectExtendedLimitInformation,
                (&raw const limits).cast::<c_void>(),
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        })?;
        Ok(Self(job))
    }

    /// Ends every process in the job with `code`; a job with none left succeeds.
    pub fn terminate(&self, code: u32) -> io::Result<()> {
        // SAFETY: the job handle is open.
        check(unsafe { TerminateJobObject(self.0.as_raw_handle(), code) })
    }
}

/// Delivers `CTRL_C_EVENT` to every process on the console that `process` is
/// attached to. A process holds one console, so this only works in a helper
/// that has none of its own (started `DETACHED_PROCESS`): it attaches to the
/// child's console, ignores the event itself, sends it and detaches again.
pub fn interrupt_console(process: u32) -> io::Result<()> {
    // `AttachConsole` reads `u32::MAX` as `ATTACH_PARENT_PROCESS`, which would
    // send the event to this helper's parent console, and 0 names no process.
    if process == 0 || process == u32::MAX {
        return Err(io::Error::from(io::ErrorKind::InvalidInput));
    }
    // SAFETY: detaching a console this helper may not have is harmless.
    unsafe { FreeConsole() };
    // SAFETY: attaches to another process's console by ID.
    check(unsafe { AttachConsole(process) })?;
    // SAFETY: a null handler with `TRUE` makes this process ignore Ctrl+C.
    let sent = check(unsafe { SetConsoleCtrlHandler(None, 1) })
        // SAFETY: group 0 is every process on the attached console.
        .and_then(|()| check(unsafe { GenerateConsoleCtrlEvent(CTRL_C_EVENT, 0) }));
    // The event is queued to the console's processes asynchronously.
    std::thread::sleep(Duration::from_millis(100));
    // SAFETY: this helper owns the console it attached to.
    unsafe { FreeConsole() };
    sent
}

/// A ConPTY pseudo-console. Closing it (drop) ends the console host, which
/// closes the output pipe once its buffered output has been read.
pub struct PseudoConsole {
    console: HPCON,
    /// Resize and close are not synchronized by the system; callers serialize.
    _unsync: PhantomData<std::cell::Cell<()>>,
}

fn coordinates(columns: u16, rows: u16) -> io::Result<COORD> {
    let invalid = || io::Error::new(io::ErrorKind::InvalidInput, "terminal size out of range");
    Ok(COORD {
        X: i16::try_from(columns).map_err(|_| invalid())?,
        Y: i16::try_from(rows).map_err(|_| invalid())?,
    })
}

impl PseudoConsole {
    /// Creates a console that reads keyboard input from `input` (a pipe's
    /// read end) and writes its rendered output to `output` (a pipe's write
    /// end). The console host duplicates both, so they are closed here.
    pub fn new(
        columns: u16,
        rows: u16,
        input: OwnedHandle,
        output: OwnedHandle,
    ) -> io::Result<Self> {
        let mut console: HPCON = 0;
        // SAFETY: both handles are open pipe ends for the duration of the call.
        let result = unsafe {
            CreatePseudoConsole(
                coordinates(columns, rows)?,
                input.as_raw_handle(),
                output.as_raw_handle(),
                0,
                &mut console,
            )
        };
        if result < 0 {
            return Err(io::Error::from_raw_os_error(result));
        }
        Ok(Self {
            console,
            _unsync: PhantomData,
        })
    }

    pub fn resize(&self, columns: u16, rows: u16) -> io::Result<()> {
        // SAFETY: the console is open until drop.
        let result = unsafe { ResizePseudoConsole(self.console, coordinates(columns, rows)?) };
        if result < 0 {
            return Err(io::Error::from_raw_os_error(result));
        }
        Ok(())
    }
}

impl Drop for PseudoConsole {
    fn drop(&mut self) {
        // SAFETY: closed exactly once.
        unsafe { ClosePseudoConsole(self.console) };
    }
}

/// An auto-reset event, for waking a thread blocked in [`wait_any`].
pub struct Event(OwnedHandle);

impl Event {
    pub fn new() -> io::Result<Self> {
        // SAFETY: anonymous auto-reset event, initially unsignalled.
        handle(unsafe { CreateEventW(std::ptr::null(), 0, 0, std::ptr::null()) }).map(Self)
    }

    pub fn set(&self) {
        // SAFETY: the event handle is open.
        unsafe { SetEvent(self.0.as_raw_handle()) };
    }

    pub fn as_handle(&self) -> BorrowedHandle<'_> {
        use std::os::windows::io::AsHandle as _;
        self.0.as_handle()
    }
}

/// Blocks until one of at most 64 handles is signalled and returns its
/// index, or `None` after `timeout`.
pub fn wait_any(
    handles: &[BorrowedHandle<'_>],
    timeout: Option<Duration>,
) -> io::Result<Option<usize>> {
    let raw: Vec<HANDLE> = handles
        .iter()
        .map(|handle| handle.as_raw_handle())
        .collect();
    let milliseconds = timeout.map_or(INFINITE, |timeout| {
        u32::try_from(timeout.as_millis()).unwrap_or(INFINITE - 1)
    });
    // SAFETY: every handle is borrowed for the duration of the call.
    let result = unsafe { WaitForMultipleObjects(raw.len() as u32, raw.as_ptr(), 0, milliseconds) };
    match result {
        WAIT_FAILED => Err(io::Error::last_os_error()),
        WAIT_TIMEOUT => Ok(None),
        index if (index.wrapping_sub(WAIT_OBJECT_0) as usize) < raw.len() => {
            Ok(Some((index - WAIT_OBJECT_0) as usize))
        }
        _ => Err(io::Error::other("unexpected wait result")),
    }
}

/// The child's standard streams.
pub enum Stdio<'a> {
    /// Pipe ends the child inherits as stdin, stdout and stderr; nothing else
    /// is inherited.
    Pipes {
        input: BorrowedHandle<'a>,
        output: BorrowedHandle<'a>,
        error: BorrowedHandle<'a>,
    },
    /// The child attaches to this pseudo-console and inherits no handle.
    Console(&'a PseudoConsole),
}

pub struct Command<'a> {
    /// A full path, run as is: no search and no extension appended.
    pub application: &'a OsStr,
    /// The complete command line (see `command_line::build`).
    pub command_line: &'a str,
    /// The complete environment; nothing is inherited.
    pub environment: &'a [(&'a str, &'a str)],
    pub directory: Option<&'a OsStr>,
    pub stdio: Stdio<'a>,
    pub job: &'a Job,
}

/// A started process. Holding its handle keeps its ID from being reused.
pub struct Child {
    process: OwnedHandle,
    id: u32,
}

impl Child {
    pub fn id(&self) -> u32 {
        self.id
    }

    /// Signalled once the process has exited.
    pub fn as_handle(&self) -> BorrowedHandle<'_> {
        use std::os::windows::io::AsHandle as _;
        self.process.as_handle()
    }

    /// The exit code; meaningful once the handle is signalled.
    pub fn exit_code(&self) -> io::Result<u32> {
        let mut code = 0;
        // SAFETY: the process handle is open; `code` outlives the call.
        check(unsafe { GetExitCodeProcess(self.process.as_raw_handle(), &mut code) })?;
        Ok(code)
    }
}

struct AttributeList(LPPROC_THREAD_ATTRIBUTE_LIST);

impl Drop for AttributeList {
    fn drop(&mut self) {
        // SAFETY: initialized and deleted exactly once, before its storage is freed.
        unsafe { DeleteProcThreadAttributeList(self.0) };
    }
}

fn environment_block(environment: &[(&str, &str)]) -> io::Result<Vec<u16>> {
    let mut block = Vec::new();
    for (name, value) in environment {
        if name.is_empty() || name.contains(['=', '\0']) || value.contains('\0') {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "invalid environment variable",
            ));
        }
        block.extend(name.encode_utf16());
        block.push(u16::from(b'='));
        block.extend(value.encode_utf16());
        block.push(0);
    }
    // An empty block is still two NULs.
    if block.is_empty() {
        block.push(0);
    }
    block.push(0);
    Ok(block)
}

/// Starts `command` inside its job. The job is assigned atomically at
/// creation (`PROC_THREAD_ATTRIBUTE_JOB_LIST`), so not even the first
/// instruction of the child runs outside it.
pub fn spawn(command: &Command<'_>) -> io::Result<Child> {
    let application = terminated(command.application)?;
    let mut line = terminated(OsStr::new(command.command_line))?;
    // CreateProcessW limits the command line to 32,767 characters.
    if line.len() > 32_767 {
        return Err(io::Error::from_raw_os_error(
            ERROR_FILENAME_EXCED_RANGE as i32,
        ));
    }
    let environment = environment_block(command.environment)?;
    let directory = command.directory.map(terminated).transpose()?;

    let mut size = 0;
    // SAFETY: a null list asks only for the size of a two-attribute list.
    unsafe { InitializeProcThreadAttributeList(std::ptr::null_mut(), 2, 0, &mut size) };
    let mut storage = vec![0usize; size.div_ceil(size_of::<usize>())];
    let list: LPPROC_THREAD_ATTRIBUTE_LIST = storage.as_mut_ptr().cast();
    // SAFETY: the storage holds at least `size` bytes and outlives the list.
    check(unsafe { InitializeProcThreadAttributeList(list, 2, 0, &mut size) })?;
    let list = AttributeList(list);

    let jobs = [command.job.0.as_raw_handle()];
    // SAFETY: `jobs` outlives CreateProcessW below; its size is passed.
    check(unsafe {
        UpdateProcThreadAttribute(
            list.0,
            0,
            PROC_THREAD_ATTRIBUTE_JOB_LIST as usize,
            jobs.as_ptr().cast::<c_void>(),
            size_of_val(&jobs),
            std::ptr::null_mut(),
            std::ptr::null(),
        )
    })?;

    let mut startup = STARTUPINFOEXW::default();
    startup.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    startup.lpAttributeList = list.0;
    let inherited: [HANDLE; 3];
    let (inherit, flags) = match &command.stdio {
        Stdio::Pipes {
            input,
            output,
            error,
        } => {
            inherited = [
                input.as_raw_handle(),
                output.as_raw_handle(),
                error.as_raw_handle(),
            ];
            for raw in inherited {
                // The handle list admits only inheritable handles.
                // SAFETY: each handle is borrowed and open.
                check(unsafe {
                    SetHandleInformation(raw, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT)
                })?;
            }
            // SAFETY: `inherited` outlives CreateProcessW below; its size is passed.
            check(unsafe {
                UpdateProcThreadAttribute(
                    list.0,
                    0,
                    PROC_THREAD_ATTRIBUTE_HANDLE_LIST as usize,
                    inherited.as_ptr().cast::<c_void>(),
                    size_of_val(&inherited),
                    std::ptr::null_mut(),
                    std::ptr::null(),
                )
            })?;
            startup.StartupInfo.hStdInput = inherited[0];
            startup.StartupInfo.hStdOutput = inherited[1];
            startup.StartupInfo.hStdError = inherited[2];
            // Its own hidden console: the host's console never reaches it.
            (1, CREATE_NO_WINDOW)
        }
        Stdio::Console(console) => {
            // The attribute value is the HPCON itself, not a pointer to it.
            // SAFETY: the console stays open for the duration of the spawn.
            check(unsafe {
                UpdateProcThreadAttribute(
                    list.0,
                    0,
                    PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE as usize,
                    console.console as *const c_void,
                    size_of::<HPCON>(),
                    std::ptr::null_mut(),
                    std::ptr::null(),
                )
            })?;
            // Invalid standard handles make the child use the console's own
            // rather than any redirected handles of the host.
            startup.StartupInfo.hStdInput = INVALID_HANDLE_VALUE;
            startup.StartupInfo.hStdOutput = INVALID_HANDLE_VALUE;
            startup.StartupInfo.hStdError = INVALID_HANDLE_VALUE;
            (0, 0)
        }
    };

    let mut information = PROCESS_INFORMATION::default();
    // SAFETY: every string is NUL-terminated and outlives the call, the
    // command line buffer is writable, the environment block is UTF-16 as
    // flagged, and the attribute list and the arrays it points to are live.
    check(unsafe {
        CreateProcessW(
            application.as_ptr(),
            line.as_mut_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            inherit,
            flags | CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT,
            environment.as_ptr().cast::<c_void>(),
            directory
                .as_ref()
                .map_or(std::ptr::null(), |directory| directory.as_ptr()),
            &raw const startup.StartupInfo,
            &mut information,
        )
    })?;
    drop(list);
    drop(storage);
    // The main thread handle is not needed.
    drop(handle(information.hThread));
    Ok(Child {
        process: handle(information.hProcess)?,
        id: information.dwProcessId,
    })
}

#[cfg(test)]
mod tests {
    #[test]
    fn an_interrupt_never_targets_the_parent_console_or_process_zero() {
        // Neither value reaches `AttachConsole`, so no event can be sent.
        for process in [0, u32::MAX] {
            assert_eq!(
                interrupt_console(process).unwrap_err().kind(),
                io::ErrorKind::InvalidInput
            );
        }
    }

    use super::*;

    #[test]
    fn environment_blocks_are_double_terminated() {
        assert_eq!(environment_block(&[]).unwrap(), [0, 0]);
        let block = environment_block(&[("A", "b c"), ("Z", "")]).unwrap();
        assert_eq!(String::from_utf16(&block).unwrap(), "A=b c\0Z=\0\0");
        assert!(environment_block(&[("A=B", "x")]).is_err());
    }
}
