//! Native services have an immutable launch policy, separate from features.

use serde::{Deserialize, Serialize};

const MAX_DISPLAY_COORDINATE: f64 = 1_048_576.;
pub const MAX_CLIPBOARD_BYTES: usize = 8_192;
pub const MAX_SERVICE_REQUESTS: usize = 8;
pub const MAX_GLOBAL_SHORTCUTS: usize = 16;
pub const MAX_NOTIFICATIONS: usize = 32;
pub const MAX_NOTIFICATION_TITLE_BYTES: usize = 256;
pub const MAX_NOTIFICATION_BODY_BYTES: usize = 2_048;

#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ServicePolicy {
    pub window_display: bool,
    pub clipboard_read: bool,
    pub clipboard_write: bool,
    pub global_shortcuts: bool,
    pub notifications: bool,
    /// Owned targets that receive external file drops as untrusted names.
    pub drag_drop: bool,
    /// Directories a window may open as scoped grants, in launch order.
    pub filesystem_roots: Vec<crate::FilesystemRoot>,
}

/// OS-wide modifier state. Shift alone cannot form a global shortcut: at least
/// one of control, alt or platform (Super/Command/Windows) is required.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ShortcutModifiers {
    pub control: bool,
    pub alt: bool,
    pub shift: bool,
    pub platform: bool,
}

/// The closed set of layout-level keys a global shortcut may name: `a`-`z`,
/// `0`-`9` and `f1`-`f12`. Anything else is rejected, never approximated.
pub fn validate_global_shortcut(
    key: &str,
    modifiers: ShortcutModifiers,
) -> Result<(), &'static str> {
    if !matches!(
        key.as_bytes(),
        [b'a'..=b'z' | b'0'..=b'9'] | [b'f', b'1'..=b'9'] | [b'f', b'1', b'0'..=b'2']
    ) {
        return Err("global shortcut key must be one of a-z, 0-9 or f1-f12");
    }
    if !(modifiers.control || modifiers.alt || modifiers.platform) {
        return Err("global shortcut requires control, alt or platform");
    }
    Ok(())
}

/// Plain-text notification content. The title is one nonempty line; the body
/// may hold line breaks but no other control characters. Neither is markup.
pub fn validate_notification(title: &str, body: &str) -> Result<(), &'static str> {
    if title.is_empty()
        || title.len() > MAX_NOTIFICATION_TITLE_BYTES
        || title.chars().any(char::is_control)
    {
        return Err(
            "notification title must be nonempty, at most 256 bytes, and contain no control characters",
        );
    }
    if body.len() > MAX_NOTIFICATION_BODY_BYTES
        || body
            .chars()
            .any(|character| character != '\n' && character.is_control())
    {
        return Err(
            "notification body must be at most 2048 bytes with no control characters other than line feeds",
        );
    }
    Ok(())
}

/// Why the notification server removed a posted notification that the
/// application did not withdraw.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NotificationDismissal {
    Expired,
    Dismissed,
    Closed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum ClipboardText {
    Empty {},
    Text { text: String },
}

impl ClipboardText {
    pub fn validate(&self) -> Result<(), &'static str> {
        if let Self::Text { text } = self {
            validate_clipboard_text(text)?;
        }
        Ok(())
    }
}

pub fn validate_clipboard_text(text: &str) -> Result<(), &'static str> {
    if text.len() > MAX_CLIPBOARD_BYTES || text.contains('\0') {
        Err("clipboard text exceeds 8192 UTF-8 bytes or contains NUL")
    } else {
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DisplayBounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DisplaySnapshot {
    pub bounds: DisplayBounds,
    pub scale_factor: f64,
}

impl DisplaySnapshot {
    pub fn validate(&self) -> Result<(), &'static str> {
        let bounds = self.bounds;
        if [bounds.x, bounds.y]
            .into_iter()
            .any(|value| !value.is_finite() || value.abs() > MAX_DISPLAY_COORDINATE)
            || [bounds.width, bounds.height]
                .into_iter()
                .any(|value| !value.is_finite() || value <= 0. || value > MAX_DISPLAY_COORDINATE)
            || !self.scale_factor.is_finite()
            || !(0.125..=16.).contains(&self.scale_factor)
        {
            return Err("native display geometry exceeds its finite logical-pixel range");
        }
        Ok(())
    }
}
