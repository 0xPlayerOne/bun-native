//! Version 6's private native wire contract. No DOM or renderer-specific types.

use serde::{de, Deserialize, Deserializer, Serialize};
use std::fmt;

pub const PROTOCOL_VERSION: u32 = 8;
pub const MAX_ID: u64 = 9_007_199_254_740_991;
pub const MAX_FRAME_BYTES: usize = 65_536;
pub const MAX_TEXT_BYTES: usize = 16_384;
pub const MAX_TEXT_BYTES_PER_WINDOW: usize = 4_194_304;
pub const MAX_TITLE_BYTES: usize = 256;
pub const MAX_OPERATIONS: usize = 256;
pub const MAX_NODES_PER_WINDOW: usize = 4_096;
pub const MAX_WINDOWS: usize = 16;
pub const MAX_DEPTH: usize = 64;
/// Overlays nested inside overlays, the outermost counting as one. GPUI
/// processes each nested deferred layer in its own bounded prepaint round.
pub const MAX_OVERLAY_DEPTH: usize = 8;
/// Largest programmatic scroll offset, in logical pixels from the content start.
pub const MAX_SCROLL_OFFSET: f64 = 1_000_000.;

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

fn safe_u32<'de, D: Deserializer<'de>>(deserializer: D) -> Result<u32, D::Error> {
    u32::try_from(safe_integer(deserializer)?).map_err(de::Error::custom)
}

fn non_null_revision<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<u64>, D::Error> {
    safe_integer(deserializer).map(Some)
}

fn non_null_color<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<u32>, D::Error> {
    safe_u32(deserializer).map(Some)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Direction {
    Row,
    Column,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AlignItems {
    Start,
    Center,
    End,
    Stretch,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum JustifyContent {
    Start,
    Center,
    End,
    SpaceBetween,
    SpaceAround,
    SpaceEvenly,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Overflow {
    Visible,
    Hidden,
    ScrollX,
    ScrollY,
    Scroll,
}

impl Overflow {
    pub fn scrolls(self) -> bool {
        matches!(self, Self::ScrollX | Self::ScrollY | Self::Scroll)
    }
}

/// Which edge a vertical scroll viewport keeps visible as its content changes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ScrollAnchor {
    Start,
    End,
}

/// Where an overlay's layer is placed.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OverlayAnchor {
    /// A layer covering the whole window viewport, blocking pointer input beneath it.
    #[default]
    Window,
    /// A content-sized layer below its parent's bottom-left corner, kept inside the window.
    Parent,
}

/// How arrow keys move focus among an overlay's own controls.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OverlayNavigation {
    /// Only Tab and Shift-Tab move focus.
    #[default]
    Tab,
    /// Up/Down/Home/End move a roving focus and printable keys type ahead.
    Menu,
}

impl OverlayNavigation {
    fn is_tab(&self) -> bool {
        *self == Self::Tab
    }
}

fn is_false(value: &bool) -> bool {
    !*value
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

fn non_null<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    T::deserialize(deserializer).map(Some)
}

#[derive(Debug, Default, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Style {
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "non_null"
    )]
    pub direction: Option<Direction>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "non_null"
    )]
    pub gap: Option<f64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "non_null"
    )]
    pub padding: Option<f64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "non_null"
    )]
    pub width: Option<Dimension>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "non_null"
    )]
    pub height: Option<Dimension>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "non_null"
    )]
    pub min_width: Option<f64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "non_null"
    )]
    pub max_width: Option<f64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "non_null"
    )]
    pub min_height: Option<f64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "non_null"
    )]
    pub max_height: Option<f64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "non_null"
    )]
    pub flex_grow: Option<f64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "non_null"
    )]
    pub flex_shrink: Option<f64>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "non_null"
    )]
    pub align_items: Option<AlignItems>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "non_null"
    )]
    pub justify_content: Option<JustifyContent>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "non_null"
    )]
    pub overflow: Option<Overflow>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "non_null"
    )]
    pub scroll_anchor: Option<ScrollAnchor>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "non_null_color"
    )]
    pub background: Option<u32>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "non_null_color"
    )]
    pub color: Option<u32>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "non_null"
    )]
    pub font_size: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Element {
    Box {
        #[serde(default)]
        style: Style,
    },
    Text {
        text: String,
        #[serde(default)]
        style: Style,
    },
    Button {
        text: String,
        #[serde(default)]
        disabled: bool,
        #[serde(default)]
        style: Style,
    },
    Input {
        value: String,
        #[serde(default)]
        placeholder: String,
        #[serde(default)]
        style: Style,
    },
    /// A container painted above the ordinary tree. Nested overlays paint
    /// above shallower ones; equal depths follow tree order.
    Overlay {
        #[serde(default)]
        anchor: OverlayAnchor,
        /// Traps keyboard focus and Tab order until removed.
        #[serde(default)]
        modal: bool,
        /// Moves focus to the first enabled control when the layer opens.
        /// Requires `overlay_keyboard_v1`; omitted when false.
        #[serde(default, skip_serializing_if = "is_false")]
        autofocus: bool,
        /// Requires `overlay_keyboard_v1`; omitted when `tab`.
        #[serde(default, skip_serializing_if = "OverlayNavigation::is_tab")]
        navigation: OverlayNavigation,
        #[serde(default)]
        style: Style,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum Operation {
    Create {
        node_id: NodeId,
        element: Element,
    },
    Set {
        node_id: NodeId,
        element: Element,
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "non_null_revision"
        )]
        expected_input_revision: Option<u64>,
    },
    Insert {
        parent_id: NodeId,
        child_id: NodeId,
        #[serde(deserialize_with = "safe_usize")]
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
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "non_null"
        )]
        x: Option<f64>,
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "non_null"
        )]
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
    Shutdown {
        id: RequestId,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    InvalidCommand,
    VersionMismatch,
    InvalidState,
    InvalidHandle,
    StaleRevision,
    LimitExceeded,
    NativeFailure,
    PermissionDenied,
    ServiceUnavailable,
    Cancelled,
    OperationTimedOut,
    PayloadTooLarge,
    Conflict,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Capability {
    Tree,
    InputRevisions,
    LayoutV1,
    InteractionsV1,
    WindowDisplayV1,
    ClipboardTextV1,
    GlobalShortcutsV1,
    NotificationsV1,
    OverlaysV1,
    ScrollAnchorV1,
    FocusV1,
    ScrollControlV1,
    OverlayKeyboardV1,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Limits {
    pub max_frame_bytes: usize,
    pub max_operations: usize,
    pub max_nodes_per_window: usize,
    pub max_windows: usize,
    pub max_depth: usize,
    pub max_text_bytes: usize,
    pub max_text_bytes_per_window: usize,
    pub max_clipboard_bytes: usize,
    pub max_service_requests: usize,
    pub max_global_shortcuts: usize,
    pub max_notifications: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            max_frame_bytes: MAX_FRAME_BYTES,
            max_operations: MAX_OPERATIONS,
            max_nodes_per_window: MAX_NODES_PER_WINDOW,
            max_windows: MAX_WINDOWS,
            max_depth: MAX_DEPTH,
            max_text_bytes: MAX_TEXT_BYTES,
            max_text_bytes_per_window: MAX_TEXT_BYTES_PER_WINDOW,
            max_clipboard_bytes: crate::MAX_CLIPBOARD_BYTES,
            max_service_requests: crate::MAX_SERVICE_REQUESTS,
            max_global_shortcuts: crate::MAX_GLOBAL_SHORTCUTS,
            max_notifications: crate::MAX_NOTIFICATIONS,
        }
    }
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
            } => {
                revision(*base_revision)?;
                if operations.is_empty() || operations.len() > MAX_OPERATIONS {
                    return Err("batch must have between 1 and 256 operations");
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
                                (_, Some(_)) => {
                                    return Err("expected_input_revision is only valid for input")
                                }
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
            }
            Self::ClipboardWrite { text, .. } => crate::validate_clipboard_text(text)?,
            Self::RegisterGlobalShortcut { key, modifiers, .. } => {
                crate::validate_global_shortcut(key, *modifiers)?
            }
            Self::PostNotification { title, body, .. } => {
                crate::validate_notification(title, body)?
            }
            Self::Hello { .. }
            | Self::Close { .. }
            | Self::DisplaySnapshot { .. }
            | Self::ClipboardRead { .. }
            | Self::UnregisterGlobalShortcut { .. }
            | Self::WithdrawNotification { .. }
            | Self::Shutdown { .. } => {}
        }
        Ok(())
    }
}

impl Element {
    pub fn text_bytes(&self) -> usize {
        match self {
            Self::Text { text, .. } | Self::Button { text, .. } => text.len(),
            Self::Input {
                value, placeholder, ..
            } => value.len() + placeholder.len(),
            Self::Box { .. } | Self::Overlay { .. } => 0,
        }
    }

    /// Boxes and overlays own ordered children and may scroll.
    pub fn is_container(&self) -> bool {
        matches!(self, Self::Box { .. } | Self::Overlay { .. })
    }

    pub fn style(&self) -> &Style {
        match self {
            Self::Box { style }
            | Self::Text { style, .. }
            | Self::Button { style, .. }
            | Self::Input { style, .. }
            | Self::Overlay { style, .. } => style,
        }
    }

    pub fn same_kind(&self, other: &Self) -> bool {
        std::mem::discriminant(self) == std::mem::discriminant(other)
    }

    pub fn validate(&self) -> Result<(), &'static str> {
        if !self.is_container() && self.style().overflow.is_some_and(Overflow::scrolls) {
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
        match self {
            Self::Text { text, .. } | Self::Button { text, .. } => validate_text(text)?,
            Self::Input {
                value, placeholder, ..
            } => {
                validate_text(value)?;
                validate_text(placeholder)?;
            }
            Self::Box { .. } | Self::Overlay { .. } => {}
        }
        self.style().validate()
    }
}

impl Style {
    pub fn validate(&self) -> Result<(), &'static str> {
        for value in [self.gap, self.padding].into_iter().flatten() {
            bounded(
                value,
                0.,
                4_096.,
                "gap and padding must be between 0 and 4096 pixels",
            )?;
        }
        for dimension in [self.width, self.height].into_iter().flatten() {
            if let Dimension::Pixels(value) = dimension {
                bounded(
                    value,
                    0.,
                    16_384.,
                    "dimensions must be between 0 and 16384 pixels",
                )?;
            }
        }
        for value in [
            self.min_width,
            self.max_width,
            self.min_height,
            self.max_height,
        ]
        .into_iter()
        .flatten()
        {
            bounded(
                value,
                0.,
                16_384.,
                "size constraints must be between 0 and 16384 pixels",
            )?;
        }
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
        for value in [self.flex_grow, self.flex_shrink].into_iter().flatten() {
            bounded(value, 0., 1_000., "flex factors must be between 0 and 1000")?;
        }
        if self.scroll_anchor.is_some()
            && !matches!(self.overflow, Some(Overflow::ScrollY | Overflow::Scroll))
        {
            return Err("scroll_anchor requires vertical scrolling overflow");
        }
        if let Some(value) = self.font_size {
            bounded(
                value,
                1.,
                512.,
                "font_size must be between 1 and 512 pixels",
            )?;
        }
        if [self.background, self.color]
            .into_iter()
            .flatten()
            .any(|value| value > 0xff_ffff)
        {
            return Err("colors must be unsigned 24-bit RGB values");
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
