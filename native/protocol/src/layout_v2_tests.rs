//! `split_v1` and `style_decoration_v1`: the shared corpus and split ownership.

use super::*;
use serde_json::{json, Value};
use std::io::Cursor;

fn read_json(value: &Value) -> Result<Option<Command>, ProtocolError> {
    CommandReader::default().read(&mut Cursor::new(format!("{value}\n").as_bytes()))
}
fn batch(element: Value) -> Value {
    json!({"type":"batch","id":1,"window_id":1,"base_revision":0,"operations":[{"type":"create","node_id":2,"element":element}]})
}

/// JSON has one numeric type; serde keeps `64` and `64.0` apart in a Value.
fn same(actual: &Value, expected: &Value) -> bool {
    match (actual, expected) {
        (Value::Number(a), Value::Number(b)) => a.as_f64() == b.as_f64(),
        (Value::Object(a), Value::Object(b)) => {
            a.len() == b.len()
                && b.iter()
                    .all(|(key, b)| a.get(key).is_some_and(|a| same(a, b)))
        }
        _ => actual == expected,
    }
}

#[test]
fn split_and_decoration_contract_matches_javascript() {
    let fixtures: Value =
        serde_json::from_str(include_str!("../../../tests/fixtures/layout-style-v2.json")).unwrap();
    assert_eq!(
        fixtures["capabilities"],
        json!([Capability::SplitV1, Capability::StyleDecorationV1])
    );
    for case in fixtures["cases"].as_array().unwrap() {
        let result = read_json(&batch(case["element"].clone()));
        let expected = case.get("expected");
        assert_eq!(
            result.is_ok(),
            expected.is_some(),
            "{}: {result:?}",
            case["name"]
        );
        if let Some(expected) = expected {
            let element: Element = serde_json::from_value(case["element"].clone()).unwrap();
            let actual = serde_json::to_value(&element).unwrap();
            assert!(same(&actual, expected), "{}: {actual}", case["name"]);
        }
    }
    for value in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
        let styles = [
            Style {
                border_width: Some(value),
                ..Style::default()
            },
            Style {
                corner_radius: Some(value),
                ..Style::default()
            },
            Style {
                opacity: Some(value),
                ..Style::default()
            },
            Style {
                font_weight: Some(value),
                ..Style::default()
            },
        ];
        for style in styles {
            assert!(style.uses_decoration());
            assert!(Element::Box { style }.validate().is_err());
        }
        for (ratio, min_size) in [(value, 0.), (0.5, value)] {
            let split = Element::Split {
                ratio,
                min_size,
                style: Style::default(),
            };
            assert!(split.validate().is_err());
        }
    }
    assert!(!Style::default().uses_decoration());
}

fn id(value: u64) -> NodeId {
    NodeId::try_from(value).unwrap()
}
fn split() -> Element {
    Element::Split {
        ratio: 0.5,
        min_size: 0.,
        style: Style::default(),
    }
}
fn text() -> Element {
    Element::Text {
        text: "pane".into(),
        style: Style::default(),
    }
}
fn create(node: u64, element: Element) -> Operation {
    Operation::Create {
        node_id: id(node),
        element,
    }
}
fn insert(parent: u64, child: u64, index: usize) -> Operation {
    Operation::Insert {
        parent_id: id(parent),
        child_id: id(child),
        index,
    }
}

#[test]
fn a_split_owns_at_most_two_panes_and_keeps_its_children_on_set() {
    let tree = Tree::new(id(1));
    let prepared = tree
        .prepare(
            0,
            vec![
                create(2, split()),
                create(3, text()),
                create(4, text()),
                insert(1, 2, 0),
                insert(2, 3, 0),
                insert(2, 4, 1),
            ],
            1,
        )
        .unwrap();
    assert!(prepared.tree.node(id(2)).unwrap().element().is_container());
    assert_eq!(
        prepared.tree.node(id(2)).unwrap().children(),
        [id(3), id(4)]
    );
    let third = prepared
        .tree
        .prepare(1, vec![create(5, text()), insert(2, 5, 0)], 4)
        .err()
        .unwrap();
    assert_eq!(third.code, ErrorCode::LimitExceeded);
    // Reordering within the split does not count as a third pane.
    let reordered = prepared.tree.prepare(1, vec![insert(2, 4, 0)], 4).unwrap();
    assert_eq!(
        reordered.tree.node(id(2)).unwrap().children(),
        [id(4), id(3)]
    );
    let restyled = reordered
        .tree
        .prepare(
            2,
            vec![Operation::Set {
                node_id: id(2),
                element: Element::Split {
                    ratio: 0.25,
                    min_size: 40.,
                    style: Style {
                        direction: Some(Direction::Column),
                        ..Style::default()
                    },
                },
                expected_input_revision: None,
            }],
            4,
        )
        .unwrap();
    assert_eq!(
        restyled.tree.node(id(2)).unwrap().children(),
        [id(4), id(3)]
    );
    let leaf_parent = restyled
        .tree
        .prepare(3, vec![create(5, text()), insert(3, 5, 0)], 4)
        .err()
        .unwrap();
    assert_eq!(leaf_parent.code, ErrorCode::InvalidState);
    assert_eq!(
        Element::Box {
            style: Style::default()
        }
        .max_children(),
        MAX_NODES_PER_WINDOW
    );
    assert_eq!(text().max_children(), 0);
}
