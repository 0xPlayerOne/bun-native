//! Policy is fixed before the private channel starts. Wire messages cannot grant it.

use bun_native_protocol::{
    DisplayBounds, DisplaySnapshot, ErrorCode, FileAccess, FilesystemRoot, ServicePolicy,
    validate_filesystem_roots,
};
use gpui::{App, Window};
use std::ffi::OsString;

#[cfg(target_os = "linux")]
pub(crate) mod clipboard;
#[cfg(not(target_os = "linux"))]
#[path = "services/clipboard_unavailable.rs"]
pub(crate) mod clipboard;
pub(crate) mod file_dialogs;
#[cfg(not(target_os = "linux"))]
#[path = "services/file_dialogs_unavailable.rs"]
pub(crate) mod file_dialogs;
#[cfg(target_os = "linux")]
pub(crate) mod files;
#[cfg(not(target_os = "linux"))]
#[path = "services/files_unavailable.rs"]
pub(crate) mod files;
#[cfg(target_os = "linux")]
pub(crate) mod notifications;
#[cfg(not(target_os = "linux"))]
#[path = "services/notifications_unavailable.rs"]
pub(crate) mod notifications;
#[cfg(target_os = "linux")]
pub(crate) mod shortcuts;
#[cfg(not(target_os = "linux"))]
#[path = "services/shortcuts_unavailable.rs"]
pub(crate) mod shortcuts;
#[cfg(target_os = "linux")]
pub(crate) mod x11;

pub(crate) const DISPLAY_PERMISSION_ARGUMENT: &str = "--bun-native-allow-window-display";
pub(crate) const CLIPBOARD_READ_ARGUMENT: &str = "--bun-native-allow-clipboard-read";
pub(crate) const CLIPBOARD_WRITE_ARGUMENT: &str = "--bun-native-allow-clipboard-write";
pub(crate) const GLOBAL_SHORTCUTS_ARGUMENT: &str = "--bun-native-allow-global-shortcuts";
pub(crate) const NOTIFICATIONS_ARGUMENT: &str = "--bun-native-allow-notifications";
/// `--bun-native-filesystem-root=<read|read_write>:<id>:<absolute path>`.
pub(crate) const FILESYSTEM_ROOT_ARGUMENT: &str = "--bun-native-filesystem-root=";

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
    let bounds = display.bounds();
    let snapshot = DisplaySnapshot {
        bounds: DisplayBounds {
            x: f64::from(f32::from(bounds.origin.x)),
            y: f64::from(f32::from(bounds.origin.y)),
            width: f64::from(f32::from(bounds.size.width)),
            height: f64::from(f32::from(bounds.size.height)),
        },
        scale_factor: f64::from(window.scale_factor()),
    };
    snapshot
        .validate()
        .map_err(|message| (ErrorCode::NativeFailure, message))?;
    Ok(snapshot)
}

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
                filesystem_roots: Vec::new(),
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
        for argument in [
            CLIPBOARD_READ_ARGUMENT,
            CLIPBOARD_WRITE_ARGUMENT,
            GLOBAL_SHORTCUTS_ARGUMENT,
            NOTIFICATIONS_ARGUMENT,
            FILE_DIALOGS_ARGUMENT,
        ] {
            assert!(policy([argument, argument].map(OsString::from)).is_err());
        }
    }

    #[test]
    fn filesystem_roots_are_explicit_validated_and_ordered() {
        let roots = policy(
            [
                "--bun-native-filesystem-root=read:docs:/srv/docs",
                "--bun-native-filesystem-root=read_write:work:/tmp/a:b",
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
                    path: "/srv/docs".into(),
                    access: FileAccess::Read,
                },
                FilesystemRoot {
                    id: "work".into(),
                    path: "/tmp/a:b".into(),
                    access: FileAccess::ReadWrite,
                },
            ]
        );
        for arguments in [
            vec!["--bun-native-filesystem-root=write:docs:/srv"],
            vec!["--bun-native-filesystem-root=read:Docs:/srv"],
            vec!["--bun-native-filesystem-root=read:docs:relative"],
            vec!["--bun-native-filesystem-root=read:docs:/srv/../etc"],
            vec!["--bun-native-filesystem-root=read:docs:/srv/"],
            vec!["--bun-native-filesystem-root=read:docs"],
            vec![
                "--bun-native-filesystem-root=read:docs:/a",
                "--bun-native-filesystem-root=read:docs:/b",
            ],
        ] {
            assert!(policy(arguments.into_iter().map(OsString::from)).is_err());
        }
        let many: Vec<_> = (0..9)
            .map(|index| OsString::from(format!("--bun-native-filesystem-root=read:r{index}:/r")))
            .collect();
        assert!(policy(many).is_err());
    }
}
