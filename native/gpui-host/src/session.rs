use crate::{
    channel::EventSink,
    evidence::Evidence,
    services,
    services::clipboard::{Clipboard, Operation as ClipboardOperation},
    services::files::Files,
    services::notifications::Notifications,
    services::processes::{Change, Processes, Spawn},
    services::shortcuts::Shortcuts,
    state::{SharedWindowState, WindowState},
    view::NativeView,
};
use bun_native_protocol::{
    Capability, Command, ErrorCode, Event, FileAccess, FileGrantId, FileOperation, Limits,
    MAX_WINDOWS, NodeId, NotificationId, Operation, PROTOCOL_VERSION, ProcessId, ProcessLaunch,
    RequestId, ServicePolicy, ShortcutId, ShortcutModifiers, Tree, WindowId,
};
use gpui::{
    App, Bounds, TitlebarOptions, WindowBounds, WindowHandle, WindowOptions, prelude::*, px, size,
};
use std::cell::{Cell, RefCell};
use std::collections::BTreeMap;
use std::rc::Rc;

struct WindowEntry {
    handle: WindowHandle<NativeView>,
    state: SharedWindowState,
}

struct OpenWindow {
    id: RequestId,
    window_id: WindowId,
    root_id: NodeId,
    title: String,
    width: f64,
    height: f64,
}

pub(crate) struct Session {
    greeted: bool,
    last_request_id: u64,
    last_window_id: u64,
    last_node_id: u64,
    windows: Rc<RefCell<BTreeMap<WindowId, WindowEntry>>>,
    finishing: Rc<Cell<bool>>,
    events: EventSink,
    evidence: Evidence,
    policy: ServicePolicy,
    clipboard: Clipboard,
    shortcuts: Shortcuts,
    notifications: Notifications,
    files: Files,
    processes: Processes,
}

impl Session {
    pub(crate) fn new(
        events: EventSink,
        evidence: Evidence,
        policy: ServicePolicy,
        cx: &mut App,
    ) -> Self {
        let windows = Rc::new(RefCell::new(BTreeMap::<WindowId, WindowEntry>::new()));
        let finishing = Rc::new(Cell::new(false));
        let clipboard = Clipboard::new(events.clone(), cx);
        let shortcuts = Shortcuts::new(events.clone(), cx);
        evidence.observe_keys(cx);
        let notifications = Notifications::new(events.clone(), cx);
        let files = Files::new(events.clone(), policy.filesystem_roots.clone(), cx);
        let processes = Processes::new(events.clone(), policy.processes.clone(), cx);
        cx.on_window_closed({
            let windows = windows.clone();
            let finishing = finishing.clone();
            let events = events.clone();
            let evidence = evidence.clone();
            let clipboard = clipboard.clone();
            let shortcuts = shortcuts.clone();
            let notifications = notifications.clone();
            let files = files.clone();
            let processes = processes.clone();
            move |cx, closed| {
                let id = windows
                    .borrow()
                    .iter()
                    .find_map(|(id, entry)| (entry.handle.window_id() == closed).then_some(*id));
                if let Some(window_id) = id {
                    if let Some(entry) = windows.borrow_mut().remove(&window_id) {
                        entry.state.borrow_mut().active = false;
                    }
                    evidence.closed(window_id);
                    clipboard.cancel(
                        Some(window_id),
                        ErrorCode::InvalidHandle,
                        "clipboard owner window was closed",
                        cx,
                    );
                    shortcuts.close_window(window_id, cx);
                    notifications.close_window(window_id, cx);
                    files.close_window(window_id, cx);
                    processes.close_window(window_id, cx);
                    if !finishing.get() {
                        events.ui(
                            |sequence| Event::Closed {
                                sequence,
                                window_id,
                            },
                            cx,
                        );
                    }
                }
            }
        })
        .detach();
        Self {
            greeted: false,
            last_request_id: 0,
            last_window_id: 0,
            last_node_id: 0,
            windows,
            finishing,
            events,
            evidence,
            policy,
            clipboard,
            shortcuts,
            notifications,
            files,
            processes,
        }
    }

    pub(crate) fn finishing(&self) -> bool {
        self.finishing.get()
    }

    fn error(&self, id: RequestId, code: ErrorCode, message: &str, cx: &mut App) {
        self.events.send(
            Event::Error {
                id: Some(id),
                code,
                message: message.into(),
            },
            cx,
        );
    }

    pub(crate) fn dispatch(&mut self, command: Command, cx: &mut App) {
        let id = command.id();
        if id.get() <= self.last_request_id {
            self.error(
                id,
                ErrorCode::InvalidCommand,
                "request IDs must increase across the session",
                cx,
            );
            return;
        }
        self.last_request_id = id.get();
        if let Command::Hello { protocol, .. } = command {
            if self.greeted {
                self.error(
                    id,
                    ErrorCode::InvalidState,
                    "hello has already completed",
                    cx,
                );
            } else if protocol != PROTOCOL_VERSION {
                self.error(
                    id,
                    ErrorCode::VersionMismatch,
                    "unsupported protocol version",
                    cx,
                );
            } else {
                self.greeted = true;
                let mut capabilities = vec![
                    Capability::Tree,
                    Capability::InputRevisions,
                    Capability::LayoutV1,
                    Capability::InteractionsV1,
                    Capability::WindowDisplayV1,
                ];
                if self.clipboard.available() {
                    capabilities.push(Capability::ClipboardTextV1);
                }
                if self.shortcuts.available() {
                    capabilities.push(Capability::GlobalShortcutsV1);
                }
                if self.notifications.available() {
                    capabilities.push(Capability::NotificationsV1);
                }
                if self.files.available() {
                    capabilities.push(Capability::FilesystemGrantsV1);
                }
                if self.processes.available() {
                    capabilities.push(Capability::ProcessesV1);
                }
                self.events.send(
                    Event::Ready {
                        protocol: PROTOCOL_VERSION,
                        capabilities,
                        limits: Limits::default(),
                        service_policy: self.policy.clone(),
                    },
                    cx,
                );
                self.events.send(Event::Ack { id }, cx);
            }
            return;
        }
        if !self.greeted {
            self.error(
                id,
                ErrorCode::InvalidState,
                "hello is required before native commands",
                cx,
            );
            return;
        }
        match command {
            Command::Open {
                window_id,
                root_id,
                title,
                width,
                height,
                ..
            } => self.open(
                OpenWindow {
                    id,
                    window_id,
                    root_id,
                    title,
                    width,
                    height,
                },
                cx,
            ),
            Command::Batch {
                window_id,
                base_revision,
                operations,
                ..
            } => self.batch(id, window_id, base_revision, operations, cx),
            Command::Close { window_id, .. } => self.close(id, window_id, cx),
            Command::DisplaySnapshot { window_id, .. } => self.display_snapshot(id, window_id, cx),
            Command::ClipboardRead { window_id, .. } => {
                self.clipboard_request(id, window_id, ClipboardOperation::Read, cx)
            }
            Command::ClipboardWrite {
                window_id, text, ..
            } => self.clipboard_request(id, window_id, ClipboardOperation::Write(text), cx),
            Command::RegisterGlobalShortcut {
                window_id,
                shortcut_id,
                key,
                modifiers,
                ..
            } => self.register_shortcut((id, window_id, shortcut_id), &key, modifiers, cx),
            Command::UnregisterGlobalShortcut {
                window_id,
                shortcut_id,
                ..
            } => {
                if let Err((code, message)) =
                    self.shortcuts.unregister(id, window_id, shortcut_id, cx)
                {
                    self.error(id, code, message, cx);
                }
            }
            Command::PostNotification {
                window_id,
                notification_id,
                title,
                body,
                ..
            } => self.post_notification((id, window_id, notification_id), title, body, cx),
            Command::WithdrawNotification {
                window_id,
                notification_id,
                ..
            } => {
                if let Err((code, message)) =
                    self.notifications
                        .withdraw(id, window_id, notification_id, cx)
                {
                    self.error(id, code, message, cx);
                }
            }
            Command::OpenFileGrant {
                window_id,
                grant_id,
                root,
                access,
                ..
            } => self.open_file_grant((id, window_id, grant_id), &root, access, cx),
            Command::CloseFileGrant {
                window_id,
                grant_id,
                ..
            } => {
                if let Err((code, message)) = self.files.close(id, window_id, grant_id, cx) {
                    self.error(id, code, message, cx);
                }
            }
            Command::FileRequest {
                window_id,
                grant_id,
                path,
                operation,
                ..
            } => self.file_request((id, window_id, grant_id), path, operation, cx),
            Command::SpawnProcess {
                window_id,
                process_id,
                launch,
                ..
            } => self.spawn_process((id, window_id, process_id), launch, cx),
            Command::WriteProcess {
                window_id,
                process_id,
                data,
                ..
            } => match base64::Engine::decode(&base64::engine::general_purpose::STANDARD, data) {
                Ok(bytes) => {
                    self.update_process((id, window_id, process_id), Change::Write(bytes), cx)
                }
                Err(_) => self.error(
                    id,
                    ErrorCode::InvalidCommand,
                    "process input is not base64",
                    cx,
                ),
            },
            Command::CloseProcessInput {
                window_id,
                process_id,
                ..
            } => self.update_process((id, window_id, process_id), Change::CloseInput, cx),
            Command::ResizeProcess {
                window_id,
                process_id,
                size,
                ..
            } => self.update_process((id, window_id, process_id), Change::Resize(size), cx),
            Command::SignalProcess {
                window_id,
                process_id,
                signal,
                ..
            } => self.update_process((id, window_id, process_id), Change::Signal(signal), cx),
            Command::AcknowledgeProcessOutput {
                window_id,
                process_id,
                chunk,
                ..
            } => self.update_process((id, window_id, process_id), Change::Acknowledge(chunk), cx),
            Command::ReleaseProcess {
                window_id,
                process_id,
                ..
            } => {
                if let Err((code, message)) = self.processes.release(id, window_id, process_id, cx)
                {
                    self.error(id, code, message, cx);
                }
            }
            Command::Shutdown { .. } => self.finish(Event::Ack { id }, cx),
            Command::Hello { .. } => unreachable!("hello handled before command dispatch"),
        }
    }

    fn open(&mut self, request: OpenWindow, cx: &mut App) {
        let OpenWindow {
            id,
            window_id,
            root_id,
            title,
            width,
            height,
        } = request;
        self.evidence.startup("open_dispatched", id, window_id);
        if self.windows.borrow().len() >= MAX_WINDOWS {
            self.error(
                id,
                ErrorCode::LimitExceeded,
                "session window limit exceeded",
                cx,
            );
            return;
        }
        if window_id.get() <= self.last_window_id || root_id.get() <= self.last_node_id {
            self.error(
                id,
                ErrorCode::InvalidHandle,
                "window and root IDs must increase across the session",
                cx,
            );
            return;
        }
        let state = Rc::new(RefCell::new(WindowState {
            tree: Tree::new(root_id),
            active: true,
        }));
        let view_state = state.clone();
        let events = self.events.clone();
        let evidence = self.evidence.clone();
        let bounds = Bounds::centered(None, size(px(width as f32), px(height as f32)), cx);
        self.evidence.startup("open_window_enter", id, window_id);
        let result = cx.open_window(
            WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(bounds)),
                titlebar: Some(TitlebarOptions {
                    title: Some(title.into()),
                    ..Default::default()
                }),
                app_id: Some("dev.bunnative.host".into()),
                ..Default::default()
            },
            move |window, cx| {
                evidence.startup("root_constructor_enter", id, window_id);
                evidence.renderer(window_id, window);
                let view = cx.new(|cx| {
                    NativeView::new(window_id, view_state, events, evidence.clone(), window, cx)
                });
                evidence.startup("root_constructor_returned", id, window_id);
                view
            },
        );
        self.evidence.startup("open_window_returned", id, window_id);
        match result {
            Ok(handle) => {
                if self.evidence.enabled() {
                    let evidence = self.evidence.clone();
                    let _ = handle.update(cx, |_, window, cx| {
                        window.on_window_should_close(cx, move |_, _| {
                            evidence.close_requested(window_id);
                            true
                        });
                    });
                }
                self.windows
                    .borrow_mut()
                    .insert(window_id, WindowEntry { handle, state });
                self.last_window_id = window_id.get();
                self.last_node_id = root_id.get();
                cx.activate(true);
                self.evidence.startup("activation_returned", id, window_id);
                self.events.send(
                    Event::Opened {
                        id,
                        window_id,
                        root_id,
                        tree_revision: 0,
                    },
                    cx,
                );
                self.evidence
                    .startup("opened_submit_returned", id, window_id);
            }
            Err(error) => {
                state.borrow_mut().active = false;
                eprintln!("Bun Native window creation failed: {error:#}");
                self.error(
                    id,
                    ErrorCode::NativeFailure,
                    "native window creation failed; see stderr",
                    cx,
                );
            }
        }
    }

    fn window(
        &self,
        id: RequestId,
        window_id: WindowId,
        cx: &mut App,
    ) -> Option<(WindowHandle<NativeView>, SharedWindowState)> {
        let windows = self.windows.borrow();
        if let Some(entry) = windows.get(&window_id)
            && entry.state.borrow().active
        {
            Some((entry.handle, entry.state.clone()))
        } else {
            self.error(
                id,
                ErrorCode::InvalidHandle,
                "window is closed or is not owned by this session",
                cx,
            );
            None
        }
    }

    fn batch(
        &mut self,
        id: RequestId,
        window_id: WindowId,
        base_revision: u64,
        operations: Vec<Operation>,
        cx: &mut App,
    ) {
        let Some((handle, state)) = self.window(id, window_id, cx) else {
            return;
        };
        let prepared = state
            .borrow()
            .tree
            .prepare(base_revision, operations, self.last_node_id);
        let prepared = match prepared {
            Ok(prepared) => prepared,
            Err(error) => {
                self.error(id, error.code, error.message, cx);
                return;
            }
        };
        let revision = prepared.tree.revision();
        let result = handle.update(cx, |view, window, cx| view.apply(prepared.tree, window, cx));
        if result.is_ok() {
            self.last_node_id = prepared.last_node_id;
            self.evidence.batch(window_id, revision, &prepared.metrics);
            self.events.send(
                Event::Applied {
                    id,
                    window_id,
                    tree_revision: revision,
                },
                cx,
            );
        } else {
            self.error(
                id,
                ErrorCode::NativeFailure,
                "native window update failed",
                cx,
            );
        }
    }

    fn display_snapshot(&self, id: RequestId, window_id: WindowId, cx: &mut App) {
        if !self.policy.window_display {
            self.error(
                id,
                ErrorCode::PermissionDenied,
                "window display access was not granted at native process launch",
                cx,
            );
            return;
        }
        let Some((handle, _)) = self.window(id, window_id, cx) else {
            return;
        };
        match handle.update(cx, |_, window, cx| services::display_snapshot(window, cx)) {
            Ok(Ok(snapshot)) => self.events.send(
                Event::DisplaySnapshot {
                    id,
                    window_id,
                    snapshot,
                },
                cx,
            ),
            Ok(Err((code, message))) => self.error(id, code, message, cx),
            Err(_) => self.error(
                id,
                ErrorCode::InvalidHandle,
                "native window is no longer available",
                cx,
            ),
        }
    }

    fn close(&self, id: RequestId, window_id: WindowId, cx: &mut App) {
        let Some((handle, state)) = self.window(id, window_id, cx) else {
            return;
        };
        state.borrow_mut().active = false;
        if handle
            .update(cx, |_, window, _| window.remove_window())
            .is_ok()
        {
            self.clipboard.cancel(
                Some(window_id),
                ErrorCode::InvalidHandle,
                "clipboard owner window was closed",
                cx,
            );
            self.shortcuts.close_window(window_id, cx);
            self.notifications.close_window(window_id, cx);
            self.files.close_window(window_id, cx);
            self.processes.close_window(window_id, cx);
            self.events.send(Event::Ack { id }, cx);
        } else {
            state.borrow_mut().active = true;
            self.error(
                id,
                ErrorCode::NativeFailure,
                "native window close failed",
                cx,
            );
        }
    }

    fn clipboard_request(
        &self,
        id: RequestId,
        window_id: WindowId,
        operation: ClipboardOperation,
        cx: &mut App,
    ) {
        let granted = match operation {
            ClipboardOperation::Read => self.policy.clipboard_read,
            ClipboardOperation::Write(_) => self.policy.clipboard_write,
        };
        if !granted {
            self.error(
                id,
                ErrorCode::PermissionDenied,
                "this clipboard operation was not granted at native process launch",
                cx,
            );
            return;
        }
        let Some((handle, _)) = self.window(id, window_id, cx) else {
            return;
        };
        if !handle
            .update(cx, |_, window, _| Clipboard::supports_window(window))
            .unwrap_or(false)
        {
            self.error(
                id,
                ErrorCode::ServiceUnavailable,
                "clipboard text is unavailable for this native window backend",
                cx,
            );
            return;
        }
        if let Err((code, message)) = self.clipboard.submit(id, window_id, operation, cx) {
            self.error(id, code, message, cx);
        }
    }

    fn register_shortcut(
        &self,
        request: (RequestId, WindowId, ShortcutId),
        key: &str,
        modifiers: ShortcutModifiers,
        cx: &mut App,
    ) {
        let (id, window_id, _) = request;
        if !self.policy.global_shortcuts {
            self.error(
                id,
                ErrorCode::PermissionDenied,
                "global shortcuts were not granted at native process launch",
                cx,
            );
            return;
        }
        let Some((handle, _)) = self.window(id, window_id, cx) else {
            return;
        };
        if !handle
            .update(cx, |_, window, _| Shortcuts::supports_window(window))
            .unwrap_or(false)
        {
            self.error(
                id,
                ErrorCode::ServiceUnavailable,
                "global shortcuts are unavailable for this native window backend",
                cx,
            );
            return;
        }
        if let Err((code, message)) = self.shortcuts.register(request, key, modifiers, cx) {
            self.error(id, code, message, cx);
        }
    }

    fn post_notification(
        &self,
        request: (RequestId, WindowId, NotificationId),
        title: String,
        body: String,
        cx: &mut App,
    ) {
        let (id, window_id, _) = request;
        if !self.policy.notifications {
            self.error(
                id,
                ErrorCode::PermissionDenied,
                "notifications were not granted at native process launch",
                cx,
            );
            return;
        }
        if self.window(id, window_id, cx).is_none() {
            return;
        }
        if let Err((code, message)) = self.notifications.post(request, title, body, cx) {
            self.error(id, code, message, cx);
        }
    }

    fn open_file_grant(
        &self,
        request: (RequestId, WindowId, FileGrantId),
        root: &str,
        access: FileAccess,
        cx: &mut App,
    ) {
        let (id, window_id, _) = request;
        if !self
            .policy
            .filesystem_roots
            .iter()
            .any(|item| item.id == root)
        {
            self.error(
                id,
                ErrorCode::PermissionDenied,
                "this filesystem root was not granted at native process launch",
                cx,
            );
            return;
        }
        if self.window(id, window_id, cx).is_none() {
            return;
        }
        if let Err((code, message)) = self.files.open(request, root, access, cx) {
            self.error(id, code, message, cx);
        }
    }

    fn file_request(
        &self,
        request: (RequestId, WindowId, FileGrantId),
        path: String,
        operation: FileOperation,
        cx: &mut App,
    ) {
        let (id, window_id, _) = request;
        if self.window(id, window_id, cx).is_none() {
            return;
        }
        if let Err((code, message)) = self.files.request(request, path, operation, cx) {
            self.error(id, code, message, cx);
        }
    }

    fn spawn_process(
        &self,
        request: (RequestId, WindowId, ProcessId),
        launch: ProcessLaunch,
        cx: &mut App,
    ) {
        let (id, window_id, _) = request;
        if !self
            .policy
            .processes
            .iter()
            .any(|item| item.id == launch.executable)
        {
            self.error(
                id,
                ErrorCode::PermissionDenied,
                "this process executable was not granted at native process launch",
                cx,
            );
            return;
        }
        if self.window(id, window_id, cx).is_none() {
            return;
        }
        let directory = match &launch.cwd {
            Some(cwd) => match self.files.directory(window_id, cwd.grant_id) {
                Some(root) => Some((root, cwd.path.clone())),
                None => {
                    self.error(
                        id,
                        ErrorCode::InvalidHandle,
                        "process cwd names a file grant that is closed or not owned by this window",
                        cx,
                    );
                    return;
                }
            },
            None => None,
        };
        if let Err((code, message)) = self
            .processes
            .spawn(request, Spawn { launch, directory }, cx)
        {
            self.error(id, code, message, cx);
        }
    }

    fn update_process(
        &self,
        request: (RequestId, WindowId, ProcessId),
        change: Change,
        cx: &mut App,
    ) {
        let (id, window_id, _) = request;
        if self.window(id, window_id, cx).is_none() {
            return;
        }
        if let Err((code, message)) = self.processes.update(request, change, cx) {
            self.error(id, code, message, cx);
        }
    }

    fn revoke(&self) {
        self.finishing.set(true);
        for entry in self.windows.borrow().values() {
            entry.state.borrow_mut().active = false;
        }
    }

    /// Revoke ownership and stop every service worker. Each returned join
    /// must complete before the final reply or process exit.
    fn stop_services(&self, cx: &mut App) -> Vec<gpui::Task<()>> {
        self.revoke();
        [
            self.clipboard.stop(cx),
            self.shortcuts.stop(cx),
            self.notifications.stop(cx),
            self.files.stop(cx),
            self.processes.stop(cx),
        ]
        .into_iter()
        .flatten()
        .collect()
    }

    pub(crate) fn finish(&self, final_event: Event, cx: &mut App) {
        let joins = self.stop_services(cx);
        let events = self.events.clone();
        if joins.is_empty() {
            flush_and_quit(events, final_event, cx);
        } else {
            cx.spawn(async move |cx| {
                for joined in joins {
                    joined.await;
                }
                cx.update(|cx| flush_and_quit(events, final_event, cx));
            })
            .detach();
        }
    }

    pub(crate) fn disconnect(&self, cx: &mut App) {
        let joins = self.stop_services(cx);
        if joins.is_empty() {
            cx.quit();
        } else {
            cx.spawn(async move |cx| {
                for joined in joins {
                    joined.await;
                }
                cx.update(|cx| cx.quit());
            })
            .detach();
        }
    }
}

fn flush_and_quit(events: EventSink, final_event: Event, cx: &mut App) {
    match events.finish(final_event) {
        Some(flushed) => cx
            .spawn(async move |cx| {
                let _ = flushed.recv().await;
                cx.update(|cx| cx.quit());
            })
            .detach(),
        None => cx.quit(),
    }
}
