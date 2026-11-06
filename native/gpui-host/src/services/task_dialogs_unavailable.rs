//! No OS message dialog implementation is advertised on these targets.

use crate::channel::EventSink;
use bun_native_protocol::{DialogId, ErrorCode, MessageDialogOptions, RequestId, WindowId};
use gpui::{App, Task, Window};

type Failure = (ErrorCode, &'static str);

#[derive(Clone)]
pub(crate) struct TaskDialogs;

impl TaskDialogs {
    pub(crate) fn new(_events: EventSink, _cx: &App) -> Self {
        Self
    }
    pub(crate) fn available(&self) -> bool {
        false
    }
    pub(crate) fn owner(_window: &Window) -> isize {
        0
    }
    pub(crate) fn show(
        &self,
        _request: (RequestId, WindowId, DialogId),
        _options: MessageDialogOptions,
        _owner: isize,
        _cx: &mut App,
    ) -> Result<(), Failure> {
        Err((
            ErrorCode::ServiceUnavailable,
            "OS message dialogs are not implemented on this target",
        ))
    }
    pub(crate) fn close(
        &self,
        _id: RequestId,
        _window: WindowId,
        _dialog: DialogId,
        _cx: &mut App,
    ) -> Result<(), Failure> {
        Err((
            ErrorCode::InvalidHandle,
            "message dialog is not live for this window",
        ))
    }
    pub(crate) fn close_window(&self, _window: WindowId, _cx: &mut App) {}
    pub(crate) fn stop(&self, _cx: &mut App) -> Option<Task<()>> {
        None
    }
}
