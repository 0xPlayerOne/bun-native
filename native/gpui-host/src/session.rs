use crate::{
    channel::EventSink,
    evidence::Evidence,
    services,
    services::app_menu::AppMenus,
    services::clipboard::{Clipboard, Operation as ClipboardOperation},
    services::context_menus::ContextMenus,
    services::drops::Drops,
    services::file_dialogs::FileDialogs,
    services::files::Files,
    services::notifications::Notifications,
    services::processes::{Change, Processes, Spawn},
    services::shortcuts::Shortcuts,
    services::task_dialogs::TaskDialogs,
    state::{SharedWindowState, WindowState},
    view::NativeView,
};
use bun_native_protocol::{
    AppMenuEntry, Capability, Command, ContextMenuId, DialogId, DropId, DropTargetId, ErrorCode,
    Event, FileAccess, FileDialogOptions, FileGrantId, FileOperation, Limits, MAX_WINDOWS,
    MessageDialogOptions, NodeId, NotificationId, Operation, PROTOCOL_VERSION, ProcessId,
    ProcessLaunch, RequestId, ServicePolicy, ShortcutId, ShortcutModifiers, Tree, WindowId,
};
use gpui::{
    App, Bounds, TitlebarOptions, Window, WindowBounds, WindowHandle, WindowOptions, prelude::*,
    px, size,
};
use std::cell::{Cell, RefCell};
use std::collections::BTreeMap;
use std::rc::Rc;

/// A service's refusal: the request's error code and message.
type Failure = (ErrorCode, &'static str);

struct WindowEntry {
    handle: WindowHandle<NativeView>,
    state: SharedWindowState,
    /// Dropped with the entry, so a closed window reports no display change.
    display: Option<services::DisplayObservation>,
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
    file_dialogs: FileDialogs,
    task_dialogs: TaskDialogs,
    context_menus: ContextMenus,
    drops: Drops,
    app_menu: AppMenus,
    /// Test-only fault injection (`BUN_NATIVE_TEST_FAULT=panic-in-batch`):
    /// the first batch panics inside its GPUI window update, so the panic
    /// path of an established session can be qualified on the real host.
    /// The launching application already controls the host's environment,
    /// so this grants it nothing new.
    panic_in_batch: bool,
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
        let file_dialogs = FileDialogs::new(events.clone(), cx);
        let task_dialogs = TaskDialogs::new(events.clone(), cx);
        let context_menus = ContextMenus::new(events.clone(), cx);
        let drops = Drops::new(events.clone(), cx);
        let app_menu = AppMenus::new(events.clone(), cx);
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
            let file_dialogs = file_dialogs.clone();
            let task_dialogs = task_dialogs.clone();
            let context_menus = context_menus.clone();
            let drops = drops.clone();
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
                    file_dialogs.close_window(window_id, cx);
                    task_dialogs.close_window(window_id, cx);
                    context_menus.close_window(window_id, cx);
                    // GPUI's drag outlives a window closed under it. End it
                    // in a live window so its stale data is never dropped.
                    let dragging = cx.has_active_drag();
                    drops.close_window(window_id, dragging);
                    let survivor = windows.borrow().values().next().map(|entry| entry.handle);
                    if let Some(survivor) = survivor.filter(|_| dragging) {
                        let _ = survivor.update(cx, |_, window, cx| cx.stop_active_drag(window));
                    }
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
            file_dialogs,
            task_dialogs,
            context_menus,
            drops,
            app_menu,
            panic_in_batch: std::env::var("BUN_NATIVE_TEST_FAULT").as_deref()
                == Ok("panic-in-batch"),
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
                    Capability::SplitV1,
                    Capability::StyleDecorationV1,
                    Capability::OverlaysV1,
                    Capability::ScrollAnchorV1,
                    Capability::FocusV1,
                    Capability::ScrollControlV1,
                    Capability::OverlayKeyboardV1,
                ];
                if services::DISPLAY_DETAILS {
                    capabilities.push(Capability::DisplayDetailsV1);
                }
                if services::display_changes(cx) {
                    capabilities.push(Capability::DisplayChangesV1);
                }
                if services::display_identity(cx) {
                    capabilities.push(Capability::DisplayIdentityV1);
                }
                if crate::view::popups_available(cx) {
                    capabilities.push(Capability::PopupWindowsV1);
                }
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
                if self.file_dialogs.available() {
                    capabilities.push(Capability::FileDialogsV1);
                }
                if self.drops.available() {
                    capabilities.push(Capability::DragDropFilesV1);
                }
                capabilities.push(Capability::InputStatesV1);
                if self.app_menu.available() {
                    capabilities.push(Capability::AppMenuV1);
                }
                if self.task_dialogs.available() {
                    capabilities.push(Capability::TaskDialogsV1);
                }
                if self.context_menus.available() {
                    capabilities.push(Capability::ContextMenusV1);
                }
                capabilities.push(Capability::SplitResizeV1);
                capabilities.push(Capability::AccessibilityV1);
                capabilities.push(Capability::AccessibilityListsV1);
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
            } => self.report(
                id,
                self.shortcuts.unregister(id, window_id, shortcut_id, cx),
                cx,
            ),
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
            } => self.report(
                id,
                self.notifications
                    .withdraw(id, window_id, notification_id, cx),
                cx,
            ),
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
            } => self.report(id, self.files.close(id, window_id, grant_id, cx), cx),
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
            } => self.report(
                id,
                self.processes.release(id, window_id, process_id, cx),
                cx,
            ),
            Command::ShowFileDialog {
                window_id,
                dialog_id,
                options,
                ..
            } => self.show_file_dialog((id, window_id, dialog_id), options, cx),
            Command::CloseFileDialog {
                window_id,
                dialog_id,
                ..
            } => self.report(
                id,
                self.file_dialogs.close(id, window_id, dialog_id, cx),
                cx,
            ),
            Command::ShowMessageDialog {
                window_id,
                dialog_id,
                options,
                ..
            } => self.show_message_dialog((id, window_id, dialog_id), options, cx),
            Command::CloseMessageDialog {
                window_id,
                dialog_id,
                ..
            } => self.report(
                id,
                self.task_dialogs.close(id, window_id, dialog_id, cx),
                cx,
            ),
            Command::ShowContextMenu {
                window_id,
                menu_id,
                x,
                y,
                items,
                ..
            } => self.show_context_menu((id, window_id, menu_id), (x, y), &items, cx),
            Command::CloseContextMenu {
                window_id, menu_id, ..
            } => self.report(id, self.context_menus.close(id, window_id, menu_id, cx), cx),
            Command::RegisterDropTarget {
                window_id,
                target_id,
                node_id,
                ..
            } => self.register_drop_target(id, window_id, target_id, node_id, cx),
            Command::UnregisterDropTarget {
                window_id,
                target_id,
                ..
            } => self.unregister_drop_target(id, window_id, target_id, cx),
            Command::ResolveDroppedItem {
                window_id,
                target_id,
                drop_id,
                item,
                root,
                ..
            } => self.resolve_dropped_item((id, window_id, target_id), drop_id, item, root, cx),
            Command::SetAppMenu { menu_id, menus, .. } => {
                let result = if self.policy.app_menu {
                    self.app_menu.set(id, menu_id, &menus, cx)
                } else {
                    Err((
                        ErrorCode::PermissionDenied,
                        "the application menu was not granted at native process launch",
                    ))
                };
                match result {
                    Ok(event) => self.events.send(event, cx),
                    Err((code, message)) => self.error(id, code, message, cx),
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
        let drops = self.drops.clone();
        let evidence = self.evidence.clone();
        let bounds = whole_point_origin(Bounds::centered(
            None,
            size(px(width as f32), px(height as f32)),
            cx,
        ));
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
                    NativeView::new(
                        window_id,
                        view_state,
                        events,
                        drops,
                        evidence.clone(),
                        window,
                        cx,
                    )
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
                let display = (services::display_changes(cx) && self.policy.window_display)
                    .then(|| {
                        services::observe_display(
                            handle,
                            window_id,
                            state.clone(),
                            self.events.clone(),
                            cx,
                        )
                    })
                    .flatten();
                self.windows.borrow_mut().insert(
                    window_id,
                    WindowEntry {
                        handle,
                        state,
                        display,
                    },
                );
                self.last_window_id = window_id.get();
                self.last_node_id = root_id.get();
                // The pinned GPUI's AccessKit adapter subclasses the window's
                // content view, but AppKit asks the first responder (GPUI's view,
                // a subview of it) for the focused element, and the adapter
                // starts out believing the window is unfocused although GPUI
                // already made it key (#241); see bun_native_macos_surface.
                #[cfg(target_os = "macos")]
                let _ = handle.update(cx, |_, window, _| {
                    let native = raw_window_handle::HasWindowHandle::window_handle(window)
                        .expect("an owned macOS GPUI window exposes its native view");
                    if let Err(error) = bun_native_macos_surface::focus_route::route(native) {
                        eprintln!("Bun Native accessibility focus routing unavailable: {error}");
                    }
                    bun_native_macos_surface::key_status::track(native)
                        .expect("GPUI opens its windows on the AppKit owner thread");
                });
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

    /// A launch-policy grant, then the owned window. A denial is reported as
    /// `PermissionDenied` with `denial`; a missing window as [`Self::window`]
    /// reports it.
    fn gated(
        &self,
        id: RequestId,
        window_id: WindowId,
        granted: bool,
        denial: &str,
        cx: &mut App,
    ) -> Option<(WindowHandle<NativeView>, SharedWindowState)> {
        if !granted {
            self.error(id, ErrorCode::PermissionDenied, denial, cx);
            return None;
        }
        self.window(id, window_id, cx)
    }

    /// Reads from an owned window; a window GPUI already released is
    /// reported as `InvalidHandle`.
    fn read_window<R>(
        &self,
        id: RequestId,
        handle: WindowHandle<NativeView>,
        read: impl FnOnce(&Window) -> R,
        cx: &mut App,
    ) -> Option<R> {
        let read = handle.update(cx, |_, window, _| read(window));
        if read.is_err() {
            self.error(
                id,
                ErrorCode::InvalidHandle,
                "native window is no longer available",
                cx,
            );
        }
        read.ok()
    }

    /// Whether this window's backend supports a service; otherwise reported
    /// as `ServiceUnavailable` with `unavailable`.
    fn supports(
        &self,
        id: RequestId,
        handle: WindowHandle<NativeView>,
        supports: impl FnOnce(&Window) -> bool,
        unavailable: &str,
        cx: &mut App,
    ) -> bool {
        let supported = handle
            .update(cx, |_, window, _| supports(window))
            .unwrap_or(false);
        if !supported {
            self.error(id, ErrorCode::ServiceUnavailable, unavailable, cx);
        }
        supported
    }

    /// Reports a service's refusal as this request's error.
    fn report(&self, id: RequestId, result: Result<(), Failure>, cx: &mut App) {
        if let Err((code, message)) = result {
            self.error(id, code, message, cx);
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
        let started = crate::phases::now();
        let operation_count = operations.len();
        let Some((handle, state)) = self.window(id, window_id, cx) else {
            return;
        };
        let prepared = state
            .borrow()
            .tree
            .prepare(base_revision, operations, self.last_node_id);
        let prepared_at = started.map(|_| std::time::Instant::now());
        let prepared = match prepared {
            Ok(prepared) => prepared,
            Err(error) => {
                self.error(id, error.code, error.message, cx);
                return;
            }
        };
        let revision = prepared.tree.revision();
        let panic_in_batch = self.panic_in_batch;
        let result = handle.update(cx, |view, window, cx| {
            if panic_in_batch {
                panic!("Bun Native test fault: injected panic while applying a batch");
            }
            view.apply(prepared.tree, &prepared.requests, window, cx)
        });
        if result.is_ok() {
            let applied_at = started.map(|_| std::time::Instant::now());
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
            if let (Some(started), Some(prepared), Some(applied)) =
                (started, prepared_at, applied_at)
            {
                let times = crate::phases::BatchTimes {
                    started,
                    prepared,
                    applied,
                    replied: std::time::Instant::now(),
                };
                crate::phases::batch(id, window_id, operation_count, times);
            }
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
        let Some((handle, _)) = self.gated(
            id,
            window_id,
            self.policy.window_display,
            "window display access was not granted at native process launch",
            cx,
        ) else {
            return;
        };
        let disconnected = self.windows.borrow().get(&window_id).is_some_and(|entry| {
            entry
                .display
                .as_ref()
                .is_some_and(|display| !display.connected())
        });
        if disconnected {
            self.error(
                id,
                ErrorCode::ServiceUnavailable,
                "the owned window's display was disconnected and the platform has not reported its new display",
                cx,
            );
            return;
        }
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
        // End an OS dialog or menu owned by this window before it goes away.
        self.task_dialogs.close_window(window_id, cx);
        self.context_menus.close_window(window_id, cx);
        // GPUI runs the closed-window hook in `new` synchronously when this
        // update returns, so it has already released every service's
        // per-window state and sent `Closed` before the `Ack` below.
        if handle
            .update(cx, |_, window, _| window.remove_window())
            .is_ok()
        {
            debug_assert!(!self.windows.borrow().contains_key(&window_id));
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
        let Some((handle, _)) = self.gated(
            id,
            window_id,
            granted,
            "this clipboard operation was not granted at native process launch",
            cx,
        ) else {
            return;
        };
        if !self.supports(
            id,
            handle,
            Clipboard::supports_window,
            "clipboard text is unavailable for this native window backend",
            cx,
        ) {
            return;
        }
        self.report(id, self.clipboard.submit(id, window_id, operation, cx), cx);
    }

    fn register_shortcut(
        &self,
        request: (RequestId, WindowId, ShortcutId),
        key: &str,
        modifiers: ShortcutModifiers,
        cx: &mut App,
    ) {
        let (id, window_id, _) = request;
        let Some((handle, _)) = self.gated(
            id,
            window_id,
            self.policy.global_shortcuts,
            "global shortcuts were not granted at native process launch",
            cx,
        ) else {
            return;
        };
        if !self.supports(
            id,
            handle,
            Shortcuts::supports_window,
            "global shortcuts are unavailable for this native window backend",
            cx,
        ) {
            return;
        }
        self.report(id, self.shortcuts.register(request, key, modifiers, cx), cx);
    }

    fn post_notification(
        &self,
        request: (RequestId, WindowId, NotificationId),
        title: String,
        body: String,
        cx: &mut App,
    ) {
        let (id, window_id, _) = request;
        if self
            .gated(
                id,
                window_id,
                self.policy.notifications,
                "notifications were not granted at native process launch",
                cx,
            )
            .is_none()
        {
            return;
        }
        self.report(id, self.notifications.post(request, title, body, cx), cx);
    }

    fn open_file_grant(
        &self,
        request: (RequestId, WindowId, FileGrantId),
        root: &str,
        access: FileAccess,
        cx: &mut App,
    ) {
        let (id, window_id, _) = request;
        let granted = self
            .policy
            .filesystem_roots
            .iter()
            .any(|item| item.id == root);
        if self
            .gated(
                id,
                window_id,
                granted,
                "this filesystem root was not granted at native process launch",
                cx,
            )
            .is_none()
        {
            return;
        }
        self.report(id, self.files.open(request, root, access, cx), cx);
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
        self.report(id, self.files.request(request, path, operation, cx), cx);
    }

    fn spawn_process(
        &self,
        request: (RequestId, WindowId, ProcessId),
        launch: ProcessLaunch,
        cx: &mut App,
    ) {
        let (id, window_id, _) = request;
        let granted = self
            .policy
            .processes
            .iter()
            .any(|item| item.id == launch.executable);
        if self
            .gated(
                id,
                window_id,
                granted,
                "this process executable was not granted at native process launch",
                cx,
            )
            .is_none()
        {
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
        self.report(
            id,
            self.processes
                .spawn(request, Spawn { launch, directory }, cx),
            cx,
        );
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
        self.report(id, self.processes.update(request, change, cx), cx);
    }

    fn show_file_dialog(
        &self,
        request: (RequestId, WindowId, DialogId),
        options: FileDialogOptions,
        cx: &mut App,
    ) {
        let (id, window_id, _) = request;
        let Some((handle, _)) = self.gated(
            id,
            window_id,
            self.policy.file_dialogs,
            "file dialogs were not granted at native process launch",
            cx,
        ) else {
            return;
        };
        let Some(parent) = self.read_window(id, handle, FileDialogs::parent, cx) else {
            return;
        };
        self.report(id, self.file_dialogs.show(request, options, parent, cx), cx);
    }

    fn show_message_dialog(
        &self,
        request: (RequestId, WindowId, DialogId),
        options: MessageDialogOptions,
        cx: &mut App,
    ) {
        let (id, window_id, _) = request;
        let Some((handle, _)) = self.gated(
            id,
            window_id,
            self.policy.task_dialogs,
            "OS message dialogs were not granted at native process launch",
            cx,
        ) else {
            return;
        };
        let Some(owner) = self.read_window(id, handle, TaskDialogs::owner, cx) else {
            return;
        };
        self.report(id, self.task_dialogs.show(request, options, owner, cx), cx);
    }

    fn show_context_menu(
        &self,
        request: (RequestId, WindowId, ContextMenuId),
        position: (f64, f64),
        items: &[AppMenuEntry],
        cx: &mut App,
    ) {
        let (id, window_id, _) = request;
        services::context_menus::trace("command received");
        let Some((handle, _)) = self.window(id, window_id, cx) else {
            return;
        };
        let Some(owner) = self.read_window(id, handle, ContextMenus::owner, cx) else {
            return;
        };
        self.report(
            id,
            self.context_menus.show(request, position, items, owner, cx),
            cx,
        );
    }

    fn register_drop_target(
        &self,
        id: RequestId,
        window_id: WindowId,
        target_id: DropTargetId,
        node_id: NodeId,
        cx: &mut App,
    ) {
        let Some((handle, state)) = self.gated(
            id,
            window_id,
            self.policy.drag_drop,
            "drag and drop was not granted at native process launch",
            cx,
        ) else {
            return;
        };
        if !self.drops.available() {
            self.error(
                id,
                ErrorCode::ServiceUnavailable,
                "file drops are unavailable for this native window backend",
                cx,
            );
            return;
        }
        let registered = self
            .drops
            .register(window_id, target_id, node_id, &state.borrow().tree);
        if let Err((code, message)) = registered {
            self.error(id, code, message, cx);
            return;
        }
        // Render the target's drag and drop listeners before acknowledging.
        let _ = handle.update(cx, |_, window, _| window.refresh());
        self.events.send(
            Event::DropTargetRegistered {
                id,
                window_id,
                target_id,
            },
            cx,
        );
    }

    fn unregister_drop_target(
        &self,
        id: RequestId,
        window_id: WindowId,
        target_id: DropTargetId,
        cx: &mut App,
    ) {
        let Some((handle, _)) = self.window(id, window_id, cx) else {
            return;
        };
        if let Err((code, message)) = self.drops.unregister(window_id, target_id) {
            self.error(id, code, message, cx);
            return;
        }
        let _ = handle.update(cx, |_, window, _| window.refresh());
        self.events.send(
            Event::DropTargetUnregistered {
                id,
                window_id,
                target_id,
            },
            cx,
        );
    }

    fn resolve_dropped_item(
        &self,
        request: (RequestId, WindowId, DropTargetId),
        drop_id: DropId,
        item: u32,
        root: String,
        cx: &mut App,
    ) {
        let (id, window_id, target_id) = request;
        let Some(launch_root) = self
            .policy
            .filesystem_roots
            .iter()
            .find(|candidate| candidate.id == root)
        else {
            self.error(
                id,
                ErrorCode::PermissionDenied,
                "this filesystem root was not granted at native process launch",
                cx,
            );
            return;
        };
        if self.window(id, window_id, cx).is_none() {
            return;
        }
        match self
            .drops
            .resolve(window_id, target_id, drop_id, item, launch_root)
        {
            Ok(path) => self.events.send(
                Event::DroppedItemResolved {
                    id,
                    window_id,
                    target_id,
                    drop_id,
                    item,
                    root,
                    path,
                },
                cx,
            ),
            Err((code, message)) => self.error(id, code, message, cx),
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
        self.app_menu.stop(cx);
        [
            self.clipboard.stop(cx),
            self.shortcuts.stop(cx),
            self.notifications.stop(cx),
            self.files.stop(cx),
            self.processes.stop(cx),
            self.file_dialogs.stop(cx),
            self.task_dialogs.stop(cx),
            self.context_menus.stop(cx),
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
        Ok(flushed) => cx
            .spawn(async move |cx| {
                let _ = flushed.recv().await;
                cx.update(|cx| cx.quit());
            })
            .detach(),
        Err(_) => cx.quit(),
    }
}

/// Centering on a work area with an odd height (or width) leaves a half-point
/// origin. AppKit aligns a window's content rectangle to whole backing pixels
/// by growing it outward, so on a 1x display a requested 420-point-high
/// window opened with a 421-point viewport (hosted run 43110442504). Whole
/// points keep the requested content size on every platform.
fn whole_point_origin(mut bounds: Bounds<gpui::Pixels>) -> Bounds<gpui::Pixels> {
    bounds.origin.x = bounds.origin.x.floor();
    bounds.origin.y = bounds.origin.y.floor();
    bounds
}

#[cfg(test)]
mod window_origin_tests {
    use super::whole_point_origin;
    use gpui::{Bounds, point, px, size};

    #[test]
    fn a_half_point_centered_origin_becomes_whole_and_keeps_the_size() {
        let centered = Bounds::new(point(px(272.), px(170.5)), size(px(480.), px(420.)));
        let whole = whole_point_origin(centered);
        assert_eq!(whole.origin, point(px(272.), px(170.)));
        assert_eq!(whole.size, size(px(480.), px(420.)));
    }
}
