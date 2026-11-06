//! Policy is fixed before the private channel starts. Wire messages cannot grant it.

use crate::{channel::EventSink, state::SharedWindowState};
use bun_native_protocol::{
    DisplayBounds, DisplaySnapshot, ErrorCode, Event, FileAccess, FilesystemRoot,
    ProcessExecutable, ServicePolicy, WindowId, validate_filesystem_roots,
    validate_process_executables,
};
use gpui::{AnyWindowHandle, App, Bounds, Pixels, Subscription, Window};
use std::cell::RefCell;
use std::ffi::OsString;
use std::rc::Rc;
use std::time::Duration;

#[cfg(target_os = "linux")]
pub(crate) mod clipboard;
#[cfg(not(target_os = "linux"))]
#[path = "services/clipboard_unavailable.rs"]
pub(crate) mod clipboard;
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
#[cfg(not(target_os = "linux"))]
#[path = "services/shortcuts_unavailable.rs"]
pub(crate) mod shortcuts;
#[cfg(target_os = "linux")]
pub(crate) mod x11;

/// GPUI's macOS and Windows displays report a work area and an OS display
/// identifier; the pinned X11 display reports neither.
pub(crate) const DISPLAY_DETAILS: bool = cfg!(any(target_os = "macos", target_os = "windows"));
/// GPUI's macOS and Windows windows notify display observers when the window
/// changes display or the OS reconfigures its display; the pinned X11 window's
/// `on_display_changed` is a no-op.
pub(crate) const DISPLAY_CHANGES: bool = cfg!(any(target_os = "macos", target_os = "windows"));

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
        // The X11 display has no work area (it repeats `bounds`) and an
        // all-zero UUID, so only macOS and Windows report these details.
        visible_bounds: DISPLAY_DETAILS.then(|| logical(display.visible_bounds())),
        display_uuid: DISPLAY_DETAILS
            .then(|| display.uuid().ok().map(|uuid| uuid.to_string()))
            .flatten(),
    };
    snapshot
        .validate()
        .map_err(|message| (ErrorCode::NativeFailure, message))?;
    Ok(snapshot)
}

/// Reports each display change of a live owned window with a fresh snapshot.
/// GPUI calls the observer when the window moves to another display or when
/// the OS display configuration changes that display's bounds or refresh
/// rate. The subscription is the window entry's; dropping it stops reports.
pub(crate) fn observe_display(
    handle: AnyWindowHandle,
    window_id: WindowId,
    state: SharedWindowState,
    events: EventSink,
    cx: &mut App,
) -> Option<Subscription> {
    // The last snapshot reported, so a settle re-read reports only a change.
    let reported: Rc<RefCell<Option<DisplaySnapshot>>> = Rc::new(RefCell::new(None));
    handle
        .update(cx, |_, window, _| {
            window.observe_window_display(move |window, cx| {
                if !state.borrow().active {
                    return;
                }
                // A window between displays has no snapshot to report; the
                // next change, or an explicit read, observes where it lands.
                if let Ok(snapshot) = display_snapshot(window, cx) {
                    report(&events, window_id, &reported, snapshot, cx);
                }
                settle(window, window_id, &state, &events, &reported, cx);
            })
        })
        .ok()
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
                },
                ProcessExecutable {
                    id: "tool".into(),
                    executable: tool.into(),
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
    }
}
