//! Validation branches of atomic tree preparation that the scenario tests in
//! `tests.rs` do not reach: allocation state, unknown handles, same-batch
//! lifecycles, kind changes, detached subtrees and text accounting.

use super::*;
use crate::Overflow;

fn id(value: u64) -> NodeId {
    NodeId::try_from(value).unwrap()
}
fn box_element() -> Element {
    Element::Box {
        accessibility: Default::default(),
        style: Style::default(),
    }
}
fn text(value: &str) -> Element {
    Element::Text {
        accessible_live: None,
        text: value.into(),
        style: Style::default(),
    }
}
fn button(value: &str) -> Element {
    Element::Button {
        text: value.into(),
        disabled: false,
        style: Style::default(),
    }
}
fn input(value: &str, placeholder: &str) -> Element {
    Element::Input {
        value: value.into(),
        placeholder: placeholder.into(),
        disabled: false,
        read_only: false,
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
fn delete(node: u64) -> Operation {
    Operation::Delete { node_id: id(node) }
}
fn set(node: u64, element: Element, revision: Option<u64>) -> Operation {
    Operation::Set {
        node_id: id(node),
        element,
        expected_input_revision: revision,
    }
}
/// root(1) -> box(2) -> [text(3) "abc", input(4) "" / "hint"]
fn populated() -> Tree {
    Tree::new(id(1))
        .prepare(
            0,
            vec![
                create(2, box_element()),
                create(3, text("abc")),
                create(4, input("", "hint")),
                insert(1, 2, 0),
                insert(2, 3, 0),
                insert(2, 4, 1),
            ],
            1,
        )
        .unwrap()
        .tree
}
fn rejected(tree: &Tree, operations: Vec<Operation>, last_id: u64, code: ErrorCode) -> ModelError {
    let before = tree.clone();
    let error = tree
        .prepare(tree.revision(), operations, last_id)
        .err()
        .expect("batch must fail");
    assert_eq!(error.code, code, "{}", error.message);
    assert_eq!(tree, &before, "failure changed committed state");
    error
}

#[test]
fn new_tree_has_one_root_box_at_revision_zero() {
    let tree = Tree::new(id(7));
    assert_eq!(tree.root_id(), id(7));
    assert_eq!(tree.revision(), 0);
    assert_eq!(tree.text_bytes, 0);
    let root = tree.node(id(7)).unwrap();
    assert_eq!(root.element(), &box_element());
    assert!(root.children().is_empty());
    assert_eq!(root.input_revision(), None);
    assert_eq!(tree.path(id(7)), Some(vec![id(7)]));
    assert_eq!(tree.path(id(8)), None);
}

#[test]
fn inconsistent_session_allocation_state_is_rejected() {
    let tree = populated();
    // The high-water mark cannot be below an ID this window already owns.
    let error = rejected(&tree, vec![delete(3)], 3, ErrorCode::InvalidState);
    assert_eq!(error.message, "session allocation state is inconsistent");
    rejected(&tree, vec![delete(3)], MAX_ID + 1, ErrorCode::InvalidState);
    // A high-water mark above the window's IDs is normal for multiple windows.
    assert!(tree.prepare(1, vec![delete(3)], 100).is_ok());
}

#[test]
fn stale_revision_is_checked_before_any_operation_is_inspected() {
    let tree = populated();
    for base in [0, 2, MAX_ID] {
        let error = tree.prepare(base, vec![], 4).err().unwrap();
        assert_eq!(error.code, ErrorCode::StaleRevision);
    }
}

#[test]
fn create_at_the_largest_safe_id_is_accepted_and_exhausts_allocation() {
    let tree = Tree::new(id(1));
    let prepared = tree
        .prepare(0, vec![create(MAX_ID, text("x")), insert(1, MAX_ID, 0)], 1)
        .unwrap();
    assert_eq!(prepared.last_node_id, MAX_ID);
    // No identifier above MAX_ID exists, so any further create collides.
    rejected(
        &prepared.tree,
        vec![create(MAX_ID, text("again"))],
        MAX_ID,
        ErrorCode::InvalidHandle,
    );
}

#[test]
fn unknown_handles_in_every_operation_are_invalid() {
    let tree = populated();
    for operations in [
        vec![set(9, text("x"), None)],
        vec![insert(9, 3, 0)],
        vec![insert(2, 9, 0)],
        vec![delete(9)],
    ] {
        let error = rejected(&tree, operations, 4, ErrorCode::InvalidHandle);
        assert_eq!(
            error.message,
            "node is stale or is not owned by this window"
        );
    }
}

#[test]
fn invalid_elements_are_rejected_in_create_and_set_without_consuming_ids() {
    let scrolling_text = Element::Text {
        accessible_live: None,
        text: "x".into(),
        style: Style {
            overflow: Some(Overflow::Scroll),
            ..Style::default()
        },
    };
    let tree = populated();
    rejected(
        &tree,
        vec![create(5, scrolling_text.clone()), insert(1, 5, 1)],
        4,
        ErrorCode::InvalidCommand,
    );
    rejected(
        &tree,
        vec![set(3, scrolling_text, None)],
        4,
        ErrorCode::InvalidCommand,
    );
    rejected(
        &tree,
        vec![set(3, text("nul\0"), None)],
        4,
        ErrorCode::InvalidCommand,
    );
    // The rejected ID 5 was not consumed.
    assert!(tree
        .prepare(1, vec![create(5, box_element()), insert(1, 5, 1)], 4)
        .is_ok());
}

#[test]
fn set_cannot_change_between_any_two_kinds() {
    let tree = Tree::new(id(1))
        .prepare(
            0,
            vec![
                create(2, box_element()),
                create(3, text("t")),
                create(4, button("b")),
                create(5, input("i", "")),
                insert(1, 2, 0),
                insert(1, 3, 1),
                insert(1, 4, 2),
                insert(1, 5, 3),
            ],
            1,
        )
        .unwrap()
        .tree;
    let kinds = [
        (2, box_element(), None),
        (3, text("t"), None),
        (4, button("b"), None),
        (5, input("i", ""), Some(0)),
    ];
    for (node, _, _) in &kinds {
        for (other, element, revision) in &kinds {
            if node == other {
                continue;
            }
            let error = rejected(
                &tree,
                vec![set(*node, element.clone(), *revision)],
                5,
                ErrorCode::InvalidState,
            );
            assert_eq!(error.message, "set cannot change an element kind");
        }
    }
    // Same-kind sets of every kind succeed in one batch.
    let prepared = tree
        .prepare(
            1,
            kinds
                .iter()
                .map(|(node, element, revision)| set(*node, element.clone(), *revision))
                .collect(),
            5,
        )
        .unwrap();
    assert_eq!(prepared.tree.node(id(5)).unwrap().input_revision(), Some(1));
    // The root is a box and may be restyled like any other box.
    assert!(tree
        .prepare(1, vec![set(1, box_element(), None)], 5)
        .is_ok());
}

#[test]
fn create_then_delete_in_one_batch_still_consumes_the_id() {
    let tree = populated();
    let prepared = tree
        .prepare(1, vec![create(5, text("ephemeral")), delete(5)], 4)
        .unwrap();
    assert_eq!(prepared.last_node_id, 5);
    assert_eq!(prepared.tree.nodes().count(), tree.nodes().count());
    assert_eq!(prepared.tree.text_bytes, tree.text_bytes);
    rejected(
        &prepared.tree,
        vec![create(5, text("reuse")), insert(1, 5, 1)],
        5,
        ErrorCode::InvalidHandle,
    );
}

#[test]
fn deleted_nodes_cannot_be_used_later_in_the_same_batch() {
    let tree = populated();
    for operations in [
        vec![delete(2), insert(1, 3, 0)],
        vec![delete(2), set(3, text("gone"), None)],
        vec![delete(2), delete(4)],
        vec![delete(3), delete(3)],
    ] {
        rejected(&tree, operations, 4, ErrorCode::InvalidHandle);
    }
}

#[test]
fn a_subtree_moved_out_before_deleting_its_parent_survives() {
    let tree = populated();
    let prepared = tree
        .prepare(1, vec![insert(1, 4, 0), delete(2)], 4)
        .unwrap()
        .tree;
    assert_eq!(prepared.node(id(1)).unwrap().children(), &[id(4)]);
    assert!(prepared.node(id(3)).is_none());
    assert_eq!(prepared.path(id(4)), Some(vec![id(1), id(4)]));
    assert_eq!(prepared.text_bytes, "hint".len());
}

#[test]
fn detached_subtrees_are_rejected_even_when_internally_linked() {
    let tree = populated();
    let error = rejected(
        &tree,
        vec![
            create(5, box_element()),
            create(6, text("inner")),
            insert(5, 6, 0),
        ],
        4,
        ErrorCode::InvalidState,
    );
    assert_eq!(error.message, "batch leaves detached nodes");
    // Detaching an existing node is impossible: insert always reattaches, so
    // the only way to leave the tree is delete.
    let attached = tree
        .prepare(
            1,
            vec![
                create(5, box_element()),
                create(6, text("inner")),
                insert(5, 6, 0),
                insert(2, 5, 2),
            ],
            4,
        )
        .unwrap()
        .tree;
    assert_eq!(attached.path(id(6)), Some(vec![id(1), id(2), id(5), id(6)]));
}

#[test]
fn reinserting_at_the_same_position_is_a_noop_move() {
    let tree = populated();
    let prepared = tree
        .prepare(1, vec![insert(2, 3, 0), insert(2, 4, 1)], 4)
        .unwrap()
        .tree;
    assert_eq!(
        prepared.node(id(2)).unwrap().children(),
        tree.node(id(2)).unwrap().children()
    );
    assert_eq!(prepared.revision(), 2);
    // Appending at the end after detaching is the child count minus one.
    rejected(&tree, vec![insert(2, 3, 2)], 4, ErrorCode::InvalidCommand);
    let appended = tree.prepare(1, vec![insert(2, 3, 1)], 4).unwrap().tree;
    assert_eq!(appended.node(id(2)).unwrap().children(), &[id(4), id(3)]);
}

#[test]
fn only_boxes_own_children_even_when_created_in_the_same_batch() {
    let tree = populated();
    for parent in [create(5, button("b")), create(5, input("", ""))] {
        let error = rejected(
            &tree,
            vec![
                parent,
                insert(1, 5, 1),
                create(6, text("child")),
                insert(5, 6, 0),
            ],
            4,
            ErrorCode::InvalidState,
        );
        assert_eq!(
            error.message,
            "only box, split and overlay elements can own children"
        );
    }
}

#[test]
fn text_accounting_tracks_every_text_field_through_set_and_delete() {
    let tree = populated();
    assert_eq!(tree.text_bytes, "abc".len() + "hint".len());
    let prepared = tree
        .prepare(
            1,
            vec![
                set(3, text("界"), None),
                set(4, input("typed", "longer hint"), Some(0)),
            ],
            4,
        )
        .unwrap();
    assert_eq!(
        prepared.metrics.text_bytes,
        "界".len() + "typed".len() + "longer hint".len()
    );
    assert_eq!(prepared.tree.text_bytes, prepared.metrics.text_bytes);
    let emptied = prepared.tree.prepare(2, vec![delete(2)], 4).unwrap().tree;
    assert_eq!(emptied.text_bytes, 0);
}

#[test]
fn placeholder_only_input_set_still_advances_its_revision() {
    let tree = populated();
    let prepared = tree
        .prepare(1, vec![set(4, input("", "other hint"), Some(0))], 4)
        .unwrap()
        .tree;
    assert_eq!(prepared.node(id(4)).unwrap().input_revision(), Some(1));
    // Two sets of one input in a batch must chain revisions.
    let chained = tree
        .prepare(
            1,
            vec![
                set(4, input("a", ""), Some(0)),
                set(4, input("b", ""), Some(1)),
            ],
            4,
        )
        .unwrap()
        .tree;
    assert_eq!(chained.node(id(4)).unwrap().input_revision(), Some(2));
    assert_eq!(chained.node(id(4)).unwrap().element(), &input("b", ""));
    rejected(
        &tree,
        vec![
            set(4, input("a", ""), Some(0)),
            set(4, input("b", ""), Some(0)),
        ],
        4,
        ErrorCode::StaleRevision,
    );
}

#[test]
fn replace_input_keeps_placeholder_and_style_and_rejects_unknown_nodes() {
    let mut tree = populated();
    assert_eq!(tree.replace_input(id(4), "v".into()).unwrap(), Some(1));
    assert_eq!(tree.node(id(4)).unwrap().element(), &input("v", "hint"));
    assert_eq!(tree.text_bytes, "abc".len() + "v".len() + "hint".len());
    assert_eq!(
        tree.replace_input(id(9), "x".into()).unwrap_err().code,
        ErrorCode::InvalidHandle
    );
    assert_eq!(
        tree.replace_input(id(1), "x".into()).unwrap_err().code,
        ErrorCode::InvalidState
    );
    // Replacing with a shorter value releases budget.
    assert_eq!(tree.replace_input(id(4), String::new()).unwrap(), Some(2));
    assert_eq!(tree.text_bytes, "abc".len() + "hint".len());
}

#[test]
fn replace_input_does_not_mutate_shared_snapshots() {
    let mut tree = populated();
    let snapshot = tree.clone();
    tree.replace_input(id(4), "edited".into()).unwrap();
    assert_eq!(snapshot.node(id(4)).unwrap().element(), &input("", "hint"));
    assert_eq!(snapshot.node(id(4)).unwrap().input_revision(), Some(0));
}

#[test]
fn path_follows_committed_parents_from_root_to_target() {
    let tree = populated();
    assert_eq!(tree.path(id(4)), Some(vec![id(1), id(2), id(4)]));
    let moved = tree.prepare(1, vec![insert(1, 4, 0)], 4).unwrap().tree;
    assert_eq!(moved.path(id(4)), Some(vec![id(1), id(4)]));
    assert_eq!(tree.path(id(4)), Some(vec![id(1), id(2), id(4)]));
}

#[test]
fn moving_a_deep_subtree_past_the_depth_limit_is_rejected() {
    // Two independent 32-edge chains are valid; stacking them is too deep.
    let mut operations = Vec::new();
    for node in 2..=33 {
        operations.push(create(node, box_element()));
        operations.push(insert(node - 1, node, 0));
    }
    operations.push(create(34, box_element()));
    operations.push(insert(1, 34, 1));
    for node in 35..=66 {
        operations.push(create(node, box_element()));
        operations.push(insert(node - 1, node, 0));
    }
    let tree = Tree::new(id(1)).prepare(0, operations, 1).unwrap().tree;
    let error = rejected(&tree, vec![insert(33, 34, 0)], 66, ErrorCode::LimitExceeded);
    assert_eq!(error.message, "tree depth exceeds 64 edges");
    // One edge less fits exactly at the limit.
    assert!(tree.prepare(1, vec![insert(32, 34, 1)], 66).is_ok());
}

#[test]
fn metrics_describe_the_prepared_tree() {
    let prepared = populated()
        .prepare(1, vec![create(5, text("12345")), insert(1, 5, 1)], 4)
        .unwrap();
    assert_eq!(prepared.metrics.operation_count, 2);
    assert_eq!(prepared.metrics.node_count, 5);
    assert_eq!(prepared.metrics.text_bytes, 3 + 4 + 5);
    let value = serde_json::to_value(&prepared.metrics).unwrap();
    for key in [
        "operation_count",
        "node_count",
        "text_bytes",
        "preflight_nanos",
    ] {
        assert!(value.get(key).is_some(), "metrics omit {key}");
    }
}
