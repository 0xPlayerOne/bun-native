//! Owned child processes. Each process has one thread that starts it, moves
//! its output under a delivery credit and observes its exit (a pidfd on
//! Linux, a `waitid(WNOWAIT)` watcher on macOS). The UI thread holds only
//! shared state, so a stalled child never blocks input, paint or the tree
//! queue.

#[cfg(target_os = "linux")]
#[path = "processes/linux.rs"]
mod platform;
#[cfg(target_os = "macos")]
#[path = "processes/macos.rs"]
mod platform;

use crate::channel::EventSink;
use crate::services::files::Directory;
use async_channel::{Receiver, Sender};
use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use bun_native_protocol::{
    ErrorCode, Event, MAX_FILE_CHUNK_BYTES, MAX_PROCESS_OUTPUT_CREDIT, MAX_PROCESSES,
    ProcessExecutable, ProcessExit, ProcessId, ProcessLaunch, ProcessSignal, ProcessStream,
    RequestId, TerminalSize, WindowId,
};
use gpui::{App, BackgroundExecutor, Task};
use platform::{ExitWatch, Wake};
use rustix::event::{PollFd, PollFlags, poll};
use rustix::fs::{OFlags, fcntl_getfl, fcntl_setfl};
use rustix::io::Errno;
use rustix::process::{Pid, Signal, kill_process_group};
use std::cell::{Cell, RefCell};
use std::collections::{BTreeMap, VecDeque};
use std::io::{ErrorKind, Read as _, Write as _};
use std::os::fd::{AsFd, OwnedFd};
use std::os::unix::process::{CommandExt as _, ExitStatusExt as _};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::rc::Rc;
use std::sync::{Arc, Mutex, MutexGuard};
use std::thread::JoinHandle;

type Failure = (ErrorCode, &'static str);

/// Input accepted but not yet written to the child.
const MAX_PENDING_INPUT: usize = 65_536;
/// The terminal end-of-file character in canonical mode (VEOF, ^D).
const TERMINAL_EOF: u8 = 0x04;

#[derive(Default)]
struct State {
    /// Output chunks the thread has sent and the UI has acknowledged.
    sent: u64,
    acknowledged: u64,
    input: VecDeque<u8>,
    close_input: bool,
    released: bool,
    /// The leader's group may no longer be signalled: it is reaped or reaping.
    reaped: bool,
    group: Option<Pid>,
}

struct Control {
    state: Mutex<State>,
    wake: Wake,
}

impl Control {
    fn new() -> std::io::Result<Self> {
        Ok(Self {
            state: Mutex::new(State::default()),
            wake: Wake::new()?,
        })
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn wake(&self) {
        self.wake.notify();
    }
}

enum Message {
    Spawned(ProcessId, Result<(), Failure>),
    Output(ProcessId, ProcessStream, Vec<u8>),
    Exited(ProcessId, ProcessExit),
}

struct Entry {
    window: WindowId,
    control: Arc<Control>,
    terminal: Option<Arc<OwnedFd>>,
    /// The spawn request still waiting for its reply.
    spawning: Option<RequestId>,
    delivered: u64,
    exited: bool,
    thread: Option<JoinHandle<()>>,
}

struct Inner {
    executables: Vec<ProcessExecutable>,
    entries: RefCell<BTreeMap<ProcessId, Entry>>,
    last_process: Cell<u64>,
    messages: Sender<Message>,
    receiver: RefCell<Option<Receiver<Message>>>,
    detached: RefCell<Vec<JoinHandle<()>>>,
    stopping: Cell<bool>,
    events: EventSink,
}

#[derive(Clone)]
pub(crate) struct Processes(Rc<Inner>);

/// What a spawn needs from the session: the launch and a resolved cwd root.
pub(crate) struct Spawn {
    pub(crate) launch: ProcessLaunch,
    pub(crate) directory: Option<(Directory, String)>,
}

impl Processes {
    pub(crate) fn new(events: EventSink, executables: Vec<ProcessExecutable>, _cx: &App) -> Self {
        // Every process thread reports through one bounded queue: each holds at
        // most its output credit, one spawn result and one exit.
        let (messages, receiver) =
            async_channel::bounded(MAX_PROCESSES * (MAX_PROCESS_OUTPUT_CREDIT + 2));
        Self(Rc::new(Inner {
            executables,
            entries: RefCell::new(BTreeMap::new()),
            last_process: Cell::new(0),
            messages,
            receiver: RefCell::new(Some(receiver)),
            detached: RefCell::new(Vec::new()),
            stopping: Cell::new(false),
            events,
        }))
    }

    pub(crate) fn available(&self) -> bool {
        platform::available()
    }

    pub(crate) fn spawn(
        &self,
        request: (RequestId, WindowId, ProcessId),
        spawn: Spawn,
        cx: &mut App,
    ) -> Result<(), Failure> {
        let (id, window, process) = request;
        let executable = self
            .0
            .executables
            .iter()
            .find(|entry| entry.id == spawn.launch.executable)
            .ok_or((
                ErrorCode::PermissionDenied,
                "this process executable was not granted at native process launch",
            ))?
            .executable
            .clone();
        if !self.available() {
            return Err((ErrorCode::ServiceUnavailable, platform::UNAVAILABLE));
        }
        if self.0.stopping.get() {
            return Err((ErrorCode::Cancelled, "native processes are shutting down"));
        }
        if process.get() <= self.0.last_process.get() {
            return Err((
                ErrorCode::InvalidHandle,
                "process IDs must increase across the session",
            ));
        }
        if self.0.entries.borrow().len() >= MAX_PROCESSES {
            return Err((ErrorCode::LimitExceeded, "owned process limit exceeded"));
        }
        let control = Arc::new(Control::new().map_err(|_| {
            (
                ErrorCode::NativeFailure,
                "cannot create a process wake event",
            )
        })?);
        let (master, terminal) = match spawn.launch.terminal {
            Some(size) => {
                let (master, pts) = open_terminal(size)?;
                (Some(master.clone()), Some((master, pts)))
            }
            None => (None, None),
        };
        self.start_receiver(cx);
        let job = Job {
            process,
            executable,
            launch: spawn.launch,
            directory: spawn.directory,
            terminal,
            control: control.clone(),
            messages: self.0.messages.clone(),
        };
        let thread = std::thread::Builder::new()
            .name("bun-native-process".into())
            .spawn(move || job.run())
            .map_err(|_| (ErrorCode::NativeFailure, "cannot start a process thread"))?;
        self.0.last_process.set(process.get());
        self.0.entries.borrow_mut().insert(
            process,
            Entry {
                window,
                control,
                terminal: master,
                spawning: Some(id),
                delivered: 0,
                exited: false,
                thread: Some(thread),
            },
        );
        Ok(())
    }

    fn owned(
        &self,
        window: WindowId,
        process: ProcessId,
        then: impl FnOnce(&mut Entry) -> Result<(), Failure>,
    ) -> Result<(), Failure> {
        let mut entries = self.0.entries.borrow_mut();
        let entry = entries
            .get_mut(&process)
            .filter(|entry| entry.window == window && entry.spawning.is_none())
            .ok_or((
                ErrorCode::InvalidHandle,
                "process is released, still starting or not owned by this window",
            ))?;
        then(entry)
    }

    pub(crate) fn update(
        &self,
        request: (RequestId, WindowId, ProcessId),
        change: Change,
        cx: &mut App,
    ) -> Result<(), Failure> {
        let (id, window, process) = request;
        self.owned(window, process, |entry| {
            if let Change::Acknowledge(chunk) = change {
                let mut state = entry.control.lock();
                if chunk <= state.acknowledged || chunk > entry.delivered {
                    return Err((
                        ErrorCode::InvalidState,
                        "acknowledgement must name delivered, unacknowledged output",
                    ));
                }
                state.acknowledged = chunk;
                drop(state);
                entry.control.wake();
                return Ok(());
            }
            if entry.exited {
                return Err((ErrorCode::InvalidState, "the process has exited"));
            }
            match change {
                Change::Write(data) => {
                    let mut state = entry.control.lock();
                    if state.close_input {
                        return Err((ErrorCode::InvalidState, "process input is closed"));
                    }
                    if state.input.len() + data.len() > MAX_PENDING_INPUT {
                        return Err((
                            ErrorCode::LimitExceeded,
                            "the process has not read its pending input",
                        ));
                    }
                    state.input.extend(data);
                }
                Change::CloseInput => {
                    let mut state = entry.control.lock();
                    if state.close_input {
                        return Err((ErrorCode::InvalidState, "process input is closed"));
                    }
                    if entry.terminal.is_some() {
                        // A terminal has no separate input to close; end the line discipline's input.
                        state.input.push_back(TERMINAL_EOF);
                    } else {
                        state.close_input = true;
                    }
                }
                Change::Resize(size) => {
                    let master = entry.terminal.as_ref().ok_or((
                        ErrorCode::WrongKind,
                        "only a terminal process can be resized",
                    ))?;
                    rustix::termios::tcsetwinsize(master.as_fd(), winsize(size))
                        .map_err(|_| (ErrorCode::NativeFailure, "cannot resize the terminal"))?;
                }
                Change::Signal(signal) => {
                    let state = entry.control.lock();
                    let group = state
                        .group
                        .filter(|_| !state.reaped)
                        .ok_or((ErrorCode::InvalidState, "the process has exited"))?;
                    // The unreaped leader keeps its group ID from being reused.
                    // macOS may count a group holding only that zombie as
                    // empty: the process has exited either way.
                    kill_process_group(group, native_signal(signal)).map_err(|error| {
                        if error == Errno::SRCH {
                            (ErrorCode::InvalidState, "the process has exited")
                        } else {
                            (ErrorCode::NativeFailure, "cannot signal the process")
                        }
                    })?;
                }
                Change::Acknowledge(_) => unreachable!(),
            }
            entry.control.wake();
            Ok(())
        })?;
        self.0.events.send(
            Event::ProcessUpdated {
                id,
                window_id: window,
                process_id: process,
            },
            cx,
        );
        Ok(())
    }

    pub(crate) fn release(
        &self,
        id: RequestId,
        window: WindowId,
        process: ProcessId,
        cx: &mut App,
    ) -> Result<(), Failure> {
        let owned = self
            .0
            .entries
            .borrow()
            .get(&process)
            .is_some_and(|entry| entry.window == window);
        if !owned {
            return Err((
                ErrorCode::InvalidHandle,
                "process is released or is not owned by this window",
            ));
        }
        self.revoke(
            |_, candidate| candidate == process,
            "process was released",
            cx,
        );
        self.0.events.send(
            Event::ProcessReleased {
                id,
                window_id: window,
                process_id: process,
            },
            cx,
        );
        Ok(())
    }

    pub(crate) fn close_window(&self, window: WindowId, cx: &mut App) {
        self.revoke(
            |owner, _| owner == window,
            "process owner window was closed",
            cx,
        );
    }

    pub(crate) fn stop(&self, cx: &mut App) -> Option<Task<()>> {
        self.0.stopping.set(true);
        self.revoke(|_, _| true, "process cancelled during shutdown", cx);
        let threads = std::mem::take(&mut *self.0.detached.borrow_mut());
        (!threads.is_empty()).then(|| join(threads, cx.background_executor()))
    }

    /// Releases matching processes: their groups are killed and reaped on
    /// their own threads, and no later output or exit is delivered.
    fn revoke(
        &self,
        matches: impl Fn(WindowId, ProcessId) -> bool,
        message: &'static str,
        cx: &mut App,
    ) {
        let mut released = Vec::new();
        self.0.entries.borrow_mut().retain(|process, entry| {
            if !matches(entry.window, *process) {
                return true;
            }
            entry.control.lock().released = true;
            entry.control.wake();
            if let Some(id) = entry.spawning.take() {
                released.push(id);
            }
            if let Some(thread) = entry.thread.take() {
                self.0.detached.borrow_mut().push(thread);
            }
            false
        });
        for id in released {
            self.0.events.send(
                Event::Error {
                    id: Some(id),
                    code: ErrorCode::Cancelled,
                    message: message.into(),
                },
                cx,
            );
        }
        // Finished threads are joined here so a long session holds none.
        self.0
            .detached
            .borrow_mut()
            .retain(|thread| !thread.is_finished());
    }

    fn start_receiver(&self, cx: &mut App) {
        let Some(receiver) = self.0.receiver.borrow_mut().take() else {
            return;
        };
        let processes = self.clone();
        cx.spawn(async move |cx| {
            while let Ok(message) = receiver.recv().await {
                cx.update(|cx| processes.receive(message, cx));
            }
        })
        .detach();
    }

    fn receive(&self, message: Message, cx: &mut App) {
        let mut entries = self.0.entries.borrow_mut();
        match message {
            Message::Spawned(process, result) => {
                let Some(entry) = entries.get_mut(&process) else {
                    return; // Released while starting: the request was already answered.
                };
                let Some(id) = entry.spawning.take() else {
                    return;
                };
                let window = entry.window;
                match result {
                    Ok(()) => self.0.events.send(
                        Event::ProcessSpawned {
                            id,
                            window_id: window,
                            process_id: process,
                        },
                        cx,
                    ),
                    Err((code, message)) => {
                        if let Some(entry) = entries.remove(&process)
                            && let Some(thread) = entry.thread
                        {
                            self.0.detached.borrow_mut().push(thread);
                        }
                        self.0.events.send(
                            Event::Error {
                                id: Some(id),
                                code,
                                message: message.into(),
                            },
                            cx,
                        );
                    }
                }
            }
            Message::Output(process, stream, data) => {
                let Some(entry) = entries.get_mut(&process) else {
                    return;
                };
                entry.delivered += 1;
                let chunk = entry.delivered;
                let window = entry.window;
                drop(entries);
                self.0.events.ui(
                    |sequence| Event::ProcessOutput {
                        sequence,
                        window_id: window,
                        process_id: process,
                        chunk,
                        stream,
                        data: STANDARD.encode(data),
                    },
                    cx,
                );
            }
            Message::Exited(process, exit) => {
                let Some(entry) = entries.get_mut(&process) else {
                    return;
                };
                entry.exited = true;
                let window = entry.window;
                drop(entries);
                self.0.events.ui(
                    |sequence| Event::ProcessExited {
                        sequence,
                        window_id: window,
                        process_id: process,
                        exit,
                    },
                    cx,
                );
            }
        }
    }
}

pub(crate) enum Change {
    Write(Vec<u8>),
    CloseInput,
    Resize(TerminalSize),
    Signal(ProcessSignal),
    Acknowledge(u64),
}

fn native_signal(signal: ProcessSignal) -> Signal {
    match signal {
        ProcessSignal::Interrupt => Signal::INT,
        ProcessSignal::Terminate => Signal::TERM,
        ProcessSignal::Kill => Signal::KILL,
        ProcessSignal::Hangup => Signal::HUP,
    }
}

fn winsize(size: TerminalSize) -> rustix::termios::Winsize {
    rustix::termios::Winsize {
        ws_row: size.rows,
        ws_col: size.columns,
        ws_xpixel: 0,
        ws_ypixel: 0,
    }
}

type Terminal = (Arc<OwnedFd>, pty_process::blocking::Pts);

fn open_terminal(size: TerminalSize) -> Result<Terminal, Failure> {
    let (master, pts) = pty_process::blocking::open().map_err(|_| {
        (
            ErrorCode::NativeFailure,
            "cannot allocate a pseudo-terminal",
        )
    })?;
    master
        .resize(pty_process::Size::new(size.rows, size.columns))
        .map_err(|_| (ErrorCode::NativeFailure, "cannot size the pseudo-terminal"))?;
    let master = OwnedFd::from(master);
    nonblocking(&master)?;
    Ok((Arc::new(master), pts))
}

fn nonblocking(fd: &impl AsFd) -> Result<(), Failure> {
    fcntl_getfl(fd)
        .and_then(|flags| fcntl_setfl(fd, flags | OFlags::NONBLOCK))
        .map_err(|_| (ErrorCode::NativeFailure, "cannot configure process I/O"))
}

fn join(threads: Vec<JoinHandle<()>>, executor: &BackgroundExecutor) -> Task<()> {
    executor.spawn(async move {
        // Each released thread kills and reaps its group, then ends.
        for thread in threads {
            let _ = thread.join();
        }
    })
}

fn spawn_failure(error: &std::io::Error) -> Failure {
    match error.raw_os_error().map(Errno::from_raw_os_error) {
        Some(Errno::NOENT | Errno::NOTDIR) => (
            ErrorCode::NotFound,
            "the process executable or working directory does not exist",
        ),
        Some(Errno::ACCESS | Errno::PERM) => (
            ErrorCode::AccessDenied,
            "the operating system denied starting this process",
        ),
        Some(Errno::NOEXEC | Errno::ISDIR) => (
            ErrorCode::WrongKind,
            "the process executable is not a program this system can run",
        ),
        Some(Errno::AGAIN | Errno::NOMEM) => (
            ErrorCode::LimitExceeded,
            "the operating system has no capacity for another process",
        ),
        _ => (ErrorCode::NativeFailure, "cannot start the process"),
    }
}

struct Job {
    process: ProcessId,
    executable: String,
    launch: ProcessLaunch,
    directory: Option<(Directory, String)>,
    terminal: Option<Terminal>,
    control: Arc<Control>,
    messages: Sender<Message>,
}

struct Stream {
    fd: OwnedFd,
    kind: ProcessStream,
    open: bool,
}

impl Job {
    fn run(self) {
        let process = self.process;
        let control = self.control.clone();
        let messages = self.messages.clone();
        match self.start() {
            Ok(running) => {
                let _ = messages.send_blocking(Message::Spawned(process, Ok(())));
                running.supervise(process, &control, &messages);
            }
            Err(failure) => {
                let _ = messages.send_blocking(Message::Spawned(process, Err(failure)));
            }
        }
    }

    fn start(self) -> Result<Running, Failure> {
        // The grant descriptor, not a path string, names the working directory.
        let (directory, cwd) = platform::working_directory(self.directory.as_ref())?.unzip();
        let env = self.launch.env.iter();
        let terminal = self.terminal.is_some();
        let (mut child, input, streams) = match self.terminal {
            Some((master, pts)) => {
                let mut command = pty_process::blocking::Command::new(&self.executable)
                    .args(&self.launch.args)
                    .env_clear()
                    .envs(env);
                if let Some(cwd) = &cwd {
                    command = command.current_dir(cwd);
                }
                let child = command.spawn(pts).map_err(|error| match error {
                    pty_process::Error::Io(error) => spawn_failure(&error),
                    _ => (
                        ErrorCode::NativeFailure,
                        "cannot attach the pseudo-terminal",
                    ),
                })?;
                let master = master
                    .try_clone()
                    .map_err(|_| (ErrorCode::NativeFailure, "cannot share the terminal"))?;
                let input = master
                    .try_clone()
                    .map_err(|_| (ErrorCode::NativeFailure, "cannot share the terminal"))?;
                (
                    child,
                    Some(input),
                    vec![Stream {
                        fd: master,
                        kind: ProcessStream::Terminal,
                        open: true,
                    }],
                )
            }
            None => {
                let mut command = Command::new(&self.executable);
                command
                    .args(&self.launch.args)
                    .env_clear()
                    .envs(env)
                    .stdin(Stdio::piped())
                    .stdout(Stdio::piped())
                    .stderr(Stdio::piped())
                    // Its own group, so one signal reaches every descendant.
                    .process_group(0);
                if let Some(cwd) = &cwd {
                    command.current_dir(cwd);
                }
                let mut child = command.spawn().map_err(|error| spawn_failure(&error))?;
                let take = |fd: Option<OwnedFd>| {
                    fd.ok_or((ErrorCode::NativeFailure, "child pipe is missing"))
                };
                let input = take(child.stdin.take().map(OwnedFd::from))?;
                let stdout = take(child.stdout.take().map(OwnedFd::from))?;
                let stderr = take(child.stderr.take().map(OwnedFd::from))?;
                (
                    child,
                    Some(input),
                    vec![
                        Stream {
                            fd: stdout,
                            kind: ProcessStream::Stdout,
                            open: true,
                        },
                        Stream {
                            fd: stderr,
                            kind: ProcessStream::Stderr,
                            open: true,
                        },
                    ],
                )
            }
        };
        drop(directory);
        let pid = Pid::from_raw(child.id().cast_signed()).ok_or((
            ErrorCode::NativeFailure,
            "the operating system reported no process ID",
        ));
        let watch = pid.and_then(|pid| ExitWatch::new(pid).map(|watch| (pid, watch)));
        let (pid, watch) = match watch {
            Ok(value) => value,
            Err(failure) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(failure);
            }
        };
        for fd in input.iter().chain(streams.iter().map(|stream| &stream.fd)) {
            nonblocking(fd)?;
        }
        self.control.lock().group = Some(pid);
        Ok(Running {
            child,
            group: pid,
            watch,
            input,
            terminal,
            streams,
            exited: false,
        })
    }
}

struct Running {
    child: Child,
    group: Pid,
    watch: ExitWatch,
    input: Option<OwnedFd>,
    terminal: bool,
    streams: Vec<Stream>,
    /// The leader has exited and its group was stopped; it is not yet reaped.
    exited: bool,
}

/// The exit as the reaping `waitpid` reported it.
fn exit_of(status: ExitStatus) -> Option<ProcessExit> {
    match (status.code(), status.signal()) {
        (Some(code), _) => Some(ProcessExit {
            code: Some(code & 0xff),
            signal: None,
        }),
        (None, Some(signal)) => Some(ProcessExit {
            code: None,
            signal: Some(signal),
        }),
        (None, None) => None,
    }
}

enum Slot {
    Wake,
    Exit,
    Stream(usize),
    Input,
}

impl Running {
    fn supervise(mut self, process: ProcessId, control: &Control, messages: &Sender<Message>) {
        let mut buffer = vec![0; MAX_FILE_CHUNK_BYTES];
        loop {
            let (credit, writing) = {
                let mut state = control.lock();
                if state.released {
                    // No signal may target the group once the leader can be reaped.
                    state.reaped = true;
                    break;
                }
                if state.close_input && state.input.is_empty() && !self.terminal {
                    self.input = None;
                }
                (
                    state.sent - state.acknowledged < MAX_PROCESS_OUTPUT_CREDIT as u64,
                    !state.input.is_empty() && self.input.is_some(),
                )
            };
            if self.exited && self.streams.iter().all(|stream| !stream.open) {
                if let Some(exit) = self.reap(control) {
                    let _ = messages.send_blocking(Message::Exited(process, exit));
                }
                return;
            }
            let mut slots = vec![Slot::Wake];
            let mut fds = vec![PollFd::new(&control.wake, PollFlags::IN)];
            if !self.exited {
                slots.push(Slot::Exit);
                fds.push(PollFd::new(&self.watch, PollFlags::IN));
            }
            if credit {
                for (index, stream) in self.streams.iter().enumerate() {
                    if stream.open {
                        slots.push(Slot::Stream(index));
                        fds.push(PollFd::new(&stream.fd, PollFlags::IN));
                    }
                }
            }
            if writing && let Some(input) = &self.input {
                slots.push(Slot::Input);
                fds.push(PollFd::new(input, PollFlags::OUT));
            }
            match poll(&mut fds, None) {
                Ok(_) | Err(Errno::INTR) => {}
                Err(_) => break,
            }
            let ready: Vec<usize> = fds
                .iter()
                .enumerate()
                .filter(|(_, fd)| !fd.revents().is_empty())
                .map(|(index, _)| index)
                .collect();
            drop(fds);
            for index in ready {
                match slots[index] {
                    Slot::Wake => control.wake.drain(),
                    Slot::Exit => self.observe_exit(),
                    Slot::Stream(stream) => {
                        if !self.read(stream, &mut buffer, process, control, messages) {
                            return;
                        }
                    }
                    Slot::Input => self.write(control),
                }
            }
        }
        // Released: stop the whole group, then reap the leader once nothing
        // else observes its PID.
        let _ = kill_process_group(self.group, Signal::KILL);
        self.watch.finish();
        let _ = self.child.wait();
    }

    /// The leader has exited but is not reaped, so its group ID still names
    /// only its own descendants. Stop them so every output end closes.
    fn observe_exit(&mut self) {
        if !self.watch.exited() {
            return;
        }
        let _ = kill_process_group(self.group, Signal::KILL);
        self.input = None;
        self.exited = true;
    }

    fn reap(&mut self, control: &Control) -> Option<ProcessExit> {
        control.lock().reaped = true;
        self.watch.finish();
        let exit = self.child.wait().ok().and_then(exit_of);
        debug_assert!(exit.is_some(), "a reaped leader has exited or was killed");
        exit
    }

    /// Returns false when the UI side is gone.
    fn read(
        &mut self,
        index: usize,
        buffer: &mut [u8],
        process: ProcessId,
        control: &Control,
        messages: &Sender<Message>,
    ) -> bool {
        let stream = &mut self.streams[index];
        let mut file = std::fs::File::from(match stream.fd.try_clone() {
            Ok(fd) => fd,
            Err(_) => {
                stream.open = false;
                return true;
            }
        });
        match file.read(buffer) {
            Ok(0) => stream.open = false,
            Ok(length) => {
                control.lock().sent += 1;
                if messages
                    .send_blocking(Message::Output(
                        process,
                        stream.kind,
                        buffer[..length].to_vec(),
                    ))
                    .is_err()
                {
                    return false;
                }
            }
            Err(error) if error.kind() == ErrorKind::WouldBlock => {}
            Err(error) if error.kind() == ErrorKind::Interrupted => {}
            // A terminal reports EIO once every slave descriptor has closed.
            Err(_) => stream.open = false,
        }
        true
    }

    fn write(&mut self, control: &Control) {
        let Some(input) = &self.input else {
            return;
        };
        let mut state = control.lock();
        let (front, _) = state.input.as_slices();
        let mut file = match input.try_clone() {
            Ok(fd) => std::fs::File::from(fd),
            Err(_) => return,
        };
        match file.write(front) {
            Ok(written) => {
                state.input.drain(..written);
            }
            Err(error)
                if matches!(error.kind(), ErrorKind::WouldBlock | ErrorKind::Interrupted) => {}
            // The child closed its input: later bytes cannot be delivered.
            Err(_) => {
                state.input.clear();
                drop(state);
                if !self.terminal {
                    self.input = None;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(target_os = "linux")]
    use std::os::unix::fs::symlink;
    use std::time::Duration;

    #[cfg(target_os = "linux")]
    fn temp() -> std::path::PathBuf {
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

    fn start(
        script: &str,
        env: &[(&str, &str)],
        directory: Option<(Directory, &str)>,
        terminal: Option<TerminalSize>,
    ) -> Started {
        let (sender, messages) = async_channel::bounded(16);
        let control = Arc::new(Control::new().unwrap());
        let job = Job {
            process: ProcessId::try_from(1).unwrap(),
            executable: "/bin/sh".into(),
            launch: ProcessLaunch {
                executable: "shell".into(),
                args: vec!["-c".into(), script.into()],
                env: env
                    .iter()
                    .map(|(name, value)| ((*name).into(), (*value).into()))
                    .collect(),
                cwd: None,
                terminal,
            },
            directory: directory.map(|(root, path)| (root, path.into())),
            terminal: terminal.map(|size| open_terminal(size).unwrap()),
            control: control.clone(),
            messages: sender,
        };
        let thread = std::thread::spawn(move || job.run());
        Started {
            messages,
            control,
            thread,
        }
    }

    /// Acknowledges every chunk as it arrives, like a settled core callback.
    fn finish(started: Started) -> (Vec<(ProcessStream, Vec<u8>)>, ProcessExit) {
        let mut output = Vec::new();
        let exit = loop {
            match started.messages.recv_blocking().unwrap() {
                Message::Spawned(_, result) => assert!(result.is_ok()),
                Message::Output(_, stream, data) => {
                    output.push((stream, data));
                    started.control.lock().acknowledged += 1;
                    started.control.wake();
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

    #[test]
    fn pipes_carry_separate_streams_an_explicit_environment_and_the_exit_code() {
        let (output, exit) = finish(start(
            "printf out; printf err >&2; printf '|%s|%s' \"$HOME\" \"$BUN\"; exit 3",
            &[("BUN", "x y")],
            None,
            None,
        ));
        assert_eq!(joined(&output, ProcessStream::Stdout), "out||x y");
        assert_eq!(joined(&output, ProcessStream::Stderr), "err");
        assert_eq!(
            exit,
            ProcessExit {
                code: Some(3),
                signal: None
            }
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn the_working_directory_comes_from_a_grant_descriptor_without_links() {
        let base = temp();
        std::fs::create_dir_all(base.join("root/sub")).unwrap();
        symlink(&base, base.join("root/up")).unwrap();
        let root = || {
            Arc::new(
                rustix::fs::open(
                    base.join("root"),
                    OFlags::PATH | OFlags::DIRECTORY | OFlags::CLOEXEC,
                    rustix::fs::Mode::empty(),
                )
                .unwrap(),
            )
        };
        let (output, _) = finish(start("pwd -P", &[], Some((root(), "sub")), None));
        assert_eq!(
            joined(&output, ProcessStream::Stdout).trim_end(),
            base.join("root/sub")
                .canonicalize()
                .unwrap()
                .to_str()
                .unwrap()
        );
        for (path, code) in [
            ("up", ErrorCode::PathDenied),
            ("missing", ErrorCode::NotFound),
        ] {
            let started = start("true", &[], Some((root(), path)), None);
            match started.messages.recv_blocking().unwrap() {
                Message::Spawned(_, Err((actual, _))) => assert_eq!(actual, code, "{path}"),
                _ => panic!("{path} must fail before the process starts"),
            }
            started.thread.join().unwrap();
        }
        std::fs::remove_dir_all(base).unwrap();
    }

    /// macOS has no grant directory to start in, so a cwd is refused before
    /// anything is spawned rather than replaced with a path.
    #[cfg(target_os = "macos")]
    #[test]
    fn a_working_directory_is_refused_without_filesystem_grants() {
        let started = start("true", &[], Some((Directory, "sub")), None);
        match started.messages.recv_blocking().unwrap() {
            Message::Spawned(_, Err((code, _))) => assert_eq!(code, ErrorCode::ServiceUnavailable),
            _ => panic!("a cwd must fail before the process starts"),
        }
        started.thread.join().unwrap();
    }

    #[test]
    fn a_terminal_process_is_a_session_leader_on_a_sized_pseudo_terminal() {
        // Linux ps reports the session ID; macOS ps has none, so there the
        // group ID stands in and the state flags carry session leadership.
        #[cfg(target_os = "linux")]
        const LEADER: &str = "ps -o sid= -p $$ | tr -d ' '";
        #[cfg(target_os = "macos")]
        const LEADER: &str = "ps -o pgid= -p $$ | tr -d ' '";
        let (output, exit) = finish(start(
            &format!(
                "stty size; test -t 0 && test -t 1 && echo tty; {LEADER}; echo $$; ps -o stat= -p $$"
            ),
            &[("PATH", "/usr/bin:/bin")],
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
        let lines: Vec<_> = text.lines().map(str::trim).collect();
        assert_eq!(lines[..2], ["11 77", "tty"], "{text:?}");
        assert_eq!(
            lines[2], lines[3],
            "the child leads its own session: {text:?}"
        );
        // `s`: a session leader; `+`: in its controlling terminal's foreground group.
        assert!(
            lines[4].contains('s') && lines[4].contains('+'),
            "the terminal controls the child's session: {text:?}"
        );
        assert_eq!(exit.code, Some(0));
    }

    #[test]
    fn unacknowledged_output_holds_the_child_at_its_delivery_credit() {
        let started = start(
            "head -c 1000000 /dev/zero",
            &[("PATH", "/usr/bin:/bin")],
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
    }

    #[test]
    fn a_group_signal_reaches_descendants_and_the_exit_stops_the_group() {
        let started = start(
            "sleep 30 & echo $!; wait",
            &[("PATH", "/usr/bin:/bin")],
            None,
            None,
        );
        let mut grandchild = String::new();
        while !grandchild.ends_with('\n') {
            match started.messages.recv_blocking().unwrap() {
                Message::Output(_, _, data) => {
                    grandchild.push_str(std::str::from_utf8(&data).unwrap());
                    started.control.lock().acknowledged += 1;
                    started.control.wake();
                }
                Message::Spawned(_, result) => assert!(result.is_ok()),
                Message::Exited(..) => panic!("exited early"),
            }
        }
        let grandchild = Pid::from_raw(grandchild.trim().parse().unwrap()).unwrap();
        let group = started.control.lock().group.unwrap();
        kill_process_group(group, Signal::TERM).unwrap();
        let (_, exit) = finish(started);
        assert_eq!(
            exit,
            ProcessExit {
                code: None,
                signal: Some(15)
            }
        );
        // The group was stopped on exit: the descendant is gone or a zombie
        // awaiting its new parent, never still running.
        assert!(stopped(grandchild));
    }

    /// True once `pid` no longer runs. A SIGKILL is delivered asynchronously
    /// and a dying process closes its files before it becomes a zombie, so
    /// the state is polled briefly rather than read once.
    fn stopped(pid: Pid) -> bool {
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while !not_running(pid) {
            if std::time::Instant::now() > deadline {
                return false;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        true
    }

    /// True when `pid` no longer runs: gone, or a zombie for init to reap.
    #[cfg(target_os = "linux")]
    fn not_running(pid: Pid) -> bool {
        std::fs::read_to_string(format!("/proc/{}/stat", pid.as_raw_nonzero()))
            .map(|stat| stat.rsplit_once(") ").map(|(_, rest)| rest.as_bytes()[0]))
            .unwrap_or(Some(b'Z'))
            == Some(b'Z')
    }

    /// True when `pid` no longer runs: gone, or a zombie for launchd to reap.
    #[cfg(target_os = "macos")]
    fn not_running(pid: Pid) -> bool {
        let output = Command::new("/bin/ps")
            .args(["-o", "stat=", "-p", &pid.as_raw_nonzero().to_string()])
            .output()
            .unwrap();
        let state = String::from_utf8(output.stdout).unwrap();
        state.trim().is_empty() || state.trim_start().starts_with('Z')
    }

    #[test]
    fn the_leader_exit_stops_descendants_that_hold_its_output_open() {
        let begun = std::time::Instant::now();
        let started = start(
            "sleep 30 & echo $!; exit 4",
            &[("PATH", "/usr/bin:/bin")],
            None,
            None,
        );
        let mut descendant = String::new();
        let exit = loop {
            match started.messages.recv_blocking().unwrap() {
                Message::Output(_, _, data) => {
                    descendant.push_str(std::str::from_utf8(&data).unwrap());
                    started.control.lock().acknowledged += 1;
                    started.control.wake();
                }
                Message::Spawned(_, result) => assert!(result.is_ok()),
                Message::Exited(_, exit) => break exit,
            }
        };
        started.thread.join().unwrap();
        // The background sleep shares stdout: output could only end this soon
        // because the group was killed while the exited leader held its ID.
        assert!(begun.elapsed() < Duration::from_secs(20));
        assert_eq!(
            exit,
            ProcessExit {
                code: Some(4),
                signal: None
            }
        );
        let descendant = Pid::from_raw(descendant.trim().parse().unwrap()).unwrap();
        assert!(stopped(descendant));
        assert!(started.control.lock().reaped);
    }

    #[test]
    fn release_kills_and_reaps_without_reporting_an_exit() {
        // exec: a forked sleep would be orphaned to init on the kill and stay
        // in the group as a zombie until init reaps it, which a container
        // init may never do, so the group check below would race it.
        let started = start("exec sleep 30", &[("PATH", "/usr/bin:/bin")], None, None);
        assert!(matches!(
            started.messages.recv_blocking().unwrap(),
            Message::Spawned(_, Ok(()))
        ));
        let group = started.control.lock().group.unwrap();
        started.control.lock().released = true;
        started.control.wake();
        started.thread.join().unwrap();
        assert!(started.control.lock().reaped);
        assert!(started.messages.try_recv().is_err());
        assert!(kill_process_group(group, Signal::KILL).is_err());
    }

    #[test]
    fn a_missing_executable_is_typed_before_any_output() {
        let (sender, messages) = async_channel::bounded(4);
        let job = Job {
            process: ProcessId::try_from(1).unwrap(),
            executable: "/nonexistent/bun-native".into(),
            launch: ProcessLaunch {
                executable: "missing".into(),
                args: Vec::new(),
                env: BTreeMap::new(),
                cwd: None,
                terminal: None,
            },
            directory: None,
            terminal: None,
            control: Arc::new(Control::new().unwrap()),
            messages: sender,
        };
        job.run();
        assert!(matches!(
            messages.try_recv().unwrap(),
            Message::Spawned(_, Err((ErrorCode::NotFound, _)))
        ));
    }
}
