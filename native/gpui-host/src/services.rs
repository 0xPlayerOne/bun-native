//! Policy is fixed before the private channel starts. Wire messages cannot grant it.

use crate::view::NativeView;
use crate::{channel::EventSink, state::SharedWindowState};
use bun_native_protocol::{
    DisplayBounds, DisplaySnapshot, ErrorCode, Event, FileAccess, FilesystemRoot,
    ProcessExecutable, ProcessLimits, ServicePolicy, WindowId, validate_filesystem_roots,
    validate_process_executables,
};
use gpui::{App, Bounds, DisplayEvent, DisplayId, Pixels, Subscription, Window, WindowHandle};
use std::cell::RefCell;
use std::ffi::OsString;
use std::rc::Rc;
use std::time::Duration;

pub(crate) mod app_menu;
#[cfg(target_os = "linux")]
pub(crate) mod clipboard;
#[cfg(target_os = "macos")]
#[path = "services/clipboard_macos.rs"]
pub(crate) mod clipboard;
#[cfg(not(any(target_os = "linux", target_os = "macos")))]
#[path = "services/clipboard_unavailable.rs"]
pub(crate) mod clipboard;
#[cfg(any(windows, target_os = "macos", test))]
pub(crate) mod context_menu_model;
#[cfg(any(windows, target_os = "macos"))]
pub(crate) mod context_menus;
#[cfg(not(any(windows, target_os = "macos")))]
#[path = "services/context_menus_unavailable.rs"]
pub(crate) mod context_menus;
pub(crate) mod drops;
#[cfg(target_os = "linux")]
pub(crate) mod file_dialogs;
#[cfg(not(target_os = "linux"))]
#[path = "services/file_dialogs_unavailable.rs"]
pub(crate) mod file_dialogs;
#[cfg(any(target_os = "linux", target_os = "macos", windows))]
pub(crate) mod files;
#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
#[path = "services/files_unavailable.rs"]
pub(crate) mod files;
#[cfg(target_os = "linux")]
pub(crate) mod notifications;
#[cfg(not(target_os = "linux"))]
#[path = "services/notifications_unavailable.rs"]
pub(crate) mod notifications;
#[cfg(any(target_os = "linux", target_os = "macos", windows))]
pub(crate) mod processes;
#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
#[path = "services/processes_unavailable.rs"]
pub(crate) mod processes;
#[cfg(target_os = "linux")]
pub(crate) mod shortcuts;
#[cfg(target_os = "macos")]
#[path = "services/shortcuts_macos.rs"]
pub(crate) mod shortcuts;
#[cfg(not(any(target_os = "linux", target_os = "macos")))]
#[path = "services/shortcuts_unavailable.rs"]
pub(crate) mod shortcuts;
#[cfg(any(windows, target_os = "macos", test))]
pub(crate) mod task_dialog_model;
#[cfg(windows)]
pub(crate) mod task_dialogs;
#[cfg(target_os = "macos")]
#[path = "services/task_dialogs_macos.rs"]
pub(crate) mod task_dialogs;
#[cfg(not(any(windows, target_os = "macos")))]
#[path = "services/task_dialogs_unavailable.rs"]
pub(crate) mod task_dialogs;
#[cfg(target_os = "linux")]
pub(crate) mod x11;

/// GPUI's macOS and Windows displays report a work area; the pinned X11 and
/// Wayland displays report none (`PlatformDisplay::visible_bounds` defaults to
/// `bounds`).
pub(crate) const DISPLAY_DETAILS: bool = cfg!(any(target_os = "macos", target_os = "windows"));

/// Whether snapshots name their display. GPUI's macOS display UUID comes from
/// CoreGraphics, the Windows one from the GDI device name, and the pinned
/// Wayland one is a v5 UUID of the `wl_output.name` (wl_output v4) connector
/// name. The pinned X11 display's UUID is all zeros, so X11 names nothing.
pub(crate) fn display_identity(cx: &App) -> bool {
    cfg!(any(target_os = "macos", target_os = "windows")) || wayland(cx)
}

/// Whether owned windows report display changes. GPUI's macOS and Windows
/// windows notify display observers when the window changes display or the OS
/// reconfigures its display, and so does the pinned Wayland window when the
/// compositor moves its surface to another output (`wl_surface.enter` and
/// `leave`) or reconfigures that output. The pinned X11 window's
/// `on_display_changed` is a no-op.
pub(crate) fn display_changes(cx: &App) -> bool {
    cfg!(any(target_os = "macos", target_os = "windows")) || wayland(cx)
}

fn wayland(cx: &App) -> bool {
    cfg!(target_os = "linux") && cx.compositor_name() == "Wayland"
}

pub(crate) const DISPLAY_PERMISSION_ARGUMENT: &str = "--bun-native-allow-window-display";
pub(crate) const CLIPBOARD_READ_ARGUMENT: &str = "--bun-native-allow-clipboard-read";
pub(crate) const CLIPBOARD_WRITE_ARGUMENT: &str = "--bun-native-allow-clipboard-write";
pub(crate) const GLOBAL_SHORTCUTS_ARGUMENT: &str = "--bun-native-allow-global-shortcuts";
pub(crate) const NOTIFICATIONS_ARGUMENT: &str = "--bun-native-allow-notifications";
pub(crate) const DRAG_DROP_ARGUMENT: &str = "--bun-native-allow-drag-drop";
/// `--bun-native-filesystem-root=<read|read_write>:<id>:<absolute path>`.
pub(crate) const FILESYSTEM_ROOT_ARGUMENT: &str = "--bun-native-filesystem-root=";
/// `--bun-native-process=<id>:<absolute executable path>`.
pub(crate) const PROCESS_ARGUMENT: &str = "--bun-native-process=";
/// `--bun-native-process-limits=<id>:cpu_seconds=N,memory_bytes=N,open_files=N`,
/// after that executable's own argument.
pub(crate) const PROCESS_LIMITS_ARGUMENT: &str = "--bun-native-process-limits=";

/// Whether a validated absolute launch path is in this platform's form: a
/// Windows host opens only drive paths, a POSIX host only `/` paths.
fn native_path(path: &str) -> bool {
    if cfg!(windows) {
        bun_native_protocol::windows_root_path(path)
    } else {
        bun_native_protocol::posix_root_path(path)
    }
}

fn process_executable(argument: &str) -> Result<ProcessExecutable, &'static str> {
    let (id, executable) = argument
        .split_once(':')
        .ok_or("process argument must be <id>:<path>")?;
    let entry = ProcessExecutable {
        id: id.into(),
        executable: executable.into(),
        limits: None,
    };
    entry.validate()?;
    if !native_path(&entry.executable) {
        return Err("process executable is not an absolute path on this platform");
    }
    Ok(entry)
}

fn filesystem_root(argument: &str) -> Result<FilesystemRoot, &'static str> {
    let mut parts = argument.splitn(3, ':');
    let access = match parts.next() {
        Some("read") => FileAccess::Read,
        Some("read_write") => FileAccess::ReadWrite,
        _ => return Err("filesystem root access must be read or read_write"),
    };
    let (Some(id), Some(path)) = (parts.next(), parts.next()) else {
        return Err("filesystem root argument must be <access>:<id>:<path>");
    };
    let root = FilesystemRoot {
        id: id.into(),
        path: path.into(),
        access,
    };
    root.validate()?;
    if !native_path(&root.path) {
        return Err("filesystem root path is not an absolute path on this platform");
    }
    Ok(root)
}

pub(crate) const FILE_DIALOGS_ARGUMENT: &str = "--bun-native-allow-file-dialogs";
pub(crate) const APP_MENU_ARGUMENT: &str = "--bun-native-allow-app-menu";
pub(crate) const TASK_DIALOGS_ARGUMENT: &str = "--bun-native-allow-task-dialogs";

/// When the host binary is started as the Windows console interrupt helper,
/// runs it and returns its exit code; `None` for a normal start.
#[cfg(windows)]
pub(crate) fn console_interrupt_helper(
    arguments: impl IntoIterator<Item = OsString>,
) -> Option<i32> {
    use bun_native_windows_services::process::{INTERRUPT_HELPER_ARGUMENT, send_console_interrupt};
    let mut arguments = arguments.into_iter();
    if arguments.next()? != INTERRUPT_HELPER_ARGUMENT {
        return None;
    }
    let sent = arguments
        .next()
        .and_then(|pid| pid.to_str()?.parse::<u32>().ok())
        .is_some_and(|pid| send_console_interrupt(pid).is_ok());
    Some(i32::from(!sent))
}

pub(crate) fn policy(
    arguments: impl IntoIterator<Item = OsString>,
) -> Result<ServicePolicy, &'static str> {
    let mut policy = ServicePolicy::default();
    for argument in arguments {
        if let Some(root) = argument
            .to_str()
            .and_then(|value| value.strip_prefix(FILESYSTEM_ROOT_ARGUMENT))
        {
            policy.filesystem_roots.push(filesystem_root(root)?);
            validate_filesystem_roots(&policy.filesystem_roots)?;
            continue;
        }
        if let Some(entry) = argument
            .to_str()
            .and_then(|value| value.strip_prefix(PROCESS_ARGUMENT))
        {
            policy.processes.push(process_executable(entry)?);
            validate_process_executables(&policy.processes)?;
            continue;
        }
        if let Some(text) = argument
            .to_str()
            .and_then(|value| value.strip_prefix(PROCESS_LIMITS_ARGUMENT))
        {
            const UNGRANTED: &str = "process limits must follow their granted executable, once";
            let (id, limits) = text.split_once(':').ok_or(UNGRANTED)?;
            let entry = policy
                .processes
                .iter_mut()
                .find(|entry| entry.id == id)
                .filter(|entry| entry.limits.is_none())
                .ok_or(UNGRANTED)?;
            entry.limits = Some(ProcessLimits::from_argument(limits)?);
            continue;
        }
        let permission = if argument == DISPLAY_PERMISSION_ARGUMENT {
            &mut policy.window_display
        } else if argument == CLIPBOARD_READ_ARGUMENT {
            &mut policy.clipboard_read
        } else if argument == CLIPBOARD_WRITE_ARGUMENT {
            &mut policy.clipboard_write
        } else if argument == GLOBAL_SHORTCUTS_ARGUMENT {
            &mut policy.global_shortcuts
        } else if argument == NOTIFICATIONS_ARGUMENT {
            &mut policy.notifications
        } else if argument == FILE_DIALOGS_ARGUMENT {
            &mut policy.file_dialogs
        } else if argument == DRAG_DROP_ARGUMENT {
            &mut policy.drag_drop
        } else if argument == APP_MENU_ARGUMENT {
            &mut policy.app_menu
        } else if argument == TASK_DIALOGS_ARGUMENT {
            &mut policy.task_dialogs
        } else {
            return Err("unknown native host argument");
        };
        if std::mem::replace(permission, true) {
            return Err("duplicate native host argument");
        }
    }
    Ok(policy)
}

pub(crate) fn display_snapshot(
    window: &Window,
    cx: &App,
) -> Result<DisplaySnapshot, (ErrorCode, &'static str)> {
    let display = window.display(cx).ok_or((
        ErrorCode::ServiceUnavailable,
        "the owned window has no current native display",
    ))?;
    let logical = |bounds: Bounds<Pixels>| DisplayBounds {
        x: f64::from(f32::from(bounds.origin.x)),
        y: f64::from(f32::from(bounds.origin.y)),
        width: f64::from(f32::from(bounds.size.width)),
        height: f64::from(f32::from(bounds.size.height)),
    };
    let snapshot = DisplaySnapshot {
        bounds: logical(display.bounds()),
        scale_factor: f64::from(window.scale_factor()),
        // The X11 and Wayland displays have no work area (it repeats
        // `bounds`), so only macOS and Windows report one.
        visible_bounds: DISPLAY_DETAILS.then(|| logical(display.visible_bounds())),
        // A Wayland output without a `wl_output.name` (before wl_output v4)
        // has no UUID, and so no identity.
        display_uuid: display_identity(cx)
            .then(|| display.uuid().ok().map(|uuid| uuid.to_string()))
            .flatten(),
    };
    snapshot
        .validate()
        .map_err(|message| (ErrorCode::NativeFailure, message))?;
    Ok(snapshot)
}

/// Whether an owned window's GPUI display can still be trusted after the
/// platform disconnected displays.
///
/// The pinned Wayland backend keeps an output in a surface's entered set when
/// the compositor removes that output's global without a `wl_surface.leave`,
/// as wlroots does on unplug, so the window keeps naming the removed display
/// and reports no move. A later output can reuse the removed output's protocol
/// id, and so its `DisplayId`. A window whose display was removed is therefore
/// untrusted until GPUI reports that it moved to a different display; until
/// then a snapshot fails closed and no change is reported.
#[derive(Debug, Default, PartialEq, Eq)]
pub(crate) struct DisplayContinuity {
    current: Option<DisplayId>,
    lost: Option<DisplayId>,
}

impl DisplayContinuity {
    pub(crate) fn new(current: Option<DisplayId>) -> Self {
        Self {
            current,
            lost: None,
        }
    }

    /// GPUI notified the window's display observers and now names `display`.
    /// Returns whether the window's display is trustworthy.
    pub(crate) fn observed(&mut self, display: Option<DisplayId>) -> bool {
        if let Some(lost) = self.lost {
            if display.is_none_or(|display| display == lost) {
                return false;
            }
            self.lost = None;
        }
        self.current = display;
        true
    }

    /// The platform disconnected `display`.
    pub(crate) fn removed(&mut self, display: DisplayId) {
        if self.current == Some(display) {
            self.lost = Some(display);
        }
    }

    pub(crate) fn connected(&self) -> bool {
        self.lost.is_none()
    }
}

/// The display observation of one owned window: dropping it stops reports.
pub(crate) struct DisplayObservation {
    continuity: Rc<RefCell<DisplayContinuity>>,
    _subscriptions: Vec<Subscription>,
}

impl DisplayObservation {
    /// False after the window's display was disconnected and before GPUI
    /// reported where the window is now.
    pub(crate) fn connected(&self) -> bool {
        self.continuity.borrow().connected()
    }
}

/// Reports each display change of a live owned window with a fresh snapshot.
/// GPUI calls the observer when the window moves to another display or when
/// the OS display configuration changes that display's bounds or refresh
/// rate. The subscriptions are the window entry's; dropping them stops
/// reports.
///
/// On Wayland the window learns its output (`wl_surface.enter`) before its new
/// scale (`preferred_scale`), and an output's scale can change after its
/// geometry. The snapshot is therefore read after the current batch of
/// compositor events, again whenever the window's scale or size changes, and
/// reported only when it differs from the last one reported.
pub(crate) fn observe_display(
    handle: WindowHandle<NativeView>,
    window_id: WindowId,
    state: SharedWindowState,
    events: EventSink,
    cx: &mut App,
) -> Option<DisplayObservation> {
    let wayland = wayland(cx);
    let reporter = Reporter {
        window_id,
        state,
        events,
        // The last snapshot reported, so a re-read reports only a change.
        reported: Rc::new(RefCell::new(None)),
        continuity: Rc::new(RefCell::new(DisplayContinuity::default())),
    };
    let mut subscriptions = handle
        .update(cx, |_, window, cx| {
            *reporter.continuity.borrow_mut() =
                DisplayContinuity::new(window.display(cx).map(|display| display.id()));
            if wayland {
                *reporter.reported.borrow_mut() = display_snapshot(window, cx).ok();
            }
            let display = {
                let reporter = reporter.clone();
                window.observe_window_display(move |window, cx| {
                    if !reporter.state.borrow().active {
                        return;
                    }
                    let display = window.display(cx).map(|display| display.id());
                    if !reporter.continuity.borrow_mut().observed(display) {
                        return;
                    }
                    if wayland {
                        reporter.schedule(window, cx);
                        return;
                    }
                    // A window between displays has no snapshot to report; the
                    // next change, or an explicit read, observes where it lands.
                    if let Ok(snapshot) = display_snapshot(window, cx) {
                        report(
                            &reporter.events,
                            window_id,
                            &reporter.reported,
                            snapshot,
                            cx,
                        );
                    }
                    settle(
                        window,
                        window_id,
                        &reporter.state,
                        &reporter.events,
                        &reporter.reported,
                        cx,
                    );
                })
            };
            let mut subscriptions = vec![display];
            if wayland {
                let reporter = reporter.clone();
                subscriptions.push(cx.observe_window_bounds(window, move |_, window, cx| {
                    reporter.schedule(window, cx);
                }));
            }
            subscriptions
        })
        .ok()?;
    let continuity = reporter.continuity.clone();
    subscriptions.push(cx.observe_displays(move |event, _| {
        if let DisplayEvent::Removed(display) = event {
            continuity.borrow_mut().removed(display);
        }
    }));
    Some(DisplayObservation {
        continuity: reporter.continuity,
        _subscriptions: subscriptions,
    })
}

/// One owned window's change reporting state.
#[derive(Clone)]
struct Reporter {
    window_id: WindowId,
    state: SharedWindowState,
    events: EventSink,
    reported: Rc<RefCell<Option<DisplaySnapshot>>>,
    continuity: Rc<RefCell<DisplayContinuity>>,
}

impl Reporter {
    /// Reads the snapshot once the current batch of platform events has been
    /// handled, so an output's geometry and the window's scale are read
    /// together, and reports it if it differs from the last one reported and
    /// the window's display is still connected.
    fn schedule(&self, window: &Window, cx: &App) {
        let reporter = self.clone();
        window
            .spawn(cx, async move |cx| {
                let _ = cx.update(move |window, cx| {
                    if !reporter.state.borrow().active || !reporter.continuity.borrow().connected()
                    {
                        return;
                    }
                    if let Ok(snapshot) = display_snapshot(window, cx)
                        && reporter.reported.borrow().as_ref() != Some(&snapshot)
                    {
                        report(
                            &reporter.events,
                            reporter.window_id,
                            &reporter.reported,
                            snapshot,
                            cx,
                        );
                    }
                });
            })
            .detach();
    }
}

fn report(
    events: &EventSink,
    window_id: WindowId,
    reported: &RefCell<Option<DisplaySnapshot>>,
    snapshot: DisplaySnapshot,
    cx: &mut App,
) {
    *reported.borrow_mut() = Some(snapshot.clone());
    events.ui(
        |sequence| Event::DisplayChanged {
            sequence,
            window_id,
            snapshot,
        },
        cx,
    );
}

/// macOS recomputes the work area (menu bar and Dock) after it has announced
/// a display change, so the first snapshot can be stale. Re-read twice after
/// the change and report only a snapshot that differs from the last reported.
fn settle(
    window: &Window,
    window_id: WindowId,
    state: &SharedWindowState,
    events: &EventSink,
    reported: &Rc<RefCell<Option<DisplaySnapshot>>>,
    cx: &App,
) {
    if !cfg!(target_os = "macos") {
        return;
    }
    let (state, events, reported) = (state.clone(), events.clone(), reported.clone());
    window
        .spawn(cx, async move |cx| {
            for delay in DISPLAY_SETTLE_DELAYS {
                cx.background_executor().timer(delay).await;
                let reported = reported.clone();
                let (state, events) = (state.clone(), events.clone());
                let live = cx
                    .update(move |window, cx| {
                        if !state.borrow().active {
                            return false;
                        }
                        if let Ok(snapshot) = display_snapshot(window, cx)
                            && reported.borrow().as_ref() != Some(&snapshot)
                        {
                            report(&events, window_id, &reported, snapshot, cx);
                        }
                        true
                    })
                    .unwrap_or(false);
                if !live {
                    return;
                }
            }
        })
        .detach();
}

/// Delays after a display change at which the snapshot is read again.
const DISPLAY_SETTLE_DELAYS: [Duration; 3] = [
    Duration::from_millis(300),
    Duration::from_millis(1200),
    Duration::from_millis(3000),
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_window_whose_display_was_removed_is_untrusted_until_it_moves_elsewhere() {
        let (first, second, third) = (DisplayId::new(4), DisplayId::new(5), DisplayId::new(6));
        let mut continuity = DisplayContinuity::new(Some(second));
        // Removing another display changes nothing.
        continuity.removed(first);
        assert!(continuity.connected());
        // The window's display goes away and GPUI still names it.
        continuity.removed(second);
        assert!(!continuity.connected());
        assert!(!continuity.observed(None));
        // A new output that reuses the removed id is not the window's display.
        assert!(!continuity.observed(Some(second)));
        assert!(!continuity.connected());
        // GPUI reports a move to a different display: trusted again.
        assert!(continuity.observed(Some(third)));
        assert!(continuity.connected());
        continuity.removed(second);
        assert!(continuity.connected());
        // A move reported before the removal leaves the window trusted.
        let mut continuity = DisplayContinuity::new(Some(first));
        assert!(continuity.observed(Some(second)));
        continuity.removed(first);
        assert!(continuity.connected());
        // A window that has not yet entered any display stays trusted.
        let mut continuity = DisplayContinuity::new(None);
        continuity.removed(first);
        assert!(continuity.connected());
        assert!(continuity.observed(None));
    }

    #[test]
    fn service_policy_is_default_deny_and_accepts_only_an_explicit_launch_grant() {
        assert_eq!(policy([]).unwrap(), ServicePolicy::default());
        assert_eq!(
            policy([OsString::from(DISPLAY_PERMISSION_ARGUMENT)]).unwrap(),
            ServicePolicy {
                window_display: true,
                ..ServicePolicy::default()
            }
        );
        for arguments in [
            vec![DISPLAY_PERMISSION_ARGUMENT, DISPLAY_PERMISSION_ARGUMENT],
            vec!["--bun-native-allow-clipboard"],
            vec!["--bun-native-allow-window-display=true"],
        ] {
            assert!(policy(arguments.into_iter().map(OsString::from)).is_err());
        }
        assert_eq!(
            policy([CLIPBOARD_READ_ARGUMENT, CLIPBOARD_WRITE_ARGUMENT].map(OsString::from))
                .unwrap(),
            ServicePolicy {
                window_display: false,
                clipboard_read: true,
                clipboard_write: true,
                global_shortcuts: false,
                notifications: false,
                drag_drop: false,
                filesystem_roots: Vec::new(),
                processes: Vec::new(),
                file_dialogs: false,
                app_menu: false,
                task_dialogs: false,
            }
        );
        assert_eq!(
            policy([OsString::from(GLOBAL_SHORTCUTS_ARGUMENT)]).unwrap(),
            ServicePolicy {
                global_shortcuts: true,
                ..ServicePolicy::default()
            }
        );
        assert_eq!(
            policy([OsString::from(NOTIFICATIONS_ARGUMENT)]).unwrap(),
            ServicePolicy {
                notifications: true,
                ..ServicePolicy::default()
            }
        );
        assert_eq!(
            policy([OsString::from(FILE_DIALOGS_ARGUMENT)]).unwrap(),
            ServicePolicy {
                file_dialogs: true,
                ..ServicePolicy::default()
            }
        );
        assert_eq!(
            policy([OsString::from(APP_MENU_ARGUMENT)]).unwrap(),
            ServicePolicy {
                app_menu: true,
                ..ServicePolicy::default()
            }
        );
        assert_eq!(
            policy([OsString::from(TASK_DIALOGS_ARGUMENT)]).unwrap(),
            ServicePolicy {
                task_dialogs: true,
                ..ServicePolicy::default()
            }
        );
        assert_eq!(
            policy([OsString::from(DRAG_DROP_ARGUMENT)]).unwrap(),
            ServicePolicy {
                drag_drop: true,
                ..ServicePolicy::default()
            }
        );
        for argument in [
            CLIPBOARD_READ_ARGUMENT,
            CLIPBOARD_WRITE_ARGUMENT,
            GLOBAL_SHORTCUTS_ARGUMENT,
            NOTIFICATIONS_ARGUMENT,
            FILE_DIALOGS_ARGUMENT,
            DRAG_DROP_ARGUMENT,
            APP_MENU_ARGUMENT,
            TASK_DIALOGS_ARGUMENT,
        ] {
            assert!(policy([argument, argument].map(OsString::from)).is_err());
        }
    }

    /// Absolute paths in this platform's form, then the other platform's.
    #[cfg(not(windows))]
    const PATHS: [&str; 4] = ["/srv/docs", "/tmp/a:b", "/srv", "C:\\srv"];
    #[cfg(windows)]
    const PATHS: [&str; 4] = ["C:\\srv\\docs", "D:\\tmp\\a b", "C:\\srv", "/srv"];
    const SEPARATOR: char = if cfg!(windows) { '\\' } else { '/' };

    #[test]
    fn filesystem_roots_are_explicit_validated_and_ordered() {
        let [docs, work, srv, foreign] = PATHS;
        let roots = policy(
            [
                format!("--bun-native-filesystem-root=read:docs:{docs}"),
                format!("--bun-native-filesystem-root=read_write:work:{work}"),
            ]
            .map(OsString::from),
        )
        .unwrap()
        .filesystem_roots;
        assert_eq!(
            roots,
            [
                FilesystemRoot {
                    id: "docs".into(),
                    path: docs.into(),
                    access: FileAccess::Read,
                },
                FilesystemRoot {
                    id: "work".into(),
                    path: work.into(),
                    access: FileAccess::ReadWrite,
                },
            ]
        );
        for arguments in [
            vec![format!("--bun-native-filesystem-root=write:docs:{srv}")],
            vec![format!("--bun-native-filesystem-root=read:Docs:{srv}")],
            vec!["--bun-native-filesystem-root=read:docs:relative".into()],
            vec![format!(
                "--bun-native-filesystem-root=read:docs:{srv}{SEPARATOR}..{SEPARATOR}etc"
            )],
            vec![format!(
                "--bun-native-filesystem-root=read:docs:{srv}{SEPARATOR}"
            )],
            vec!["--bun-native-filesystem-root=read:docs".into()],
            vec![format!("--bun-native-filesystem-root=read:docs:{foreign}")],
            vec![
                format!("--bun-native-filesystem-root=read:docs:{srv}"),
                format!("--bun-native-filesystem-root=read:docs:{docs}"),
            ],
        ] {
            assert!(
                policy(arguments.iter().map(OsString::from)).is_err(),
                "{arguments:?}"
            );
        }
        let many: Vec<_> = (0..9)
            .map(|index| {
                OsString::from(format!("--bun-native-filesystem-root=read:r{index}:{srv}"))
            })
            .collect();
        assert!(policy(many).is_err());
    }

    #[test]
    fn process_executables_are_explicit_validated_and_ordered() {
        #[cfg(not(windows))]
        let [shell, tool, root, foreign] = ["/bin/sh", "/opt/a:b/tool", "/", "C:\\bin\\sh.exe"];
        #[cfg(windows)]
        let [shell, tool, root, foreign] = [
            "C:\\Windows\\System32\\cmd.exe",
            "D:\\opt\\a b\\tool.exe",
            "C:\\",
            "/bin/sh",
        ];
        let entries = policy(
            [
                format!("--bun-native-process=shell:{shell}"),
                format!("--bun-native-process=tool:{tool}"),
            ]
            .map(OsString::from),
        )
        .unwrap()
        .processes;
        assert_eq!(
            entries,
            [
                ProcessExecutable {
                    id: "shell".into(),
                    executable: shell.into(),
                    limits: None,
                },
                ProcessExecutable {
                    id: "tool".into(),
                    executable: tool.into(),
                    limits: None,
                },
            ]
        );
        for arguments in [
            vec!["--bun-native-process=shell".into()],
            vec![format!("--bun-native-process=Shell:{shell}")],
            vec!["--bun-native-process=shell:sh".into()],
            vec![format!("--bun-native-process=shell:{root}")],
            vec![format!(
                "--bun-native-process=shell:{shell}{SEPARATOR}..{SEPARATOR}sh"
            )],
            vec![format!("--bun-native-process=shell:{foreign}")],
            vec![
                format!("--bun-native-process=shell:{shell}"),
                format!("--bun-native-process=shell:{tool}"),
            ],
        ] {
            assert!(
                policy(arguments.iter().map(OsString::from)).is_err(),
                "{arguments:?}"
            );
        }
        let many: Vec<_> = (0..9)
            .map(|index| OsString::from(format!("--bun-native-process=p{index}:{shell}")))
            .collect();
        assert!(policy(many).is_err());
        let limited = policy(
            [
                format!("--bun-native-process=shell:{shell}"),
                "--bun-native-process-limits=shell:cpu_seconds=2,open_files=16".into(),
            ]
            .map(OsString::from),
        )
        .unwrap()
        .processes;
        assert_eq!(
            limited[0].limits,
            Some(ProcessLimits {
                cpu_seconds: Some(2),
                memory_bytes: None,
                open_files: Some(16),
            })
        );
        // An earlier executable may take its limits after another entry, as in
        // the TypeScript parser.
        let interleaved = policy(
            [
                format!("--bun-native-process=shell:{shell}"),
                format!("--bun-native-process=tool:{shell}"),
                "--bun-native-process-limits=shell:cpu_seconds=2".into(),
            ]
            .map(OsString::from),
        )
        .unwrap()
        .processes;
        assert_eq!(
            interleaved[0].limits.and_then(|limits| limits.cpu_seconds),
            Some(2)
        );
        assert_eq!(interleaved[1].limits, None);
        for arguments in [
            // Before its executable, for another ID, twice, or malformed.
            vec![
                "--bun-native-process-limits=shell:cpu_seconds=2".into(),
                format!("--bun-native-process=shell:{shell}"),
            ],
            vec![
                format!("--bun-native-process=shell:{shell}"),
                "--bun-native-process-limits=tool:cpu_seconds=2".into(),
            ],
            vec![
                format!("--bun-native-process=shell:{shell}"),
                "--bun-native-process-limits=shell:cpu_seconds=2".into(),
                "--bun-native-process-limits=shell:open_files=8".into(),
            ],
            vec![
                format!("--bun-native-process=shell:{shell}"),
                "--bun-native-process-limits=shell:cpu_seconds=0".into(),
            ],
            vec![
                format!("--bun-native-process=shell:{shell}"),
                "--bun-native-process-limits=shell".into(),
            ],
        ] {
            assert!(
                policy(arguments.iter().map(OsString::from)).is_err(),
                "{arguments:?}"
            );
        }
    }
}
