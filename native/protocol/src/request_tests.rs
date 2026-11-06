//! Focus and scroll requests carried by batches: wire shape, final-tree
//! validation and the active modal scope.

use super::*;
use serde_json::json;
use std::io::Cursor;

fn node(value: u64) -> NodeId {
    NodeId::try_from(value).unwrap()
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
fn button(disabled: bool) -> Element {
    Element::Button {
        text: "Item".into(),
        disabled,
        style: Style::default(),
    }
}
fn scroller(overflow: Overflow) -> Element {
    Element::Box {
        style: Style {
            overflow: Some(overflow),
            ..Style::default()
        },
    }
}
fn overlay(modal: bool) -> Element {
    Element::Overlay {
        anchor: OverlayAnchor::Window,
        modal,
        autofocus: false,
        navigation: OverlayNavigation::Tab,
        style: Style::default(),
    }
}
fn code(tree: &Tree, operations: Vec<Operation>, last: u64) -> ErrorCode {
    tree.prepare(tree.revision(), operations, last)
        .err()
        .expect("request is rejected")
        .code
}

#[test]
fn request_operations_round_trip_with_optional_axes() {
    let line = json!({"type":"batch","id":1,"window_id":1,"base_revision":0,"operations":[
        {"type":"focus","node_id":2},
        {"type":"scroll_to","node_id":3,"y":40},
        {"type":"scroll_into_view","node_id":4}
    ]});
    let command = CommandReader::default()
        .read(&mut Cursor::new(format!("{line}\n").as_bytes()))
        .unwrap()
        .unwrap();
    let Command::Batch { operations, .. } = command else {
        panic!("batch expected")
    };
    assert_eq!(
        operations[1],
        Operation::ScrollTo {
            node_id: node(3),
            x: None,
            y: Some(40.)
        }
    );
    assert_eq!(
        serde_json::to_value(&operations[1]).unwrap(),
        json!({"type":"scroll_to","node_id":3,"y":40.0})
    );
    for invalid in [
        json!({"type":"focus","node_id":2,"extra":1}),
        json!({"type":"scroll_to","node_id":3,"y":null}),
        json!({"type":"scroll_to","node_id":3}),
        json!({"type":"scroll_to","node_id":3,"y":-1}),
        json!({"type":"scroll_to","node_id":3,"x":MAX_SCROLL_OFFSET + 1.}),
    ] {
        let line =
            json!({"type":"batch","id":1,"window_id":1,"base_revision":0,"operations":[invalid]});
        assert!(CommandReader::default()
            .read(&mut Cursor::new(format!("{line}\n").as_bytes()))
            .is_err());
    }
}

#[test]
fn requests_validate_against_the_final_tree_in_order() {
    let tree = Tree::new(node(1));
    // A control created, attached and focused in one batch is accepted.
    let prepared = tree
        .prepare(
            0,
            vec![
                create(2, scroller(Overflow::ScrollY)),
                insert(1, 2),
                create(3, button(false)),
                Operation::Focus { node_id: node(3) },
                insert(2, 3),
                Operation::ScrollTo {
                    node_id: node(2),
                    x: None,
                    y: Some(12.),
                },
                Operation::ScrollIntoView { node_id: node(3) },
            ],
            1,
        )
        .unwrap();
    assert_eq!(
        prepared.requests,
        vec![
            ViewRequest::Focus(node(3)),
            ViewRequest::ScrollTo {
                node_id: node(2),
                x: None,
                y: Some(12.)
            },
            ViewRequest::ScrollIntoView(node(3)),
        ]
    );
    let tree = prepared.tree;
    // Focusing a node deleted later in the same batch fails it entirely.
    let before = tree.clone();
    assert_eq!(
        code(
            &tree,
            vec![
                Operation::Focus { node_id: node(3) },
                Operation::Delete { node_id: node(3) }
            ],
            3
        ),
        ErrorCode::InvalidHandle
    );
    assert_eq!(tree, before);
    let set = |element| Operation::Set {
        node_id: node(3),
        element,
        expected_input_revision: None,
    };
    assert_eq!(
        code(
            &tree,
            vec![set(button(true)), Operation::Focus { node_id: node(3) }],
            3
        ),
        ErrorCode::InvalidState
    );
    assert_eq!(
        code(&tree, vec![Operation::Focus { node_id: node(2) }], 3),
        ErrorCode::InvalidState
    );
    let scroll = |node_id, x, y| Operation::ScrollTo {
        node_id: node(node_id),
        x,
        y,
    };
    assert_eq!(
        code(&tree, vec![scroll(3, None, Some(1.))], 3),
        ErrorCode::InvalidState
    );
    assert_eq!(
        code(&tree, vec![scroll(2, Some(1.), None)], 3),
        ErrorCode::InvalidState
    );
    assert_eq!(
        code(
            &tree,
            vec![Operation::ScrollIntoView { node_id: node(9) }],
            3
        ),
        ErrorCode::InvalidHandle
    );
}

#[test]
fn focus_stays_inside_the_topmost_modal() {
    let tree = Tree::new(node(1))
        .prepare(
            0,
            vec![
                create(2, button(false)),
                insert(1, 2),
                create(3, overlay(true)),
                insert(1, 3),
                create(4, button(false)),
                insert(3, 4),
                create(5, overlay(true)),
                insert(3, 5),
                create(6, button(false)),
                insert(5, 6),
            ],
            1,
        )
        .unwrap()
        .tree;
    // The nested modal is deeper, so it is active even though it is earlier.
    assert_eq!(tree.active_modal(), Some(node(5)));
    for outside in [2, 4] {
        assert_eq!(
            code(
                &tree,
                vec![Operation::Focus {
                    node_id: node(outside)
                }],
                6
            ),
            ErrorCode::InvalidState
        );
    }
    assert!(tree
        .prepare(
            tree.revision(),
            vec![Operation::Focus { node_id: node(6) }],
            6
        )
        .is_ok());
    // Removing the inner modal in the same batch makes the outer one active.
    assert!(tree
        .prepare(
            tree.revision(),
            vec![
                Operation::Delete { node_id: node(5) },
                Operation::Focus { node_id: node(4) }
            ],
            6
        )
        .is_ok());
    // Among equal depths, the later sibling is active.
    let siblings = Tree::new(node(1))
        .prepare(
            0,
            vec![
                create(2, overlay(true)),
                insert(1, 2),
                create(3, overlay(true)),
                insert(1, 3),
            ],
            1,
        )
        .unwrap()
        .tree;
    assert_eq!(siblings.active_modal(), Some(node(2)));
}
