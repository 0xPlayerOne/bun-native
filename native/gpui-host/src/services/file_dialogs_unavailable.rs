//! No OS file dialog implementation is advertised on these targets.

use crate::channel::EventSink;
use bun_native_protocol::{DialogId, ErrorCode, FileDialogOptions, RequestId, WindowId};
use gpui::{App, Task, Window};

type Failure = (ErrorCode, &'static str);

#[derive(Clone)]
pub(crate) struct FileDialogs;

impl FileDialogs {
    pub(crate) fn new(_events: EventSink, _cx: &App) -> Self {
        Self
    }
    pub(crate) fn available(&self) -> bool {
        false
    }
    pub(crate) fn parent(_window: &Window) -> String {
        String::new()
    }
    pub(crate) fn show(
        &self,
        _request: (RequestId, WindowId, DialogId),
        _options: FileDialogOptions,
        _parent: String,
        _cx: &mut App,
    ) -> Result<(), Failure> {
        Err((
            ErrorCode::ServiceUnavailable,
            "file dialogs are not implemented on this target",
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
            "file dialog is not live for this window",
        ))
    }
    pub(crate) fn close_window(&self, _window: WindowId, _cx: &mut App) {}
    pub(crate) fn stop(&self, _cx: &mut App) -> Option<Task<()>> {
        None
    }
}
