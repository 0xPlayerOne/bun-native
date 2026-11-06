//! Native event payloads carry the committed ownership route, never callbacks.

use crate::{
    validate_text, Capability, ClipboardText, DialogId, DisplaySnapshot, ErrorCode, EventSequence,
    FileDialogResult, Limits, NodeId, NotificationDismissal, NotificationId, RequestId,
    ServicePolicy, ShortcutId, WindowId, MAX_DEPTH, MAX_ID,
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

/// Why the host requests a popup dismissal.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DismissReason {
    /// The popup's parent window stopped being the active window.
    WindowBlur,
}

/// What moved a split divider (`split_resize_v1`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ResizeSource {
    Pointer,
    Keyboard,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum Event {
    Ready {
        #[serde(deserialize_with = "crate::wire::safe_u32")]
        protocol: u32,
        capabilities: Vec<Capability>,
        limits: Limits,
        service_policy: ServicePolicy,
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
    DisplaySnapshot {
        id: RequestId,
        window_id: WindowId,
        snapshot: DisplaySnapshot,
    },
    ClipboardText {
        id: RequestId,
        window_id: WindowId,
        result: ClipboardText,
    },
    ClipboardWritten {
        id: RequestId,
        window_id: WindowId,
    },
    GlobalShortcutRegistered {
        id: RequestId,
        window_id: WindowId,
        shortcut_id: ShortcutId,
    },
    GlobalShortcutUnregistered {
        id: RequestId,
        window_id: WindowId,
        shortcut_id: ShortcutId,
    },
    /// The window moved to another display or its display's geometry changed.
    /// Sent only by a host that advertises `display_changes_v1`, for a
    /// granted `window_display` policy.
    DisplayChanged {
        sequence: EventSequence,
        window_id: WindowId,
        snapshot: DisplaySnapshot,
    },
    /// An OS-wide activation of a live registration owned by this window.
    GlobalShortcut {
        sequence: EventSequence,
        window_id: WindowId,
        shortcut_id: ShortcutId,
    },
    /// The server displays the notification. `activatable` is false when the
    /// server does not offer actions, so no activation can arrive.
    NotificationPosted {
        id: RequestId,
        window_id: WindowId,
        notification_id: NotificationId,
        activatable: bool,
    },
    NotificationWithdrawn {
        id: RequestId,
        window_id: WindowId,
        notification_id: NotificationId,
    },
    /// The user activated a live notification owned by this window.
    NotificationActivated {
        sequence: EventSequence,
        window_id: WindowId,
        notification_id: NotificationId,
    },
    /// The server removed a live notification; it is no longer owned.
    FileGrantOpened {
        id: RequestId,
        window_id: WindowId,
        grant_id: crate::FileGrantId,
    },
    FileGrantClosed {
        id: RequestId,
        window_id: WindowId,
        grant_id: crate::FileGrantId,
    },
    FileResult {
        id: RequestId,
        window_id: WindowId,
        grant_id: crate::FileGrantId,
        result: crate::FileResult,
    },
    ProcessSpawned {
        id: RequestId,
        window_id: WindowId,
        process_id: crate::ProcessId,
    },
    /// Reply to write, input close, resize, signal and acknowledgement.
    ProcessUpdated {
        id: RequestId,
        window_id: WindowId,
        process_id: crate::ProcessId,
    },
    ProcessReleased {
        id: RequestId,
        window_id: WindowId,
        process_id: crate::ProcessId,
    },
    /// One chunk of output; `chunk` counts from 1 per process.
    ProcessOutput {
        sequence: EventSequence,
        window_id: WindowId,
        process_id: crate::ProcessId,
        #[serde(deserialize_with = "crate::wire::safe_integer")]
        chunk: u64,
        stream: crate::ProcessStream,
        data: String,
    },
    /// The direct child ended; its group was stopped and all output delivered.
    ProcessExited {
        sequence: EventSequence,
        window_id: WindowId,
        process_id: crate::ProcessId,
        exit: crate::ProcessExit,
    },
    DropTargetRegistered {
        id: RequestId,
        window_id: WindowId,
        target_id: crate::DropTargetId,
    },
    DropTargetUnregistered {
        id: RequestId,
        window_id: WindowId,
        target_id: crate::DropTargetId,
    },
    /// A path relative to `root` for one retained dropped item.
    DroppedItemResolved {
        id: RequestId,
        window_id: WindowId,
        target_id: crate::DropTargetId,
        drop_id: crate::DropId,
        #[serde(deserialize_with = "crate::wire::safe_u32")]
        item: u32,
        root: String,
        path: String,
    },
    /// An external file drag moved onto or off a live owned target.
    DropTargetDrag {
        sequence: EventSequence,
        window_id: WindowId,
        target_id: crate::DropTargetId,
        state: crate::DragState,
    },
    /// The user dropped local files onto a live owned target. Names are
    /// untrusted display data; the host retains the paths under `drop_id`.
    DropReceived {
        sequence: EventSequence,
        window_id: WindowId,
        target_id: crate::DropTargetId,
        drop_id: crate::DropId,
        items: Vec<crate::DroppedItem>,
    },
    /// A drop onto a live owned target delivered nothing.
    DropRejected {
        sequence: EventSequence,
        window_id: WindowId,
        target_id: crate::DropTargetId,
        reason: crate::DropRejection,
    },
    NotificationDismissed {
        sequence: EventSequence,
        window_id: WindowId,
        notification_id: NotificationId,
        reason: NotificationDismissal,
    },
    /// The OS dialog is shown for this owned window.
    FileDialogOpened {
        id: RequestId,
        window_id: WindowId,
        dialog_id: DialogId,
    },
    /// The application closed its dialog; no completion follows.
    FileDialogClosed {
        id: RequestId,
        window_id: WindowId,
        dialog_id: DialogId,
    },
    /// The user finished a live dialog owned by this window. It is no longer owned.
    FileDialogCompleted {
        sequence: EventSequence,
        window_id: WindowId,
        dialog_id: DialogId,
        result: FileDialogResult,
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
    /// The host asks the application to close a popup window overlay. The
    /// host never removes the node itself; the model tree stays app-owned.
    Dismiss {
        sequence: EventSequence,
        window_id: WindowId,
        node_id: NodeId,
        #[serde(deserialize_with = "crate::wire::safe_integer")]
        tree_revision: u64,
        path: Vec<NodeId>,
        reason: DismissReason,
    },
    /// `split_resize_v1`: the user moved a split divider. `ratio` is the
    /// host-owned leading-pane share after the move, once per finished drag
    /// or keyboard step that changed it.
    SplitResize {
        sequence: EventSequence,
        window_id: WindowId,
        node_id: NodeId,
        #[serde(deserialize_with = "crate::wire::safe_integer")]
        tree_revision: u64,
        path: Vec<NodeId>,
        ratio: f64,
        source: ResizeSource,
    },
    Closed {
        sequence: EventSequence,
        window_id: WindowId,
    },
    /// The menu bar `menu_id` is installed; the previous one is revoked.
    AppMenuSet {
        id: RequestId,
        menu_id: crate::AppMenuId,
    },
    /// The user selected an item of the current menu bar. Application-scoped:
    /// a menu bar belongs to the application, not to a window.
    AppMenuItem {
        sequence: EventSequence,
        menu_id: crate::AppMenuId,
        item_id: String,
    },
    Error {
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::non_null"
        )]
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

/// Sorts a stack copy of an already length-bounded route: a deep route would
/// otherwise cost quadratic comparisons on every UI event.
fn has_duplicate(path: &[NodeId]) -> bool {
    let Some(first) = path.first() else {
        return false;
    };
    let mut sorted = [*first; MAX_EVENT_PATH_NODES];
    let Some(sorted) = sorted.get_mut(..path.len()) else {
        return path
            .iter()
            .enumerate()
            .any(|(index, id)| path[..index].contains(id));
    };
    sorted.copy_from_slice(path);
    sorted.sort_unstable();
    sorted.windows(2).any(|pair| pair[0] == pair[1])
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
            }
            | Self::Dismiss {
                node_id,
                tree_revision,
                path,
                ..
            }
            | Self::SplitResize {
                node_id,
                tree_revision,
                path,
                ..
            } if *tree_revision > MAX_ID
                || path.is_empty()
                || path.len() > MAX_EVENT_PATH_NODES
                || path.last() != Some(node_id)
                || has_duplicate(path) =>
            {
                return Err("event route must contain unique root-to-target identities and a safe tree revision");
            }
            _ => {}
        }
        match self {
            Self::DisplaySnapshot { snapshot, .. } | Self::DisplayChanged { snapshot, .. } => {
                snapshot.validate()?
            }
            Self::ClipboardText { result, .. } => result.validate()?,
            Self::FileResult { result, .. } => result.validate()?,
            Self::DropReceived { items, .. } => crate::validate_drop_items(items)?,
            Self::DroppedItemResolved {
                item, root, path, ..
            } => {
                crate::validate_drop_item_index(*item)?;
                crate::validate_root_id(root)?;
                crate::validate_file_path(path)?;
            }
            Self::Ready {
                protocol,
                capabilities,
                limits,
                service_policy,
            } => {
                if *protocol != crate::PROTOCOL_VERSION {
                    return Err("ready must advertise the implemented protocol version");
                }
                if (1..capabilities.len()).any(|i| capabilities[..i].contains(&capabilities[i])) {
                    return Err("ready capabilities must be unique");
                }
                limits.validate()?;
                crate::validate_filesystem_roots(&service_policy.filesystem_roots)?;
                crate::validate_process_executables(&service_policy.processes)?
            }
            Self::Error { message, .. } => validate_text(message)?,
            Self::ProcessOutput { data, chunk, .. } => {
                if *chunk == 0 || *chunk > MAX_ID {
                    return Err("process output chunk must be a positive safe integer");
                }
                crate::validate_process_output(data)?
            }
            Self::ProcessExited { exit, .. } => exit.validate()?,
            Self::FileDialogCompleted { result, .. } => result.validate()?,
            Self::AppMenuItem { item_id, .. } => crate::validate_app_menu_item_id(item_id)?,
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
            Self::SplitResize { ratio, .. } if !(0. ..=1.).contains(ratio) => {
                return Err("split ratio must be between 0 and 1");
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
