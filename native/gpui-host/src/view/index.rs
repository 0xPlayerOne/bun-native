//! Per-node render facts derived from the committed tree: shared labels,
//! focusable controls, scroll modes and the split, overlay and popup nodes.
//! Kept current from what a batch changed instead of rebuilt from every node,
//! so a one-node update on a large window does not walk, clone and reinsert
//! the whole graph's caches, and a window without splits, overlays or popups
//! never walks its tree for them.

use bun_native_protocol::{Element, Node, NodeId, Overflow, OverlaySurface, Tree};
use gpui::SharedString;
use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Default, PartialEq)]
pub(super) struct NodeIndex {
    /// Text and button labels as shared strings, reused across batches while
    /// unchanged, so each render bumps a refcount instead of copying text.
    pub(super) labels: BTreeMap<NodeId, SharedString>,
    /// Input and button nodes, which own GPUI focus handles or entities.
    pub(super) controls: BTreeSet<NodeId>,
    pub(super) scroll_modes: BTreeMap<NodeId, Overflow>,
    /// Split nodes, which own a ratio and a divider focus handle.
    pub(super) splits: BTreeSet<NodeId>,
    /// Overlay nodes of any surface. Layer order and nesting depend on the
    /// tree structure, so these only say whether a structural walk can find
    /// anything; an empty set means no layers and no active modal.
    pub(super) overlays: BTreeSet<NodeId>,
    /// Modal overlays; empty means no active modal.
    pub(super) modals: BTreeSet<NodeId>,
    /// Overlays with `surface: window`, drawn into owned popup windows.
    pub(super) popups: BTreeSet<NodeId>,
}

impl NodeIndex {
    pub(super) fn new(tree: &Tree) -> Self {
        let mut index = Self::default();
        for (id, node) in tree.nodes() {
            index.index(id, node);
        }
        index
    }

    /// `previous` must be the tree `next` was prepared from. Batches share
    /// every untouched element `Arc`, so a node whose element is the same
    /// allocation in both trees cannot have changed any indexed fact; created,
    /// set and deleted (including whole deleted subtrees) nodes are exactly the
    /// keys that differ, and the persistent node storage finds them without
    /// visiting the shared rest. Moves never change an element and are not
    /// indexed. Returns the created or set controls, in ID order: the only
    /// inputs whose properties can differ from what their entity holds.
    pub(super) fn sync(&mut self, previous: &Tree, next: &Tree) -> Vec<NodeId> {
        let mut changed = Vec::new();
        next.diff_elements(previous, |id, _, node| match node {
            Some(node) => {
                self.index(id, node);
                if self.controls.contains(&id) {
                    changed.push(id);
                }
            }
            None => self.forget(id),
        });
        #[cfg(debug_assertions)]
        assert_eq!(
            *self,
            Self::new(next),
            "incremental node index diverged from a full rebuild"
        );
        changed
    }

    fn index(&mut self, id: NodeId, node: &Node) {
        let element = node.element();
        if matches!(element, Element::Input { .. } | Element::Button { .. }) {
            self.controls.insert(id);
        } else {
            self.controls.remove(&id);
        }
        if let Element::Text { text, .. } | Element::Button { text, .. } = element {
            if self
                .labels
                .get(&id)
                .is_none_or(|label| label.as_ref() != text.as_str())
            {
                self.labels.insert(id, SharedString::from(text));
            }
        } else {
            self.labels.remove(&id);
        }
        match element.style().overflow.filter(|mode| mode.scrolls()) {
            Some(mode) => self.scroll_modes.insert(id, mode),
            None => self.scroll_modes.remove(&id),
        };
        let (split, overlay, modal, popup) = match element {
            Element::Split { .. } => (true, false, false, false),
            Element::Overlay { modal, surface, .. } => {
                (false, true, *modal, *surface == OverlaySurface::Window)
            }
            _ => (false, false, false, false),
        };
        for (set, member) in [
            (&mut self.splits, split),
            (&mut self.overlays, overlay),
            (&mut self.modals, modal),
            (&mut self.popups, popup),
        ] {
            if member {
                set.insert(id);
            } else {
                set.remove(&id);
            }
        }
    }

    fn forget(&mut self, id: NodeId) {
        self.labels.remove(&id);
        self.controls.remove(&id);
        self.scroll_modes.remove(&id);
        self.splits.remove(&id);
        self.overlays.remove(&id);
        self.modals.remove(&id);
        self.popups.remove(&id);
    }
}

#[cfg(test)]
mod tests;
