//! Differential tests: the hand-written `Element` and `Operation` decoders must
//! accept and reject exactly what the derived internally tagged decoders did,
//! and produce the same values. The oracle types below are the previous derived
//! definitions, kept only here.

use super::*;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

fn non_null_revision_oracle<'de, D: Deserializer<'de>>(d: D) -> Result<Option<u64>, D::Error> {
    safe_integer(d).map(Some)
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
enum OracleElement {
    Box {
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "non_null"
        )]
        accessible_role: Option<AccessibleRole>,
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "non_null"
        )]
        accessible_label: Option<String>,
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "non_null_color"
        )]
        accessible_set_size: Option<u32>,
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "non_null_color"
        )]
        accessible_position: Option<u32>,
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "non_null"
        )]
        accessible_selected: Option<bool>,
        #[serde(default)]
        style: Style,
    },
    Text {
        text: String,
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "non_null"
        )]
        accessible_live: Option<Live>,
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
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        disabled: bool,
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        read_only: bool,
        #[serde(default)]
        style: Style,
    },
    Split {
        #[serde(default = "half")]
        ratio: f64,
        #[serde(default)]
        min_size: f64,
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "non_null"
        )]
        accessible_label: Option<String>,
        #[serde(default)]
        style: Style,
    },
    Overlay {
        #[serde(default)]
        anchor: OverlayAnchor,
        #[serde(default)]
        modal: bool,
        #[serde(default, skip_serializing_if = "is_false")]
        autofocus: bool,
        #[serde(default, skip_serializing_if = "OverlayNavigation::is_tab")]
        navigation: OverlayNavigation,
        #[serde(default, skip_serializing_if = "OverlaySurface::is_layer")]
        surface: OverlaySurface,
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "non_null"
        )]
        accessible_label: Option<String>,
        #[serde(default)]
        style: Style,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
enum OracleOperation {
    Create {
        node_id: NodeId,
        element: OracleElement,
    },
    Set {
        node_id: NodeId,
        element: OracleElement,
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "non_null_revision_oracle"
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
    Focus {
        node_id: NodeId,
    },
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
    ScrollIntoView {
        node_id: NodeId,
    },
}

/// serde resolves an internal tag through an identifier visitor, which also
/// accepts a variant's index: `{"kind":1}` decoded as `text`. That is not part
/// of the wire contract (the TypeScript validators reject it), so the hand-written
/// decoders reject it. Only this difference is allowed, and only when some tag
/// member is a number.
fn has_numeric_tag(value: &Value) -> bool {
    match value {
        Value::Object(map) => map.iter().any(|(key, child)| {
            ((key == "kind" || key == "type") && child.is_number()) || has_numeric_tag(child)
        }),
        _ => false,
    }
}

fn numeric_tag_exemption(text: &str) -> bool {
    serde_json::from_str::<Value>(text).is_ok_and(|value| has_numeric_tag(&value))
}

/// Both decoders read `text`; equal outcomes must also serialize identically.
fn compare_operation(text: &str) -> bool {
    let new = serde_json::from_str::<Operation>(text);
    let old = serde_json::from_str::<OracleOperation>(text);
    match (&new, &old) {
        (Ok(new), Ok(old)) => {
            assert_eq!(
                serde_json::to_string(new).unwrap(),
                serde_json::to_string(old).unwrap(),
                "different values for {text}"
            );
            true
        }
        (Err(_), Err(_)) => false,
        (Err(_), Ok(_)) if numeric_tag_exemption(text) => false,
        _ => panic!("decoders disagree on {text}: new {new:?}, old {old:?}"),
    }
}

fn compare_element(text: &str) -> bool {
    let new = serde_json::from_str::<Element>(text);
    let old = serde_json::from_str::<OracleElement>(text);
    match (&new, &old) {
        (Ok(new), Ok(old)) => {
            assert_eq!(
                serde_json::to_string(new).unwrap(),
                serde_json::to_string(old).unwrap(),
                "different values for {text}"
            );
            true
        }
        (Err(_), Err(_)) => false,
        (Err(_), Ok(_)) if numeric_tag_exemption(text) => false,
        _ => panic!("decoders disagree on {text}: new {new:?}, old {old:?}"),
    }
}

fn elements() -> Vec<Value> {
    let style = json!({
        "direction": "column", "gap": 4, "padding": 2.5, "width": "fill", "height": 30,
        "min_width": 1, "max_width": 9, "min_height": 1, "max_height": 9,
        "flex_grow": 1, "flex_shrink": 0, "align_items": "center",
        "justify_content": "space_between", "overflow": "scroll_y", "scroll_anchor": "end",
        "background": 16777215, "color": 0, "font_size": 12, "border_width": 1,
        "border_color": 5, "corner_radius": 3, "opacity": 0.5, "font_weight": 700
    });
    vec![
        json!({"kind": "box"}),
        json!({"kind": "box", "style": style}),
        json!({"kind": "text", "text": "héllo \u{1F600} \"quoted\"", "style": {"gap": 1}}),
        json!({"kind": "button", "text": "Go", "disabled": true}),
        json!({"kind": "input", "value": "v", "placeholder": "p", "disabled": true,
               "read_only": true, "style": {}}),
        json!({"kind": "input", "value": ""}),
        json!({"kind": "split", "ratio": 0.25, "min_size": 40, "style": {"direction": "row"}}),
        json!({"kind": "split", "accessible_label": "Sidebar"}),
        json!({"kind": "split"}),
        json!({"kind": "overlay", "anchor": "parent", "modal": false, "autofocus": true,
               "navigation": "menu", "surface": "window", "style": {"width": 100, "height": 50}}),
        json!({"kind": "overlay", "modal": true, "accessible_label": "Delete file"}),
        json!({"kind": "overlay"}),
        json!({"kind": "box", "accessible_role": "list", "accessible_label": "Messages",
               "accessible_set_size": 10150}),
        json!({"kind": "box", "accessible_role": "list_item", "accessible_position": 3,
               "accessible_selected": true}),
        json!({"kind": "text", "text": "Token", "accessible_live": "polite"}),
    ]
}

fn operations() -> Vec<Value> {
    let mut all = vec![
        json!({"type": "insert", "parent_id": 1, "child_id": 2, "index": 0}),
        json!({"type": "delete", "node_id": 7}),
        json!({"type": "focus", "node_id": 7}),
        json!({"type": "scroll_into_view", "node_id": 7}),
        json!({"type": "scroll_to", "node_id": 7}),
        json!({"type": "scroll_to", "node_id": 7, "x": 1.5, "y": 0}),
    ];
    for element in elements() {
        all.push(json!({"type": "create", "node_id": 3, "element": element}));
        all.push(json!({"type": "set", "node_id": 3, "element": element}));
        all.push(json!({"type": "set", "node_id": 3, "element": element,
                        "expected_input_revision": 9}));
    }
    all
}

/// Values that exercise each member's type and range checks.
fn replacements() -> Vec<Value> {
    vec![
        Value::Null,
        json!(true),
        json!(false),
        json!(0),
        json!(1),
        json!(-1),
        json!(1.5),
        json!(1.0),
        json!(9_007_199_254_740_991_u64),
        json!(9_007_199_254_740_992_u64),
        json!(1e30),
        json!(u64::MAX),
        json!(""),
        json!("fill"),
        json!("row"),
        json!("box"),
        json!("text"),
        json!("create"),
        json!([]),
        json!([1]),
        json!({}),
        json!({"kind": "box"}),
        json!({"gap": 1}),
        json!({"gap": null}),
        json!({"unknown": 1}),
    ]
}

struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn below(&mut self, bound: usize) -> usize {
        usize::try_from(self.next() % bound as u64).unwrap()
    }
}

/// Every member path (object keys only) of a value, for mutation targets.
fn paths(value: &Value, prefix: &mut Vec<String>, out: &mut Vec<Vec<String>>) {
    if let Value::Object(map) = value {
        for (key, child) in map {
            prefix.push(key.clone());
            out.push(prefix.clone());
            paths(child, prefix, out);
            prefix.pop();
        }
    }
}

fn at<'a>(value: &'a mut Value, path: &[String]) -> &'a mut Value {
    let mut current = value;
    for key in path {
        current = current.get_mut(key).unwrap();
    }
    current
}

fn mutate(value: &mut Value, rng: &mut Rng, replacements: &[Value]) {
    let mut found = Vec::new();
    paths(value, &mut Vec::new(), &mut found);
    if found.is_empty() {
        return;
    }
    let path = found[rng.below(found.len())].clone();
    let (parent, last) = path.split_at(path.len() - 1);
    let parent = at(value, parent);
    let map = parent.as_object_mut().unwrap();
    match rng.below(4) {
        0 => {
            map.remove(&last[0]);
        }
        1 => {
            map.insert(
                last[0].clone(),
                replacements[rng.below(replacements.len())].clone(),
            );
        }
        2 => {
            let names = [
                "kind",
                "type",
                "style",
                "text",
                "value",
                "placeholder",
                "disabled",
                "read_only",
                "ratio",
                "min_size",
                "anchor",
                "modal",
                "autofocus",
                "navigation",
                "surface",
                "accessible_label",
                "node_id",
                "element",
                "expected_input_revision",
                "parent_id",
                "child_id",
                "index",
                "x",
                "y",
                "extra",
            ];
            map.insert(
                names[rng.below(names.len())].to_string(),
                replacements[rng.below(replacements.len())].clone(),
            );
        }
        _ => {
            // Rename a member to another variant's member.
            if let Some(old) = map.remove(&last[0]) {
                let names = [
                    "text", "value", "modal", "ratio", "index", "x", "element", "style",
                ];
                map.insert(names[rng.below(names.len())].to_string(), old);
            }
        }
    }
}

#[test]
fn valid_corpus_matches() {
    for element in elements() {
        assert!(compare_element(&element.to_string()), "{element}");
    }
    for operation in operations() {
        assert!(compare_operation(&operation.to_string()), "{operation}");
    }
}

#[test]
fn mutated_corpus_matches() {
    let replacements = replacements();
    let mut rng = Rng(0x9E37_79B9_7F4A_7C15);
    let operations = operations();
    let elements = elements();
    let (mut accepted, mut rejected) = (0, 0);
    for round in 0..60_000 {
        let mut value = if round % 4 == 0 {
            elements[rng.below(elements.len())].clone()
        } else {
            operations[rng.below(operations.len())].clone()
        };
        for _ in 0..=rng.below(3) {
            mutate(&mut value, &mut rng, &replacements);
        }
        let text = value.to_string();
        let ok = if value.get("type").is_some() || round % 4 != 0 {
            compare_operation(&text)
        } else {
            compare_element(&text)
        };
        // Mutations may also land an element-shaped value on the operation path.
        let _ = compare_element(&text);
        if ok {
            accepted += 1;
        } else {
            rejected += 1;
        }
    }
    assert!(accepted > 1_000, "{accepted} accepted");
    assert!(rejected > 1_000, "{rejected} rejected");
}

#[test]
fn key_order_and_duplicates_match() {
    let cases = [
        // The tag after every other member.
        r#"{"element":{"style":{},"kind":"box"},"node_id":1,"type":"create"}"#,
        r#"{"node_id":1,"type":"delete"}"#,
        r#"{"index":3,"child_id":2,"parent_id":1,"type":"insert"}"#,
        // Duplicates of the tag, of members and of nested members.
        r#"{"type":"delete","type":"delete","node_id":1}"#,
        r#"{"type":"delete","node_id":1,"node_id":2}"#,
        r#"{"type":"create","node_id":1,"element":{"kind":"box","kind":"box"}}"#,
        r#"{"type":"create","node_id":1,"element":{"kind":"box","style":{},"style":{}}}"#,
        r#"{"type":"create","node_id":1,"element":{"kind":"box","style":{"gap":1,"gap":2}}}"#,
        r#"{"type":"create","node_id":1,"node_id":1,"element":{"kind":"box"}}"#,
        // Empty, non-objects and trailing members.
        r"{}",
        r"[]",
        r"null",
        r#""create""#,
        r#"{"type":"delete","node_id":1,}"#,
        r#"{"type":"delete","node_id":1} x"#,
        // Escaped member names and tags.
        r#"{"type":"delete","node_id":1}"#,
        r#"{"type":"delete","node_id":1}"#,
        r#"{"type":"create","node_id":1,"element":{"kind":"box"}}"#,
        // Cross-variant members.
        r#"{"type":"delete","node_id":1,"x":1}"#,
        r#"{"type":"scroll_to","node_id":1,"index":1}"#,
        r#"{"type":"create","node_id":1,"element":{"kind":"text","text":"a","value":"b"}}"#,
        r#"{"type":"create","node_id":1,"element":{"kind":"box","modal":true}}"#,
        // Absent defaults and safe-integer spellings.
        r#"{"type":"insert","parent_id":1.0,"child_id":2e0,"index":0.0}"#,
        r#"{"type":"set","node_id":1,"element":{"kind":"box"},"expected_input_revision":1e0}"#,
        r#"{"type":"set","node_id":1,"element":{"kind":"box"},"expected_input_revision":null}"#,
        r#"{"type":"insert","parent_id":1,"child_id":2,"index":-0}"#,
        r#"{"type":"create","node_id":0,"element":{"kind":"box"}}"#,
        r#"{"type":"create","node_id":9007199254740992,"element":{"kind":"box"}}"#,
    ];
    for case in cases {
        let _ = compare_operation(case);
        let _ = compare_element(case);
    }
}

#[test]
fn numeric_tags_are_rejected() {
    // The derived decoders accepted these as variant indexes.
    // Reached through an enclosing tagged value, the tag is a buffered number.
    let nested = r#"{"type":"create","node_id":1,"element":{"kind":1,"text":"a"}}"#;
    assert!(serde_json::from_str::<Operation>(nested).is_err());
    assert!(serde_json::from_str::<OracleOperation>(nested).is_ok());
    assert!(serde_json::from_str::<Element>(r#"{"kind":0}"#).is_err());
    assert!(serde_json::from_str::<Operation>(r#"{"type":3,"node_id":1}"#).is_err());
}

#[test]
fn rejects_what_the_wire_forbids() {
    for case in [
        r#"{"kind":"box","unknown":1}"#,
        r#"{"kind":"box","style":null}"#,
        r#"{"kind":"text"}"#,
        r#"{"style":{}}"#,
        r#"{"kind":"nope"}"#,
        r#"{"kind":"box","kind":"box"}"#,
        r#"{"kind":"overlay","modal":null}"#,
    ] {
        assert!(!compare_element(case), "{case}");
    }
    for case in [
        r#"{"type":"nope"}"#,
        r#"{"type":"delete"}"#,
        r#"{"type":"scroll_to","node_id":1,"x":null}"#,
        r#"{"type":"insert","parent_id":1,"child_id":2,"index":-1}"#,
    ] {
        assert!(!compare_operation(case), "{case}");
    }
}
