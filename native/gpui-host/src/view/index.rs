//! Per-node render facts derived from the committed tree: shared labels,
//! focusable controls and scroll modes. Kept current from what a batch changed
//! instead of rebuilt from every node, so a one-node update on a large window
//! does not walk, clone and reinsert the whole graph's caches.

use bun_native_protocol::{Element, Node, NodeId, Overflow, Tree};
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
    /// keys that differ. Moves never change an element and are not indexed.
    pub(super) fn sync(&mut self, previous: &Tree, next: &Tree) {
        let mut before = previous.nodes().peekable();
        for (id, node) in next.nodes() {
            while let Some((deleted, _)) = before.next_if(|(old, _)| *old < id) {
                self.forget(deleted);
            }
            match before.next_if(|(old, _)| *old == id) {
                Some((_, old)) if std::ptr::eq(old.element(), node.element()) => {}
                _ => self.index(id, node),
            }
        }
        for (deleted, _) in before {
            self.forget(deleted);
        }
        #[cfg(debug_assertions)]
        assert_eq!(
            *self,
            Self::new(next),
            "incremental node index diverged from a full rebuild"
        );
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
    }

    fn forget(&mut self, id: NodeId) {
        self.labels.remove(&id);
        self.controls.remove(&id);
        self.scroll_modes.remove(&id);
    }
}

#[cfg(test)]
mod tests;
