//! No global shortcut implementation is advertised on these targets.

use crate::channel::EventSink;
use bun_native_protocol::{ErrorCode, RequestId, ShortcutId, ShortcutModifiers, WindowId};
use gpui::{App, Task, Window};

type Failure = (ErrorCode, &'static str);

#[derive(Clone)]
pub(crate) struct Shortcuts;

impl Shortcuts {
    pub(crate) fn new(_events: EventSink, _cx: &App) -> Self {
        Self
    }
    pub(crate) fn available(&self) -> bool {
        false
    }
    pub(crate) fn supports_window(_window: &Window) -> bool {
        false
    }
    pub(crate) fn register(
        &self,
        _request: (RequestId, WindowId, ShortcutId),
        _key: &str,
        _modifiers: ShortcutModifiers,
        _cx: &mut App,
    ) -> Result<(), Failure> {
        Err((
            ErrorCode::ServiceUnavailable,
            "global shortcuts are not implemented on this target",
        ))
    }
    pub(crate) fn unregister(
        &self,
        _id: RequestId,
        _window: WindowId,
        _shortcut: ShortcutId,
        _cx: &mut App,
    ) -> Result<(), Failure> {
        Err((
            ErrorCode::InvalidHandle,
            "global shortcut is not registered by this window",
        ))
    }
    pub(crate) fn close_window(&self, _window: WindowId, _cx: &mut App) {}
    pub(crate) fn stop(&self, _cx: &mut App) -> Option<Task<()>> {
        None
    }
}
