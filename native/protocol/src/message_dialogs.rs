//! Owned OS message dialogs (Windows task dialogs). The options are the same
//! validated values as the public `showMessageDialog` call: the overlay
//! backend and the OS backend accept and answer the same shape.

use crate::{
    MAX_MESSAGE_DIALOG_BUTTONS, MAX_MESSAGE_DIALOG_DETAIL_BYTES, MAX_MESSAGE_DIALOG_ID_BYTES,
    MAX_MESSAGE_DIALOG_LABEL_BYTES, MAX_MESSAGE_DIALOG_MESSAGE_BYTES,
    MAX_MESSAGE_DIALOG_TITLE_BYTES,
};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

/// Live message dialogs per session. Each window owns at most one at a time.
pub const MAX_MESSAGE_DIALOGS: usize = 16;

fn non_null<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    T::deserialize(deserializer).map(Some)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MessageDialogButton {
    /// Returned in the result; 1-64 bytes without control characters.
    pub id: String,
    /// One nonblank line of at most 64 bytes.
    pub label: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct MessageDialogOptions {
    pub title: String,
    pub message: String,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "non_null"
    )]
    pub detail: Option<String>,
    pub buttons: Vec<MessageDialogButton>,
    /// The focused button. Names one of `buttons`.
    pub default_button: String,
    /// The button the close box and Escape activate. Names one of `buttons`.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "non_null"
    )]
    pub cancel_button: Option<String>,
    /// Escape and the close box resolve `dismissed` when there is no cancel
    /// button. Neither does anything for a dialog that is neither.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub dismissible: bool,
}

/// Nonblank text of at most `maximum` bytes. A single line has no control
/// character; a block may contain line feeds.
fn text(value: &str, maximum: usize, block: bool) -> bool {
    !value.trim().is_empty()
        && value.len() <= maximum
        && !value
            .chars()
            .any(|character| character.is_control() && !(block && character == '\n'))
}

impl MessageDialogOptions {
    pub fn validate(&self) -> Result<(), &'static str> {
        if !text(&self.title, MAX_MESSAGE_DIALOG_TITLE_BYTES, false) {
            return Err(
                "message dialog title must be one nonblank line of at most 256 bytes without control characters",
            );
        }
        if !text(&self.message, MAX_MESSAGE_DIALOG_MESSAGE_BYTES, true) {
            return Err(
                "message dialog message must be nonblank, at most 2048 bytes, with no control character but line feed",
            );
        }
        if self
            .detail
            .as_ref()
            .is_some_and(|detail| !text(detail, MAX_MESSAGE_DIALOG_DETAIL_BYTES, true))
        {
            return Err(
                "message dialog detail must be nonblank, at most 4096 bytes, with no control character but line feed",
            );
        }
        if self.buttons.is_empty() || self.buttons.len() > MAX_MESSAGE_DIALOG_BUTTONS {
            return Err("a message dialog needs between 1 and 4 buttons");
        }
        let mut ids = HashSet::new();
        for button in &self.buttons {
            if !text(&button.id, MAX_MESSAGE_DIALOG_ID_BYTES, false) {
                return Err(
                    "message dialog button id must be nonblank, at most 64 bytes, without control characters",
                );
            }
            if !text(&button.label, MAX_MESSAGE_DIALOG_LABEL_BYTES, false) {
                return Err(
                    "message dialog button label must be one nonblank line of at most 64 bytes",
                );
            }
            if !ids.insert(button.id.as_str()) {
                return Err("message dialog button ids must be unique");
            }
        }
        if !ids.contains(self.default_button.as_str()) {
            return Err("message dialog default button must name one of its buttons");
        }
        if self
            .cancel_button
            .as_ref()
            .is_some_and(|cancel| !ids.contains(cancel.as_str()))
        {
            return Err("message dialog cancel button must name one of its buttons");
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum MessageDialogResult {
    /// The user chose this button (the cancel button for Escape).
    Button {
        id: String,
    },
    /// The user closed a `dismissible` dialog without a cancel button.
    Dismissed {},
    Failed {},
}

impl MessageDialogResult {
    pub fn validate(&self) -> Result<(), &'static str> {
        match self {
            Self::Button { id } if !text(id, MAX_MESSAGE_DIALOG_ID_BYTES, false) => {
                Err("message dialog result id must be nonblank, at most 64 bytes, without control characters")
            }
            _ => Ok(()),
        }
    }
}
