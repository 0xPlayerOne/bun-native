//! The private native wire contract (`PROTOCOL_VERSION`). No DOM or renderer-specific types.

use serde::{de, Deserialize, Deserializer, Serialize};
use std::fmt;

mod decode;
#[rustfmt::skip]
mod schema;

pub use schema::*;
#[cfg(test)]
mod oracle_tests;

pub const MAX_ID: u64 = 9_007_199_254_740_991;
pub(crate) const BATCH_SIZE_MESSAGE: &str = "batch must have between 1 and 16384 operations";

macro_rules! identifier {
    ($name:ident) => {
        #[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize)]
        #[serde(into = "u64")]
        pub struct $name(u64);

        impl<'de> Deserialize<'de> for $name {
            fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
                Self::try_from(safe_integer(deserializer)?).map_err(de::Error::custom)
            }
        }

        impl $name {
            pub const fn get(self) -> u64 {
                self.0
            }
        }

        impl TryFrom<u64> for $name {
            type Error = &'static str;
            fn try_from(value: u64) -> Result<Self, Self::Error> {
                if value == 0 || value > MAX_ID {
                    Err("identifier must be a positive JavaScript-safe integer")
                } else {
                    Ok(Self(value))
                }
            }
        }

        impl From<$name> for u64 {
            fn from(value: $name) -> Self {
                value.0
            }
        }
    };
}

identifier!(RequestId);
identifier!(WindowId);
identifier!(NodeId);
identifier!(EventSequence);
identifier!(ShortcutId);
identifier!(NotificationId);
identifier!(FileGrantId);
identifier!(ProcessId);
identifier!(DialogId);
identifier!(DropTargetId);
identifier!(DropId);
identifier!(AppMenuId);
identifier!(ContextMenuId);

/// JSON has one number type. Match JavaScript's safe-integer validation even
/// when a sender spells an integer as `1.0` or `1e0` instead of canonical `1`.
pub(crate) fn safe_integer<'de, D: Deserializer<'de>>(deserializer: D) -> Result<u64, D::Error> {
    struct Integer;
    impl de::Visitor<'_> for Integer {
        type Value = u64;

        fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
            formatter.write_str("a nonnegative JavaScript-safe integer")
        }

        fn visit_u64<E: de::Error>(self, value: u64) -> Result<u64, E> {
            if value <= MAX_ID {
                Ok(value)
            } else {
                Err(E::custom("integer exceeds JavaScript's safe range"))
            }
        }

        fn visit_i64<E: de::Error>(self, value: i64) -> Result<u64, E> {
            u64::try_from(value)
                .map_err(E::custom)
                .and_then(|value| self.visit_u64(value))
        }

        fn visit_f64<E: de::Error>(self, value: f64) -> Result<u64, E> {
            if value.is_finite() && (0.0..=MAX_ID as f64).contains(&value) && value.fract() == 0.0 {
                Ok(value as u64)
            } else {
                Err(E::custom(
                    "number is not a nonnegative JavaScript-safe integer",
                ))
            }
        }
    }
    deserializer.deserialize_any(Integer)
}

fn safe_usize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<usize, D::Error> {
    usize::try_from(safe_integer(deserializer)?).map_err(de::Error::custom)
}

pub(crate) fn safe_u32<'de, D: Deserializer<'de>>(deserializer: D) -> Result<u32, D::Error> {
    u32::try_from(safe_integer(deserializer)?).map_err(de::Error::custom)
}

fn non_null_color<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<u32>, D::Error> {
    safe_u32(deserializer).map(Some)
}

impl Overflow {
    pub fn scrolls(self) -> bool {
        matches!(self, Self::ScrollX | Self::ScrollY | Self::Scroll)
    }
}

impl OverlayNavigation {
    fn is_tab(&self) -> bool {
        *self == Self::Tab
    }
}

fn is_false(value: &bool) -> bool {
    !*value
}

impl OverlaySurface {
    pub fn is_layer(&self) -> bool {
        *self == Self::Layer
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Fill {
    Fill,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Dimension {
    Pixels(f64),
    Fill(Fill),
}

pub(crate) fn non_null<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    T::deserialize(deserializer).map(Some)
}

fn half() -> f64 {
    0.5
}

/// Decoded by hand in `decode.rs`; unknown, duplicate and null members are rejected.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Element {
    Box {
        /// Requires `accessibility_lists_v1`; every member is omitted when unset.
        #[serde(flatten)]
        accessibility: BoxAccessibility,
        style: Style,
    },
    Text {
        text: String,
        /// Requires `accessibility_lists_v1`: announce the text when the node
        /// appears and whenever it changes.
        #[serde(skip_serializing_if = "Option::is_none")]
        accessible_live: Option<Live>,
        style: Style,
    },
    Button {
        text: String,
        disabled: bool,
        style: Style,
    },
    Input {
        value: String,
        placeholder: String,
        /// Requires `input_states_v1`. Not focusable, editable or selectable.
        #[serde(skip_serializing_if = "std::ops::Not::not")]
        disabled: bool,
        /// Requires `input_states_v1`. Focusable, selectable and copyable;
        /// native edits, paste, cut and composition are rejected.
        #[serde(skip_serializing_if = "std::ops::Not::not")]
        read_only: bool,
        style: Style,
    },
    /// `split_v1`: at most two panes separated by a host-owned draggable
    /// divider. `style.direction` chooses the axis (row by default).
    Split {
        /// The leading pane's share of the space left after the divider.
        ratio: f64,
        /// The smallest main-axis size of each pane, in logical pixels.
        min_size: f64,
        /// Requires `accessibility_v1`: the divider's accessible name.
        #[serde(skip_serializing_if = "Option::is_none")]
        accessible_label: Option<String>,
        style: Style,
    },
    /// A container painted above the ordinary tree. Nested overlays paint
    /// above shallower ones; equal depths follow tree order.
    Overlay {
        anchor: OverlayAnchor,
        /// Traps keyboard focus and Tab order until removed.
        modal: bool,
        /// Moves focus to the first enabled control when the layer opens.
        /// Requires `overlay_keyboard_v1`; omitted when false.
        #[serde(skip_serializing_if = "is_false")]
        autofocus: bool,
        /// Requires `overlay_keyboard_v1`; omitted when `tab`.
        #[serde(skip_serializing_if = "OverlayNavigation::is_tab")]
        navigation: OverlayNavigation,
        /// Omitted from normalized output while it is the default layer.
        #[serde(skip_serializing_if = "OverlaySurface::is_layer")]
        surface: OverlaySurface,
        /// Requires `accessibility_v1`: the dialog's accessible name.
        #[serde(skip_serializing_if = "Option::is_none")]
        accessible_label: Option<String>,
        style: Style,
    },
}

/// `accessibility_lists_v1` members of a box. A list's `accessible_set_size`
/// counts every item, including items the application has not mounted; an
/// item's `accessible_position` is its 1-based place in that full set.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct BoxAccessibility {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub accessible_role: Option<AccessibleRole>,
    /// Only with a role: the list's or item's accessible name.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub accessible_label: Option<String>,
    /// Only on a `list`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub accessible_set_size: Option<u32>,
    /// Only on a `list_item`; 1-based.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub accessible_position: Option<u32>,
    /// Only on a `list_item`: selectable, and whether it is selected.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub accessible_selected: Option<bool>,
}

impl BoxAccessibility {
    pub fn is_empty(&self) -> bool {
        *self == Self::default()
    }

    fn validate(&self) -> Result<(), &'static str> {
        let Some(role) = self.accessible_role else {
            return if self.is_empty() {
                Ok(())
            } else {
                Err("box accessibility members require accessible_role")
            };
        };
        if role != AccessibleRole::List && self.accessible_set_size.is_some() {
            return Err("accessible_set_size is only accepted on a list");
        }
        if role != AccessibleRole::ListItem
            && (self.accessible_position.is_some() || self.accessible_selected.is_some())
        {
            return Err(
                "accessible_position and accessible_selected are only accepted on a list_item",
            );
        }
        if self
            .accessible_set_size
            .is_some_and(|size| size > MAX_ACCESSIBLE_SET_SIZE)
        {
            return Err("accessible_set_size must be between 0 and 2147483647");
        }
        if self
            .accessible_position
            .is_some_and(|position| position == 0 || position > MAX_ACCESSIBLE_SET_SIZE)
        {
            return Err("accessible_position must be between 1 and 2147483647");
        }
        Ok(())
    }
}

/// Decoded by hand in `decode.rs`; unknown, duplicate and null members are rejected.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Operation {
    Create {
        node_id: NodeId,
        element: Element,
    },
    Set {
        node_id: NodeId,
        element: Element,
        #[serde(skip_serializing_if = "Option::is_none")]
        expected_input_revision: Option<u64>,
    },
    Insert {
        parent_id: NodeId,
        child_id: NodeId,
        index: usize,
    },
    Delete {
        node_id: NodeId,
    },
    /// Requires `focus_v1`. Focuses an enabled button or input after the
    /// batch's tree changes commit.
    Focus {
        node_id: NodeId,
    },
    /// Requires `scroll_control_v1`. Sets a scrolling container's offset from
    /// its content start; an omitted axis keeps its offset. Clamped natively.
    ScrollTo {
        node_id: NodeId,
        #[serde(skip_serializing_if = "Option::is_none")]
        x: Option<f64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        y: Option<f64>,
    },
    /// Requires `scroll_control_v1`. Scrolls every scrolling ancestor so the
    /// child containing the node is visible.
    ScrollIntoView {
        node_id: NodeId,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum Command {
    Hello {
        id: RequestId,
        #[serde(deserialize_with = "safe_u32")]
        protocol: u32,
    },
    Open {
        id: RequestId,
        window_id: WindowId,
        root_id: NodeId,
        title: String,
        width: f64,
        height: f64,
    },
    Batch {
        id: RequestId,
        window_id: WindowId,
        #[serde(deserialize_with = "safe_integer")]
        base_revision: u64,
        operations: Vec<Operation>,
    },
    Close {
        id: RequestId,
        window_id: WindowId,
    },
    DisplaySnapshot {
        id: RequestId,
        window_id: WindowId,
    },
    ClipboardRead {
        id: RequestId,
        window_id: WindowId,
    },
    ClipboardWrite {
        id: RequestId,
        window_id: WindowId,
        text: String,
    },
    RegisterGlobalShortcut {
        id: RequestId,
        window_id: WindowId,
        shortcut_id: ShortcutId,
        key: String,
        modifiers: crate::ShortcutModifiers,
    },
    UnregisterGlobalShortcut {
        id: RequestId,
        window_id: WindowId,
        shortcut_id: ShortcutId,
    },
    PostNotification {
        id: RequestId,
        window_id: WindowId,
        notification_id: NotificationId,
        title: String,
        body: String,
    },
    WithdrawNotification {
        id: RequestId,
        window_id: WindowId,
        notification_id: NotificationId,
    },
    OpenFileGrant {
        id: RequestId,
        window_id: WindowId,
        grant_id: FileGrantId,
        root: String,
        access: crate::FileAccess,
    },
    CloseFileGrant {
        id: RequestId,
        window_id: WindowId,
        grant_id: FileGrantId,
    },
    FileRequest {
        id: RequestId,
        window_id: WindowId,
        grant_id: FileGrantId,
        path: String,
        operation: crate::FileOperation,
    },
    SpawnProcess {
        id: RequestId,
        window_id: WindowId,
        process_id: ProcessId,
        launch: crate::ProcessLaunch,
    },
    WriteProcess {
        id: RequestId,
        window_id: WindowId,
        process_id: ProcessId,
        data: String,
    },
    CloseProcessInput {
        id: RequestId,
        window_id: WindowId,
        process_id: ProcessId,
    },
    ResizeProcess {
        id: RequestId,
        window_id: WindowId,
        process_id: ProcessId,
        size: crate::TerminalSize,
    },
    SignalProcess {
        id: RequestId,
        window_id: WindowId,
        process_id: ProcessId,
        signal: crate::ProcessSignal,
    },
    /// Acknowledge output through `chunk`, returning that delivery credit.
    AcknowledgeProcessOutput {
        id: RequestId,
        window_id: WindowId,
        process_id: ProcessId,
        #[serde(deserialize_with = "safe_integer")]
        chunk: u64,
    },
    /// Stop the process group, reap it and release the identity.
    ReleaseProcess {
        id: RequestId,
        window_id: WindowId,
        process_id: ProcessId,
    },
    ShowFileDialog {
        id: RequestId,
        window_id: WindowId,
        dialog_id: DialogId,
        options: crate::FileDialogOptions,
    },
    CloseFileDialog {
        id: RequestId,
        window_id: WindowId,
        dialog_id: DialogId,
    },
    ShowMessageDialog {
        id: RequestId,
        window_id: WindowId,
        dialog_id: DialogId,
        options: crate::MessageDialogOptions,
    },
    CloseMessageDialog {
        id: RequestId,
        window_id: WindowId,
        dialog_id: DialogId,
    },
    /// Show an OS context menu at a logical point of the window's content.
    /// `menu_id` increases per session; one menu is live at a time.
    ShowContextMenu {
        id: RequestId,
        window_id: WindowId,
        menu_id: ContextMenuId,
        x: f64,
        y: f64,
        items: Vec<crate::AppMenuEntry>,
    },
    CloseContextMenu {
        id: RequestId,
        window_id: WindowId,
        menu_id: ContextMenuId,
    },
    RegisterDropTarget {
        id: RequestId,
        window_id: WindowId,
        target_id: DropTargetId,
        node_id: NodeId,
    },
    UnregisterDropTarget {
        id: RequestId,
        window_id: WindowId,
        target_id: DropTargetId,
    },
    /// Map one item of the target's latest drop to a path relative to a
    /// launch root. The host matches its own retained path; no path is sent.
    ResolveDroppedItem {
        id: RequestId,
        window_id: WindowId,
        target_id: DropTargetId,
        drop_id: DropId,
        #[serde(deserialize_with = "safe_u32")]
        item: u32,
        root: String,
    },
    /// Replace the application menu bar; an empty `menus` removes it. Every
    /// item of the previous bar is revoked. `menu_id` increases per session.
    SetAppMenu {
        id: RequestId,
        menu_id: AppMenuId,
        menus: Vec<crate::AppMenu>,
    },
    Shutdown {
        id: RequestId,
    },
}

impl Command {
    pub fn id(&self) -> RequestId {
        match self {
            Self::Hello { id, .. }
            | Self::Open { id, .. }
            | Self::Batch { id, .. }
            | Self::Close { id, .. }
            | Self::DisplaySnapshot { id, .. }
            | Self::ClipboardRead { id, .. }
            | Self::ClipboardWrite { id, .. }
            | Self::RegisterGlobalShortcut { id, .. }
            | Self::UnregisterGlobalShortcut { id, .. }
            | Self::PostNotification { id, .. }
            | Self::WithdrawNotification { id, .. }
            | Self::OpenFileGrant { id, .. }
            | Self::CloseFileGrant { id, .. }
            | Self::FileRequest { id, .. }
            | Self::SpawnProcess { id, .. }
            | Self::WriteProcess { id, .. }
            | Self::CloseProcessInput { id, .. }
            | Self::ResizeProcess { id, .. }
            | Self::SignalProcess { id, .. }
            | Self::AcknowledgeProcessOutput { id, .. }
            | Self::ReleaseProcess { id, .. }
            | Self::ShowFileDialog { id, .. }
            | Self::CloseFileDialog { id, .. }
            | Self::ShowMessageDialog { id, .. }
            | Self::CloseMessageDialog { id, .. }
            | Self::ShowContextMenu { id, .. }
            | Self::CloseContextMenu { id, .. }
            | Self::RegisterDropTarget { id, .. }
            | Self::UnregisterDropTarget { id, .. }
            | Self::ResolveDroppedItem { id, .. }
            | Self::SetAppMenu { id, .. }
            | Self::Shutdown { id } => *id,
        }
    }

    pub fn validate(&self) -> Result<(), &'static str> {
        match self {
            Self::Open {
                title,
                width,
                height,
                ..
            } => {
                if title.is_empty()
                    || title.len() > MAX_TITLE_BYTES
                    || title.chars().any(char::is_control)
                {
                    return Err("title must be nonempty, at most 256 bytes, and contain no control characters");
                }
                bounded(
                    *width,
                    64.,
                    16_384.,
                    "window width must be between 64 and 16384 pixels",
                )?;
                bounded(
                    *height,
                    64.,
                    16_384.,
                    "window height must be between 64 and 16384 pixels",
                )?;
            }
            Self::Batch {
                base_revision,
                operations,
                ..
            } => validate_batch(*base_revision, operations)?,
            Self::ClipboardWrite { text, .. } => crate::validate_clipboard_text(text)?,
            Self::RegisterGlobalShortcut { key, modifiers, .. } => {
                crate::validate_global_shortcut(key, *modifiers)?
            }
            Self::PostNotification { title, body, .. } => {
                crate::validate_notification(title, body)?
            }
            Self::OpenFileGrant { root, .. } => crate::validate_root_id(root)?,
            Self::FileRequest {
                path, operation, ..
            } => operation.validate(path)?,
            Self::SpawnProcess { launch, .. } => launch.validate()?,
            Self::WriteProcess { data, .. } => crate::validate_process_output(data)?,
            Self::ResizeProcess { size, .. } => size.validate()?,
            Self::AcknowledgeProcessOutput { chunk, .. } => {
                if *chunk == 0 || *chunk > MAX_ID {
                    return Err("process output chunk must be a positive safe integer");
                }
            }
            Self::ShowFileDialog { options, .. } => options.validate()?,
            Self::ShowMessageDialog { options, .. } => options.validate()?,
            Self::SetAppMenu { menus, .. } => crate::validate_app_menus(menus)?,
            Self::ShowContextMenu { x, y, items, .. } => {
                if [*x, *y].into_iter().any(|coordinate| {
                    !coordinate.is_finite()
                        || !(0. ..=crate::MAX_POINTER_COORDINATE).contains(&coordinate)
                }) {
                    return Err(
                        "context menu position must be a finite, nonnegative logical point",
                    );
                }
                crate::validate_context_menu(items)?;
            }
            Self::ResolveDroppedItem { item, root, .. } => {
                crate::validate_drop_item_index(*item)?;
                crate::validate_root_id(root)?;
            }
            Self::Hello { .. }
            | Self::Close { .. }
            | Self::DisplaySnapshot { .. }
            | Self::ClipboardRead { .. }
            | Self::UnregisterGlobalShortcut { .. }
            | Self::WithdrawNotification { .. }
            | Self::CloseFileGrant { .. }
            | Self::CloseProcessInput { .. }
            | Self::SignalProcess { .. }
            | Self::ReleaseProcess { .. }
            | Self::CloseFileDialog { .. }
            | Self::CloseMessageDialog { .. }
            | Self::CloseContextMenu { .. }
            | Self::RegisterDropTarget { .. }
            | Self::UnregisterDropTarget { .. }
            | Self::Shutdown { .. } => {}
        }
        Ok(())
    }
}

/// A batch's own rules, every element included: `Command::validate` for a
/// batch, and the proof a `ValidBatch` carries.
fn validate_batch(base_revision: u64, operations: &[Operation]) -> Result<(), &'static str> {
    revision(base_revision)?;
    if operations.is_empty() || operations.len() > MAX_OPERATIONS {
        return Err(BATCH_SIZE_MESSAGE);
    }
    for operation in operations {
        match operation {
            Operation::Create { element, .. } => element.validate()?,
            Operation::Set {
                element,
                expected_input_revision,
                ..
            } => {
                element.validate()?;
                match (element, expected_input_revision) {
                    (Element::Input { .. }, Some(value)) => revision(*value)?,
                    (Element::Input { .. }, None) => {
                        return Err("input set requires expected_input_revision")
                    }
                    (_, Some(_)) => return Err("expected_input_revision is only valid for input"),
                    (_, None) => {}
                }
            }
            Operation::Insert { index, .. } if *index > MAX_NODES_PER_WINDOW => {
                return Err("child index exceeds the node limit")
            }
            Operation::ScrollTo { x, y, .. } => {
                if x.is_none() && y.is_none() {
                    return Err("scroll_to requires x or y");
                }
                for value in [x, y].into_iter().flatten() {
                    bounded(
                        *value,
                        0.,
                        MAX_SCROLL_OFFSET,
                        "scroll offsets must be between 0 and 1000000",
                    )?;
                }
            }
            Operation::Insert { .. }
            | Operation::Delete { .. }
            | Operation::Focus { .. }
            | Operation::ScrollIntoView { .. } => {}
        }
    }
    Ok(())
}

/// A command that passed `Command::validate`. Only `CommandReader` makes one,
/// so a batch taken from it with `into_batch` keeps that proof and
/// `Tree::prepare_valid` need not validate its elements again.
#[derive(Debug, Clone, PartialEq)]
pub struct ValidCommand(Command);

impl ValidCommand {
    pub(crate) fn new(command: Command) -> Result<Self, &'static str> {
        command.validate()?;
        Ok(Self(command))
    }

    pub fn command(&self) -> &Command {
        &self.0
    }

    pub fn into_command(self) -> Command {
        self.0
    }

    /// The batch with its validation proof, or any other command unchanged.
    pub fn into_batch(self) -> Result<ValidBatch, Box<Command>> {
        match self.0 {
            Command::Batch {
                id,
                window_id,
                base_revision,
                operations,
            } => Ok(ValidBatch {
                id,
                window_id,
                base_revision,
                operations,
            }),
            command => Err(Box::new(command)),
        }
    }
}

/// A `batch` command whose operations, every element included, passed the
/// batch rules of `Command::validate`. The operations are private, so they
/// cannot change after that check.
#[derive(Debug, Clone, PartialEq)]
pub struct ValidBatch {
    pub id: RequestId,
    pub window_id: WindowId,
    pub base_revision: u64,
    operations: Vec<Operation>,
}

impl ValidBatch {
    /// Validates a batch that did not come through `CommandReader`.
    pub fn new(
        id: RequestId,
        window_id: WindowId,
        base_revision: u64,
        operations: Vec<Operation>,
    ) -> Result<Self, &'static str> {
        validate_batch(base_revision, &operations)?;
        Ok(Self {
            id,
            window_id,
            base_revision,
            operations,
        })
    }

    pub fn operations(&self) -> &[Operation] {
        &self.operations
    }

    pub(crate) fn into_operations(self) -> Vec<Operation> {
        self.operations
    }
}

impl Element {
    pub fn text_bytes(&self) -> usize {
        match self {
            Self::Text { text, .. } | Self::Button { text, .. } => text.len(),
            Self::Input {
                value, placeholder, ..
            } => value.len() + placeholder.len(),
            Self::Split {
                accessible_label, ..
            }
            | Self::Overlay {
                accessible_label, ..
            } => accessible_label.as_ref().map_or(0, String::len),
            Self::Box { accessibility, .. } => accessibility
                .accessible_label
                .as_ref()
                .map_or(0, String::len),
        }
    }

    /// The name an overlay or split (`accessibility_v1`) or a list or list
    /// item box (`accessibility_lists_v1`) declares.
    pub fn accessible_label(&self) -> Option<&str> {
        match self {
            Self::Split {
                accessible_label, ..
            }
            | Self::Overlay {
                accessible_label, ..
            } => accessible_label.as_deref(),
            Self::Box { accessibility, .. } => accessibility.accessible_label.as_deref(),
            Self::Text { .. } | Self::Button { .. } | Self::Input { .. } => None,
        }
    }

    /// The most children this element may own.
    pub fn max_children(&self) -> usize {
        match self {
            Self::Box { .. } | Self::Overlay { .. } => MAX_NODES_PER_WINDOW,
            Self::Split { .. } => 2,
            Self::Text { .. } | Self::Button { .. } | Self::Input { .. } => 0,
        }
    }

    /// Boxes, splits and overlays own ordered children.
    pub fn is_container(&self) -> bool {
        matches!(
            self,
            Self::Box { .. } | Self::Split { .. } | Self::Overlay { .. }
        )
    }

    pub fn style(&self) -> &Style {
        match self {
            Self::Box { style, .. }
            | Self::Text { style, .. }
            | Self::Button { style, .. }
            | Self::Input { style, .. }
            | Self::Split { style, .. }
            | Self::Overlay { style, .. } => style,
        }
    }

    pub fn same_kind(&self, other: &Self) -> bool {
        std::mem::discriminant(self) == std::mem::discriminant(other)
    }

    pub fn validate(&self) -> Result<(), &'static str> {
        if !matches!(self, Self::Box { .. } | Self::Overlay { .. })
            && self.style().overflow.is_some_and(Overflow::scrolls)
        {
            return Err("scrolling is supported only on box and overlay elements");
        }
        if let Self::Overlay {
            anchor: OverlayAnchor::Parent,
            modal: true,
            ..
        } = self
        {
            return Err("a modal overlay must be anchored to the window");
        }
        if let Self::Overlay {
            anchor,
            surface: OverlaySurface::Window,
            autofocus,
            navigation,
            style,
            ..
        } = self
        {
            if *anchor != OverlayAnchor::Parent {
                return Err("a popup window overlay must be anchored to its parent");
            }
            // Keyboard focus stays on the parent window while a popup is open.
            if *autofocus || *navigation != OverlayNavigation::Tab {
                return Err("a popup window overlay does not take keyboard focus");
            }
            let sized = |value: Option<Dimension>| matches!(value, Some(Dimension::Pixels(pixels)) if pixels >= 1.);
            if !sized(style.width) || !sized(style.height) {
                return Err("a popup window overlay needs a fixed width and height");
            }
        }
        match self {
            Self::Text { text, .. } | Self::Button { text, .. } => validate_text(text)?,
            Self::Input {
                value, placeholder, ..
            } => {
                validate_text(value)?;
                validate_text(placeholder)?;
            }
            Self::Split {
                ratio,
                min_size,
                style,
                ..
            } => {
                bounded(*ratio, 0., 1., "split ratio must be between 0 and 1")?;
                bounded(
                    *min_size,
                    0.,
                    16_384.,
                    "split min_size must be between 0 and 16384 pixels",
                )?;
                if style.gap.is_some()
                    || style.align_items.is_some()
                    || style.justify_content.is_some()
                {
                    return Err("split panes do not accept gap or alignment");
                }
            }
            Self::Box { accessibility, .. } => accessibility.validate()?,
            Self::Overlay { .. } => {}
        }
        if let Some(label) = self.accessible_label() {
            validate_text(label)?;
        }
        self.style().validate()
    }
}

impl Style {
    /// The schema's per-field bounds, then the rules between fields.
    pub fn validate(&self) -> Result<(), &'static str> {
        self.validate_fields()?;
        for (minimum, maximum) in [
            (self.min_width, self.max_width),
            (self.min_height, self.max_height),
        ] {
            if minimum
                .zip(maximum)
                .is_some_and(|(minimum, maximum)| minimum > maximum)
            {
                return Err("minimum size must not exceed maximum size");
            }
        }
        if self.scroll_anchor.is_some()
            && !matches!(self.overflow, Some(Overflow::ScrollY | Overflow::Scroll))
        {
            return Err("scroll_anchor requires vertical scrolling overflow");
        }
        Ok(())
    }
}

pub fn validate_text(text: &str) -> Result<(), &'static str> {
    if text.len() > MAX_TEXT_BYTES || text.contains('\0') {
        Err("text exceeds 16384 bytes or contains NUL")
    } else {
        Ok(())
    }
}

fn revision(value: u64) -> Result<(), &'static str> {
    if value > MAX_ID {
        Err("revision must be a nonnegative JavaScript-safe integer")
    } else {
        Ok(())
    }
}

fn bounded(
    value: f64,
    minimum: f64,
    maximum: f64,
    message: &'static str,
) -> Result<(), &'static str> {
    if value.is_finite() && (minimum..=maximum).contains(&value) {
        Ok(())
    } else {
        Err(message)
    }
}
