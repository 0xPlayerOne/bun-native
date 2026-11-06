//! Overlay element and scroll-anchor contract shared with the TypeScript validator.

use super::*;
use serde_json::{json, Value};
use std::io::Cursor;

fn node(value: u64) -> NodeId {
    NodeId::try_from(value).unwrap()
}
fn read_json(value: &Value) -> Result<Option<Command>, ProtocolError> {
    CommandReader::default().read(&mut Cursor::new(format!("{value}\n").as_bytes()))
}
fn batch(element: Value) -> Value {
    json!({"type":"batch","id":1,"window_id":1,"base_revision":0,"operations":[{"type":"create","node_id":2,"element":element}]})
}
/// JSON has one numeric type; serde's generic value keeps the 4 / 4.0 spelling.
fn numeric(value: Value) -> Value {
    match value {
        Value::Number(number) => json!(number.as_f64().unwrap()),
        Value::Object(entries) => entries
            .into_iter()
            .map(|(key, value)| (key, numeric(value)))
            .collect(),
        Value::Array(values) => values.into_iter().map(numeric).collect(),
        other => other,
    }
}
fn overlay(modal: bool) -> Element {
    Element::Overlay {
        anchor: OverlayAnchor::Window,
        modal,
        autofocus: false,
        navigation: OverlayNavigation::Tab,
        surface: OverlaySurface::Layer,
        style: Style::default(),
    }
}
fn create(id: u64, element: Element) -> Operation {
    Operation::Create {
        node_id: node(id),
        element,
    }
}
fn insert(parent: u64, child: u64) -> Operation {
    Operation::Insert {
        parent_id: node(parent),
        child_id: node(child),
        index: 0,
    }
}

#[test]
fn shared_overlay_contract_has_the_same_acceptance_in_both_languages() {
    let fixtures: Value =
        serde_json::from_str(include_str!("../../../tests/fixtures/overlays.json")).unwrap();
    assert_eq!(
        fixtures["capabilities"],
        json!([
            serde_json::to_value(Capability::OverlaysV1).unwrap(),
            serde_json::to_value(Capability::ScrollAnchorV1).unwrap(),
            serde_json::to_value(Capability::OverlayKeyboardV1).unwrap()
        ])
    );
    assert_eq!(fixtures["max_overlay_depth"], json!(MAX_OVERLAY_DEPTH));
    for case in fixtures["cases"].as_array().unwrap() {
        let result = read_json(&batch(case["element"].clone()));
        assert_eq!(
            result.is_ok(),
            case["valid"].as_bool().unwrap(),
            "{}: {result:?}",
            case["name"]
        );
        if let Some(normalized) = case.get("normalized") {
            let element: Element = serde_json::from_value(case["element"].clone()).unwrap();
            assert_eq!(
                numeric(serde_json::to_value(&element).unwrap()),
                numeric(normalized.clone()),
                "{}",
                case["name"]
            );
        }
    }
}

#[test]
fn overlays_own_children_and_nest_to_a_bounded_depth() {
    let mut operations = Vec::new();
    let mut parent = 1;
    for id in 2..2 + MAX_OVERLAY_DEPTH as u64 {
        operations.push(create(id, overlay(id % 2 == 0)));
        operations.push(insert(parent, id));
        parent = id;
    }
    operations.push(create(
        100,
        Element::Text {
            text: "deepest".into(),
            style: Style::default(),
        },
    ));
    operations.push(insert(parent, 100));
    let tree = Tree::new(node(1))
        .prepare(0, operations, 1)
        .expect("eight nested overlays are accepted")
        .tree;
    assert_eq!(tree.path(node(100)).unwrap().len(), MAX_OVERLAY_DEPTH + 2);

    // A ninth layer fails the entire batch without changing committed state.
    let before = tree.clone();
    let error = tree
        .prepare(
            tree.revision(),
            vec![create(101, overlay(false)), insert(parent, 101)],
            100,
        )
        .err()
        .unwrap();
    assert_eq!(error.code, ErrorCode::LimitExceeded);
    assert_eq!(tree, before);
    // Ordinary boxes inside the deepest overlay do not count as layers.
    assert!(tree
        .prepare(
            tree.revision(),
            vec![
                create(
                    101,
                    Element::Box {
                        style: Style::default()
                    }
                ),
                insert(parent, 101)
            ],
            100,
        )
        .is_ok());
}

#[test]
fn modal_overlays_reject_parent_anchoring_and_set_keeps_the_kind() {
    assert!(Element::Overlay {
        anchor: OverlayAnchor::Parent,
        modal: true,
        autofocus: false,
        navigation: OverlayNavigation::Tab,
        surface: OverlaySurface::Layer,
        style: Style::default(),
    }
    .validate()
    .is_err());
    let tree = Tree::new(node(1))
        .prepare(0, vec![create(2, overlay(true)), insert(1, 2)], 1)
        .unwrap()
        .tree;
    let changed = tree
        .prepare(
            tree.revision(),
            vec![Operation::Set {
                node_id: node(2),
                element: Element::Box {
                    style: Style::default(),
                },
                expected_input_revision: None,
            }],
            2,
        )
        .err()
        .unwrap();
    assert_eq!(changed.code, ErrorCode::InvalidState);
    assert!(tree
        .prepare(
            tree.revision(),
            vec![Operation::Set {
                node_id: node(2),
                element: overlay(false),
                expected_input_revision: None,
            }],
            2,
        )
        .is_ok());
}
