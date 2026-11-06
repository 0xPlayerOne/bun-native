//! Popup window overlay contract shared with the TypeScript validator.

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
fn popup() -> Element {
    serde_json::from_value(json!({
        "kind": "overlay",
        "anchor": "parent",
        "surface": "window",
        "style": { "width": 120, "height": 80 }
    }))
    .unwrap()
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
fn text(id: u64) -> Operation {
    create(
        id,
        Element::Text {
            text: "item".into(),
            style: Style::default(),
        },
    )
}

#[test]
fn shared_popup_contract_has_the_same_acceptance_in_both_languages() {
    let fixtures: Value =
        serde_json::from_str(include_str!("../../../tests/fixtures/popup-windows.json")).unwrap();
    assert_eq!(
        fixtures["capability"],
        serde_json::to_value(Capability::PopupWindowsV1).unwrap()
    );
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
fn popup_content_rejects_editors_and_nested_layers_atomically() {
    let tree = Tree::new(node(1))
        .prepare(
            0,
            vec![
                create(
                    2,
                    Element::Box {
                        style: Style::default(),
                    },
                ),
                insert(1, 2),
                create(3, popup()),
                insert(2, 3),
                create(
                    4,
                    Element::Button {
                        text: "Copy".into(),
                        disabled: false,
                        style: Style::default(),
                    },
                ),
                insert(3, 4),
                text(5),
                insert(3, 5),
            ],
            1,
        )
        .expect("buttons and text are popup content")
        .tree;
    for (id, element) in [
        (
            10,
            Element::Input {
                value: String::new(),
                placeholder: String::new(),
                disabled: false,
                read_only: false,
                style: Style::default(),
            },
        ),
        (
            11,
            Element::Overlay {
                anchor: OverlayAnchor::Parent,
                modal: false,
                surface: OverlaySurface::Layer,
                autofocus: false,
                navigation: OverlayNavigation::Tab,
                style: Style::default(),
            },
        ),
    ] {
        let before = tree.clone();
        // Placed below an ordinary box inside the popup: depth does not matter.
        let error = tree
            .prepare(
                tree.revision(),
                vec![
                    create(
                        9,
                        Element::Box {
                            style: Style::default(),
                        },
                    ),
                    insert(3, 9),
                    create(id, element),
                    insert(9, id),
                ],
                5,
            )
            .err()
            .unwrap();
        assert_eq!(error.code, ErrorCode::InvalidState);
        assert_eq!(tree, before);
    }
    // A popup may itself sit inside a layer overlay, such as a dialog.
    assert!(Tree::new(node(1))
        .prepare(
            0,
            vec![
                create(
                    2,
                    Element::Overlay {
                        anchor: OverlayAnchor::Window,
                        modal: true,
                        surface: OverlaySurface::Layer,
                        autofocus: false,
                        navigation: OverlayNavigation::Tab,
                        style: Style::default(),
                    },
                ),
                insert(1, 2),
                create(3, popup()),
                insert(2, 3),
            ],
            1,
        )
        .is_ok());
}

#[test]
fn dismiss_events_carry_a_validated_route_and_reason() {
    let event = Event::Dismiss {
        sequence: EventSequence::try_from(1).unwrap(),
        window_id: WindowId::try_from(1).unwrap(),
        node_id: node(3),
        tree_revision: 2,
        path: vec![node(1), node(2), node(3)],
        reason: DismissReason::WindowBlur,
    };
    assert!(event.validate().is_ok());
    assert_eq!(
        serde_json::to_value(&event).unwrap(),
        json!({"type":"dismiss","sequence":1,"window_id":1,"node_id":3,"tree_revision":2,"path":[1,2,3],"reason":"window_blur"})
    );
    let Event::Dismiss {
        sequence,
        window_id,
        reason,
        ..
    } = event
    else {
        unreachable!()
    };
    let misrouted = Event::Dismiss {
        sequence,
        window_id,
        node_id: node(3),
        tree_revision: 2,
        path: vec![node(1), node(2)],
        reason,
    };
    assert!(misrouted.validate().is_err());
}
