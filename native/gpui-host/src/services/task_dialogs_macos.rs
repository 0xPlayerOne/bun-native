//! Window-owned OS message dialogs on macOS through `NSAlert` sheets.
//!
//! A sheet runs no nested event loop, so everything happens on GPUI's main
//! thread: the sheet exists as soon as `show` returns, and AppKit reports the
//! pressed button from the run loop. The completion only queues a message;
//! the registry is read and changed by GPUI tasks, never inside AppKit's
//! callback. An entry that is closing, or whose owner closed, never produces
//! a result event.

use crate::channel::EventSink;
use crate::services::task_dialog_model::{self as model, AlertKey};
use bun_native_macos_surface::alert::{self, Alert, AlertButton, AlertEnd, AlertOwner, AlertSpec};
use bun_native_protocol::{
    DialogId, ErrorCode, Event, MAX_MESSAGE_DIALOGS, MessageDialogOptions, MessageDialogResult,
    RequestId, WindowId,
};
use bun_native_windows_services::task_dialog_spec::Pressed;
use gpui::{App, Task, Window};
use std::cell::{Cell, RefCell};
use std::collections::BTreeMap;
use std::rc::Rc;

type Failure = (ErrorCode, &'static str);

pub(crate) type Owner = Option<AlertOwner>;

enum State {
    Live,
    /// Ending. Holds the close request to answer once the sheet is gone.
    Closing(Option<RequestId>),
}

struct Entry {
    window: WindowId,
    alert: Alert,
    state: State,
}

struct Inner {
    entries: RefCell<BTreeMap<DialogId, Entry>>,
    last_dialog: Cell<u64>,
    stopping: Cell<bool>,
    events: EventSink,
}

#[derive(Clone)]
pub(crate) struct TaskDialogs(Rc<Inner>);

impl TaskDialogs {
    pub(crate) fn new(events: EventSink, _cx: &App) -> Self {
        Self(Rc::new(Inner {
            entries: RefCell::new(BTreeMap::new()),
            last_dialog: Cell::new(0),
            stopping: Cell::new(false),
            events,
        }))
    }

    /// AppKit always offers alert sheets.
    pub(crate) fn available(&self) -> bool {
        true
    }

    /// The window's `NSWindow`, or none when the view is not in one.
    pub(crate) fn owner(window: &Window) -> Owner {
        use raw_window_handle::HasWindowHandle;
        HasWindowHandle::window_handle(window)
            .ok()
            .and_then(|handle| alert::owner(handle).ok())
    }

    pub(crate) fn show(
        &self,
        request: (RequestId, WindowId, DialogId),
        options: MessageDialogOptions,
        owner: Owner,
        cx: &mut App,
    ) -> Result<(), Failure> {
        let (id, window, dialog) = request;
        let Some(owner) = owner else {
            return Err((ErrorCode::InvalidHandle, "native window has no handle"));
        };
        if dialog.get() <= self.0.last_dialog.get() {
            return Err((
                ErrorCode::InvalidHandle,
                "message dialog IDs must increase across the session",
            ));
        }
        {
            let entries = self.0.entries.borrow();
            if entries.values().any(|entry| entry.window == window) {
                return Err((
                    ErrorCode::LimitExceeded,
                    "this window already has an open message dialog",
                ));
            }
            if entries.len() >= MAX_MESSAGE_DIALOGS {
                return Err((
                    ErrorCode::LimitExceeded,
                    "live message dialog limit exceeded",
                ));
            }
        }
        if self.0.stopping.get() {
            return Err((
                ErrorCode::Cancelled,
                "message dialog service is shutting down",
            ));
        }
        let spec = AlertSpec {
            title: options.title.clone(),
            message: options.title.clone(),
            informative: Some(model::alert_informative(&options)),
            buttons: options
                .buttons
                .iter()
                .zip(model::alert_keys(&options))
                .map(|(button, key)| AlertButton {
                    title: button.label.clone(),
                    key: match key {
                        AlertKey::Return => alert::AlertKey::Return,
                        AlertKey::Escape => alert::AlertKey::Escape,
                        AlertKey::None => alert::AlertKey::None,
                    },
                })
                .collect(),
        };
        let (sender, receiver) = async_channel::bounded::<AlertEnd>(1);
        let shown = alert::show(&owner, &spec, move |end| {
            let _ = sender.try_send(end);
        })
        .map_err(|_| {
            (
                ErrorCode::NativeFailure,
                "the OS message dialog failed to open",
            )
        })?;
        self.0.last_dialog.set(dialog.get());
        self.0.entries.borrow_mut().insert(
            dialog,
            Entry {
                window,
                alert: shown,
                state: State::Live,
            },
        );
        self.0.events.send(
            Event::MessageDialogOpened {
                id,
                window_id: window,
                dialog_id: dialog,
            },
            cx,
        );
        let this = self.clone();
        cx.spawn(async move |cx| {
            // A sheet dropped without a completion counts as closed.
            let end = receiver.recv().await.unwrap_or(AlertEnd::Closed);
            cx.update(|cx| this.finished(dialog, window, &options, end, cx));
        })
        .detach();
        Ok(())
    }

    /// The sheet ended. What the application hears depends on who ended it.
    fn finished(
        &self,
        dialog: DialogId,
        window: WindowId,
        options: &MessageDialogOptions,
        end: AlertEnd,
        cx: &mut App,
    ) {
        let Some(entry) = self.0.entries.borrow_mut().remove(&dialog) else {
            return;
        };
        match entry.state {
            State::Live => {
                let result = match end {
                    AlertEnd::Button(index) => model::result(options, Pressed::Button(index)),
                    AlertEnd::Closed => MessageDialogResult::Failed {},
                };
                self.0.events.ui(
                    |sequence| Event::MessageDialogCompleted {
                        sequence,
                        window_id: window,
                        dialog_id: dialog,
                        result,
                    },
                    cx,
                );
            }
            // The application closed it; no completion follows.
            State::Closing(Some(id)) => self.0.events.send(
                Event::MessageDialogClosed {
                    id,
                    window_id: window,
                    dialog_id: dialog,
                },
                cx,
            ),
            State::Closing(None) => {}
        }
    }

    /// End a live sheet. It is answered once the sheet is gone, so the next
    /// dialog of the window never overlaps this one.
    pub(crate) fn close(
        &self,
        id: RequestId,
        window: WindowId,
        dialog: DialogId,
        _cx: &mut App,
    ) -> Result<(), Failure> {
        let mut entries = self.0.entries.borrow_mut();
        match entries.get_mut(&dialog) {
            Some(entry) if entry.window == window && matches!(entry.state, State::Live) => {
                entry.state = State::Closing(Some(id));
                // AppKit runs the completion now; it only queues a message.
                entry.alert.close();
                Ok(())
            }
            _ => Err((
                ErrorCode::InvalidHandle,
                "message dialog is not live for this window",
            )),
        }
    }

    /// Owner close revokes delivery now and ends the sheet.
    pub(crate) fn close_window(&self, window: WindowId, _cx: &mut App) {
        let mut entries = self.0.entries.borrow_mut();
        for entry in entries.values_mut().filter(|entry| entry.window == window) {
            // A pending close request is answered when the sheet ends.
            if !matches!(entry.state, State::Closing(Some(_))) {
                entry.state = State::Closing(None);
            }
            entry.alert.close();
        }
    }

    /// Revoke every dialog and end every sheet. Nothing runs on another
    /// thread, so there is nothing to wait for.
    pub(crate) fn stop(&self, _cx: &mut App) -> Option<Task<()>> {
        self.0.stopping.set(true);
        for entry in self.0.entries.borrow_mut().values_mut() {
            entry.state = State::Closing(None);
            entry.alert.close();
        }
        None
    }
}
