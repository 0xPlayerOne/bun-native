//! Window-owned OS file dialogs through the xdg-desktop-portal
//! `org.freedesktop.portal.FileChooser` interface on the D-Bus session bus.
//!
//! GPUI's `prompt_for_paths`/`prompt_for_new_path` use the same portal, but
//! they cannot close a shown dialog, parent it to a chosen window, set a title
//! or filters, or bound the portal call. This module talks to the portal
//! directly so owner close, cancellation and shutdown can close the dialog.
//!
//! The UI thread owns the registry and decides delivery. Removing an entry
//! stops delivery at once, before the portal is asked to close the dialog, so
//! a response already queued for a closed dialog is never published. Only a
//! `Response` from the bus connection that answered the request is accepted.
//! Selected paths are returned as data and never become a filesystem grant.

use super::session_bus::{Failure, Link, Messages, SessionBus, sender, session_bus_configured};
use crate::channel::EventSink;
use bun_native_protocol::{
    DialogId, ErrorCode, Event, EventSequence, FileDialogFailure, FileDialogMode,
    FileDialogOptions, FileDialogResult, MAX_DIALOG_PATHS, MAX_FILE_DIALOGS, MAX_FRAME_BYTES,
    MAX_ID, RequestId, WindowId, validate_dialog_path,
};
use gpui::{App, AsyncApp, Task, Window};
use std::cell::{Cell, RefCell};
use std::collections::{BTreeMap, HashMap, VecDeque};
use std::ops::ControlFlow;
use std::rc::Rc;
use zbus::names::OwnedUniqueName;
use zbus::zvariant::{OwnedObjectPath, OwnedValue, Value};

const PORTAL: &str = "org.freedesktop.portal.Desktop";
const PORTAL_PATH: &str = "/org/freedesktop/portal/desktop";
const FILE_CHOOSER: &str = "org.freedesktop.portal.FileChooser";
const REQUEST: &str = "org.freedesktop.portal.Request";
/// Responses seen before the matching request reply was processed.
const MAX_EARLY_RESPONSES: usize = 16;

enum State {
    Opening(RequestId),
    Live {
        portal: OwnedUniqueName,
        handle: OwnedObjectPath,
    },
}

struct Entry {
    window: WindowId,
    mode: FileDialogMode,
    state: State,
}

struct Response {
    portal: OwnedUniqueName,
    handle: OwnedObjectPath,
    code: u32,
    uris: Option<Vec<String>>,
}

struct Inner {
    entries: RefCell<BTreeMap<DialogId, Entry>>,
    last_dialog: Cell<u64>,
    /// Every bus operation, including showing the dialog, is bounded. Waiting
    /// for the user is not: that is the dialog's purpose, and it is always
    /// closable.
    bus: SessionBus,
    early: RefCell<VecDeque<Response>>,
    stopping: Cell<bool>,
    events: EventSink,
    available: bool,
}

#[derive(Clone)]
pub(crate) struct FileDialogs(Rc<Inner>);

impl FileDialogs {
    pub(crate) fn new(events: EventSink, _cx: &App) -> Self {
        Self(Rc::new(Inner {
            entries: RefCell::new(BTreeMap::new()),
            last_dialog: Cell::new(0),
            bus: SessionBus::new(Messages {
                timed_out: "desktop portal did not answer within two seconds",
                subscribe_failed: "cannot subscribe to desktop portal responses",
            }),
            early: RefCell::new(VecDeque::new()),
            stopping: Cell::new(false),
            events,
            available: session_bus_configured(),
        }))
    }

    /// A session bus is configured. Whether a portal with a file chooser
    /// answers is only known when a dialog is shown, and is reported then.
    pub(crate) fn available(&self) -> bool {
        self.0.available
    }

    /// The portal's parent-window identifier. X11 windows are parented; other
    /// backends are shown unparented, which the portal permits.
    pub(crate) fn parent(window: &Window) -> String {
        use raw_window_handle::{HasWindowHandle, RawWindowHandle};
        match HasWindowHandle::window_handle(window).map(|handle| handle.as_raw()) {
            Ok(RawWindowHandle::Xcb(handle)) => format!("x11:{:x}", handle.window.get()),
            Ok(RawWindowHandle::Xlib(handle)) => format!("x11:{:x}", handle.window),
            _ => String::new(),
        }
    }

    pub(crate) fn show(
        &self,
        request: (RequestId, WindowId, DialogId),
        options: FileDialogOptions,
        parent: String,
        cx: &mut App,
    ) -> Result<(), Failure> {
        let (id, window, dialog) = request;
        if !self.available() {
            return Err((
                ErrorCode::ServiceUnavailable,
                "file dialogs require a D-Bus session bus",
            ));
        }
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
        let link = self.link(cx);
        self.0.last_dialog.set(dialog.get());
        self.0.entries.borrow_mut().insert(
            dialog,
            Entry {
                window,
                mode: options.mode,
                state: State::Opening(id),
            },
        );
        self.spawn(cx, async move |this, cx| {
            let result = this.bounded(cx, open(link, dialog, options, parent)).await;
            cx.update(|cx| this.opened(dialog, result, cx));
        });
        Ok(())
    }

    pub(crate) fn close(
        &self,
        id: RequestId,
        window: WindowId,
        dialog: DialogId,
        cx: &mut App,
    ) -> Result<(), Failure> {
        let (portal, handle) = match self.0.entries.borrow().get(&dialog) {
            Some(Entry {
                window: owner,
                state,
                ..
            }) if *owner == window => match state {
                State::Opening(_) => {
                    return Err((ErrorCode::InvalidState, "file dialog is still being shown"));
                }
                State::Live { portal, handle } => (portal.clone(), handle.clone()),
            },
            _ => {
                return Err((
                    ErrorCode::InvalidHandle,
                    "file dialog is not live for this window",
                ));
            }
        };
        self.0.entries.borrow_mut().remove(&dialog);
        let link = self.link(cx);
        self.spawn(cx, async move |this, cx| {
            let result = this.bounded(cx, close_request(link, portal, handle)).await;
            cx.update(|cx| {
                let event = match result {
                    Ok(()) => Event::FileDialogClosed {
                        id,
                        window_id: window,
                        dialog_id: dialog,
                    },
                    Err((code, message)) => Event::Error {
                        id: Some(id),
                        code,
                        message: message.into(),
                    },
                };
                this.0.events.send(event, cx);
            });
        });
        Ok(())
    }

    /// Owner close revokes delivery now and closes the shown dialog.
    pub(crate) fn close_window(&self, window: WindowId, cx: &mut App) {
        let owned: Vec<DialogId> = self
            .0
            .entries
            .borrow()
            .iter()
            .filter_map(|(id, entry)| (entry.window == window).then_some(*id))
            .collect();
        for dialog in owned {
            let Some(entry) = self.0.entries.borrow_mut().remove(&dialog) else {
                continue;
            };
            match entry.state {
                State::Opening(id) => self.0.events.send(
                    Event::Error {
                        id: Some(id),
                        code: ErrorCode::InvalidHandle,
                        message: "file dialog owner window was closed".into(),
                    },
                    cx,
                ),
                State::Live { portal, handle } => self.discard(portal, handle, cx),
            }
        }
    }

    /// Close a dialog nobody owns any more; shutdown waits for it.
    fn discard(&self, portal: OwnedUniqueName, handle: OwnedObjectPath, cx: &mut App) {
        let link = self.link(cx);
        self.spawn(cx, async move |this, cx| {
            let _ = this.bounded(cx, close_request(link, portal, handle)).await;
        });
    }

    fn spawn(&self, cx: &mut App, work: impl AsyncFnOnce(Self, &mut AsyncApp) + 'static) {
        self.0.bus.spawn(self.clone(), cx, work);
    }

    async fn bounded<T>(
        &self,
        cx: &mut AsyncApp,
        work: impl Future<Output = Result<T, Failure>>,
    ) -> Result<T, Failure> {
        self.0.bus.bounded(cx, work).await
    }

    fn link(&self, cx: &mut App) -> Link {
        let weak = Rc::downgrade(&self.0);
        self.0.bus.link(cx, response_rule, move |message, cx| {
            let Some(response) = parse_response(message) else {
                return ControlFlow::Continue(());
            };
            let Some(inner) = weak.upgrade() else {
                return ControlFlow::Break(());
            };
            cx.update(|cx| FileDialogs(inner).response(response, cx));
            ControlFlow::Continue(())
        })
    }

    fn opened(
        &self,
        dialog: DialogId,
        result: Result<(OwnedUniqueName, OwnedObjectPath), Failure>,
        cx: &mut App,
    ) {
        let mut entries = self.0.entries.borrow_mut();
        let pending = match entries.get_mut(&dialog) {
            Some(entry) => match entry.state {
                State::Opening(id) => Some((entry, id)),
                State::Live { .. } => None,
            },
            None => None,
        };
        let Some((entry, id)) = pending else {
            drop(entries);
            // The owner closed or the session stopped while the portal was
            // showing it: nothing owns the dialog, so close it.
            if let Ok((portal, handle)) = result {
                self.discard(portal, handle, cx);
            }
            return;
        };
        let (window, mode) = (entry.window, entry.mode);
        let (portal, handle) = match result {
            Ok(shown) => shown,
            Err((code, message)) => {
                entries.remove(&dialog);
                drop(entries);
                self.0.events.send(
                    Event::Error {
                        id: Some(id),
                        code,
                        message: message.into(),
                    },
                    cx,
                );
                return;
            }
        };
        let early = {
            let mut early = self.0.early.borrow_mut();
            early
                .iter()
                .position(|response| response.portal == portal && response.handle == handle)
                .and_then(|index| early.remove(index))
        };
        if early.is_some() {
            entries.remove(&dialog);
        } else {
            entry.state = State::Live { portal, handle };
        }
        drop(entries);
        self.0.events.send(
            Event::FileDialogOpened {
                id,
                window_id: window,
                dialog_id: dialog,
            },
            cx,
        );
        if let Some(response) = early {
            self.complete(window, dialog, completion(mode, response), cx);
        }
    }

    fn complete(&self, window: WindowId, dialog: DialogId, result: FileDialogResult, cx: &mut App) {
        let result = fit_frame(window, dialog, result);
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

    fn response(&self, response: Response, cx: &mut App) {
        let found = self
            .0
            .entries
            .borrow()
            .iter()
            .find_map(|(id, entry)| match &entry.state {
                State::Live { portal, handle }
                    if *portal == response.portal && *handle == response.handle =>
                {
                    Some((*id, entry.window, entry.mode))
                }
                _ => None,
            });
        match found {
            Some((dialog, window, mode)) => {
                self.0.entries.borrow_mut().remove(&dialog);
                self.complete(window, dialog, completion(mode, response), cx);
            }
            None => {
                let opening = self
                    .0
                    .entries
                    .borrow()
                    .values()
                    .any(|entry| matches!(entry.state, State::Opening(_)));
                if opening {
                    let mut early = self.0.early.borrow_mut();
                    if early.len() == MAX_EARLY_RESPONSES {
                        early.pop_front();
                    }
                    early.push_back(response);
                }
            }
        }
    }

    /// Revoke every dialog, close the shown ones and wait, within the bound,
    /// for every outstanding bus operation.
    pub(crate) fn stop(&self, cx: &mut App) -> Option<Task<()>> {
        self.0.stopping.set(true);
        let entries = std::mem::take(&mut *self.0.entries.borrow_mut());
        for entry in entries.into_values() {
            match entry.state {
                State::Opening(id) => self.0.events.send(
                    Event::Error {
                        id: Some(id),
                        code: ErrorCode::Cancelled,
                        message: "file dialog cancelled during shutdown".into(),
                    },
                    cx,
                ),
                State::Live { portal, handle } => self.discard(portal, handle, cx),
            }
        }
        self.0.bus.drain(cx)
    }
}

/// Map a portal response to a result. A partial selection is never returned.
fn completion(mode: FileDialogMode, response: Response) -> FileDialogResult {
    let failed = |code| FileDialogResult::Failed { code };
    match response.code {
        0 => {
            let Some(uris) = response.uris else {
                return failed(FileDialogFailure::NativeFailure);
            };
            if uris.len() > MAX_DIALOG_PATHS {
                return failed(FileDialogFailure::PayloadTooLarge);
            }
            if uris.is_empty() || (mode.single() && uris.len() != 1) {
                return failed(FileDialogFailure::NativeFailure);
            }
            let paths: Option<Vec<String>> = uris.iter().map(|uri| file_uri_path(uri)).collect();
            match paths {
                Some(paths) => FileDialogResult::Selected { paths },
                None => failed(FileDialogFailure::NativeFailure),
            }
        }
        // 1: the user cancelled. 2: the interaction ended another way, such
        // as Escape or the window manager's close button (GTK reports both
        // as a deleted dialog). Neither carries a selection.
        1 | 2 => FileDialogResult::Cancelled {},
        _ => failed(FileDialogFailure::NativeFailure),
    }
}

/// A result whose event would exceed one frame is reported, not truncated.
fn fit_frame(window: WindowId, dialog: DialogId, result: FileDialogResult) -> FileDialogResult {
    let Ok(sequence) = EventSequence::try_from(MAX_ID) else {
        return result;
    };
    let event = Event::FileDialogCompleted {
        sequence,
        window_id: window,
        dialog_id: dialog,
        result,
    };
    let fits = serde_json::to_vec(&event).is_ok_and(|bytes| bytes.len() <= MAX_FRAME_BYTES);
    let Event::FileDialogCompleted { result, .. } = event else {
        unreachable!("constructed above")
    };
    if fits {
        result
    } else {
        FileDialogResult::Failed {
            code: FileDialogFailure::PayloadTooLarge,
        }
    }
}

/// Decode a local `file://` URI to an absolute UTF-8 path. Remote hosts,
/// queries, fragments, NUL bytes and non-UTF-8 names are not representable.
fn file_uri_path(uri: &str) -> Option<String> {
    let rest = uri.strip_prefix("file://")?;
    let rest = rest.strip_prefix("localhost").unwrap_or(rest);
    if !rest.starts_with('/') || rest.contains(['?', '#']) {
        return None;
    }
    let bytes = rest.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let hex = bytes.get(index + 1..index + 3)?;
            let value = u8::from_str_radix(std::str::from_utf8(hex).ok()?, 16).ok()?;
            decoded.push(value);
            index += 3;
        } else {
            decoded.push(bytes[index]);
            index += 1;
        }
    }
    let path = String::from_utf8(decoded).ok()?;
    validate_dialog_path(&path).ok()?;
    Some(path)
}

fn bus_failure(error: &zbus::Error) -> Failure {
    match error {
        zbus::Error::MethodError(name, _, _)
            if matches!(
                name.as_str(),
                "org.freedesktop.DBus.Error.ServiceUnknown"
                    | "org.freedesktop.DBus.Error.NameHasNoOwner"
            ) =>
        {
            (
                ErrorCode::ServiceUnavailable,
                "no xdg-desktop-portal is running on the session bus",
            )
        }
        zbus::Error::MethodError(name, _, _)
            if matches!(
                name.as_str(),
                "org.freedesktop.DBus.Error.UnknownMethod"
                    | "org.freedesktop.DBus.Error.UnknownInterface"
                    | "org.freedesktop.DBus.Error.UnknownObject"
            ) =>
        {
            (
                ErrorCode::ServiceUnavailable,
                "the desktop portal has no file chooser backend",
            )
        }
        _ => (ErrorCode::NativeFailure, "desktop portal request failed"),
    }
}

fn response_rule() -> zbus::Result<zbus::MatchRule<'static>> {
    Ok(zbus::MatchRule::builder()
        .msg_type(zbus::message::Type::Signal)
        .interface(REQUEST)?
        .member("Response")?
        .build())
}

fn parse_response(message: &zbus::Message) -> Option<Response> {
    let portal = sender(message)?;
    let handle = OwnedObjectPath::from(message.header().path()?.to_owned());
    let (code, results): (u32, HashMap<String, OwnedValue>) = message.body().deserialize().ok()?;
    let uris = match results.get("uris") {
        Some(value) => Some(Vec::<String>::try_from(value.try_clone().ok()?).ok()?),
        None => None,
    };
    Some(Response {
        portal,
        handle,
        code,
        uris,
    })
}

/// The handle the portal will use, so a response can never precede our
/// knowledge of it. Older portals may return a different path; that is used.
fn token(dialog: DialogId) -> String {
    format!("bun_native_{}", dialog.get())
}

async fn open(
    link: Link,
    dialog: DialogId,
    options: FileDialogOptions,
    parent: String,
) -> Result<(OwnedUniqueName, OwnedObjectPath), Failure> {
    let connection = link.await?;
    let mut portal_options: HashMap<&str, Value<'_>> = HashMap::new();
    portal_options.insert("handle_token", Value::from(token(dialog)));
    portal_options.insert("modal", Value::from(true));
    if let Some(label) = options.accept_label {
        portal_options.insert("accept_label", Value::from(label));
    }
    if let Some(folder) = options.folder {
        // The portal takes a NUL-terminated byte string.
        let mut bytes = folder.into_bytes();
        bytes.push(0);
        portal_options.insert("current_folder", Value::from(bytes));
    }
    if !options.filters.is_empty() {
        let filters: Vec<(String, Vec<(u32, String)>)> = options
            .filters
            .into_iter()
            .map(|filter| {
                let patterns = filter
                    .patterns
                    .into_iter()
                    .map(|pattern| (0_u32, pattern))
                    .collect();
                (filter.name, patterns)
            })
            .collect();
        portal_options.insert("filters", Value::from(filters));
    }
    let method = match options.mode {
        FileDialogMode::SaveFile => {
            if let Some(name) = options.name {
                portal_options.insert("current_name", Value::from(name));
            }
            "SaveFile"
        }
        mode => {
            portal_options.insert("multiple", Value::from(mode == FileDialogMode::OpenFiles));
            portal_options.insert(
                "directory",
                Value::from(mode == FileDialogMode::OpenDirectory),
            );
            "OpenFile"
        }
    };
    let reply = connection
        .call_method(
            Some(PORTAL),
            PORTAL_PATH,
            Some(FILE_CHOOSER),
            method,
            &(parent.as_str(), options.title.as_str(), portal_options),
        )
        .await
        .map_err(|error| bus_failure(&error))?;
    let header = reply.header();
    let portal = OwnedUniqueName::from(
        header
            .sender()
            .ok_or((
                ErrorCode::NativeFailure,
                "desktop portal reply has no sender",
            ))?
            .to_owned(),
    );
    let handle: OwnedObjectPath = reply.body().deserialize().map_err(|_| {
        (
            ErrorCode::NativeFailure,
            "desktop portal returned a malformed request handle",
        )
    })?;
    Ok((portal, handle))
}

async fn close_request(
    link: Link,
    portal: OwnedUniqueName,
    handle: OwnedObjectPath,
) -> Result<(), Failure> {
    let connection = link.await?;
    match connection
        .call_method(
            Some(portal.as_str()),
            handle.as_str(),
            Some(REQUEST),
            "Close",
            &(),
        )
        .await
    {
        // A request that already ended answers with an error reply; either
        // way the portal no longer shows the dialog.
        Ok(_) | Err(zbus::Error::MethodError(..)) => Ok(()),
        Err(_) => Err((ErrorCode::NativeFailure, "cannot close the file dialog")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn response(code: u32, uris: Option<&[&str]>) -> Response {
        Response {
            portal: OwnedUniqueName::try_from(":1.2").unwrap(),
            handle: OwnedObjectPath::try_from("/a").unwrap(),
            code,
            uris: uris.map(|uris| uris.iter().map(|uri| uri.to_string()).collect()),
        }
    }

    #[test]
    fn local_file_uris_decode_to_absolute_utf8_paths_only() {
        assert_eq!(file_uri_path("file:///tmp/a.txt").unwrap(), "/tmp/a.txt");
        assert_eq!(
            file_uri_path("file://localhost/tmp/a%20b/%C3%BC.txt").unwrap(),
            "/tmp/a b/ü.txt"
        );
        assert_eq!(file_uri_path("file:///tmp/100%25").unwrap(), "/tmp/100%");
        for uri in [
            "file://server/share/a",
            "https://example.com/a",
            "file://",
            "file:///a%00b",
            "file:///a%FF",
            "file:///a%2",
            "file:///a%zz",
            "file:///a?b",
            "file:///a#b",
            "/tmp/a",
        ] {
            assert!(file_uri_path(uri).is_none(), "{uri}");
        }
    }

    #[test]
    fn responses_map_to_complete_results_without_partial_selections() {
        assert_eq!(
            completion(
                FileDialogMode::OpenFiles,
                response(0, Some(&["file:///a", "file:///b"]))
            ),
            FileDialogResult::Selected {
                paths: vec!["/a".into(), "/b".into()]
            }
        );
        for code in [1, 2] {
            assert_eq!(
                completion(FileDialogMode::SaveFile, response(code, None)),
                FileDialogResult::Cancelled {}
            );
        }
        let native = FileDialogResult::Failed {
            code: FileDialogFailure::NativeFailure,
        };
        for (mode, value) in [
            (FileDialogMode::OpenFile, response(3, None)),
            (FileDialogMode::OpenFile, response(0, None)),
            (FileDialogMode::OpenFile, response(0, Some(&[]))),
            (
                FileDialogMode::OpenFile,
                response(0, Some(&["file:///a", "file:///b"])),
            ),
            (
                FileDialogMode::OpenFiles,
                response(0, Some(&["file:///a", "https://x/b"])),
            ),
        ] {
            assert_eq!(completion(mode, value), native);
        }
        let many: Vec<&str> = vec!["file:///a"; MAX_DIALOG_PATHS + 1];
        assert_eq!(
            completion(FileDialogMode::OpenFiles, response(0, Some(&many))),
            FileDialogResult::Failed {
                code: FileDialogFailure::PayloadTooLarge
            }
        );
    }

    #[test]
    fn a_selection_that_cannot_fit_one_frame_is_reported_as_too_large() {
        let window = WindowId::try_from(1).unwrap();
        let dialog = DialogId::try_from(1).unwrap();
        let fits = FileDialogResult::Selected {
            paths: vec!["/a".into(); MAX_DIALOG_PATHS],
        };
        assert_eq!(fit_frame(window, dialog, fits.clone()), fits);
        let large = FileDialogResult::Selected {
            paths: vec![format!("/{}", "\u{1}".repeat(2_000)); 8],
        };
        assert_eq!(
            fit_frame(window, dialog, large),
            FileDialogResult::Failed {
                code: FileDialogFailure::PayloadTooLarge
            }
        );
    }
}
