//! Policy is fixed before the private channel starts. Wire messages cannot grant it.

use bun_native_protocol::{DisplayBounds, DisplaySnapshot, ErrorCode, ServicePolicy};
use gpui::{App, Window};
use std::ffi::OsString;

pub(crate) const DISPLAY_PERMISSION_ARGUMENT: &str = "--bun-native-allow-window-display";

pub(crate) fn policy(
    arguments: impl IntoIterator<Item = OsString>,
) -> Result<ServicePolicy, &'static str> {
    let mut policy = ServicePolicy::default();
    for argument in arguments {
        if argument == DISPLAY_PERMISSION_ARGUMENT && !policy.window_display {
            policy.window_display = true;
        } else {
            return Err("unknown or duplicate native host argument");
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
                window_display: true
            }
        );
        for arguments in [
            vec![DISPLAY_PERMISSION_ARGUMENT, DISPLAY_PERMISSION_ARGUMENT],
            vec!["--bun-native-allow-clipboard"],
            vec!["--bun-native-allow-window-display=true"],
        ] {
            assert!(policy(arguments.into_iter().map(OsString::from)).is_err());
        }
    }
}
