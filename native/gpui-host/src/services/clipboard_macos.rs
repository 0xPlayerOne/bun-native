//! Window-scoped, explicitly granted plain text on the macOS general
//! pasteboard.
//!
//! AppKit's pasteboard is a local server, so there is no worker: each request
//! is queued on GPUI's main thread and runs after the command that submitted
//! it returns. Closing the owner or shutting down before it runs revokes it,
//! and no result is published for a revoked request. Only the plain-text
//! flavor is read or written; a write replaces every other flavor.

use crate::channel::EventSink;
use bun_native_macos_surface::pasteboard;
use bun_native_protocol::{
    ClipboardText, ErrorCode, Event, MAX_CLIPBOARD_BYTES, MAX_SERVICE_REQUESTS, RequestId, WindowId,
};
use gpui::{App, Task, Window};
use std::cell::{Cell, RefCell};
use std::collections::BTreeMap;
use std::rc::Rc;

type Failure = (ErrorCode, &'static str);

pub(crate) enum Operation {
    Read,
    Write(String),
}

struct Inner {
    pending: RefCell<BTreeMap<RequestId, WindowId>>,
    stopping: Cell<bool>,
    events: EventSink,
}

#[derive(Clone)]
pub(crate) struct Clipboard(Rc<Inner>);

impl Clipboard {
    pub(crate) fn new(events: EventSink, _cx: &App) -> Self {
        Self(Rc::new(Inner {
            pending: RefCell::new(BTreeMap::new()),
            stopping: Cell::new(false),
            events,
        }))
    }

    /// AppKit always offers the general pasteboard.
    pub(crate) fn available(&self) -> bool {
        true
    }

    pub(crate) fn supports_window(window: &Window) -> bool {
        use raw_window_handle::{HasWindowHandle, RawWindowHandle};
        matches!(
            HasWindowHandle::window_handle(window).map(|handle| handle.as_raw()),
            Ok(RawWindowHandle::AppKit(_))
        )
    }

    pub(crate) fn submit(
        &self,
        id: RequestId,
        window: WindowId,
        operation: Operation,
        cx: &mut App,
    ) -> Result<(), Failure> {
        check_submit(self.0.pending.borrow().len(), self.0.stopping.get())?;
        if let Operation::Write(text) = &operation {
            // The wire parser already bounds the text; this keeps the
            // pasteboard write independent of that check.
            bun_native_protocol::validate_clipboard_text(text)
                .map_err(|_| (ErrorCode::PayloadTooLarge, "invalid clipboard text payload"))?;
        }
        self.0.pending.borrow_mut().insert(id, window);
        let this = self.clone();
        cx.defer(move |cx| this.run(id, operation, cx));
        Ok(())
    }

    fn run(&self, id: RequestId, operation: Operation, cx: &mut App) {
        // Revoked by owner close or shutdown before it ran: no OS access.
        let Some(window) = self.0.pending.borrow_mut().remove(&id) else {
            return;
        };
        let event = match operation {
            Operation::Read => match pasteboard::read_text() {
                Ok(text) => match read_result(text) {
                    Ok(result) => Event::ClipboardText {
                        id,
                        window_id: window,
                        result,
                    },
                    Err(failure) => error(id, failure),
                },
                Err(_) => error(
                    id,
                    (ErrorCode::NativeFailure, "the pasteboard could not be read"),
                ),
            },
            Operation::Write(text) => match pasteboard::write_text(&text) {
                Ok(()) => Event::ClipboardWritten {
                    id,
                    window_id: window,
                },
                Err(_) => error(
                    id,
                    (ErrorCode::NativeFailure, "the pasteboard refused the write"),
                ),
            },
        };
        self.0.events.send(event, cx);
    }

    pub(crate) fn cancel(
        &self,
        window: Option<WindowId>,
        code: ErrorCode,
        message: &'static str,
        cx: &mut App,
    ) {
        self.0.pending.borrow_mut().retain(|id, owner| {
            if window.is_some_and(|window| window != *owner) {
                return true;
            }
            self.0.events.send(error(*id, (code, message)), cx);
            false
        });
    }

    /// Revoke every queued request. Nothing runs on another thread.
    pub(crate) fn stop(&self, cx: &mut App) -> Option<Task<()>> {
        self.0.stopping.set(true);
        self.cancel(
            None,
            ErrorCode::Cancelled,
            "native clipboard request cancelled during shutdown",
            cx,
        );
        None
    }
}

fn error(id: RequestId, (code, message): Failure) -> Event {
    Event::Error {
        id: Some(id),
        code,
        message: message.into(),
    }
}

/// The capacity checks for a new request, in reply order.
fn check_submit(pending: usize, stopping: bool) -> Result<(), Failure> {
    if pending >= MAX_SERVICE_REQUESTS {
        return Err((
            ErrorCode::LimitExceeded,
            "native service request limit exceeded",
        ));
    }
    if stopping {
        return Err((
            ErrorCode::Cancelled,
            "native clipboard service is shutting down",
        ));
    }
    Ok(())
}

/// The protocol result for the pasteboard's plain text. Oversized text is
/// refused rather than truncated, as on X11.
fn read_result(text: Option<String>) -> Result<ClipboardText, Failure> {
    let Some(text) = text else {
        return Ok(ClipboardText::Empty {});
    };
    if text.len() > MAX_CLIPBOARD_BYTES {
        return Err((
            ErrorCode::PayloadTooLarge,
            "clipboard text exceeds 8192 UTF-8 bytes",
        ));
    }
    if text.contains('\0') {
        return Err((ErrorCode::NativeFailure, "clipboard text contains NUL"));
    }
    Ok(ClipboardText::Text { text })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn submit_checks_capacity_then_shutdown() {
        assert_eq!(check_submit(0, false), Ok(()));
        assert_eq!(check_submit(MAX_SERVICE_REQUESTS - 1, false), Ok(()));
        assert_eq!(
            check_submit(MAX_SERVICE_REQUESTS, true),
            Err((
                ErrorCode::LimitExceeded,
                "native service request limit exceeded"
            ))
        );
        assert_eq!(
            check_submit(0, true),
            Err((
                ErrorCode::Cancelled,
                "native clipboard service is shutting down"
            ))
        );
    }

    #[test]
    fn pasteboard_text_maps_to_bounded_protocol_text() {
        assert_eq!(read_result(None), Ok(ClipboardText::Empty {}));
        // An empty plain-text flavor is text, not an empty pasteboard.
        assert_eq!(
            read_result(Some(String::new())),
            Ok(ClipboardText::Text {
                text: String::new()
            })
        );
        let limit = "é".repeat(MAX_CLIPBOARD_BYTES / 2);
        assert_eq!(
            read_result(Some(limit.clone())),
            Ok(ClipboardText::Text { text: limit })
        );
        assert_eq!(
            read_result(Some("x".repeat(MAX_CLIPBOARD_BYTES + 1)))
                .unwrap_err()
                .0,
            ErrorCode::PayloadTooLarge
        );
        assert_eq!(
            read_result(Some("a\0b".into())).unwrap_err().0,
            ErrorCode::NativeFailure
        );
    }
}
