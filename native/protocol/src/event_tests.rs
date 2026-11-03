use crate::{
    write_event, Element, Event, EventSequence, NodeId, Operation, ProtocolError, Style, Tree,
    WindowId, MAX_DEPTH, MAX_EVENT_PATH_NODES, PROTOCOL_VERSION,
};
use serde::Deserialize;
use std::collections::BTreeSet;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Fixtures {
    protocol: u32,
    capability: String,
    scope: String,
    cases: Vec<Case>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Case {
    name: String,
    valid: bool,
    wire: String,
}

fn node(id: u64) -> NodeId {
    NodeId::try_from(id).unwrap()
}

#[test]
fn shared_native_event_contract_matches_typescript() {
    let fixtures: Fixtures =
        serde_json::from_str(include_str!("../../../tests/fixtures/native-events.json")).unwrap();
    assert_eq!(fixtures.protocol, PROTOCOL_VERSION);
    assert_eq!(fixtures.capability, "interactions_v1");
    assert!(!fixtures.scope.is_empty());
    let mut names = BTreeSet::new();
    for case in fixtures.cases {
        assert!(names.insert(case.name.clone()));
        let parsed = serde_json::from_str::<serde_json::Value>(&case.wire)
            .and_then(serde_json::from_value::<Event>);
        let valid = parsed.as_ref().is_ok_and(|event| event.validate().is_ok());
        assert_eq!(valid, case.valid, "{}: {parsed:?}", case.name);
        if valid {
            let event = parsed.unwrap();
            let mut bytes = Vec::new();
            write_event(&mut bytes, &event).unwrap();
            assert_eq!(serde_json::from_slice::<Event>(&bytes).unwrap(), event);
        }
    }
}

#[test]
fn event_path_is_a_committed_snapshot_across_reparent_and_delete() {
    let mut operations = Vec::new();
    for id in 2..=4 {
        operations.push(Operation::Create {
            node_id: node(id),
            element: Element::Box {
                style: Style::default(),
            },
        });
    }
    for (parent, child, index) in [(1, 2, 0), (1, 3, 1), (2, 4, 0)] {
        operations.push(Operation::Insert {
            parent_id: node(parent),
            child_id: node(child),
            index,
        });
    }
    let tree = Tree::new(node(1)).prepare(0, operations, 1).unwrap().tree;
    let path = tree.path(node(4)).unwrap();
    assert_eq!(path, vec![node(1), node(2), node(4)]);
    let moved = tree
        .prepare(
            1,
            vec![Operation::Insert {
                parent_id: node(3),
                child_id: node(4),
                index: 0,
            }],
            4,
        )
        .unwrap()
        .tree;
    assert_eq!(
        moved.path(node(4)).unwrap(),
        vec![node(1), node(3), node(4)]
    );
    assert_eq!(path, vec![node(1), node(2), node(4)]);
    let removed = moved
        .prepare(2, vec![Operation::Delete { node_id: node(4) }], 4)
        .unwrap()
        .tree;
    assert!(removed.path(node(4)).is_none());
    assert_eq!(path, vec![node(1), node(2), node(4)]);
}

#[test]
fn deepest_valid_tree_has_a_bounded_writable_event_route() {
    let mut operations = Vec::new();
    for id in 2..=MAX_EVENT_PATH_NODES as u64 {
        operations.push(Operation::Create {
            node_id: node(id),
            element: if id == MAX_EVENT_PATH_NODES as u64 {
                Element::Button {
                    text: "Deep".into(),
                    disabled: false,
                    style: Style::default(),
                }
            } else {
                Element::Box {
                    style: Style::default(),
                }
            },
        });
        operations.push(Operation::Insert {
            parent_id: node(id - 1),
            child_id: node(id),
            index: 0,
        });
    }
    let tree = Tree::new(node(1)).prepare(0, operations, 1).unwrap().tree;
    let target = node(MAX_EVENT_PATH_NODES as u64);
    let path = tree.path(target).unwrap();
    assert_eq!(path.len(), MAX_DEPTH + 1);
    let event = Event::Click {
        sequence: EventSequence::try_from(1).unwrap(),
        window_id: WindowId::try_from(1).unwrap(),
        node_id: target,
        tree_revision: tree.revision(),
        path,
    };
    write_event(&mut Vec::new(), &event).unwrap();
}

#[test]
fn invalid_native_coordinates_are_rejected_before_any_bytes_are_written() {
    let mut event: Event = serde_json::from_str(r#"{"type":"pointer_down","sequence":1,"window_id":1,"node_id":1,"tree_revision":0,"path":[1],"button":"left","x":0,"y":0,"modifiers":{"control":false,"alt":false,"shift":false,"platform":false,"function":false}}"#).unwrap();
    for coordinate in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
        if let Event::PointerDown { x, .. } = &mut event {
            *x = coordinate;
        }
        let mut bytes = Vec::new();
        assert!(matches!(
            write_event(&mut bytes, &event),
            Err(ProtocolError::InvalidEvent(_))
        ));
        assert!(bytes.is_empty());
    }
}
