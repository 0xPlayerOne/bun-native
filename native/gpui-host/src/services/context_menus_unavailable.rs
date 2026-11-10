//! No OS context menu implementation is advertised on these targets.

use crate::channel::EventSink;
use bun_native_protocol::{AppMenuEntry, ContextMenuId, ErrorCode, RequestId, WindowId};
use gpui::{App, Task, Window};

type Failure = (ErrorCode, &'static str);

pub(crate) type Owner = ();

pub(crate) fn trace(_step: &str) {}

#[derive(Clone)]
pub(crate) struct ContextMenus;

impl ContextMenus {
    pub(crate) fn new(_events: EventSink, _cx: &App) -> Self {
        Self
    }
    pub(crate) fn available(&self) -> bool {
        false
    }
    pub(crate) fn owner(_window: &Window) -> Owner {}
    pub(crate) fn show(
        &self,
        _request: (RequestId, WindowId, ContextMenuId),
        _position: (f64, f64),
        _items: &[AppMenuEntry],
        _owner: Owner,
        _cx: &mut App,
    ) -> Result<(), Failure> {
        Err((
            ErrorCode::ServiceUnavailable,
            "OS context menus are not implemented on this target",
        ))
    }
    pub(crate) fn close(
        &self,
        _id: RequestId,
        _window: WindowId,
        _menu: ContextMenuId,
        _cx: &mut App,
    ) -> Result<(), Failure> {
        Err((
            ErrorCode::InvalidHandle,
            "context menu is not live for this window",
        ))
    }
    pub(crate) fn close_window(&self, _window: WindowId, _cx: &mut App) {}
    pub(crate) fn stop(&self, _cx: &mut App) -> Option<Task<()>> {
        None
    }
}
