//! Hand-written decoders for the two internally tagged wire enums.
//!
//! `#[serde(tag = "...")]` buffers each tagged value into serde's private
//! `Content` tree and then replays it, and `Operation` nests `Element`, so every
//! created node paid for two buffered copies of its object and style. These
//! visitors read each member once, straight into the target. The accepted
//! language is the derived one: the tag may appear in any position, unknown
//! members, duplicate members, `null` for a present member and members that
//! belong to another variant are all rejected, and absent members take the same
//! defaults. Error text differs from the derived decoders' and callers must not
//! depend on it. The `derived_oracle` tests keep the derived definitions and
//! compare both decoders on a corpus.

use super::{
    half, safe_integer, safe_usize, Element, NodeId, Operation, OverlayAnchor, OverlayNavigation,
    OverlaySurface, Style,
};
use serde::de::{self, Deserialize, Deserializer, MapAccess, Visitor};
use std::fmt;

/// A member that may appear at most once.
fn once<'de, T, A>(slot: &mut Option<T>, name: &'static str, map: &mut A) -> Result<(), A::Error>
where
    T: Deserialize<'de>,
    A: MapAccess<'de>,
{
    if slot.is_some() {
        return Err(de::Error::duplicate_field(name));
    }
    *slot = Some(map.next_value()?);
    Ok(())
}

fn once_with<'de, T, W, A>(
    slot: &mut Option<T>,
    name: &'static str,
    map: &mut A,
    unwrap: fn(W) -> T,
) -> Result<(), A::Error>
where
    W: Deserialize<'de>,
    A: MapAccess<'de>,
{
    if slot.is_some() {
        return Err(de::Error::duplicate_field(name));
    }
    *slot = Some(unwrap(map.next_value::<W>()?));
    Ok(())
}

fn required<T, E: de::Error>(value: Option<T>, name: &'static str) -> Result<T, E> {
    value.ok_or_else(|| de::Error::missing_field(name))
}

/// Rejects a member that the chosen variant does not define.
fn reject<T, E: de::Error>(
    present: &Option<T>,
    name: &'static str,
    expected: &'static [&'static str],
) -> Result<(), E> {
    if present.is_some() {
        Err(de::Error::unknown_field(name, expected))
    } else {
        Ok(())
    }
}

struct SafeUsize(usize);
impl<'de> Deserialize<'de> for SafeUsize {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        safe_usize(deserializer).map(Self)
    }
}

struct SafeRevision(u64);
impl<'de> Deserialize<'de> for SafeRevision {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        safe_integer(deserializer).map(Self)
    }
}

/// The tag value of a member that must be a string naming a known variant.
fn tag_of<'de, A, T>(
    map: &mut A,
    slot: &mut Option<T>,
    name: &'static str,
    parse: fn(&str) -> Option<T>,
    variants: &'static [&'static str],
) -> Result<(), A::Error>
where
    A: MapAccess<'de>,
{
    struct Tag<T>(fn(&str) -> Option<T>, &'static [&'static str]);
    impl<'de, T> de::DeserializeSeed<'de> for Tag<T> {
        type Value = T;
        fn deserialize<D: Deserializer<'de>>(self, deserializer: D) -> Result<T, D::Error> {
            struct V<T>(fn(&str) -> Option<T>, &'static [&'static str]);
            impl<T> Visitor<'_> for V<T> {
                type Value = T;
                fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                    formatter.write_str("a variant name")
                }
                fn visit_str<E: de::Error>(self, value: &str) -> Result<T, E> {
                    (self.0)(value).ok_or_else(|| de::Error::unknown_variant(value, self.1))
                }
            }
            deserializer.deserialize_str(V(self.0, self.1))
        }
    }
    if slot.is_some() {
        return Err(de::Error::duplicate_field(name));
    }
    *slot = Some(map.next_value_seed(Tag(parse, variants))?);
    Ok(())
}

/// Hands the member name to `f`, keeping borrowed keys borrowed.
fn key<'de, A: MapAccess<'de>, R>(
    map: &mut A,
    f: impl FnOnce(&str) -> R,
) -> Result<Option<R>, A::Error> {
    struct Seed<F>(F);
    impl<'de, F, R> de::DeserializeSeed<'de> for Seed<F>
    where
        F: FnOnce(&str) -> R,
    {
        type Value = R;
        fn deserialize<D: Deserializer<'de>>(self, deserializer: D) -> Result<R, D::Error> {
            struct V<F>(F);
            impl<F, R> Visitor<'_> for V<F>
            where
                F: FnOnce(&str) -> R,
            {
                type Value = R;
                fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                    formatter.write_str("a member name")
                }
                fn visit_str<E: de::Error>(self, value: &str) -> Result<R, E> {
                    Ok((self.0)(value))
                }
            }
            deserializer.deserialize_str(V(self.0))
        }
    }
    map.next_key_seed(Seed(f))
}

#[derive(Clone, Copy)]
enum ElementKind {
    Box,
    Text,
    Button,
    Input,
    Split,
    Overlay,
}

fn element_kind(name: &str) -> Option<ElementKind> {
    Some(match name {
        "box" => ElementKind::Box,
        "text" => ElementKind::Text,
        "button" => ElementKind::Button,
        "input" => ElementKind::Input,
        "split" => ElementKind::Split,
        "overlay" => ElementKind::Overlay,
        _ => return None,
    })
}

const ELEMENT_KINDS: &[&str] = &["box", "text", "button", "input", "split", "overlay"];
const ELEMENT_FIELDS: &[&str] = &[
    "kind",
    "style",
    "text",
    "disabled",
    "value",
    "placeholder",
    "read_only",
    "ratio",
    "min_size",
    "anchor",
    "modal",
    "autofocus",
    "navigation",
    "surface",
];

#[derive(Clone, Copy)]
enum ElementField {
    Kind,
    Style,
    Text,
    Disabled,
    Value,
    Placeholder,
    ReadOnly,
    Ratio,
    MinSize,
    Anchor,
    Modal,
    Autofocus,
    Navigation,
    Surface,
}

fn element_field(name: &str) -> Option<ElementField> {
    Some(match name {
        "kind" => ElementField::Kind,
        "style" => ElementField::Style,
        "text" => ElementField::Text,
        "disabled" => ElementField::Disabled,
        "value" => ElementField::Value,
        "placeholder" => ElementField::Placeholder,
        "read_only" => ElementField::ReadOnly,
        "ratio" => ElementField::Ratio,
        "min_size" => ElementField::MinSize,
        "anchor" => ElementField::Anchor,
        "modal" => ElementField::Modal,
        "autofocus" => ElementField::Autofocus,
        "navigation" => ElementField::Navigation,
        "surface" => ElementField::Surface,
        _ => return None,
    })
}

impl<'de> Deserialize<'de> for Element {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct ElementVisitor;
        impl<'de> Visitor<'de> for ElementVisitor {
            type Value = Element;

            fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str("an element object")
            }

            #[allow(clippy::too_many_lines)]
            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Element, A::Error> {
                let mut kind = None;
                let mut style: Option<Style> = None;
                let mut text: Option<String> = None;
                let mut value: Option<String> = None;
                let mut placeholder: Option<String> = None;
                let mut disabled: Option<bool> = None;
                let mut read_only: Option<bool> = None;
                let mut ratio: Option<f64> = None;
                let mut min_size: Option<f64> = None;
                let mut anchor: Option<OverlayAnchor> = None;
                let mut modal: Option<bool> = None;
                let mut autofocus: Option<bool> = None;
                let mut navigation: Option<OverlayNavigation> = None;
                let mut surface: Option<OverlaySurface> = None;
                while let Some(field) = key(&mut map, element_field)? {
                    let Some(field) = field else {
                        // Any unread member of an unknown name is an error, so
                        // nothing is skipped without being looked at.
                        return Err(de::Error::custom(format_args!(
                            "unknown field, expected one of {}",
                            ELEMENT_FIELDS.join(", ")
                        )));
                    };
                    match field {
                        ElementField::Kind => {
                            tag_of(&mut map, &mut kind, "kind", element_kind, ELEMENT_KINDS)?;
                        }
                        ElementField::Style => once(&mut style, "style", &mut map)?,
                        ElementField::Text => once(&mut text, "text", &mut map)?,
                        ElementField::Disabled => once(&mut disabled, "disabled", &mut map)?,
                        ElementField::Value => once(&mut value, "value", &mut map)?,
                        ElementField::Placeholder => {
                            once(&mut placeholder, "placeholder", &mut map)?;
                        }
                        ElementField::ReadOnly => once(&mut read_only, "read_only", &mut map)?,
                        ElementField::Ratio => once(&mut ratio, "ratio", &mut map)?,
                        ElementField::MinSize => once(&mut min_size, "min_size", &mut map)?,
                        ElementField::Anchor => once(&mut anchor, "anchor", &mut map)?,
                        ElementField::Modal => once(&mut modal, "modal", &mut map)?,
                        ElementField::Autofocus => once(&mut autofocus, "autofocus", &mut map)?,
                        ElementField::Navigation => {
                            once(&mut navigation, "navigation", &mut map)?;
                        }
                        ElementField::Surface => once(&mut surface, "surface", &mut map)?,
                    }
                }
                let kind: ElementKind = required(kind, "kind")?;
                let style_out = style.take().unwrap_or_default();
                match kind {
                    ElementKind::Box => {
                        let own = &["kind", "style"];
                        reject(&text, "text", own)?;
                        reject(&value, "value", own)?;
                        reject(&placeholder, "placeholder", own)?;
                        reject(&disabled, "disabled", own)?;
                        reject(&read_only, "read_only", own)?;
                        reject(&ratio, "ratio", own)?;
                        reject(&min_size, "min_size", own)?;
                        reject(&anchor, "anchor", own)?;
                        reject(&modal, "modal", own)?;
                        reject(&autofocus, "autofocus", own)?;
                        reject(&navigation, "navigation", own)?;
                        reject(&surface, "surface", own)?;
                        Ok(Element::Box { style: style_out })
                    }
                    ElementKind::Text => {
                        let own = &["kind", "text", "style"];
                        reject(&value, "value", own)?;
                        reject(&placeholder, "placeholder", own)?;
                        reject(&disabled, "disabled", own)?;
                        reject(&read_only, "read_only", own)?;
                        reject(&ratio, "ratio", own)?;
                        reject(&min_size, "min_size", own)?;
                        reject(&anchor, "anchor", own)?;
                        reject(&modal, "modal", own)?;
                        reject(&autofocus, "autofocus", own)?;
                        reject(&navigation, "navigation", own)?;
                        reject(&surface, "surface", own)?;
                        Ok(Element::Text {
                            text: required(text, "text")?,
                            style: style_out,
                        })
                    }
                    ElementKind::Button => {
                        let own = &["kind", "text", "disabled", "style"];
                        reject(&value, "value", own)?;
                        reject(&placeholder, "placeholder", own)?;
                        reject(&read_only, "read_only", own)?;
                        reject(&ratio, "ratio", own)?;
                        reject(&min_size, "min_size", own)?;
                        reject(&anchor, "anchor", own)?;
                        reject(&modal, "modal", own)?;
                        reject(&autofocus, "autofocus", own)?;
                        reject(&navigation, "navigation", own)?;
                        reject(&surface, "surface", own)?;
                        Ok(Element::Button {
                            text: required(text, "text")?,
                            disabled: disabled.unwrap_or_default(),
                            style: style_out,
                        })
                    }
                    ElementKind::Input => {
                        let own = &[
                            "kind",
                            "value",
                            "placeholder",
                            "disabled",
                            "read_only",
                            "style",
                        ];
                        reject(&text, "text", own)?;
                        reject(&ratio, "ratio", own)?;
                        reject(&min_size, "min_size", own)?;
                        reject(&anchor, "anchor", own)?;
                        reject(&modal, "modal", own)?;
                        reject(&autofocus, "autofocus", own)?;
                        reject(&navigation, "navigation", own)?;
                        reject(&surface, "surface", own)?;
                        Ok(Element::Input {
                            value: required(value, "value")?,
                            placeholder: placeholder.unwrap_or_default(),
                            disabled: disabled.unwrap_or_default(),
                            read_only: read_only.unwrap_or_default(),
                            style: style_out,
                        })
                    }
                    ElementKind::Split => {
                        let own = &["kind", "ratio", "min_size", "style"];
                        reject(&text, "text", own)?;
                        reject(&value, "value", own)?;
                        reject(&placeholder, "placeholder", own)?;
                        reject(&disabled, "disabled", own)?;
                        reject(&read_only, "read_only", own)?;
                        reject(&anchor, "anchor", own)?;
                        reject(&modal, "modal", own)?;
                        reject(&autofocus, "autofocus", own)?;
                        reject(&navigation, "navigation", own)?;
                        reject(&surface, "surface", own)?;
                        Ok(Element::Split {
                            ratio: ratio.unwrap_or_else(half),
                            min_size: min_size.unwrap_or_default(),
                            style: style_out,
                        })
                    }
                    ElementKind::Overlay => {
                        let own = &[
                            "kind",
                            "anchor",
                            "modal",
                            "autofocus",
                            "navigation",
                            "surface",
                            "style",
                        ];
                        reject(&text, "text", own)?;
                        reject(&value, "value", own)?;
                        reject(&placeholder, "placeholder", own)?;
                        reject(&disabled, "disabled", own)?;
                        reject(&read_only, "read_only", own)?;
                        reject(&ratio, "ratio", own)?;
                        reject(&min_size, "min_size", own)?;
                        Ok(Element::Overlay {
                            anchor: anchor.unwrap_or_default(),
                            modal: modal.unwrap_or_default(),
                            autofocus: autofocus.unwrap_or_default(),
                            navigation: navigation.unwrap_or_default(),
                            surface: surface.unwrap_or_default(),
                            style: style_out,
                        })
                    }
                }
            }
        }
        deserializer.deserialize_map(ElementVisitor)
    }
}

#[derive(Clone, Copy)]
enum OperationKind {
    Create,
    Set,
    Insert,
    Delete,
    Focus,
    ScrollTo,
    ScrollIntoView,
}

fn operation_kind(name: &str) -> Option<OperationKind> {
    Some(match name {
        "create" => OperationKind::Create,
        "set" => OperationKind::Set,
        "insert" => OperationKind::Insert,
        "delete" => OperationKind::Delete,
        "focus" => OperationKind::Focus,
        "scroll_to" => OperationKind::ScrollTo,
        "scroll_into_view" => OperationKind::ScrollIntoView,
        _ => return None,
    })
}

const OPERATION_KINDS: &[&str] = &[
    "create",
    "set",
    "insert",
    "delete",
    "focus",
    "scroll_to",
    "scroll_into_view",
];
const OPERATION_FIELDS: &[&str] = &[
    "type",
    "node_id",
    "element",
    "expected_input_revision",
    "parent_id",
    "child_id",
    "index",
    "x",
    "y",
];

#[derive(Clone, Copy)]
enum OperationField {
    Type,
    NodeId,
    Element,
    ExpectedInputRevision,
    ParentId,
    ChildId,
    Index,
    X,
    Y,
}

fn operation_field(name: &str) -> Option<OperationField> {
    Some(match name {
        "type" => OperationField::Type,
        "node_id" => OperationField::NodeId,
        "element" => OperationField::Element,
        "expected_input_revision" => OperationField::ExpectedInputRevision,
        "parent_id" => OperationField::ParentId,
        "child_id" => OperationField::ChildId,
        "index" => OperationField::Index,
        "x" => OperationField::X,
        "y" => OperationField::Y,
        _ => return None,
    })
}

impl<'de> Deserialize<'de> for Operation {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct OperationVisitor;
        impl<'de> Visitor<'de> for OperationVisitor {
            type Value = Operation;

            fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str("an operation object")
            }

            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Operation, A::Error> {
                let mut kind = None;
                let mut node_id: Option<NodeId> = None;
                let mut element: Option<Element> = None;
                let mut revision: Option<u64> = None;
                let mut parent_id: Option<NodeId> = None;
                let mut child_id: Option<NodeId> = None;
                let mut index: Option<usize> = None;
                let mut x: Option<f64> = None;
                let mut y: Option<f64> = None;
                while let Some(field) = key(&mut map, operation_field)? {
                    let Some(field) = field else {
                        return Err(de::Error::custom(format_args!(
                            "unknown field, expected one of {}",
                            OPERATION_FIELDS.join(", ")
                        )));
                    };
                    match field {
                        OperationField::Type => {
                            tag_of(&mut map, &mut kind, "type", operation_kind, OPERATION_KINDS)?;
                        }
                        OperationField::NodeId => once(&mut node_id, "node_id", &mut map)?,
                        OperationField::Element => once(&mut element, "element", &mut map)?,
                        OperationField::ExpectedInputRevision => once_with(
                            &mut revision,
                            "expected_input_revision",
                            &mut map,
                            |wrapped: SafeRevision| wrapped.0,
                        )?,
                        OperationField::ParentId => once(&mut parent_id, "parent_id", &mut map)?,
                        OperationField::ChildId => once(&mut child_id, "child_id", &mut map)?,
                        OperationField::Index => {
                            once_with(&mut index, "index", &mut map, |wrapped: SafeUsize| {
                                wrapped.0
                            })?;
                        }
                        OperationField::X => once(&mut x, "x", &mut map)?,
                        OperationField::Y => once(&mut y, "y", &mut map)?,
                    }
                }
                let kind: OperationKind = required(kind, "type")?;
                match kind {
                    OperationKind::Create => {
                        let own = &["type", "node_id", "element"];
                        reject(&revision, "expected_input_revision", own)?;
                        reject(&parent_id, "parent_id", own)?;
                        reject(&child_id, "child_id", own)?;
                        reject(&index, "index", own)?;
                        reject(&x, "x", own)?;
                        reject(&y, "y", own)?;
                        Ok(Operation::Create {
                            node_id: required(node_id, "node_id")?,
                            element: required(element, "element")?,
                        })
                    }
                    OperationKind::Set => {
                        let own = &["type", "node_id", "element", "expected_input_revision"];
                        reject(&parent_id, "parent_id", own)?;
                        reject(&child_id, "child_id", own)?;
                        reject(&index, "index", own)?;
                        reject(&x, "x", own)?;
                        reject(&y, "y", own)?;
                        Ok(Operation::Set {
                            node_id: required(node_id, "node_id")?,
                            element: required(element, "element")?,
                            expected_input_revision: revision,
                        })
                    }
                    OperationKind::Insert => {
                        let own = &["type", "parent_id", "child_id", "index"];
                        reject(&node_id, "node_id", own)?;
                        reject(&element, "element", own)?;
                        reject(&revision, "expected_input_revision", own)?;
                        reject(&x, "x", own)?;
                        reject(&y, "y", own)?;
                        Ok(Operation::Insert {
                            parent_id: required(parent_id, "parent_id")?,
                            child_id: required(child_id, "child_id")?,
                            index: required(index, "index")?,
                        })
                    }
                    OperationKind::Delete
                    | OperationKind::Focus
                    | OperationKind::ScrollIntoView => {
                        let own = &["type", "node_id"];
                        reject(&element, "element", own)?;
                        reject(&revision, "expected_input_revision", own)?;
                        reject(&parent_id, "parent_id", own)?;
                        reject(&child_id, "child_id", own)?;
                        reject(&index, "index", own)?;
                        reject(&x, "x", own)?;
                        reject(&y, "y", own)?;
                        let node_id = required(node_id, "node_id")?;
                        Ok(match kind {
                            OperationKind::Delete => Operation::Delete { node_id },
                            OperationKind::Focus => Operation::Focus { node_id },
                            _ => Operation::ScrollIntoView { node_id },
                        })
                    }
                    OperationKind::ScrollTo => {
                        let own = &["type", "node_id", "x", "y"];
                        reject(&element, "element", own)?;
                        reject(&revision, "expected_input_revision", own)?;
                        reject(&parent_id, "parent_id", own)?;
                        reject(&child_id, "child_id", own)?;
                        reject(&index, "index", own)?;
                        Ok(Operation::ScrollTo {
                            node_id: required(node_id, "node_id")?,
                            x,
                            y,
                        })
                    }
                }
            }
        }
        deserializer.deserialize_map(OperationVisitor)
    }
}
