//! Popup window overlay contract shared with the TypeScript validator.

use super::*;
use serde_json::{json, Value};
use std::io::Cursor;

fn node(value: u64) -> NodeId {
    NodeId::try_from(value).unwrap()
}
fn read_json(value: &Value) -> Result<Option<Command>, ProtocolError> {
    CommandReader::default()
        .read(&mut Cursor::new(format!("{value}\n").as_bytes()))
        .map(|command| command.map(ValidCommand::into_command))
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
            accessible_live: None,
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
                        accessibility: Default::default(),
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
                accessible_label: None,
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
                            accessibility: Default::default(),
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
                        accessible_label: None,
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
fn validation_keeps_distinct_ancestor_contexts_between_attached_subtrees() {
    let tree = Tree::new(node(1))
        .prepare(
            0,
            vec![
                create(2, popup()),
                insert(1, 2),
                create(
                    3,
                    Element::Box {
                        accessibility: Default::default(),
                        style: Style::default(),
                    },
                ),
                insert(1, 3),
            ],
            1,
        )
        .unwrap()
        .tree;
    let input = || Element::Input {
        value: String::new(),
        placeholder: String::new(),
        disabled: false,
        read_only: false,
        style: Style::default(),
    };
    let next = tree
        .prepare(
            1,
            vec![text(4), insert(2, 4), create(5, input()), insert(3, 5)],
            3,
        )
        .unwrap()
        .tree;
    assert_eq!(next.node(node(2)).unwrap().children(), &[node(4)]);
    assert_eq!(next.node(node(3)).unwrap().children(), &[node(5)]);
    let error = tree
        .prepare(
            1,
            vec![text(4), insert(3, 4), create(5, input()), insert(2, 5)],
            3,
        )
        .err()
        .unwrap();
    assert_eq!(error.code, ErrorCode::InvalidState);
    assert!(tree.node(node(4)).is_none());
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

/// A batch that breaks two rules in different subtrees is rejected whichever
/// subtree it touches first. The incremental check and the full walk may
/// find different broken rules first, so a debug build must not treat that
/// as a disagreement (it panicked the debug host).
#[test]
fn a_batch_breaking_two_rules_is_rejected_in_either_order() {
    let split = Element::Split {
        ratio: 0.5,
        min_size: 0.0,
        accessible_label: None,
        style: Style::default(),
    };
    let input = Element::Input {
        value: String::new(),
        placeholder: String::new(),
        disabled: false,
        read_only: false,
        style: Style::default(),
    };
    let boxed = || Element::Box {
        accessibility: Default::default(),
        style: Style::default(),
    };
    // Root 1 holds box 2, a full split 3 (panes 4 and 5) and box 6.
    let tree = Tree::new(node(1))
        .prepare(
            0,
            vec![
                create(2, boxed()),
                insert(1, 2),
                create(3, split),
                insert(1, 3),
                text(4),
                insert(3, 4),
                text(5),
                insert(3, 5),
                create(6, boxed()),
                insert(1, 6),
            ],
            1,
        )
        .unwrap()
        .tree;
    // A third pane for the split, and an editor in a new popup under box 2.
    let third_pane = vec![insert(3, 6)];
    let editor_in_popup = vec![
        create(7, popup()),
        insert(2, 7),
        create(8, input),
        insert(7, 8),
    ];
    for operations in [
        [third_pane.clone(), editor_in_popup.clone()].concat(),
        [editor_in_popup, third_pane].concat(),
    ] {
        let before = tree.clone();
        let error = tree.prepare(tree.revision(), operations, 6).err().unwrap();
        assert!(
            matches!(
                error.code,
                ErrorCode::LimitExceeded | ErrorCode::InvalidState
            ),
            "{error:?}"
        );
        assert_eq!(tree, before);
    }
}
