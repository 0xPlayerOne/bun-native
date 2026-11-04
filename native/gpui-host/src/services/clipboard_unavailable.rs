//! No programmatic clipboard implementation is advertised on these targets.
//! Native editor copy/paste remains a separate user-triggered GPUI operation.

use crate::channel::EventSink;
use bun_native_protocol::{ErrorCode, RequestId, WindowId};
use gpui::{App, Task, Window};

pub(crate) enum Operation {
    Read,
    Write(String),
}

#[derive(Clone)]
pub(crate) struct Clipboard;

impl Clipboard {
    pub(crate) fn new(_events: EventSink, _cx: &App) -> Self {
        Self
    }
    pub(crate) fn available(&self) -> bool {
        false
    }
    pub(crate) fn supports_window(_window: &Window) -> bool {
        false
    }
    pub(crate) fn submit(
        &self,
        _id: RequestId,
        _window: WindowId,
        operation: Operation,
        _cx: &mut App,
    ) -> Result<(), (ErrorCode, &'static str)> {
        if let Operation::Write(text) = operation {
            drop(text);
        }
        Err((
            ErrorCode::ServiceUnavailable,
            "programmatic clipboard text is not implemented on this target",
        ))
    }
    pub(crate) fn cancel(
        &self,
        _window: Option<WindowId>,
        _code: ErrorCode,
        _message: &'static str,
        _cx: &mut App,
    ) {
    }
    pub(crate) fn stop(&self, _cx: &mut App) -> Option<Task<()>> {
        None
    }
}
