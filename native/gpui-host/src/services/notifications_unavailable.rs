//! No desktop notification implementation is advertised on these targets.

use crate::channel::EventSink;
use bun_native_protocol::{ErrorCode, NotificationId, RequestId, WindowId};
use gpui::{App, Task};

type Failure = (ErrorCode, &'static str);

#[derive(Clone)]
pub(crate) struct Notifications;

impl Notifications {
    pub(crate) fn new(_events: EventSink, _cx: &App) -> Self {
        Self
    }
    pub(crate) fn available(&self) -> bool {
        false
    }
    pub(crate) fn post(
        &self,
        _request: (RequestId, WindowId, NotificationId),
        _title: String,
        _body: String,
        _cx: &mut App,
    ) -> Result<(), Failure> {
        Err((
            ErrorCode::ServiceUnavailable,
            "notifications are not implemented on this target",
        ))
    }
    pub(crate) fn withdraw(
        &self,
        _id: RequestId,
        _window: WindowId,
        _notification: NotificationId,
        _cx: &mut App,
    ) -> Result<(), Failure> {
        Err((
            ErrorCode::InvalidHandle,
            "notification is not live for this window",
        ))
    }
    pub(crate) fn close_window(&self, _window: WindowId, _cx: &mut App) {}
    pub(crate) fn stop(&self, _cx: &mut App) -> Option<Task<()>> {
        None
    }
}
