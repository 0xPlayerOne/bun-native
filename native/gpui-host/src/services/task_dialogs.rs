//! Window-owned OS message dialogs on Windows through `TaskDialogIndirect`.
//!
//! The call runs its own message loop until the dialog ends, so each dialog
//! gets a dedicated thread and GPUI's UI thread never enters it. The owner
//! window is the dialog's parent: the OS disables it while the dialog is
//! open. The UI thread owns the registry and decides delivery; an entry that
//! is closing, or whose owner closed, never produces a result event.

use crate::channel::EventSink;
use crate::services::task_dialog_model as model;
use bun_native_protocol::{
    DialogId, ErrorCode, Event, MAX_MESSAGE_DIALOGS, MessageDialogOptions, MessageDialogResult,
    RequestId, WindowId,
};
use bun_native_windows_services::task_dialog::{self, Control};
use bun_native_windows_services::task_dialog_spec::Pressed;
use gpui::{App, Task, Window};
use std::cell::{Cell, RefCell};
use std::collections::BTreeMap;
use std::io;
use std::rc::Rc;
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

type Failure = (ErrorCode, &'static str);

/// Shutdown waits this long for dialog threads to end, then lets the process
/// exit without them.
const DRAIN: Duration = Duration::from_secs(3);
const DRAIN_POLL: Duration = Duration::from_millis(5);

enum Message {
    Created,
    Finished(io::Result<Pressed>),
}

enum State {
    /// The thread started; the dialog does not exist yet. Holds the show request.
    Opening(RequestId),
    Live,
    /// Ending. Holds the close request to answer once the dialog is gone.
    Closing(Option<RequestId>),
}

struct Entry {
    window: WindowId,
    control: Arc<Control>,
    state: State,
}

struct Inner {
    entries: RefCell<BTreeMap<DialogId, Entry>>,
    threads: RefCell<Vec<JoinHandle<()>>>,
    last_dialog: Cell<u64>,
    stopping: Cell<bool>,
    events: EventSink,
    available: bool,
}

#[derive(Clone)]
pub(crate) struct TaskDialogs(Rc<Inner>);

impl TaskDialogs {
    pub(crate) fn new(events: EventSink, _cx: &App) -> Self {
        Self(Rc::new(Inner {
            entries: RefCell::new(BTreeMap::new()),
            threads: RefCell::new(Vec::new()),
            last_dialog: Cell::new(0),
            stopping: Cell::new(false),
            events,
            available: task_dialog::available(),
        }))
    }

    /// Common Controls 6 is active, so `TaskDialogIndirect` resolves.
    pub(crate) fn available(&self) -> bool {
        self.0.available
    }

    /// The window's `HWND`, or 0 when the window has none.
    pub(crate) fn owner(window: &Window) -> isize {
        use raw_window_handle::{HasWindowHandle, RawWindowHandle};
        match HasWindowHandle::window_handle(window).map(|handle| handle.as_raw()) {
            Ok(RawWindowHandle::Win32(handle)) => handle.hwnd.get(),
            _ => 0,
        }
    }

    pub(crate) fn show(
        &self,
        request: (RequestId, WindowId, DialogId),
        options: MessageDialogOptions,
        owner: isize,
        cx: &mut App,
    ) -> Result<(), Failure> {
        let (id, window, dialog) = request;
        if !self.available() {
            return Err((
                ErrorCode::ServiceUnavailable,
                "OS message dialogs require Common Controls 6",
            ));
        }
        if owner == 0 {
            return Err((ErrorCode::InvalidHandle, "native window has no handle"));
        }
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
        let spec = model::spec(&options);
        let control = Arc::new(Control::new());
        let (sender, receiver) = async_channel::unbounded::<Message>();
        let thread = std::thread::Builder::new()
            .name("bun-native-task-dialog".into())
            .spawn({
                let control = control.clone();
                move || {
                    let created = {
                        let sender = sender.clone();
                        move || drop(sender.try_send(Message::Created))
                    };
                    let result = task_dialog::show(owner, &spec, &control, created);
                    drop(sender.try_send(Message::Finished(result)));
                }
            })
            .map_err(|_| {
                (
                    ErrorCode::NativeFailure,
                    "could not start the message dialog thread",
                )
            })?;
        {
            let mut threads = self.0.threads.borrow_mut();
            threads.retain(|thread| !thread.is_finished());
            threads.push(thread);
        }
        self.0.last_dialog.set(dialog.get());
        self.0.entries.borrow_mut().insert(
            dialog,
            Entry {
                window,
                control,
                state: State::Opening(id),
            },
        );
        let this = self.clone();
        cx.spawn(async move |cx| {
            let mut next = receiver.recv().await;
            if matches!(next, Ok(Message::Created)) {
                cx.update(|cx| this.created(dialog, window, cx));
                next = receiver.recv().await;
            }
            // A thread that ended without a result reports a failure.
            let result = match next {
                Ok(Message::Finished(result)) => result,
                _ => Err(io::Error::other("the message dialog thread ended abruptly")),
            };
            cx.update(|cx| this.finished(dialog, window, &options, result, cx));
        })
        .detach();
        Ok(())
    }

    /// The dialog exists: answer the show request.
    fn created(&self, dialog: DialogId, window: WindowId, cx: &mut App) {
        let mut entries = self.0.entries.borrow_mut();
        let Some(entry) = entries.get_mut(&dialog) else {
            return;
        };
        if let State::Opening(id) = entry.state {
            entry.state = State::Live;
            drop(entries);
            self.0.events.send(
                Event::MessageDialogOpened {
                    id,
                    window_id: window,
                    dialog_id: dialog,
                },
                cx,
            );
        }
    }

    /// The dialog ended. What the application hears depends on who ended it.
    fn finished(
        &self,
        dialog: DialogId,
        window: WindowId,
        options: &MessageDialogOptions,
        result: io::Result<Pressed>,
        cx: &mut App,
    ) {
        let Some(entry) = self.0.entries.borrow_mut().remove(&dialog) else {
            return;
        };
        match entry.state {
            // Never shown: the call fails.
            State::Opening(id) => {
                let (code, message) = match &result {
                    Err(error) if error.kind() == io::ErrorKind::Unsupported => (
                        ErrorCode::ServiceUnavailable,
                        "OS message dialogs require Common Controls 6",
                    ),
                    _ => (
                        ErrorCode::NativeFailure,
                        "the OS message dialog failed to open",
                    ),
                };
                self.0.events.send(
                    Event::Error {
                        id: Some(id),
                        code,
                        message: message.into(),
                    },
                    cx,
                );
            }
            State::Live => {
                let result = match result {
                    Ok(pressed) => model::result(options, pressed),
                    Err(_) => MessageDialogResult::Failed {},
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

    /// End a live dialog. It is answered once the dialog is gone, so the next
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
            Some(entry) if entry.window == window => match entry.state {
                State::Opening(_) => Err((
                    ErrorCode::InvalidState,
                    "message dialog is still being shown",
                )),
                State::Closing(_) => Err((
                    ErrorCode::InvalidHandle,
                    "message dialog is not live for this window",
                )),
                State::Live => {
                    entry.state = State::Closing(Some(id));
                    entry.control.close();
                    Ok(())
                }
            },
            _ => Err((
                ErrorCode::InvalidHandle,
                "message dialog is not live for this window",
            )),
        }
    }

    /// Owner close revokes delivery now and ends the shown dialog.
    pub(crate) fn close_window(&self, window: WindowId, cx: &mut App) {
        let mut entries = self.0.entries.borrow_mut();
        for entry in entries.values_mut().filter(|entry| entry.window == window) {
            if let State::Opening(id) = entry.state {
                self.0.events.send(
                    Event::Error {
                        id: Some(id),
                        code: ErrorCode::InvalidHandle,
                        message: "message dialog owner window was closed".into(),
                    },
                    cx,
                );
            }
            // A pending close request is answered when the dialog ends.
            if !matches!(entry.state, State::Closing(Some(_))) {
                entry.state = State::Closing(None);
            }
            entry.control.close();
        }
    }

    /// Revoke every dialog, end the shown ones and wait, within the bound,
    /// for their threads.
    pub(crate) fn stop(&self, cx: &mut App) -> Option<Task<()>> {
        self.0.stopping.set(true);
        for entry in self.0.entries.borrow_mut().values_mut() {
            if let State::Opening(id) = entry.state {
                self.0.events.send(
                    Event::Error {
                        id: Some(id),
                        code: ErrorCode::Cancelled,
                        message: "message dialog cancelled during shutdown".into(),
                    },
                    cx,
                );
            }
            entry.state = State::Closing(None);
            entry.control.close();
        }
        if self.0.threads.borrow().is_empty() {
            return None;
        }
        let this = self.clone();
        Some(cx.spawn(async move |cx| {
            let deadline = Instant::now() + DRAIN;
            while Instant::now() < deadline
                && this
                    .0
                    .threads
                    .borrow()
                    .iter()
                    .any(|thread| !thread.is_finished())
            {
                cx.background_executor().timer(DRAIN_POLL).await;
            }
            this.0
                .threads
                .borrow_mut()
                .retain(|thread| !thread.is_finished());
        }))
    }
}
