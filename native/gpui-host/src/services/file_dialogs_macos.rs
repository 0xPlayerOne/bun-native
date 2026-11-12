//! Window-owned OS file dialogs on macOS through `NSOpenPanel` and
//! `NSSavePanel` sheets.
//!
//! As with alert sheets, nothing runs on another thread: the sheet exists as
//! soon as `show` returns, and AppKit reports the outcome from the run loop.
//! The completion only queues a message; the registry is read and changed by
//! GPUI tasks, never inside AppKit's callback. An entry that is closing, or
//! whose owner closed, never produces a result event. Selected paths are
//! returned as data and never become a filesystem grant.

use crate::channel::EventSink;
use crate::services::file_panel_model as model;
use bun_native_macos_surface::alert::{self, AlertOwner};
use bun_native_macos_surface::file_panel::{self, Panel, PanelEnd, PanelMode, PanelSpec};
use bun_native_protocol::{
    DialogId, ErrorCode, Event, FileDialogFailure, FileDialogMode, FileDialogOptions,
    FileDialogResult, MAX_FILE_DIALOGS, RequestId, WindowId,
};
use gpui::{App, Task, Window};
use std::cell::{Cell, RefCell};
use std::collections::BTreeMap;
use std::rc::Rc;

type Failure = (ErrorCode, &'static str);

enum State {
    Live,
    /// Ending. Holds the close request to answer once the sheet is gone.
    Closing(Option<RequestId>),
}

struct Entry {
    window: WindowId,
    panel: Panel,
    state: State,
}

struct Inner {
    entries: RefCell<BTreeMap<DialogId, Entry>>,
    last_dialog: Cell<u64>,
    stopping: Cell<bool>,
    events: EventSink,
}

#[derive(Clone)]
pub(crate) struct FileDialogs(Rc<Inner>);

impl FileDialogs {
    pub(crate) fn new(events: EventSink, _cx: &App) -> Self {
        Self(Rc::new(Inner {
            entries: RefCell::new(BTreeMap::new()),
            last_dialog: Cell::new(0),
            stopping: Cell::new(false),
            events,
        }))
    }

    /// AppKit always offers open and save panels.
    pub(crate) fn available(&self) -> bool {
        true
    }

    /// The window's `NSWindow`, or none when the view is not in one.
    pub(crate) fn parent(window: &Window) -> Option<AlertOwner> {
        use raw_window_handle::HasWindowHandle;
        HasWindowHandle::window_handle(window)
            .ok()
            .and_then(|handle| alert::owner(handle).ok())
    }

    pub(crate) fn show(
        &self,
        request: (RequestId, WindowId, DialogId),
        options: FileDialogOptions,
        parent: Option<AlertOwner>,
        cx: &mut App,
    ) -> Result<(), Failure> {
        let (id, window, dialog) = request;
        let Some(owner) = parent else {
            return Err((ErrorCode::InvalidHandle, "native window has no handle"));
        };
        if dialog.get() <= self.0.last_dialog.get() {
            return Err((
                ErrorCode::InvalidHandle,
                "file dialog IDs must increase across the session",
            ));
        }
        {
            let entries = self.0.entries.borrow();
            if entries.values().any(|entry| entry.window == window) {
                return Err((
                    ErrorCode::LimitExceeded,
                    "this window already has an open file dialog",
                ));
            }
            if entries.len() >= MAX_FILE_DIALOGS {
                return Err((ErrorCode::LimitExceeded, "live file dialog limit exceeded"));
            }
        }
        if self.0.stopping.get() {
            return Err((ErrorCode::Cancelled, "file dialog service is shutting down"));
        }
        let mode = options.mode;
        let spec = PanelSpec {
            mode: match mode {
                FileDialogMode::OpenFile => PanelMode::OpenFile,
                FileDialogMode::OpenFiles => PanelMode::OpenFiles,
                FileDialogMode::OpenDirectory => PanelMode::OpenDirectory,
                FileDialogMode::SaveFile => PanelMode::Save,
            },
            extensions: model::extensions(&options.filters)?,
            title: options.title,
            prompt: options.accept_label,
            folder: options.folder,
            name: options.name,
        };
        let (sender, receiver) = async_channel::bounded::<PanelEnd>(1);
        let panel = file_panel::show(&owner, &spec, move |end| {
            let _ = sender.try_send(end);
        })
        .map_err(|_| {
            (
                ErrorCode::NativeFailure,
                "the OS file dialog failed to open",
            )
        })?;
        self.0.last_dialog.set(dialog.get());
        self.0.entries.borrow_mut().insert(
            dialog,
            Entry {
                window,
                panel,
                state: State::Live,
            },
        );
        self.0.events.send(
            Event::FileDialogOpened {
                id,
                window_id: window,
                dialog_id: dialog,
            },
            cx,
        );
        let this = self.clone();
        cx.spawn(async move |cx| {
            // A sheet dropped without a completion counts as closed.
            let end = receiver.recv().await.unwrap_or(PanelEnd::Closed);
            cx.update(|cx| this.finished(dialog, mode, end, cx));
        })
        .detach();
        Ok(())
    }

    /// The sheet ended. What the application hears depends on who ended it.
    fn finished(&self, dialog: DialogId, mode: FileDialogMode, end: PanelEnd, cx: &mut App) {
        let Some(entry) = self.0.entries.borrow_mut().remove(&dialog) else {
            return;
        };
        let window = entry.window;
        match entry.state {
            State::Live => {
                let result = match end {
                    PanelEnd::Selected(paths) => {
                        model::fit_frame(window, dialog, model::selected(mode, paths))
                    }
                    PanelEnd::Cancelled => FileDialogResult::Cancelled {},
                    PanelEnd::Closed => FileDialogResult::Failed {
                        code: FileDialogFailure::NativeFailure,
                    },
                };
                self.0.events.ui(
                    |sequence| Event::FileDialogCompleted {
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
                Event::FileDialogClosed {
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
                entry.panel.close();
                Ok(())
            }
            _ => Err((
                ErrorCode::InvalidHandle,
                "file dialog is not live for this window",
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
            entry.panel.close();
        }
    }

    /// Revoke every dialog and end every sheet. Nothing runs on another
    /// thread, so there is nothing to wait for.
    pub(crate) fn stop(&self, _cx: &mut App) -> Option<Task<()>> {
        self.0.stopping.set(true);
        for entry in self.0.entries.borrow_mut().values_mut() {
            entry.state = State::Closing(None);
            entry.panel.close();
        }
        None
    }
}
