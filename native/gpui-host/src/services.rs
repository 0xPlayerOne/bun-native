//! Policy is fixed before the private channel starts. Wire messages cannot grant it.

use crate::{channel::EventSink, state::SharedWindowState};
use bun_native_protocol::{
    DisplayBounds, DisplaySnapshot, ErrorCode, Event, ServicePolicy, WindowId,
};
use gpui::{AnyWindowHandle, App, Bounds, Pixels, Subscription, Window};
use std::ffi::OsString;

#[cfg(target_os = "linux")]
pub(crate) mod clipboard;
#[cfg(not(target_os = "linux"))]
#[path = "services/clipboard_unavailable.rs"]
pub(crate) mod clipboard;
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

pub(crate) fn policy(
    arguments: impl IntoIterator<Item = OsString>,
) -> Result<ServicePolicy, &'static str> {
    let mut policy = ServicePolicy::default();
    for argument in arguments {
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
    handle
        .update(cx, |_, window, _| {
            window.observe_window_display(move |window, cx| {
                if !state.borrow().active {
                    return;
                }
                // A window between displays has no snapshot to report; the
                // next change, or an explicit read, observes where it lands.
                if let Ok(snapshot) = display_snapshot(window, cx) {
                    events.ui(
                        |sequence| Event::DisplayChanged {
                            sequence,
                            window_id,
                            snapshot,
                        },
                        cx,
                    );
                }
            })
        })
        .ok()
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
        for argument in [
            CLIPBOARD_READ_ARGUMENT,
            CLIPBOARD_WRITE_ARGUMENT,
            GLOBAL_SHORTCUTS_ARGUMENT,
            NOTIFICATIONS_ARGUMENT,
        ] {
            assert!(policy([argument, argument].map(OsString::from)).is_err());
        }
    }
}
