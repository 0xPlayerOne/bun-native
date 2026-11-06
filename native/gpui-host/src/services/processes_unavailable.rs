//! No owned process implementation is advertised on these targets: the Linux
//! host relies on pidfds and POSIX process groups.

use crate::channel::EventSink;
use crate::services::files::Directory;
use bun_native_protocol::{
    ErrorCode, ProcessExecutable, ProcessId, ProcessLaunch, ProcessSignal, RequestId, TerminalSize,
    WindowId,
};
use gpui::{App, Task};

type Failure = (ErrorCode, &'static str);

#[allow(dead_code, reason = "parsed from the wire on every target")]
pub(crate) struct Spawn {
    pub(crate) launch: ProcessLaunch,
    pub(crate) directory: Option<(Directory, String)>,
}

#[allow(dead_code, reason = "parsed from the wire on every target")]
pub(crate) enum Change {
    Write(Vec<u8>),
    CloseInput,
    Resize(TerminalSize),
    Signal(ProcessSignal),
    Acknowledge(u64),
}

#[derive(Clone)]
pub(crate) struct Processes;

impl Processes {
    pub(crate) fn new(_events: EventSink, _executables: Vec<ProcessExecutable>, _cx: &App) -> Self {
        Self
    }
    pub(crate) fn available(&self) -> bool {
        false
    }
    pub(crate) fn spawn(
        &self,
        _request: (RequestId, WindowId, ProcessId),
        _spawn: Spawn,
        _cx: &mut App,
    ) -> Result<(), Failure> {
        Err((
            ErrorCode::ServiceUnavailable,
            "owned processes are not implemented on this target",
        ))
    }
    pub(crate) fn update(
        &self,
        _request: (RequestId, WindowId, ProcessId),
        _change: Change,
        _cx: &mut App,
    ) -> Result<(), Failure> {
        Err((
            ErrorCode::InvalidHandle,
            "process is released or is not owned by this window",
        ))
    }
    pub(crate) fn release(
        &self,
        _id: RequestId,
        _window: WindowId,
        _process: ProcessId,
        _cx: &mut App,
    ) -> Result<(), Failure> {
        Err((
            ErrorCode::InvalidHandle,
            "process is released or is not owned by this window",
        ))
    }
    pub(crate) fn close_window(&self, _window: WindowId, _cx: &mut App) {}
    pub(crate) fn stop(&self, _cx: &mut App) -> Option<Task<()>> {
        None
    }
}
