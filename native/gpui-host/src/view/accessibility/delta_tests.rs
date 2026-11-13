//! The vendored `gpui_linux` sends AccessKit only what changed between two
//! of GPUI's full tree updates (`accesskit_delta.rs`). An AccessKit consumer
//! fed those deltas must hold exactly the tree, and report exactly the
//! changes, it would have from the full updates.

use super::delta::{Delta, StaleOnActivation};
use accesskit::{ActivationHandler, Node, NodeId, Role, Tree, TreeId, TreeUpdate};
use accesskit_consumer::{Node as ConsumerNode, TreeChangeHandler};
use std::collections::BTreeSet;

const ROOT: NodeId = NodeId(0);

/// A tree written as `(id, role, label, children)`, in GPUI's post-order.
fn full(nodes: &[(u64, Role, &str, &[u64])], focus: u64) -> TreeUpdate {
    TreeUpdate {
        nodes: nodes
            .iter()
            .map(|(id, role, label, children)| {
                let mut node = Node::new(*role);
                if !label.is_empty() {
                    node.set_label(*label);
                }
                node.set_children(
                    children
                        .iter()
                        .map(|child| NodeId(*child))
                        .collect::<Vec<_>>(),
                );
                (NodeId(*id), node)
            })
            .collect(),
        tree: Some(Tree::new(ROOT)),
        tree_id: TreeId::ROOT,
        focus: NodeId(focus),
    }
}

/// GPUI's initial tree: the window alone.
fn initial() -> TreeUpdate {
    full(&[(0, Role::Window, "", &[])], 0)
}

#[derive(Default, Debug, PartialEq)]
struct Reported {
    added: BTreeSet<u64>,
    updated: BTreeSet<u64>,
    removed: BTreeSet<u64>,
    focus: Vec<(Option<u64>, Option<u64>)>,
}

fn local(node: &ConsumerNode) -> u64 {
    node.locate().0.0
}

impl TreeChangeHandler for Reported {
    fn node_added(&mut self, node: &ConsumerNode) {
        self.added.insert(local(node));
    }
    fn node_updated(&mut self, _: &ConsumerNode, new: &ConsumerNode) {
        self.updated.insert(local(new));
    }
    fn focus_moved(&mut self, old: Option<&ConsumerNode>, new: Option<&ConsumerNode>) {
        self.focus.push((old.map(local), new.map(local)));
    }
    fn node_removed(&mut self, node: &ConsumerNode) {
        self.removed.insert(local(node));
    }
}

/// Every node in pre-order with its data and parent, and the focus.
fn snapshot(tree: &accesskit_consumer::Tree) -> (Vec<(u64, Option<u64>, Node)>, u64) {
    let state = tree.state();
    let mut nodes = Vec::new();
    let mut pending = vec![state.root()];
    while let Some(node) = pending.pop() {
        nodes.push((
            local(&node),
            node.parent().map(|parent| local(&parent)),
            node.data().clone(),
        ));
        let children: Vec<_> = node.children().collect();
        pending.extend(children.into_iter().rev());
    }
    (nodes, local(&state.focus_in_tree()))
}

/// Applies each update both in full and through a [`Delta`], checking that
/// both consumers agree after every step. Returns the number of nodes each
/// delta carried; `None` where no update was needed.
fn replay(updates: Vec<TreeUpdate>) -> Vec<Option<usize>> {
    let mut reference = accesskit_consumer::Tree::new(initial(), true);
    let mut incremental = accesskit_consumer::Tree::new(initial(), true);
    let mut delta = Delta::default();
    let mut sizes = Vec::new();
    for update in updates {
        let mut expected = Reported::default();
        reference.update_and_process_changes(update.clone(), &mut expected);
        let changes = delta.update(update);
        let mut reported = Reported::default();
        if delta.needed(&changes) {
            let sent = delta.send(changes);
            sizes.push(Some(sent.nodes.len()));
            incremental.update_and_process_changes(sent, &mut reported);
        } else {
            sizes.push(None);
        }
        assert_eq!(reported, expected);
        assert_eq!(snapshot(&incremental), snapshot(&reference));
    }
    sizes
}

const LIST: &[(u64, Role, &str, &[u64])] = &[
    (2, Role::Label, "Row 0", &[]),
    (3, Role::Button, "Open 0", &[]),
    (1, Role::ListItem, "", &[2, 3]),
    (5, Role::Label, "Row 1", &[]),
    (6, Role::Button, "Open 1", &[]),
    (4, Role::ListItem, "", &[5, 6]),
    (7, Role::List, "", &[1, 4]),
    (0, Role::Window, "Window", &[7]),
];

#[test]
fn sends_only_changed_nodes_and_nothing_when_unchanged() {
    let mut renamed = LIST.to_vec();
    renamed[0].2 = "Row 0 renamed";
    let sizes = replay(vec![
        full(LIST, 0),
        full(LIST, 0),
        full(&renamed, 0),
        full(&renamed, 3),
        full(&renamed, 3),
    ]);
    // The first update is the whole tree (the adapter starts stale); a
    // repeat sends nothing; a rename sends one node; a focus move none.
    assert_eq!(sizes, [Some(8), None, Some(1), Some(0), None]);
}

#[test]
fn removals_moves_and_reorders_reach_the_consumer() {
    let added: &[(u64, Role, &str, &[u64])] = &[
        (2, Role::Label, "Row 0", &[]),
        (3, Role::Button, "Open 0", &[]),
        (1, Role::ListItem, "", &[2, 3]),
        (5, Role::Label, "Row 1", &[]),
        (6, Role::Button, "Open 1", &[]),
        (4, Role::ListItem, "", &[5, 6]),
        (9, Role::Label, "Row 2", &[]),
        (8, Role::ListItem, "", &[9]),
        (7, Role::List, "", &[1, 4, 8]),
        (0, Role::Window, "Window", &[7]),
    ];
    // Row 1's subtree removed; its button moved into row 2; rows reordered.
    let moved: &[(u64, Role, &str, &[u64])] = &[
        (9, Role::Label, "Row 2", &[]),
        (6, Role::Button, "Open 1", &[]),
        (8, Role::ListItem, "", &[9, 6]),
        (2, Role::Label, "Row 0", &[]),
        (3, Role::Button, "Open 0", &[]),
        (1, Role::ListItem, "", &[2, 3]),
        (7, Role::List, "", &[8, 1]),
        (0, Role::Window, "Window", &[7]),
    ];
    let emptied: &[(u64, Role, &str, &[u64])] = &[(0, Role::Window, "Window", &[])];
    let sizes = replay(vec![
        full(LIST, 3),
        full(added, 3),
        full(moved, 6),
        full(LIST, 2),
        full(emptied, 0),
        full(LIST, 0),
    ]);
    assert_eq!(sizes[1], Some(3), "the new row, its label and the list");
    assert_eq!(
        sizes[2],
        Some(2),
        "row 2 and the list: unchanged nodes stay out"
    );
}

#[test]
fn an_activation_resends_the_whole_tree() {
    let mut delta = Delta::default();
    let mut handler = StaleOnActivation {
        handler: GpuiActivation,
        stale: delta.stale_flag(),
    };
    // Active from the start: the first update is complete.
    let mut consumer = accesskit_consumer::Tree::new(handler.request_initial_tree().unwrap(), true);
    let changes = delta.update(full(LIST, 0));
    assert!(delta.needed(&changes));
    let sent = delta.send(changes);
    assert_eq!(sent.nodes.len(), LIST.len());
    consumer.update_and_process_changes(sent, &mut Reported::default());
    let changes = delta.update(full(LIST, 0));
    assert!(!delta.needed(&changes));

    // Deactivated while the tree changed, then activated again: the adapter
    // holds only the initial tree, and gets the whole current tree.
    let mut renamed = LIST.to_vec();
    renamed[3].2 = "Row 1 renamed";
    let _skipped = delta.update(full(&renamed, 0));
    let mut consumer = accesskit_consumer::Tree::new(handler.request_initial_tree().unwrap(), true);
    let changes = delta.update(full(&renamed, 0));
    assert!(
        delta.needed(&changes),
        "nothing changed, but the adapter is stale"
    );
    let sent = delta.send(changes);
    assert_eq!(sent.nodes.len(), LIST.len());
    let mut reported = Reported::default();
    consumer.update_and_process_changes(sent, &mut reported);
    assert_eq!(reported.added.len(), LIST.len() - 1);
    let mut reference = accesskit_consumer::Tree::new(full(&renamed, 0), true);
    reference.update_and_process_changes(full(&renamed, 0), &mut Reported::default());
    assert_eq!(snapshot(&consumer), snapshot(&reference));
    let changes = delta.update(full(&renamed, 0));
    assert!(!delta.needed(&changes));
}

/// What GPUI's activation callback returns.
struct GpuiActivation;

impl ActivationHandler for GpuiActivation {
    fn request_initial_tree(&mut self) -> Option<TreeUpdate> {
        Some(initial())
    }
}
