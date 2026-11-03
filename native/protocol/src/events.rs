//! Native event payloads carry the committed ownership route, never callbacks.

use crate::{
    validate_text, Capability, ErrorCode, EventSequence, Limits, NodeId, RequestId, WindowId,
    MAX_DEPTH, MAX_ID,
};
use serde::{Deserialize, Serialize};

pub const MAX_KEY_BYTES: usize = 256;
pub const MAX_POINTER_COORDINATE: f64 = 1_048_576.;
pub const MAX_EVENT_PATH_NODES: usize = MAX_DEPTH + 1;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct KeyModifiers {
    pub control: bool,
    pub alt: bool,
    pub shift: bool,
    pub platform: bool,
    pub function: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PointerButton {
    Left,
    Right,
    Middle,
    Back,
    Forward,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum Event {
    Ready {
        protocol: u32,
        capabilities: Vec<Capability>,
        limits: Limits,
    },
    Ack {
        id: RequestId,
    },
    Opened {
        id: RequestId,
        window_id: WindowId,
        root_id: NodeId,
        #[serde(deserialize_with = "crate::wire::safe_integer")]
        tree_revision: u64,
    },
    Applied {
        id: RequestId,
        window_id: WindowId,
        #[serde(deserialize_with = "crate::wire::safe_integer")]
        tree_revision: u64,
    },
    Click {
        sequence: EventSequence,
        window_id: WindowId,
        node_id: NodeId,
        #[serde(deserialize_with = "crate::wire::safe_integer")]
        tree_revision: u64,
        path: Vec<NodeId>,
    },
    Input {
        sequence: EventSequence,
        window_id: WindowId,
        node_id: NodeId,
        #[serde(deserialize_with = "crate::wire::safe_integer")]
        tree_revision: u64,
        path: Vec<NodeId>,
        value: String,
        #[serde(deserialize_with = "crate::wire::safe_integer")]
        input_revision: u64,
    },
    KeyDown {
        sequence: EventSequence,
        window_id: WindowId,
        node_id: NodeId,
        #[serde(deserialize_with = "crate::wire::safe_integer")]
        tree_revision: u64,
        path: Vec<NodeId>,
        key: String,
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "non_null_string"
        )]
        key_char: Option<String>,
        modifiers: KeyModifiers,
    },
    KeyUp {
        sequence: EventSequence,
        window_id: WindowId,
        node_id: NodeId,
        #[serde(deserialize_with = "crate::wire::safe_integer")]
        tree_revision: u64,
        path: Vec<NodeId>,
        key: String,
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "non_null_string"
        )]
        key_char: Option<String>,
        modifiers: KeyModifiers,
    },
    PointerDown {
        sequence: EventSequence,
        window_id: WindowId,
        node_id: NodeId,
        #[serde(deserialize_with = "crate::wire::safe_integer")]
        tree_revision: u64,
        path: Vec<NodeId>,
        button: PointerButton,
        x: f64,
        y: f64,
        modifiers: KeyModifiers,
    },
    PointerUp {
        sequence: EventSequence,
        window_id: WindowId,
        node_id: NodeId,
        #[serde(deserialize_with = "crate::wire::safe_integer")]
        tree_revision: u64,
        path: Vec<NodeId>,
        button: PointerButton,
        x: f64,
        y: f64,
        modifiers: KeyModifiers,
    },
    Focus {
        sequence: EventSequence,
        window_id: WindowId,
        node_id: NodeId,
        #[serde(deserialize_with = "crate::wire::safe_integer")]
        tree_revision: u64,
        path: Vec<NodeId>,
    },
    Blur {
        sequence: EventSequence,
        window_id: WindowId,
        node_id: NodeId,
        #[serde(deserialize_with = "crate::wire::safe_integer")]
        tree_revision: u64,
        path: Vec<NodeId>,
    },
    Closed {
        sequence: EventSequence,
        window_id: WindowId,
    },
    Error {
        #[serde(skip_serializing_if = "Option::is_none")]
        id: Option<RequestId>,
        code: ErrorCode,
        message: String,
    },
}

fn non_null_string<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<String>, D::Error> {
    String::deserialize(deserializer).map(Some)
}

impl Event {
    /// Check bounded UI metadata before writing it to the application process.
    pub fn validate(&self) -> Result<(), &'static str> {
        match self {
            Self::Click {
                node_id,
                tree_revision,
                path,
                ..
            }
            | Self::Input {
                node_id,
                tree_revision,
                path,
                ..
            }
            | Self::KeyDown {
                node_id,
                tree_revision,
                path,
                ..
            }
            | Self::KeyUp {
                node_id,
                tree_revision,
                path,
                ..
            }
            | Self::PointerDown {
                node_id,
                tree_revision,
                path,
                ..
            }
            | Self::PointerUp {
                node_id,
                tree_revision,
                path,
                ..
            }
            | Self::Focus {
                node_id,
                tree_revision,
                path,
                ..
            }
            | Self::Blur {
                node_id,
                tree_revision,
                path,
                ..
            } if *tree_revision > MAX_ID
                || path.is_empty()
                || path.len() > MAX_EVENT_PATH_NODES
                || path.last() != Some(node_id)
                || path
                    .iter()
                    .enumerate()
                    .any(|(index, id)| path[..index].contains(id)) =>
            {
                return Err("event route must contain unique root-to-target identities and a safe tree revision");
            }
            _ => {}
        }
        match self {
            Self::KeyDown { key, key_char, .. } | Self::KeyUp { key, key_char, .. } => {
                validate_text(key)?;
                if key.is_empty() || key.len() > MAX_KEY_BYTES {
                    return Err("native key must be nonempty and at most 256 UTF-8 bytes");
                }
                if let Some(value) = key_char {
                    validate_text(value)?;
                    if value.len() > MAX_KEY_BYTES {
                        return Err("native key text must be at most 256 UTF-8 bytes");
                    }
                }
            }
            Self::PointerDown { x, y, .. } | Self::PointerUp { x, y, .. } => {
                if [*x, *y].into_iter().any(|coordinate| {
                    !coordinate.is_finite() || coordinate.abs() > MAX_POINTER_COORDINATE
                }) {
                    return Err("native pointer coordinate exceeds its finite logical-pixel range");
                }
            }
            Self::Input {
                value,
                input_revision,
                ..
            } => {
                validate_text(value)?;
                if *input_revision > MAX_ID {
                    return Err("native input revision exceeds JavaScript's safe range");
                }
            }
            _ => {}
        }
        Ok(())
    }
}
