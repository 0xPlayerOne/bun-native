use super::*;

mod equivalence;
mod reference;

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
fn input(value: &str) -> Element {
    Element::Input {
        value: value.into(),
        placeholder: String::new(),
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
fn populated() -> Tree {
    Tree::new(id(1))
        .prepare(
            0,
            vec![
                create(2, box_element()),
                create(3, text("a")),
                create(4, input("")),
                insert(1, 2, 0),
                insert(2, 3, 0),
                insert(2, 4, 1),
            ],
            1,
        )
        .unwrap()
        .tree
}
fn rejected(tree: &Tree, operations: Vec<Operation>, last_id: u64, code: ErrorCode) {
    let before = tree.clone();
    let error = tree
        .prepare(tree.revision(), operations, last_id)
        .err()
        .expect("batch must fail");
    assert_eq!(error.code, code);
    assert_eq!(tree, &before, "failure changed committed state");
}

#[test]
fn sibling_position_finds_tail_and_rejects_missing_nodes() {
    let siblings = [id(2), id(3), id(4)];
    assert_eq!(position(&siblings, id(2)), Ok(0));
    assert_eq!(position(&siblings, id(4)), Ok(2));
    assert_eq!(position(&siblings, id(5)), Err(invalid_handle()));
    assert_eq!(position(&[], id(2)), Err(invalid_handle()));
}

#[test]
fn successful_batch_commits_once_and_returns_allocation_and_timing() {
    let tree = Tree::new(id(1));
    let prepared = tree
        .prepare(0, vec![create(2, text("hello")), insert(1, 2, 0)], 1)
        .unwrap();
    assert_eq!(tree.nodes().count(), 1);
    assert_eq!(tree.revision(), 0);
    assert_eq!(prepared.tree.revision(), 1);
    assert_eq!(prepared.tree.node(id(1)).unwrap().children(), &[id(2)]);
    assert_eq!(prepared.last_node_id, 2);
    assert_eq!(prepared.metrics.operation_count, 2);
    assert_eq!(prepared.metrics.node_count, 2);
}

#[test]
fn rejected_create_does_not_consume_ids_or_leave_orphans() {
    let tree = Tree::new(id(1));
    rejected(
        &tree,
        vec![create(2, text("detached"))],
        1,
        ErrorCode::InvalidState,
    );
    let accepted = tree
        .prepare(0, vec![create(2, text("attached")), insert(1, 2, 0)], 1)
        .unwrap();
    assert_eq!(accepted.last_node_id, 2);
    rejected(
        &accepted.tree,
        vec![create(3, text("x")), insert(1, 3, 4)],
        2,
        ErrorCode::InvalidCommand,
    );
}

#[test]
fn reordering_uses_index_after_detachment_and_reparenting_has_one_owner() {
    let tree = populated();
    let tree = tree.prepare(1, vec![insert(2, 3, 1)], 4).unwrap().tree;
    assert_eq!(tree.node(id(2)).unwrap().children(), &[id(4), id(3)]);
    let tree = tree.prepare(2, vec![insert(1, 3, 1)], 4).unwrap().tree;
    assert_eq!(tree.node(id(2)).unwrap().children(), &[id(4)]);
    assert_eq!(tree.node(id(1)).unwrap().children(), &[id(2), id(3)]);
    rejected(&tree, vec![insert(1, 3, 2)], 4, ErrorCode::InvalidCommand);
}

#[test]
fn cycles_roots_and_leaf_parents_are_rejected_without_partial_changes() {
    let tree = populated();
    rejected(&tree, vec![insert(2, 2, 0)], 4, ErrorCode::InvalidState);
    rejected(&tree, vec![insert(2, 1, 0)], 4, ErrorCode::InvalidState);
    rejected(&tree, vec![insert(3, 4, 0)], 4, ErrorCode::InvalidState);
    rejected(&tree, vec![delete(1)], 4, ErrorCode::InvalidState);
    rejected(
        &tree,
        vec![set(3, box_element(), None)],
        4,
        ErrorCode::InvalidState,
    );
    let nested = tree
        .prepare(1, vec![create(5, box_element()), insert(2, 5, 2)], 4)
        .unwrap()
        .tree;
    rejected(&nested, vec![insert(5, 2, 0)], 5, ErrorCode::InvalidState);
}

#[test]
fn subtree_deletion_revokes_every_handle_and_ids_cannot_be_reused() {
    let tree = populated().prepare(1, vec![delete(2)], 4).unwrap().tree;
    assert_eq!(tree.nodes().count(), 1);
    for stale in [2, 3, 4] {
        rejected(&tree, vec![delete(stale)], 4, ErrorCode::InvalidHandle);
        rejected(
            &tree,
            vec![create(stale, box_element()), insert(1, stale, 0)],
            4,
            ErrorCode::InvalidHandle,
        );
    }
}

#[test]
fn foreign_window_handles_and_out_of_order_session_ids_are_rejected() {
    let first = populated();
    let second = Tree::new(id(5));
    rejected(&second, vec![insert(5, 3, 0)], 5, ErrorCode::InvalidHandle);
    rejected(
        &first,
        vec![create(5, box_element())],
        5,
        ErrorCode::InvalidHandle,
    );
    rejected(
        &first,
        vec![create(7, box_element()), create(6, box_element())],
        5,
        ErrorCode::InvalidHandle,
    );
}

#[test]
fn native_input_edits_do_not_stale_unrelated_tree_batches() {
    let mut tree = populated();
    assert_eq!(tree.replace_input(id(4), "typed".into()).unwrap(), Some(1));
    assert_eq!(tree.revision(), 1);
    assert_eq!(tree.replace_input(id(4), "typed".into()).unwrap(), None);
    let changed = tree
        .prepare(1, vec![set(3, text("label changed"), None)], 4)
        .unwrap()
        .tree;
    assert_eq!(changed.revision(), 2);
    assert_eq!(changed.node(id(4)).unwrap().input_revision(), Some(1));
    assert_eq!(changed.node(id(4)).unwrap().element(), &input("typed"));
}

#[test]
fn stale_controlled_input_cannot_overwrite_newer_native_edits() {
    let mut tree = populated();
    tree.replace_input(id(4), "new native value".into())
        .unwrap();
    rejected(
        &tree,
        vec![
            set(3, text("must rollback"), None),
            set(4, input("old app value"), Some(0)),
        ],
        4,
        ErrorCode::StaleRevision,
    );
    let changed = tree
        .prepare(
            1,
            vec![set(4, input("intentional replacement"), Some(1))],
            4,
        )
        .unwrap()
        .tree;
    assert_eq!(changed.node(id(4)).unwrap().input_revision(), Some(2));
    assert_eq!(
        changed.node(id(4)).unwrap().element(),
        &input("intentional replacement")
    );
    let changed = changed
        .prepare(
            2,
            vec![set(4, input("intentional replacement"), Some(2))],
            4,
        )
        .unwrap()
        .tree;
    assert_eq!(changed.node(id(4)).unwrap().input_revision(), Some(3));
    rejected(
        &changed,
        vec![set(4, input("missing revision"), None)],
        4,
        ErrorCode::InvalidCommand,
    );
    rejected(
        &changed,
        vec![set(3, text("wrong kind revision"), Some(0))],
        4,
        ErrorCode::InvalidCommand,
    );
}

#[test]
fn tree_revision_and_input_revision_exhaustion_are_explicit() {
    let mut tree = populated();
    let error = tree.prepare(0, vec![delete(2)], 4).err().unwrap();
    assert_eq!(error.code, ErrorCode::StaleRevision);
    tree.nodes.get_mut(id(4)).unwrap().input_revision = Some(MAX_ID);
    assert_eq!(
        tree.replace_input(id(4), "x".into()).unwrap_err().code,
        ErrorCode::LimitExceeded
    );
    assert_eq!(tree.node(id(4)).unwrap().element(), &input(""));
    rejected(
        &tree,
        vec![set(4, input("x"), Some(MAX_ID))],
        4,
        ErrorCode::LimitExceeded,
    );
    tree.revision = MAX_ID;
    rejected(&tree, vec![delete(2)], 4, ErrorCode::LimitExceeded);
}

#[test]
fn bounded_batches_and_depth_are_enforced() {
    let tree = Tree::new(id(1));
    rejected(&tree, vec![], 1, ErrorCode::LimitExceeded);
    rejected(
        &tree,
        vec![set(1, box_element(), None); MAX_OPERATIONS + 1],
        1,
        ErrorCode::LimitExceeded,
    );
    let chain = (2..=65)
        .flat_map(|node| [create(node, box_element()), insert(node - 1, node, 0)])
        .collect();
    let tree = tree.prepare(0, chain, 1).unwrap().tree;
    assert_eq!(tree.nodes().count(), 65);
    rejected(
        &tree,
        vec![create(66, box_element()), insert(65, 66, 0)],
        65,
        ErrorCode::LimitExceeded,
    );
}

#[test]
fn one_batch_mounts_and_replaces_a_full_window() {
    // Protocol 12 sends a transaction as one batch: a whole window, then its
    // replacement (delete every row, create and insert as many again, set
    // each) must fit the operation limit.
    assert_eq!(
        crate::wire::BATCH_SIZE_MESSAGE,
        format!("batch must have between 1 and {MAX_OPERATIONS} operations")
    );
    let rows = MAX_NODES_PER_WINDOW as u64 - 1;
    let mount = |first: u64| -> Vec<Operation> {
        (first..first + rows)
            .flat_map(|node| {
                [
                    create(node, text("row")),
                    insert(1, node, (node - first) as usize),
                ]
            })
            .collect()
    };
    let prepared = Tree::new(id(1)).prepare(0, mount(2), 1).unwrap();
    assert_eq!(prepared.tree.nodes().count(), MAX_NODES_PER_WINDOW);
    let next = 2 + rows;
    let mut replace: Vec<Operation> = (2..next).map(delete).collect();
    replace.extend(mount(next));
    replace.extend((next..next + rows).map(|node| set(node, text("set"), None)));
    assert!(replace.len() <= MAX_OPERATIONS);
    let replaced = prepared
        .tree
        .prepare(1, replace, prepared.last_node_id)
        .unwrap();
    assert_eq!(replaced.tree.nodes().count(), MAX_NODES_PER_WINDOW);
    assert_eq!(replaced.metrics.operation_count, 4 * rows as usize);
}

#[test]
fn window_node_limit_cannot_be_bypassed_across_batches() {
    let mut tree = Tree::new(id(1));
    let mut last_id = 1;
    while tree.nodes().count() < MAX_NODES_PER_WINDOW {
        let count = (MAX_NODES_PER_WINDOW - tree.nodes().count()).min(MAX_OPERATIONS / 2);
        let first_index = tree.node(id(1)).unwrap().children().len();
        let operations = (0..count)
            .flat_map(|offset| {
                let next_id = last_id + offset as u64 + 1;
                [
                    create(next_id, text("bounded")),
                    insert(1, next_id, first_index + offset),
                ]
            })
            .collect();
        let prepared = tree.prepare(tree.revision(), operations, last_id).unwrap();
        last_id = prepared.last_node_id;
        tree = prepared.tree;
    }
    rejected(
        &tree,
        vec![create(last_id + 1, text("overflow"))],
        last_id,
        ErrorCode::LimitExceeded,
    );
    let prepared = tree
        .prepare(
            tree.revision(),
            vec![
                delete(2),
                create(last_id + 1, text("replacement")),
                insert(1, last_id + 1, 0),
            ],
            last_id,
        )
        .unwrap();
    assert_eq!(prepared.tree.nodes().count(), MAX_NODES_PER_WINDOW);
}

#[test]
fn repeated_update_and_disposal_releases_nodes_without_tombstones() {
    let mut tree = Tree::new(id(1));
    let mut last_id = 1;
    for iteration in 0..1_000 {
        let next_id = last_id + 1;
        let prepared = tree
            .prepare(
                tree.revision(),
                vec![create(next_id, input("")), insert(1, next_id, 0)],
                last_id,
            )
            .unwrap();
        tree = prepared.tree;
        last_id = prepared.last_node_id;
        assert_eq!(
            tree.replace_input(id(next_id), format!("edit {iteration}"))
                .unwrap(),
            Some(1)
        );
        tree = tree
            .prepare(tree.revision(), vec![delete(next_id)], last_id)
            .unwrap()
            .tree;
        assert_eq!(tree.nodes().count(), 1);
        assert_eq!(
            tree.replace_input(id(next_id), "late event".into())
                .unwrap_err()
                .code,
            ErrorCode::InvalidHandle
        );
    }
    assert_eq!(tree.revision(), 2_000);
    assert_eq!(last_id, 1_001);
}

#[test]
fn direct_prepare_still_validates_every_element() {
    let tree = populated();
    let invalid = text("\0");
    rejected(
        &tree,
        vec![create(5, invalid.clone())],
        4,
        ErrorCode::InvalidCommand,
    );
    rejected(
        &tree,
        vec![set(3, invalid.clone(), None)],
        4,
        ErrorCode::InvalidCommand,
    );
    let window = crate::WindowId::try_from(1).unwrap();
    let request = crate::RequestId::try_from(1).unwrap();
    for operations in [
        vec![create(5, invalid.clone())],
        vec![set(3, invalid, None)],
    ] {
        assert!(crate::ValidBatch::new(request, window, tree.revision(), operations).is_err());
    }
}

#[test]
fn native_input_rejects_invalid_text_without_mutation() {
    let mut tree = populated();
    for value in ["\0".to_string(), "界".repeat(crate::MAX_TEXT_BYTES / 3 + 1)] {
        assert_eq!(
            tree.replace_input(id(4), value).unwrap_err().code,
            ErrorCode::InvalidCommand
        );
        assert_eq!(tree.node(id(4)).unwrap().input_revision(), Some(0));
    }
    assert_eq!(
        tree.replace_input(id(3), "not input".into())
            .unwrap_err()
            .code,
        ErrorCode::InvalidState
    );
}

#[test]
fn aggregate_text_budget_bounds_batches_and_native_edits() {
    let mut tree = Tree::new(id(1));
    let mut last_id = 1;
    let large = "x".repeat(crate::MAX_TEXT_BYTES);
    for _ in 0..4 {
        let index = tree.node(id(1)).unwrap().children().len();
        let operations = (0..64)
            .flat_map(|offset| {
                let next_id = last_id + offset as u64 + 1;
                [
                    create(next_id, text(&large)),
                    insert(1, next_id, index + offset),
                ]
            })
            .collect();
        let prepared = tree.prepare(tree.revision(), operations, last_id).unwrap();
        last_id = prepared.last_node_id;
        tree = prepared.tree;
    }
    assert_eq!(tree.text_bytes, MAX_TEXT_BYTES_PER_WINDOW);
    rejected(
        &tree,
        vec![
            create(last_id + 1, text("overflow")),
            insert(1, last_id + 1, 0),
        ],
        last_id,
        ErrorCode::LimitExceeded,
    );
    let prepared = tree
        .prepare(
            tree.revision(),
            vec![create(last_id + 1, input("")), insert(1, last_id + 1, 0)],
            last_id,
        )
        .unwrap();
    tree = prepared.tree;
    last_id = prepared.last_node_id;
    assert_eq!(
        tree.replace_input(id(last_id), "x".into())
            .unwrap_err()
            .code,
        ErrorCode::LimitExceeded
    );
    assert_eq!(tree.node(id(last_id)).unwrap().input_revision(), Some(0));
    tree = tree
        .prepare(tree.revision(), vec![delete(2)], last_id)
        .unwrap()
        .tree;
    assert_eq!(
        tree.replace_input(id(last_id), "x".into()).unwrap(),
        Some(1)
    );
    assert_eq!(
        tree.text_bytes,
        MAX_TEXT_BYTES_PER_WINDOW - crate::MAX_TEXT_BYTES + 1
    );
}

#[test]
fn preflight_shares_child_lists_until_a_batch_reorders_them() {
    let tree = populated();
    let shared = |left: &Tree, right: &Tree, node: u64| {
        Arc::ptr_eq(
            &left.node(id(node)).unwrap().children,
            &right.node(id(node)).unwrap().children,
        )
    };
    let edited = tree
        .prepare(1, vec![set(3, text("b"), None)], 4)
        .unwrap()
        .tree;
    assert!(shared(&tree, &edited, 1) && shared(&tree, &edited, 2));
    let moved = edited.prepare(2, vec![insert(2, 3, 1)], 4).unwrap().tree;
    assert!(shared(&edited, &moved, 1) && !shared(&edited, &moved, 2));
    assert_eq!(edited.node(id(2)).unwrap().children(), &[id(3), id(4)]);
    assert_eq!(moved.node(id(2)).unwrap().children(), &[id(4), id(3)]);
}

#[test]
fn node_diff_reports_set_and_restructured_nodes_and_parents() {
    let tree = populated();
    let changed = |before: &Tree, after: &Tree| {
        let mut ids = Vec::new();
        after.diff_nodes(before, |node, _, _| ids.push(node.get()));
        ids
    };
    let edited = tree
        .prepare(1, vec![set(3, text("b"), None)], 4)
        .unwrap()
        .tree;
    // An element write alone: the parent's child list is still shared.
    assert_eq!(changed(&tree, &edited), [3]);
    let moved = edited.prepare(2, vec![insert(2, 3, 1)], 4).unwrap().tree;
    // A move rewrites the parent's child list, not any element.
    assert_eq!(changed(&edited, &moved), [2]);
    let created = moved
        .prepare(3, vec![create(5, text("c")), insert(1, 5, 1)], 4)
        .unwrap()
        .tree;
    assert_eq!(changed(&moved, &created), [1, 5]);
    let deleted = created.prepare(4, vec![delete(2)], 5).unwrap().tree;
    assert_eq!(changed(&created, &deleted), [1, 2, 3, 4]);
    assert_eq!(deleted.parent(id(5)), Some(id(1)));
    assert_eq!(deleted.parent(id(1)), None);
    assert_eq!(deleted.parent(id(3)), None);
}

#[test]
fn incremental_validation_keeps_depth_before_detachment_precedence() {
    let chain = |from: u64, under: u64, length: u64| {
        (from..from + length).flat_map(move |node| {
            let parent = if node == from { under } else { node - 1 };
            [create(node, box_element()), insert(parent, node, 0)]
        })
    };
    let tree = Tree::new(id(1));
    // Detached first, then an attached chain past the limit: depth wins, as a
    // walk from the root reports it before counting detached nodes.
    let mut operations = vec![create(2, text("detached"))];
    operations.extend(chain(3, 1, MAX_DEPTH as u64 + 1));
    rejected(&tree, operations, 1, ErrorCode::LimitExceeded);
    // A chain past the limit below a detached box is unreachable, so only
    // detachment applies.
    let mut operations = vec![create(2, box_element())];
    operations.extend(chain(3, 2, MAX_DEPTH as u64 + 1));
    let error = tree.prepare(0, operations, 1).err().unwrap();
    assert_eq!(error.message, "batch leaves detached nodes");
    // Moving an existing subtree deepens nodes the batch never named.
    let tree = tree
        .prepare(0, chain(2, 1, 40).chain(chain(42, 1, 30)).collect(), 1)
        .unwrap()
        .tree;
    rejected(&tree, vec![insert(41, 42, 0)], 71, ErrorCode::LimitExceeded);
    let moved = tree.prepare(1, vec![insert(30, 42, 0)], 71).unwrap().tree;
    assert_eq!(moved.path(id(71)).unwrap().len(), 60);
}
