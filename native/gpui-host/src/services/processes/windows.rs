//! Windows: no process groups, signals, pidfds or PTYs. The same supervisor
//! contract is kept with Windows primitives (see
//! `bun_native_windows_services::process`):
//!
//! - **Launch.** The policy executable is opened and held with read-only
//!   sharing, so it cannot be replaced, renamed or written until the child
//!   has started, and `CreateProcessW` runs its normalized final path as
//!   `lpApplicationName`: no search, no shell and no appended extension (an
//!   executable without an extension is refused). Arguments are quoted as the
//!   exact inverse of `CommandLineToArgvW`. The environment block holds only
//!   the requested variables.
//! - **Tree.** Each child starts inside its own job object
//!   (`PROC_THREAD_ATTRIBUTE_JOB_LIST`, so before its first instruction) with
//!   `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`. Descendants inherit the job;
//!   terminating it, or the host's exit or crash closing its last handle,
//!   ends the whole tree.
//! - **Pipes.** Anonymous pipes; the child inherits exactly its three ends
//!   (`PROC_THREAD_ATTRIBUTE_HANDLE_LIST`) and runs on its own hidden console.
//!   One reader thread per output pipe and one writer thread replace `poll`;
//!   readers hold each read chunk until the delivery credit admits it.
//! - **Terminal.** A ConPTY pseudo-console (`CreatePseudoConsole` and
//!   `PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE`), resized with
//!   `ResizePseudoConsole`. Its output is the rendered VT stream.
//! - **Exit.** The supervisor waits on the process handle and a wake event.
//!   When the leader exits it terminates the job (descendants holding the
//!   output open end), closes the pseudo-console, drains every pipe to end of
//!   file and reports the exit last. The process handle is held until then,
//!   so its ID cannot be reused while signals are accepted.
//! - **Signals.** `terminate` and `kill` end the whole job; the exit reports
//!   that signal number. `interrupt` on a terminal types ^C, which the
//!   console delivers as `CTRL_C_EVENT`. `interrupt` on pipes and `hangup`
//!   have no Windows equivalent and are refused.
//! - **Working directory.** The grant directory and every directory down to
//!   it from the root are held open without delete sharing while
//!   `CreateProcessW` starts the child in that directory's final path, so the
//!   path cannot be redirected through anything a grant can reach.

use super::{Control, Failure, Job, MAX_PENDING_INPUT, Message, State};
use crate::services::files::working_directory;
use async_channel::Sender;
use bun_native_protocol::{
    ErrorCode, MAX_FILE_CHUNK_BYTES, MAX_PROCESS_OUTPUT_CREDIT, ProcessExit, ProcessId,
    ProcessSignal, ProcessStream, TerminalSize,
};
use bun_native_windows_services::command_line;
use bun_native_windows_services::fs;
use bun_native_windows_services::process::{
    self as native, Child, Command, ERROR_ACCESS_DENIED, ERROR_BAD_EXE_FORMAT, ERROR_DIRECTORY,
    ERROR_ELEVATION_REQUIRED, ERROR_EXE_MACHINE_TYPE_MISMATCH, ERROR_FILE_NOT_FOUND,
    ERROR_NO_SYSTEM_RESOURCES, ERROR_NOT_ENOUGH_MEMORY, ERROR_OUTOFMEMORY, ERROR_PATH_NOT_FOUND,
    ERROR_SHARING_VIOLATION, Event, PseudoConsole, Stdio,
};
use std::io::{ErrorKind, PipeReader, PipeWriter, Read as _, Write as _};
use std::os::windows::io::AsHandle as _;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard, PoisonError};

pub(super) fn available() -> bool {
    true
}

pub(super) const UNAVAILABLE: &str = "owned processes are unavailable on this Windows host";

/// The exit code the host gives a job it ends for a `terminate` or `kill`
/// request, plus the signal number, so the exit reports that signal.
const SIGNALLED: u32 = 0x00B5_0000;
/// Input written to the console per write.
const INPUT_CHUNK: usize = 4_096;
/// The console's interrupt character.
const CONTROL_C: u8 = 0x03;

const EXITED: Failure = (ErrorCode::InvalidState, "the process has exited");
const NOT_CANONICAL: Failure = (
    ErrorCode::PathDenied,
    "the process executable path is not its canonical path: it crosses a link, a short name or another spelling",
);
const NOT_PROGRAM: Failure = (
    ErrorCode::WrongKind,
    "the process executable is not a program this system can run",
);

/// Wakes the supervisor (an event it waits on with the process handle) and
/// the reader and writer threads (a condition variable on the state).
pub(super) struct Wake {
    event: Event,
    changed: Condvar,
}

impl Wake {
    pub(super) fn new() -> std::io::Result<Self> {
        Ok(Self {
            event: Event::new()?,
            changed: Condvar::new(),
        })
    }

    pub(super) fn notify(&self) {
        self.changed.notify_all();
        self.event.set();
    }

    fn wait<'a>(&self, state: MutexGuard<'a, State>) -> MutexGuard<'a, State> {
        self.changed
            .wait(state)
            .unwrap_or_else(PoisonError::into_inner)
    }
}

/// Signals reach the whole job.
pub(super) type Group = Arc<native::Job>;

/// The pseudo-console; the supervisor closes it once the child has exited.
pub(super) struct Master(Mutex<Option<PseudoConsole>>);

impl Master {
    fn console(&self) -> MutexGuard<'_, Option<PseudoConsole>> {
        self.0.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Takes the console out before closing it: a close can wait for the
    /// console host, and a resize must never wait behind it.
    fn close(&self) {
        let console = self.console().take();
        drop(console);
    }
}

/// The host's ends of the pseudo-console's input and output pipes.
pub(super) struct ConsolePipes {
    input: PipeWriter,
    output: PipeReader,
}

pub(super) type Terminal = (Arc<Master>, ConsolePipes);

pub(super) fn open_terminal(size: TerminalSize) -> Result<Terminal, Failure> {
    let failure = (ErrorCode::NativeFailure, "cannot allocate a pseudo-console");
    let (input_read, input) = std::io::pipe().map_err(|_| failure)?;
    let (output, output_write) = std::io::pipe().map_err(|_| failure)?;
    let console = PseudoConsole::new(
        size.columns,
        size.rows,
        input_read.into(),
        output_write.into(),
    )
    .map_err(|_| failure)?;
    Ok((
        Arc::new(Master(Mutex::new(Some(console)))),
        ConsolePipes { input, output },
    ))
}

pub(super) fn resize(master: &Master, size: TerminalSize) -> Result<(), Failure> {
    master
        .console()
        .as_ref()
        .ok_or(EXITED)?
        .resize(size.columns, size.rows)
        .map_err(|_| (ErrorCode::NativeFailure, "cannot resize the terminal"))
}

pub(super) fn signal(
    state: &mut State,
    signal: ProcessSignal,
    terminal: bool,
) -> Result<(), Failure> {
    let job = state
        .group
        .as_ref()
        .filter(|_| !state.reaped)
        .ok_or(EXITED)?;
    let number = match signal {
        ProcessSignal::Terminate => 15,
        ProcessSignal::Kill => 9,
        ProcessSignal::Interrupt if terminal => {
            if state.input.len() >= MAX_PENDING_INPUT {
                return Err((
                    ErrorCode::LimitExceeded,
                    "the process has not read its pending input",
                ));
            }
            state.input.push_back(CONTROL_C);
            return Ok(());
        }
        ProcessSignal::Interrupt | ProcessSignal::Hangup => {
            return Err((
                ErrorCode::ServiceUnavailable,
                "this signal has no Windows equivalent for this process",
            ));
        }
    };
    job.terminate(SIGNALLED | number)
        .map_err(|_| (ErrorCode::NativeFailure, "cannot signal the process"))
}

fn exit_of(code: u32) -> ProcessExit {
    match code ^ SIGNALLED {
        signal @ (9 | 15) => ProcessExit {
            code: None,
            signal: Some(signal as i32),
        },
        _ => ProcessExit {
            code: Some((code & 0xff) as i32),
            signal: None,
        },
    }
}

fn spawn_failure(error: std::io::Error) -> Failure {
    match error
        .raw_os_error()
        .and_then(|code| u32::try_from(code).ok())
    {
        Some(ERROR_FILE_NOT_FOUND | ERROR_PATH_NOT_FOUND | ERROR_DIRECTORY) => (
            ErrorCode::NotFound,
            "the process executable or working directory does not exist",
        ),
        Some(ERROR_ACCESS_DENIED | ERROR_SHARING_VIOLATION | ERROR_ELEVATION_REQUIRED) => (
            ErrorCode::AccessDenied,
            "the operating system denied starting this process",
        ),
        Some(ERROR_BAD_EXE_FORMAT | ERROR_EXE_MACHINE_TYPE_MISMATCH) => NOT_PROGRAM,
        Some(ERROR_NOT_ENOUGH_MEMORY | ERROR_OUTOFMEMORY | ERROR_NO_SYSTEM_RESOURCES) => (
            ErrorCode::LimitExceeded,
            "the operating system has no capacity for another process",
        ),
        _ => (ErrorCode::NativeFailure, "cannot start the process"),
    }
}

/// Whether a `\\?\X:\...` final path names the drive path `granted`,
/// compared without case as NTFS does.
fn canonical_equals(canonical: &std::ffi::OsStr, granted: &str) -> bool {
    let Some(canonical) = canonical
        .to_str()
        .and_then(|path| path.strip_prefix(r"\\?\"))
    else {
        return false;
    };
    canonical
        .chars()
        .flat_map(char::to_uppercase)
        .eq(granted.chars().flat_map(char::to_uppercase))
}

fn pipe() -> Result<(PipeReader, PipeWriter), Failure> {
    std::io::pipe().map_err(|_| (ErrorCode::NativeFailure, "cannot create process pipes"))
}

impl Job {
    pub(super) fn start(self) -> Result<Running, Failure> {
        let directory = self
            .directory
            .as_ref()
            .map(|(root, path)| {
                working_directory(root, path).map_err(|failure| match failure.0 {
                    ErrorCode::NotFound | ErrorCode::WrongKind | ErrorCode::PathDenied => failure,
                    _ => (
                        ErrorCode::AccessDenied,
                        "the operating system denied this file operation",
                    ),
                })
            })
            .transpose()?;
        // Held until the child has started: the file cannot change meanwhile.
        let executable = fs::open_executable(Path::new(&self.executable)).map_err(spawn_failure)?;
        let info = fs::info(executable.as_handle()).map_err(spawn_failure)?;
        let canonical = fs::final_path(executable.as_handle(), true).map_err(spawn_failure)?;
        // The granted path must already be the file's one canonical spelling,
        // so the policy names exactly the file that runs.
        if !canonical_equals(&canonical, &self.executable) {
            return Err(NOT_CANONICAL);
        }
        let application = fs::dos_path(&canonical);
        // CreateProcessW appends `.exe` to a name without an extension, which
        // would run a different file than the one granted.
        if info.directory || !info.disk || Path::new(&application).extension().is_none() {
            return Err(NOT_PROGRAM);
        }
        let line = application
            .to_str()
            .and_then(|program| command_line::build(program, &self.launch.args))
            .ok_or(NOT_PROGRAM)?;
        let environment: Vec<(&str, &str)> = self
            .launch
            .env
            .iter()
            .map(|(name, value)| (name.as_str(), value.as_str()))
            .collect();
        let job = Arc::new(native::Job::new().map_err(|_| {
            (
                ErrorCode::NativeFailure,
                "cannot create a process job object",
            )
        })?);
        let command = |stdio| Command {
            application: &application,
            command_line: &line,
            environment: &environment,
            directory: directory
                .as_ref()
                .map(|directory| directory.path.as_os_str()),
            stdio,
            job: &job,
        };
        let terminal = self.terminal.is_some();
        let (child, console, input, streams) = match self.terminal {
            Some((master, pipes)) => {
                let child = {
                    let console = master.console();
                    let console = console
                        .as_ref()
                        .ok_or((ErrorCode::NativeFailure, "the pseudo-console is closed"))?;
                    native::spawn(&command(Stdio::Console(console))).map_err(spawn_failure)?
                };
                (
                    child,
                    Some(master),
                    pipes.input,
                    vec![(pipes.output, ProcessStream::Terminal)],
                )
            }
            None => {
                let (input_read, input) = pipe()?;
                let (output, output_write) = pipe()?;
                let (error, error_write) = pipe()?;
                let child = native::spawn(&command(Stdio::Pipes {
                    input: input_read.as_handle(),
                    output: output_write.as_handle(),
                    error: error_write.as_handle(),
                }))
                .map_err(spawn_failure)?;
                // Only the child (and its job) now hold its ends, so each
                // output reaches end of file once the job has ended.
                drop((input_read, output_write, error_write));
                (
                    child,
                    None,
                    input,
                    vec![
                        (output, ProcessStream::Stdout),
                        (error, ProcessStream::Stderr),
                    ],
                )
            }
        };
        drop((directory, executable));
        self.control.lock().group = Some(job.clone());
        Ok(Running {
            child,
            job,
            console,
            input,
            streams,
            terminal,
        })
    }
}

pub(super) struct Running {
    child: Child,
    job: Arc<native::Job>,
    console: Option<Arc<Master>>,
    input: PipeWriter,
    streams: Vec<(PipeReader, ProcessStream)>,
    terminal: bool,
}

impl Running {
    pub(super) fn supervise(
        self,
        process: ProcessId,
        control: &Control,
        messages: &Sender<Message>,
    ) {
        let Running {
            child,
            job,
            console,
            input,
            streams,
            terminal,
        } = self;
        let finished = AtomicBool::new(false);
        let exited = std::thread::scope(|scope| {
            let mut started = true;
            for (reader, stream) in streams {
                started &= std::thread::Builder::new()
                    .name("bun-native-process-output".into())
                    .spawn_scoped(scope, move || {
                        read(reader, stream, process, control, messages);
                    })
                    .is_ok();
            }
            let finished = &finished;
            started &= std::thread::Builder::new()
                .name("bun-native-process-input".into())
                .spawn_scoped(scope, move || write(input, terminal, control, finished))
                .is_ok();
            let exited = started
                && loop {
                    {
                        let mut state = control.lock();
                        if state.released {
                            // No signal may reach the job once it is being stopped.
                            state.reaped = true;
                            break false;
                        }
                    }
                    match native::wait_any(
                        &[control.wake.event.as_handle(), child.as_handle()],
                        None,
                    ) {
                        Ok(Some(1)) => break true,
                        Ok(_) => {}
                        Err(_) => break false,
                    }
                };
            // Stop every descendant so each pipe they hold ends; a console
            // must also close before its output pipe ends.
            let _ = job.terminate(1);
            if let Some(console) = &console {
                console.close();
            }
            finished.store(true, Ordering::Release);
            control.wake();
            exited
        });
        // Every reader has reached end of file: the exit is reported last.
        control.lock().reaped = true;
        if exited && let Ok(code) = child.exit_code() {
            let _ = messages.send_blocking(Message::Exited(process, exit_of(code)));
        }
    }
}

/// Moves one output pipe to the UI under the delivery credit. After release
/// it keeps reading and discarding, so a console host is never blocked.
fn read(
    mut reader: PipeReader,
    stream: ProcessStream,
    process: ProcessId,
    control: &Control,
    messages: &Sender<Message>,
) {
    let mut buffer = vec![0; MAX_FILE_CHUNK_BYTES];
    let mut discard = false;
    loop {
        let length = match reader.read(&mut buffer) {
            Ok(0) => return,
            Ok(length) => length,
            Err(error) if error.kind() == ErrorKind::Interrupted => continue,
            // A broken pipe: every writer has closed.
            Err(_) => return,
        };
        if discard {
            continue;
        }
        let mut state = control.lock();
        loop {
            if state.released {
                discard = true;
                break;
            }
            if state.sent - state.acknowledged < MAX_PROCESS_OUTPUT_CREDIT as u64 {
                state.sent += 1;
                break;
            }
            state = control.wake.wait(state);
        }
        drop(state);
        if !discard
            && messages
                .send_blocking(Message::Output(process, stream, buffer[..length].to_vec()))
                .is_err()
        {
            discard = true;
        }
    }
}

/// Writes pending input in order. Dropping the pipe closes the child's input.
fn write(mut input: PipeWriter, terminal: bool, control: &Control, finished: &AtomicBool) {
    loop {
        let chunk: Vec<u8> = {
            let mut state = control.lock();
            loop {
                if state.released || finished.load(Ordering::Acquire) {
                    return;
                }
                if !state.input.is_empty() {
                    break state.input.iter().take(INPUT_CHUNK).copied().collect();
                }
                if state.close_input && !terminal {
                    return;
                }
                state = control.wake.wait(state);
            }
        };
        match input.write(&chunk) {
            Ok(written) => {
                control.lock().input.drain(..written);
            }
            Err(error) if error.kind() == ErrorKind::Interrupted => {}
            // The child closed its input: later bytes cannot be delivered.
            Err(_) => {
                control.lock().input.clear();
                return;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::files::Directory;
    use async_channel::Receiver;
    use bun_native_protocol::ProcessLaunch;
    use std::collections::BTreeMap;
    use std::path::PathBuf;
    use std::thread::JoinHandle;
    use std::time::{Duration, Instant};

    fn system() -> String {
        std::env::var("SystemRoot").unwrap()
    }

    fn cmd() -> String {
        format!("{}\\System32\\cmd.exe", system())
    }

    /// What a cmd.exe child needs to find programs; nothing else is inherited.
    fn base_environment() -> Vec<(String, String)> {
        vec![
            ("SystemRoot".into(), system()),
            ("PATH".into(), format!("{}\\System32", system())),
        ]
    }

    fn temp() -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "bun-native-processes-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&path).unwrap();
        path
    }

    struct Started {
        messages: Receiver<Message>,
        control: Arc<Control>,
        thread: JoinHandle<()>,
    }

    fn job(
        executable: String,
        script: &str,
        env: Vec<(String, String)>,
        directory: Option<(Directory, &str)>,
        terminal: Option<TerminalSize>,
    ) -> (Job, Receiver<Message>, Arc<Control>) {
        let (sender, messages) = async_channel::bounded(16);
        let control = Arc::new(Control::new().unwrap());
        let job = Job {
            process: ProcessId::try_from(1).unwrap(),
            executable,
            launch: ProcessLaunch {
                executable: "shell".into(),
                args: vec!["/d".into(), "/s".into(), "/c".into(), script.into()],
                env: env.into_iter().collect::<BTreeMap<_, _>>(),
                cwd: None,
                terminal,
            },
            directory: directory.map(|(root, path)| (root, path.into())),
            terminal: terminal.map(|size| open_terminal(size).unwrap()),
            control: control.clone(),
            messages: sender,
        };
        (job, messages, control)
    }

    fn start(
        script: &str,
        env: Vec<(String, String)>,
        directory: Option<(Directory, &str)>,
        terminal: Option<TerminalSize>,
    ) -> Started {
        let (job, messages, control) = job(cmd(), script, env, directory, terminal);
        let thread = std::thread::spawn(move || job.run());
        Started {
            messages,
            control,
            thread,
        }
    }

    fn acknowledge(control: &Control) {
        control.lock().acknowledged += 1;
        control.wake();
    }

    /// Acknowledges every chunk as it arrives, like a settled core callback.
    fn finish(started: Started) -> (Vec<(ProcessStream, Vec<u8>)>, ProcessExit) {
        let mut output = Vec::new();
        let exit = loop {
            match started.messages.recv_blocking().unwrap() {
                Message::Spawned(_, result) => assert!(result.is_ok(), "{result:?}"),
                Message::Output(_, stream, data) => {
                    output.push((stream, data));
                    acknowledge(&started.control);
                }
                Message::Exited(_, exit) => break exit,
            }
        };
        started.thread.join().unwrap();
        assert!(
            started.messages.try_recv().is_err(),
            "nothing follows the exit"
        );
        (output, exit)
    }

    fn joined(output: &[(ProcessStream, Vec<u8>)], kind: ProcessStream) -> String {
        String::from_utf8(
            output
                .iter()
                .filter(|(stream, _)| *stream == kind)
                .flat_map(|(_, data)| data.clone())
                .collect(),
        )
        .unwrap()
    }

    fn spawned(started: &Started) {
        match started.messages.recv_blocking().unwrap() {
            Message::Spawned(_, Ok(())) => {}
            Message::Spawned(_, Err(failure)) => panic!("spawn failed: {failure:?}"),
            _ => panic!("the spawn result comes first"),
        }
    }

    #[test]
    fn command_lines_round_trip_and_exits_map_signals() {
        assert_eq!(
            exit_of(SIGNALLED | 15),
            ProcessExit {
                code: None,
                signal: Some(15)
            }
        );
        assert_eq!(
            exit_of(0xC000_013A),
            ProcessExit {
                code: Some(0x3A),
                signal: None
            }
        );
    }

    #[test]
    fn pipes_carry_separate_streams_an_explicit_environment_and_the_exit_code() {
        let (output, exit) = finish(start(
            "echo out&(echo err)1>&2&echo [%BUN%][%HOME%]&exit /b 3",
            vec![("BUN".into(), "x y".into())],
            None,
            None,
        ));
        // An unset variable stays unexpanded: nothing was inherited.
        assert_eq!(
            joined(&output, ProcessStream::Stdout),
            "out\r\n[x y][%HOME%]\r\n"
        );
        assert_eq!(joined(&output, ProcessStream::Stderr), "err\r\n");
        assert_eq!(
            exit,
            ProcessExit {
                code: Some(3),
                signal: None
            }
        );
    }

    #[test]
    fn a_missing_executable_or_one_without_an_extension_is_typed() {
        for (executable, code) in [
            (
                format!("{}\\no-such-program.exe", system()),
                ErrorCode::NotFound,
            ),
            (format!("{}\\System32\\cmd", system()), ErrorCode::NotFound),
            (format!("{}\\System32", system()), ErrorCode::WrongKind),
            // Another spelling of cmd.exe: a `.` component is not canonical.
            (
                format!("{}\\System32\\.\\cmd.exe", system()),
                ErrorCode::PathDenied,
            ),
        ] {
            let (job, messages, _) = job(executable.clone(), "exit", Vec::new(), None, None);
            job.run();
            match messages.try_recv().unwrap() {
                Message::Spawned(_, Err((actual, _))) => assert_eq!(actual, code, "{executable}"),
                _ => panic!("{executable} must fail before the process starts"),
            }
        }
    }

    #[test]
    fn a_terminal_process_runs_on_a_sized_pseudo_console() {
        let (output, exit) = finish(start(
            "mode con&echo tty&exit /b 0",
            base_environment(),
            None,
            Some(TerminalSize {
                columns: 77,
                rows: 11,
            }),
        ));
        assert!(
            output
                .iter()
                .all(|(stream, _)| *stream == ProcessStream::Terminal)
        );
        let text = joined(&output, ProcessStream::Terminal);
        assert!(text.contains("tty"), "{text:?}");
        assert!(text.contains("77") && text.contains("11"), "{text:?}");
        assert_eq!(exit.code, Some(0));
    }

    #[test]
    fn unacknowledged_output_holds_the_child_at_its_delivery_credit() {
        let base = temp();
        let file = base.join("zeros.bin");
        std::fs::write(&file, vec![b'z'; 1_000_000]).unwrap();
        let started = start(
            &format!("type {}", file.display()),
            base_environment(),
            None,
            None,
        );
        let (mut chunks, mut held) = (0, 0);
        while chunks < MAX_PROCESS_OUTPUT_CREDIT {
            if let Message::Output(_, _, data) = started.messages.recv_blocking().unwrap() {
                chunks += 1;
                held += data.len();
            }
        }
        std::thread::sleep(Duration::from_millis(100));
        assert!(
            started.messages.try_recv().is_err(),
            "no fifth chunk without credit"
        );
        assert_eq!(
            started.control.lock().sent,
            MAX_PROCESS_OUTPUT_CREDIT as u64
        );
        started.control.lock().acknowledged = MAX_PROCESS_OUTPUT_CREDIT as u64;
        started.control.wake();
        let (output, exit) = finish(started);
        let total: usize = output.iter().map(|(_, data)| data.len()).sum();
        assert_eq!(
            total + held,
            1_000_000,
            "every byte is delivered exactly once"
        );
        assert!(
            output
                .iter()
                .all(|(_, data)| data.len() <= MAX_FILE_CHUNK_BYTES)
        );
        assert_eq!(exit.code, Some(0));
        std::fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn the_leader_exit_stops_descendants_that_hold_its_output_open() {
        let begun = Instant::now();
        // The background ping inherits stdout and would hold it for 30 s.
        let (_, exit) = finish(start(
            "start /b ping -n 30 127.0.0.1&exit /b 4",
            base_environment(),
            None,
            None,
        ));
        assert!(begun.elapsed() < Duration::from_secs(20));
        assert_eq!(
            exit,
            ProcessExit {
                code: Some(4),
                signal: None
            }
        );
    }

    #[test]
    fn terminate_ends_the_job_and_reports_the_signal() {
        let started = start("ping -n 30 127.0.0.1 >nul", base_environment(), None, None);
        spawned(&started);
        for refused in [ProcessSignal::Interrupt, ProcessSignal::Hangup] {
            assert_eq!(
                signal(&mut started.control.lock(), refused, false)
                    .unwrap_err()
                    .0,
                ErrorCode::ServiceUnavailable
            );
        }
        signal(&mut started.control.lock(), ProcessSignal::Terminate, false).unwrap();
        let begun = Instant::now();
        let (_, exit) = finish(started);
        assert!(begun.elapsed() < Duration::from_secs(20));
        assert_eq!(
            exit,
            ProcessExit {
                code: None,
                signal: Some(15)
            }
        );
    }

    #[test]
    fn release_ends_the_job_without_reporting_an_exit() {
        let started = start("ping -n 30 127.0.0.1 >nul", base_environment(), None, None);
        spawned(&started);
        let begun = Instant::now();
        started.control.lock().released = true;
        started.control.wake();
        started.thread.join().unwrap();
        assert!(begun.elapsed() < Duration::from_secs(20));
        assert!(started.control.lock().reaped);
        assert!(started.messages.try_recv().is_err());
        assert_eq!(
            signal(&mut started.control.lock(), ProcessSignal::Kill, false)
                .unwrap_err()
                .0,
            ErrorCode::InvalidState
        );
    }

    #[test]
    fn the_working_directory_comes_from_a_grant_without_reparse_points() {
        let base = temp();
        std::fs::create_dir_all(base.join("root/sub")).unwrap();
        let status = std::process::Command::new(cmd())
            .args(["/d", "/c", "mklink", "/J"])
            .arg(base.join("root/up"))
            .arg(&base)
            .status()
            .unwrap();
        assert!(status.success());
        let root = || {
            Arc::new(
                crate::services::files::open_root(base.join("root").to_str().unwrap()).unwrap(),
            )
        };
        let (output, _) = finish(start("cd", Vec::new(), Some((root(), "sub")), None));
        let expected = fs::dos_path(base.join("root/sub").canonicalize().unwrap().as_os_str());
        assert!(
            joined(&output, ProcessStream::Stdout)
                .trim_end()
                .eq_ignore_ascii_case(&expected.to_string_lossy()),
            "{output:?}"
        );
        for (path, code) in [
            ("up", ErrorCode::PathDenied),
            ("missing", ErrorCode::NotFound),
        ] {
            let started = start("exit", Vec::new(), Some((root(), path)), None);
            match started.messages.recv_blocking().unwrap() {
                Message::Spawned(_, Err((actual, _))) => assert_eq!(actual, code, "{path}"),
                _ => panic!("{path} must fail before the process starts"),
            }
            started.thread.join().unwrap();
        }
        std::fs::remove_dir_all(base).unwrap();
    }
}
