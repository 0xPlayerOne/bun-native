//! Native services have an immutable launch policy, separate from features.

use serde::{Deserialize, Serialize};

const MAX_DISPLAY_COORDINATE: f64 = 1_048_576.;
pub const MAX_CLIPBOARD_BYTES: usize = 8_192;
pub const MAX_SERVICE_REQUESTS: usize = 8;

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ServicePolicy {
    pub window_display: bool,
    pub clipboard_read: bool,
    pub clipboard_write: bool,
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
