//! Incremental index maintenance must equal a full rebuild after any batch.

use super::*;
use crate::view::accessibility::{ModalScope, beneath_modal};
use bun_native_protocol::{
    MAX_NODES_PER_WINDOW, MAX_OPERATIONS, Operation, OverlayAnchor, OverlayNavigation, Style,
};
use std::time::{Duration, Instant};

// Longer than SmolStr's inline capacity, so equal labels that are reused share
// one heap allocation and the pointer check below is meaningful.
const INLINE_LABEL_BYTES: usize = 23;
const TEXTS: [&str; 3] = [
    "first label beyond inline storage",
    "second label beyond inline storage",
    "",
];
const OVERFLOWS: [Option<Overflow>; 6] = [
    None,
    Some(Overflow::Visible),
    Some(Overflow::Hidden),
    Some(Overflow::ScrollX),
    Some(Overflow::ScrollY),
    Some(Overflow::Scroll),
];

fn id(value: u64) -> NodeId {
    NodeId::try_from(value).unwrap()
}

/// Deterministic xorshift so failures reproduce without a dependency.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn below(&mut self, bound: usize) -> usize {
        (self.next() % bound as u64) as usize
    }
    fn pick<T: Copy>(&mut self, items: &[T]) -> T {
        items[self.below(items.len())]
    }
}

fn element(rng: &mut Rng, kind: usize) -> Element {
    let text = rng.pick(&TEXTS).to_owned();
    match kind {
        0 => Element::Box {
            accessibility: Default::default(),
            style: Style {
                overflow: rng.pick(&OVERFLOWS),
                ..Style::default()
            },
        },
        1 => Element::Text {
            accessible_live: None,
            text,
            style: Style::default(),
        },
        2 => Element::Button {
            text,
            disabled: rng.below(2) == 0,
            style: Style::default(),
        },
        3 => Element::Input {
            value: text,
            placeholder: String::new(),
            disabled: false,
            read_only: false,
            style: Style::default(),
        },
        4 => Element::Split {
            ratio: 0.5,
            min_size: rng.below(3) as f64,
            accessible_label: None,
            style: Style::default(),
        },
        // A modal layer, a plain layer, or a popup window (anchored to its
        // parent, fixed size, never modal), as the protocol requires.
        _ => {
            let (modal, popup) = match rng.below(3) {
                0 => (true, false),
                1 => (false, false),
                _ => (false, true),
            };
            let pixels = Some(bun_native_protocol::Dimension::Pixels(40.));
            Element::Overlay {
                anchor: if popup {
                    OverlayAnchor::Parent
                } else {
                    OverlayAnchor::Window
                },
                modal,
                autofocus: false,
                navigation: OverlayNavigation::Tab,
                surface: if popup {
                    OverlaySurface::Window
                } else {
                    OverlaySurface::Layer
                },
                accessible_label: None,
                style: Style {
                    width: pixels.filter(|_| popup),
                    height: pixels.filter(|_| popup),
                    ..Style::default()
                },
            }
        }
    }
}

fn kind(element: &Element) -> usize {
    match element {
        Element::Box { .. } => 0,
        Element::Text { .. } => 1,
        Element::Button { .. } => 2,
        Element::Input { .. } => 3,
        Element::Split { .. } => 4,
        Element::Overlay { .. } => 5,
    }
}

/// With `layers`, splits and overlays (drawn from that separate stream, so the
/// leaf and box sequence is unchanged) are also created and used as parents.
fn random_batch(
    rng: &mut Rng,
    mut layers: Option<&mut Rng>,
    tree: &Tree,
    last_node_id: u64,
) -> Vec<Operation> {
    let ids: Vec<NodeId> = tree.nodes().map(|(id, _)| id).collect();
    let layered = layers.is_some();
    let boxes: Vec<NodeId> = tree
        .nodes()
        .filter(|(_, node)| match node.element() {
            Element::Box { .. } => true,
            Element::Split { .. } | Element::Overlay { .. } => layered,
            _ => false,
        })
        .map(|(id, _)| id)
        .collect();
    let mut next_id = last_node_id;
    let mut operations = Vec::new();
    for _ in 0..1 + rng.below(6) {
        match rng.below(10) {
            0..=3 => {
                next_id += 1;
                let kind = rng.below(4);
                let layer = layers
                    .as_deref_mut()
                    .and_then(|layers| (layers.below(8) == 0).then_some(layers));
                let element = match layer {
                    Some(layers) => {
                        let kind = 4 + layers.below(2);
                        element(layers, kind)
                    }
                    None => element(rng, kind),
                };
                operations.push(Operation::Create {
                    node_id: id(next_id),
                    element,
                });
                operations.push(Operation::Insert {
                    parent_id: rng.pick(&boxes),
                    child_id: id(next_id),
                    index: 0,
                });
            }
            4..=6 => {
                let node_id = rng.pick(&ids);
                let current = kind(tree.node(node_id).unwrap().element());
                let element = match layers.as_deref_mut() {
                    Some(layers) if current >= 4 => element(layers, current),
                    _ => element(rng, current),
                };
                operations.push(Operation::Set {
                    node_id,
                    element,
                    expected_input_revision: tree.node(node_id).unwrap().input_revision(),
                });
            }
            7 => operations.push(Operation::Insert {
                parent_id: rng.pick(&boxes),
                child_id: rng.pick(&ids),
                index: 0,
            }),
            _ => operations.push(Operation::Delete {
                node_id: rng.pick(&ids),
            }),
        }
    }
    operations
}

fn label_ptr(index: &NodeIndex, id: NodeId) -> Option<*const u8> {
    index.labels.get(&id).map(|label| label.as_ref().as_ptr())
}

struct Run {
    applied: usize,
    tree: Tree,
    /// Whether splits, modals and popups were each indexed at some point.
    seen: [bool; 3],
}

/// Applies random batches, checking after each that the incremental index
/// equals a full rebuild, that `sync` reports exactly the created or set
/// controls, and that the per-frame modal scope matches the route check.
fn random_run(mut layers: Option<Rng>) -> Run {
    let mut rng = Rng(0x9e37_79b9_7f4a_7c15);
    let mut tree = Tree::new(id(1));
    let mut last_node_id = 1;
    let mut index = NodeIndex::new(&tree);
    let mut applied = 0;
    let mut seen = [false; 3];
    for _ in 0..4_000 {
        let operations = random_batch(&mut rng, layers.as_mut(), &tree, last_node_id);
        let Ok(prepared) = tree.prepare(tree.revision(), operations, last_node_id) else {
            continue;
        };
        let before = index.labels.clone();
        let changed = index.sync(&tree, &prepared.tree);
        assert_eq!(index, NodeIndex::new(&prepared.tree));
        let expected: Vec<NodeId> = index
            .controls
            .iter()
            .copied()
            .filter(|id| {
                tree.node(*id).is_none_or(|old| {
                    !std::ptr::eq(old.element(), prepared.tree.node(*id).unwrap().element())
                })
            })
            .collect();
        assert_eq!(changed, expected);
        assert_modal_scope_matches_routes(&prepared.tree);
        for (seen, set) in seen
            .iter_mut()
            .zip([&index.splits, &index.modals, &index.popups])
        {
            *seen |= !set.is_empty();
        }
        // Like the former full rebuild, an unchanged label keeps its shared
        // allocation, whether the node was untouched or set to equal text.
        for (id, label) in &before {
            if let Some(after) = index.labels.get(id)
                && after == label
                && label.len() > INLINE_LABEL_BYTES
            {
                assert_eq!(label_ptr(&index, *id), Some(label.as_ref().as_ptr()));
            }
        }
        tree = prepared.tree;
        last_node_id = prepared.last_node_id;
        applied += 1;
    }
    Run {
        applied,
        tree,
        seen,
    }
}

#[test]
fn incremental_index_matches_full_rebuild_for_random_batches() {
    let run = random_run(None);
    assert!(
        run.applied > 1_000,
        "only {} random batches were valid",
        run.applied
    );
    assert!(run.tree.nodes().count() > 50);
}

#[test]
fn incremental_index_tracks_splits_overlays_and_popups() {
    let run = random_run(Some(Rng(0x2545_f491_4f6c_dd1d)));
    assert!(
        run.applied > 1_000,
        "only {} random batches were valid",
        run.applied
    );
    assert_eq!(
        run.seen, [true; 3],
        "splits, modals and popups were indexed"
    );
}

/// The per-frame modal scope, propagated from the root, hides exactly the
/// nodes the two-route check hides.
fn assert_modal_scope_matches_routes(tree: &Tree) {
    let modal = tree.active_modal();
    let route = modal.and_then(|modal| tree.path(modal)).unwrap_or_default();
    let mut pending = vec![ModalScope::of(tree, &route, tree.root_id())];
    let mut ids = vec![tree.root_id()];
    while let (Some(scope), Some(id)) = (pending.pop(), ids.pop()) {
        assert_eq!(
            scope.hidden(),
            modal.is_some_and(|modal| beneath_modal(tree, id, modal)),
            "node {id:?} beneath modal {modal:?}"
        );
        // A popup or nested render starts from its own node.
        assert_eq!(scope.hidden(), ModalScope::of(tree, &route, id).hidden());
        for child in tree.node(id).unwrap().children() {
            pending.push(scope.child(*child));
            ids.push(*child);
        }
    }
}

fn large_tree(nodes: usize) -> (Tree, u64) {
    let mut tree = Tree::new(id(1));
    let mut last = 1;
    let mut rng = Rng(7);
    while tree.nodes().count() < nodes.min(MAX_NODES_PER_WINDOW) {
        let room = nodes.min(MAX_NODES_PER_WINDOW) - tree.nodes().count();
        let parent = id(2);
        let base = last;
        let mut operations = Vec::new();
        if last == 1 {
            last += 1;
            operations.push(Operation::Create {
                node_id: parent,
                element: Element::Box {
                    accessibility: Default::default(),
                    style: Style {
                        overflow: Some(Overflow::ScrollY),
                        ..Style::default()
                    },
                },
            });
            operations.push(Operation::Insert {
                parent_id: id(1),
                child_id: parent,
                index: 0,
            });
        }
        while operations.len() + 2 <= MAX_OPERATIONS && operations.len() / 2 < room {
            last += 1;
            // Mostly text, with some controls, like a realistic list view.
            let kind = [1, 1, 1, 1, 1, 1, 2, 3][rng.below(8)];
            operations.push(Operation::Create {
                node_id: id(last),
                element: element(&mut rng, kind),
            });
            operations.push(Operation::Insert {
                parent_id: parent,
                child_id: id(last),
                index: 0,
            });
        }
        let prepared = tree.prepare(tree.revision(), operations, base).unwrap();
        tree = prepared.tree;
    }
    (tree, last)
}

/// The former `apply()` body: walk every node, cloning controls and
/// reinserting each label and scroll mode into fresh maps.
fn full_rebuild(
    labels: &mut BTreeMap<NodeId, SharedString>,
    tree: &Tree,
) -> (BTreeMap<NodeId, Node>, BTreeMap<NodeId, Overflow>) {
    let mut controls = BTreeMap::new();
    let mut scroll_modes = BTreeMap::new();
    let mut next_labels = BTreeMap::new();
    for (id, node) in tree.nodes() {
        if matches!(
            node.element(),
            Element::Input { .. } | Element::Button { .. }
        ) {
            controls.insert(id, node.clone());
        }
        if let Element::Text { text, .. } | Element::Button { text, .. } = node.element() {
            let label = labels
                .remove(&id)
                .filter(|label| label.as_ref() == text.as_str())
                .unwrap_or_else(|| SharedString::from(text));
            next_labels.insert(id, label);
        }
        if let Some(mode) = node.element().style().overflow.filter(|m| m.scrolls()) {
            scroll_modes.insert(id, mode);
        }
    }
    *labels = next_labels;
    (controls, scroll_modes)
}

fn median(mut samples: Vec<Duration>) -> Duration {
    samples.sort();
    samples[samples.len() / 2]
}

/// `cargo test --release -p bun-native-host view::index -- --ignored --nocapture`
#[test]
#[ignore = "timing benchmark; run explicitly in release mode"]
fn bench_one_node_set_batch() {
    for nodes in [1_000, 4_000] {
        let (tree, last) = large_tree(nodes);
        let target = id(last);
        let set = |tree: &Tree, round: usize| {
            let current = kind(tree.node(target).unwrap().element());
            let mut element = element(&mut Rng(round as u64 + 1), current);
            if let Element::Text { text, .. } | Element::Button { text, .. } = &mut element {
                *text = format!("label {round}");
            }
            tree.prepare(
                tree.revision(),
                vec![Operation::Set {
                    node_id: target,
                    element,
                    expected_input_revision: tree.node(target).unwrap().input_revision(),
                }],
                last,
            )
            .unwrap()
            .tree
        };
        const ROUNDS: usize = 2_000;
        let (mut full, mut incremental, mut sync, mut prepare) =
            (Vec::new(), Vec::new(), Vec::new(), Vec::new());
        let mut labels = BTreeMap::new();
        full_rebuild(&mut labels, &tree);
        let mut index = NodeIndex::new(&tree);
        let mut current = tree.clone();
        for round in 0..ROUNDS {
            let started = Instant::now();
            let next = set(&current, round);
            prepare.push(started.elapsed());

            let started = Instant::now();
            let snapshot = full_rebuild(&mut labels, &next);
            full.push(started.elapsed());
            std::hint::black_box(snapshot);

            let started = Instant::now();
            index.sync(&current, &next);
            sync.push(started.elapsed());
            let controls: Vec<(NodeId, Node)> = index
                .controls
                .iter()
                .map(|id| (*id, next.node(*id).unwrap().clone()))
                .collect();
            incremental.push(started.elapsed());
            std::hint::black_box(controls);
            current = next;
        }
        println!(
            "{nodes} nodes ({} controls): prepare {:?}, full rebuild {:?}, \
             incremental {:?} (index sync {:?}) (median of {ROUNDS})",
            index.controls.len(),
            median(prepare),
            median(full),
            median(incremental),
            median(sync),
        );
    }
}
