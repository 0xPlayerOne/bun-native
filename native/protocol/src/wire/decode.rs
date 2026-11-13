//! Hand-written decoders for the two internally tagged wire enums.
//!
//! `#[serde(tag = "...")]` buffers each tagged value into serde's private
//! `Content` tree and then replays it, and `Operation` nests `Element`, so every
//! created node paid for two buffered copies of its object and style. These
//! visitors read each member once, straight into the target. Member names,
//! variant tags and which variant accepts which member come from the generated
//! tables in `schema.rs`, so a member the schema adds must be read here before
//! this compiles. The accepted
//! language is the derived one: the tag may appear in any position, unknown
//! members, duplicate members, `null` for a present member and members that
//! belong to another variant are all rejected, and absent members take the same
//! defaults. Error text differs from the derived decoders' and callers must not
//! depend on it. The `derived_oracle` tests keep the derived definitions and
//! compare both decoders on a corpus.

use super::schema::{
    ElementKind, ElementMember, OperationKind, OperationMember, ELEMENT_KINDS, ELEMENT_MEMBERS,
    OPERATION_KINDS, OPERATION_MEMBERS,
};
use super::{
    half, safe_integer, safe_u32, safe_usize, AccessibleRole, BoxAccessibility, Element, Live,
    NodeId, Operation, OverlayAnchor, OverlayNavigation, OverlaySurface, Style,
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

struct SafeUsize(usize);
impl<'de> Deserialize<'de> for SafeUsize {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        safe_usize(deserializer).map(Self)
    }
}

struct SafeU32(u32);
impl<'de> Deserialize<'de> for SafeU32 {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        safe_u32(deserializer).map(Self)
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

/// Rejects the first member `present` holds that `allowed` does not, naming
/// it with the members the chosen variant accepts.
fn foreign<E: de::Error>(
    present: u32,
    allowed: u32,
    names: &'static [&'static str],
    expected: &'static [&'static str],
) -> Result<(), E> {
    let extra = present & !allowed;
    if extra == 0 {
        return Ok(());
    }
    Err(de::Error::unknown_field(
        names[extra.trailing_zeros() as usize],
        expected,
    ))
}

impl<'de> Deserialize<'de> for Element {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct ElementVisitor;
        impl<'de> Visitor<'de> for ElementVisitor {
            type Value = Element;

            fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str("an element object")
            }

            fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Element, A::Error> {
                let mut present = 0;
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
                let mut accessible_label: Option<String> = None;
                let mut accessible_role: Option<AccessibleRole> = None;
                let mut accessible_set_size: Option<SafeU32> = None;
                let mut accessible_position: Option<SafeU32> = None;
                let mut accessible_selected: Option<bool> = None;
                let mut accessible_live: Option<Live> = None;
                while let Some(member) = key(&mut map, ElementMember::from_name)? {
                    let Some(member) = member else {
                        // Any unread member of an unknown name is an error, so
                        // nothing is skipped without being looked at.
                        return Err(de::Error::custom(format_args!(
                            "unknown field, expected one of {}",
                            ELEMENT_MEMBERS.join(", ")
                        )));
                    };
                    present |= member.bit();
                    let map = &mut map;
                    match member {
                        ElementMember::Kind => {
                            tag_of(
                                map,
                                &mut kind,
                                "kind",
                                ElementKind::from_name,
                                ELEMENT_KINDS,
                            )?;
                        }
                        ElementMember::Style => once(&mut style, "style", map)?,
                        ElementMember::Text => once(&mut text, "text", map)?,
                        ElementMember::Disabled => once(&mut disabled, "disabled", map)?,
                        ElementMember::Value => once(&mut value, "value", map)?,
                        ElementMember::Placeholder => once(&mut placeholder, "placeholder", map)?,
                        ElementMember::ReadOnly => once(&mut read_only, "read_only", map)?,
                        ElementMember::Ratio => once(&mut ratio, "ratio", map)?,
                        ElementMember::MinSize => once(&mut min_size, "min_size", map)?,
                        ElementMember::Anchor => once(&mut anchor, "anchor", map)?,
                        ElementMember::Modal => once(&mut modal, "modal", map)?,
                        ElementMember::Autofocus => once(&mut autofocus, "autofocus", map)?,
                        ElementMember::Navigation => once(&mut navigation, "navigation", map)?,
                        ElementMember::Surface => once(&mut surface, "surface", map)?,
                        ElementMember::AccessibleLabel => {
                            once(&mut accessible_label, "accessible_label", map)?;
                        }
                        ElementMember::AccessibleRole => {
                            once(&mut accessible_role, "accessible_role", map)?;
                        }
                        ElementMember::AccessibleSetSize => {
                            once(&mut accessible_set_size, "accessible_set_size", map)?;
                        }
                        ElementMember::AccessiblePosition => {
                            once(&mut accessible_position, "accessible_position", map)?;
                        }
                        ElementMember::AccessibleSelected => {
                            once(&mut accessible_selected, "accessible_selected", map)?;
                        }
                        ElementMember::AccessibleLive => {
                            once(&mut accessible_live, "accessible_live", map)?;
                        }
                    }
                }
                let kind: ElementKind = required(kind, "kind")?;
                // One mask test replaces a check per member another kind owns.
                foreign(
                    present,
                    kind.members(),
                    ELEMENT_MEMBERS,
                    kind.member_names(),
                )?;
                let style = style.unwrap_or_default();
                Ok(match kind {
                    ElementKind::Box => Element::Box {
                        accessibility: BoxAccessibility {
                            accessible_role,
                            accessible_label,
                            accessible_set_size: accessible_set_size.map(|size| size.0),
                            accessible_position: accessible_position.map(|position| position.0),
                            accessible_selected,
                        },
                        style,
                    },
                    ElementKind::Text => Element::Text {
                        text: required(text, "text")?,
                        accessible_live,
                        style,
                    },
                    ElementKind::Button => Element::Button {
                        text: required(text, "text")?,
                        disabled: disabled.unwrap_or_default(),
                        style,
                    },
                    ElementKind::Input => Element::Input {
                        value: required(value, "value")?,
                        placeholder: placeholder.unwrap_or_default(),
                        disabled: disabled.unwrap_or_default(),
                        read_only: read_only.unwrap_or_default(),
                        style,
                    },
                    ElementKind::Split => Element::Split {
                        ratio: ratio.unwrap_or_else(half),
                        min_size: min_size.unwrap_or_default(),
                        accessible_label,
                        style,
                    },
                    ElementKind::Overlay => Element::Overlay {
                        anchor: anchor.unwrap_or_default(),
                        modal: modal.unwrap_or_default(),
                        autofocus: autofocus.unwrap_or_default(),
                        navigation: navigation.unwrap_or_default(),
                        surface: surface.unwrap_or_default(),
                        accessible_label,
                        style,
                    },
                })
            }
        }
        deserializer.deserialize_map(ElementVisitor)
    }
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
                let mut present = 0;
                let mut kind = None;
                let mut node_id: Option<NodeId> = None;
                let mut element: Option<Element> = None;
                let mut revision: Option<u64> = None;
                let mut parent_id: Option<NodeId> = None;
                let mut child_id: Option<NodeId> = None;
                let mut index: Option<usize> = None;
                let mut x: Option<f64> = None;
                let mut y: Option<f64> = None;
                while let Some(member) = key(&mut map, OperationMember::from_name)? {
                    let Some(member) = member else {
                        return Err(de::Error::custom(format_args!(
                            "unknown field, expected one of {}",
                            OPERATION_MEMBERS.join(", ")
                        )));
                    };
                    present |= member.bit();
                    let map = &mut map;
                    match member {
                        OperationMember::Type => tag_of(
                            map,
                            &mut kind,
                            "type",
                            OperationKind::from_name,
                            OPERATION_KINDS,
                        )?,
                        OperationMember::NodeId => once(&mut node_id, "node_id", map)?,
                        OperationMember::Element => once(&mut element, "element", map)?,
                        OperationMember::ExpectedInputRevision => once_with(
                            &mut revision,
                            "expected_input_revision",
                            map,
                            |wrapped: SafeRevision| wrapped.0,
                        )?,
                        OperationMember::ParentId => once(&mut parent_id, "parent_id", map)?,
                        OperationMember::ChildId => once(&mut child_id, "child_id", map)?,
                        OperationMember::Index => {
                            once_with(&mut index, "index", map, |wrapped: SafeUsize| wrapped.0)?;
                        }
                        OperationMember::X => once(&mut x, "x", map)?,
                        OperationMember::Y => once(&mut y, "y", map)?,
                    }
                }
                let kind: OperationKind = required(kind, "type")?;
                foreign(
                    present,
                    kind.members(),
                    OPERATION_MEMBERS,
                    kind.member_names(),
                )?;
                Ok(match kind {
                    OperationKind::Create => Operation::Create {
                        node_id: required(node_id, "node_id")?,
                        element: required(element, "element")?,
                    },
                    OperationKind::Set => Operation::Set {
                        node_id: required(node_id, "node_id")?,
                        element: required(element, "element")?,
                        expected_input_revision: revision,
                    },
                    OperationKind::Insert => Operation::Insert {
                        parent_id: required(parent_id, "parent_id")?,
                        child_id: required(child_id, "child_id")?,
                        index: required(index, "index")?,
                    },
                    OperationKind::Delete => Operation::Delete {
                        node_id: required(node_id, "node_id")?,
                    },
                    OperationKind::Focus => Operation::Focus {
                        node_id: required(node_id, "node_id")?,
                    },
                    OperationKind::ScrollTo => Operation::ScrollTo {
                        node_id: required(node_id, "node_id")?,
                        x,
                        y,
                    },
                    OperationKind::ScrollIntoView => Operation::ScrollIntoView {
                        node_id: required(node_id, "node_id")?,
                    },
                })
            }
        }
        deserializer.deserialize_map(OperationVisitor)
    }
}
