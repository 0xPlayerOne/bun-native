//! No filesystem grant implementation is advertised on these targets: they
//! have neither Linux `openat2` nor the macOS per-name `openat` walk.

use crate::channel::EventSink;
use bun_native_protocol::{
    ErrorCode, FileAccess, FileGrantId, FileOperation, FilesystemRoot, RequestId, WindowId,
};
use gpui::{App, Task};

type Failure = (ErrorCode, &'static str);

#[derive(Clone)]
pub(crate) struct Files;

impl Files {
    pub(crate) fn new(_events: EventSink, _roots: Vec<FilesystemRoot>, _cx: &App) -> Self {
        Self
    }
    pub(crate) fn available(&self) -> bool {
        false
    }
    pub(crate) fn open(
        &self,
        _request: (RequestId, WindowId, FileGrantId),
        _root: &str,
        _access: FileAccess,
        _cx: &mut App,
    ) -> Result<(), Failure> {
        Err((
            ErrorCode::ServiceUnavailable,
            "filesystem grants are not implemented on this target",
        ))
    }
    pub(crate) fn request(
        &self,
        _request: (RequestId, WindowId, FileGrantId),
        _path: String,
        _operation: FileOperation,
        _cx: &mut App,
    ) -> Result<(), Failure> {
        Err((
            ErrorCode::InvalidHandle,
            "file grant is closed or is not owned by this window",
        ))
    }
    pub(crate) fn close(
        &self,
        _id: RequestId,
        _window: WindowId,
        _grant: FileGrantId,
        _cx: &mut App,
    ) -> Result<(), Failure> {
        Err((
            ErrorCode::InvalidHandle,
            "file grant is closed or is not owned by this window",
        ))
    }
    pub(crate) fn close_window(&self, _window: WindowId, _cx: &mut App) {}
    pub(crate) fn stop(&self, _cx: &mut App) -> Option<Task<()>> {
        None
    }
}
