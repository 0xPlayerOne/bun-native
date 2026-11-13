//! Bounded file drops onto owned targets. A dropped item crosses the wire only
//! as an untrusted display name; its path stays in the host and never grants
//! authority by itself.

use crate::{MAX_DROP_ITEMS, MAX_DROP_NAME_BYTES};
use serde::{Deserialize, Serialize};

/// Whether an external file drag is over an owned target.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DragState {
    Entered,
    Left,
}

/// Why a drop onto a live target delivered no items.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DropRejection {
    /// The drag carried no local file (for example, plain text or a remote URL).
    Empty,
    /// More than [`MAX_DROP_ITEMS`] items, or a list the native backend may
    /// have truncated.
    LimitExceeded,
}

/// Untrusted display metadata: the final path component, lossily decoded,
/// with control characters replaced. It is not unique and not a path.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DroppedItem {
    pub name: String,
}

pub fn validate_drop_name(name: &str) -> Result<(), &'static str> {
    if name.is_empty() || name.len() > MAX_DROP_NAME_BYTES || name.chars().any(char::is_control) {
        return Err("dropped item name must be 1-255 UTF-8 bytes without control characters");
    }
    Ok(())
}

pub fn validate_drop_items(items: &[DroppedItem]) -> Result<(), &'static str> {
    if items.is_empty() || items.len() > MAX_DROP_ITEMS {
        return Err("a drop must deliver between 1 and 64 items");
    }
    items
        .iter()
        .try_for_each(|item| validate_drop_name(&item.name))
}

pub fn validate_drop_item_index(item: u32) -> Result<(), &'static str> {
    if item as usize >= MAX_DROP_ITEMS {
        return Err("dropped item index must be below 64");
    }
    Ok(())
}
