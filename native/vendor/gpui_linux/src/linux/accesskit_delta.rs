//! Incremental AccessKit tree updates (Bun Native patch,
//! `bun-native/accesskit-delta.patch`).
//!
//! GPUI builds the whole accessibility tree every frame and hands it to the
//! platform window. AccessKit's Unix adapter applies an update on the calling
//! thread: it looks up and compares every node in it, and the AT-SPI change
//! handler walks the siblings of every node it reports as updated. A
//! [`TreeUpdate`] only needs the nodes that are new or differ from the last
//! update the adapter applied, so [`Delta`] keeps that update and sends the
//! difference: nothing at all when no node and not the focus changed. A
//! removed node needs no entry: its old parent's child list changed, and
//! AccessKit drops every node no longer reachable.
//!
//! The adapter can be activated at any time, from its own thread, with
//! GPUI's root-only initial tree. The activation handler marks the delta
//! stale while it holds the adapter's state lock, and the update closure,
//! which runs under the same lock, then sends the full tree, so an
//! incremental update never reaches a tree it was not computed against.

use accesskit::{Node, NodeId, Tree, TreeUpdate};
use std::collections::HashMap;
use std::hash::{BuildHasherDefault, Hasher};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

/// Multiplicative hashing for GPUI's already well-mixed 64-bit node ids.
/// Self-contained, so Bun Native's host tests can compile this file.
#[derive(Default)]
struct IdHasher(u64);

impl Hasher for IdHasher {
    fn finish(&self) -> u64 {
        self.0
    }

    fn write(&mut self, bytes: &[u8]) {
        for byte in bytes {
            self.write_u64(u64::from(*byte));
        }
    }

    fn write_u64(&mut self, value: u64) {
        self.0 = (self.0.rotate_left(5) ^ value).wrapping_mul(0x51_7c_c1_b7_27_22_0a_95);
    }
}

type IdMap<V> = HashMap<NodeId, V, BuildHasherDefault<IdHasher>>;

/// The last tree sent to an AccessKit adapter, and what it is missing.
pub(crate) struct Delta {
    /// Set by the adapter's activation handler: the adapter holds only the
    /// initial tree, so the next update must be complete.
    stale: Arc<AtomicBool>,
    /// The latest full update's nodes, in GPUI's order.
    nodes: Vec<(NodeId, Node)>,
    /// Each node's position in `nodes`.
    positions: IdMap<usize>,
    tree: Option<Tree>,
    focus: Option<NodeId>,
}

/// What [`Delta::update`] found changed since the last full update.
pub(crate) struct Changes {
    nodes: Vec<(NodeId, Node)>,
    tree: Option<Tree>,
    focus: NodeId,
    tree_id: accesskit::TreeId,
    unchanged: bool,
}

impl Default for Delta {
    fn default() -> Self {
        Self {
            stale: Arc::new(AtomicBool::new(true)),
            nodes: Vec::new(),
            positions: IdMap::default(),
            tree: None,
            focus: None,
        }
    }
}

impl Delta {
    /// The flag the activation handler sets, under the adapter's state lock.
    pub(crate) fn stale_flag(&self) -> Arc<AtomicBool> {
        self.stale.clone()
    }

    /// Records a full update from GPUI and returns what differs from the
    /// previous one. Call [`Delta::send`] with the result.
    pub(crate) fn update(&mut self, full: TreeUpdate) -> Changes {
        let TreeUpdate {
            nodes,
            tree,
            tree_id,
            focus,
        } = full;
        let mut changed = Vec::new();
        // GPUI emits nodes in the same order while the structure holds, so
        // most nodes compare at their old position without hashing.
        let mut aligned = nodes.len() == self.nodes.len();
        for (position, (id, node)) in nodes.iter().enumerate() {
            let previous = match self.nodes.get(position) {
                Some((old_id, old)) if old_id == id => Some(old),
                _ => {
                    aligned = false;
                    self.positions
                        .get(id)
                        .and_then(|index| self.nodes.get(*index))
                        .filter(|(old_id, _)| old_id == id)
                        .map(|(_, old)| old)
                }
            };
            if previous != Some(node) {
                changed.push((*id, node.clone()));
            }
        }
        if !aligned {
            self.positions.clear();
            self.positions.extend(
                nodes
                    .iter()
                    .enumerate()
                    .map(|(position, (id, _))| (*id, position)),
            );
        }
        self.nodes = nodes;
        let tree_changed = tree.is_some() && tree != self.tree;
        if tree_changed {
            self.tree = tree;
        }
        let unchanged = changed.is_empty() && !tree_changed && self.focus == Some(focus);
        self.focus = Some(focus);
        Changes {
            nodes: changed,
            tree: if tree_changed {
                self.tree.clone()
            } else {
                None
            },
            focus,
            tree_id,
            unchanged,
        }
    }

    /// The update to apply to the adapter: the changes, or the whole tree
    /// when the adapter was activated since the last update it applied. Call
    /// only from the adapter's update closure, which holds its state lock.
    pub(crate) fn send(&self, changes: Changes) -> TreeUpdate {
        if self.stale.swap(false, Ordering::SeqCst) {
            return TreeUpdate {
                nodes: self.nodes.clone(),
                tree: self.tree.clone(),
                tree_id: changes.tree_id,
                focus: changes.focus,
            };
        }
        TreeUpdate {
            nodes: changes.nodes,
            tree: changes.tree,
            tree_id: changes.tree_id,
            focus: changes.focus,
        }
    }

    /// Whether the adapter must be updated: something changed, or it was
    /// activated since the last update it applied.
    pub(crate) fn needed(&self, changes: &Changes) -> bool {
        !changes.unchanged || self.stale.load(Ordering::SeqCst)
    }
}

/// Wraps an activation handler so that every activation marks `stale`
/// before the adapter holds its initial tree.
pub(crate) struct StaleOnActivation<H> {
    pub(crate) handler: H,
    pub(crate) stale: Arc<AtomicBool>,
}

impl<H: accesskit::ActivationHandler> accesskit::ActivationHandler for StaleOnActivation<H> {
    fn request_initial_tree(&mut self) -> Option<TreeUpdate> {
        self.stale.store(true, Ordering::SeqCst);
        self.handler.request_initial_tree()
    }
}
