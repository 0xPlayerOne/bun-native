//! Persistent, ID-ordered node storage. Preflight builds the next tree beside
//! the committed one, so storage is a radix trie of shared `Arc` blocks: a
//! clone is one refcount and a write copies only the blocks on its key's path.
//! A one-node update therefore costs a few small copies, not the whole window.

use super::Node;
use crate::NodeId;
use std::fmt;
use std::sync::Arc;

const BITS: u32 = 4;
const WIDTH: usize = 1 << BITS;
const MASK: u64 = WIDTH as u64 - 1;
/// Branch levels that can sit above a leaf for a 53-bit JavaScript-safe ID.
const MAX_BRANCHES: usize = 13;

type Entry = (NodeId, Node);

#[derive(Clone)]
enum Block {
    Branch(Arc<[Option<Block>; WIDTH]>),
    Leaf(Arc<[Option<Entry>; WIDTH]>),
}

impl Block {
    fn empty(shift: u32) -> Self {
        if shift == 0 {
            Self::Leaf(Arc::new(std::array::from_fn(|_| None)))
        } else {
            Self::Branch(Arc::new(std::array::from_fn(|_| None)))
        }
    }

    fn is_empty(&self) -> bool {
        match self {
            Self::Branch(slots) => slots.iter().all(Option::is_none),
            Self::Leaf(slots) => slots.iter().all(Option::is_none),
        }
    }
}

fn slot(key: u64, shift: u32) -> usize {
    // Masked to the block width, so the narrowing cannot truncate.
    ((key >> shift) & MASK) as usize
}

/// Removes `key` below `block`, dropping blocks a removal leaves empty.
fn remove(block: &mut Block, key: u64, shift: u32) -> Option<Entry> {
    match block {
        Block::Leaf(slots) => Arc::make_mut(slots)[slot(key, 0)].take(),
        Block::Branch(slots) => {
            let child = &mut Arc::make_mut(slots)[slot(key, shift)];
            let removed = remove(child.as_mut()?, key, shift - BITS);
            if child.as_ref().is_some_and(Block::is_empty) {
                *child = None;
            }
            removed
        }
    }
}

#[derive(Clone, Default)]
pub(super) struct NodeMap {
    root: Option<Block>,
    /// Key bits consumed above the leaf level; meaningful while `root` exists.
    shift: u32,
    len: usize,
}

impl NodeMap {
    pub(super) fn len(&self) -> usize {
        self.len
    }

    fn fits(&self, key: u64) -> bool {
        self.root.is_some() && key >> (self.shift + BITS) == 0
    }

    pub(super) fn get(&self, id: NodeId) -> Option<&Node> {
        let key = id.get();
        if !self.fits(key) {
            return None;
        }
        let mut block = self.root.as_ref()?;
        let mut shift = self.shift;
        loop {
            match block {
                Block::Branch(slots) => {
                    block = slots[slot(key, shift)].as_ref()?;
                    shift -= BITS;
                }
                Block::Leaf(slots) => return slots[slot(key, 0)].as_ref().map(|(_, node)| node),
            }
        }
    }

    /// Copies the shared blocks on `id`'s path only when the node exists, so a
    /// rejected lookup never detaches storage from the committed tree.
    pub(super) fn get_mut(&mut self, id: NodeId) -> Option<&mut Node> {
        self.get(id)?;
        let key = id.get();
        let mut block = self.root.as_mut()?;
        let mut shift = self.shift;
        loop {
            match block {
                Block::Branch(slots) => {
                    block = Arc::make_mut(slots)[slot(key, shift)].as_mut()?;
                    shift -= BITS;
                }
                Block::Leaf(slots) => {
                    return Arc::make_mut(slots)[slot(key, 0)]
                        .as_mut()
                        .map(|(_, node)| node)
                }
            }
        }
    }

    pub(super) fn insert(&mut self, id: NodeId, node: Node) -> Option<Node> {
        let key = id.get();
        if self.root.is_none() {
            // Start at the height this key needs: wrapping an empty block
            // would leave a stray, never-pruned block in slot zero.
            self.shift = 0;
            while key >> (self.shift + BITS) != 0 {
                self.shift += BITS;
            }
            self.root = Some(Block::empty(self.shift));
        }
        while !self.fits(key) {
            let mut slots: [Option<Block>; WIDTH] = std::array::from_fn(|_| None);
            slots[0] = self.root.take();
            self.root = Some(Block::Branch(Arc::new(slots)));
            self.shift += BITS;
        }
        let mut block = self.root.as_mut()?;
        let mut shift = self.shift;
        let previous = loop {
            match block {
                Block::Branch(slots) => {
                    block = Arc::make_mut(slots)[slot(key, shift)]
                        .get_or_insert_with(|| Block::empty(shift - BITS));
                    shift -= BITS;
                }
                Block::Leaf(slots) => {
                    break Arc::make_mut(slots)[slot(key, 0)].replace((id, node));
                }
            }
        };
        if previous.is_none() {
            self.len += 1;
        }
        previous.map(|(_, node)| node)
    }

    pub(super) fn remove(&mut self, id: NodeId) -> Option<Node> {
        self.get(id)?;
        let root = self.root.as_mut()?;
        let (_, node) = remove(root, id.get(), self.shift)?;
        if root.is_empty() {
            self.root = None;
        }
        self.len -= 1;
        Some(node)
    }

    pub(super) fn last_id(&self) -> Option<NodeId> {
        let mut block = self.root.as_ref()?;
        loop {
            match block {
                Block::Branch(slots) => block = slots.iter().rev().find_map(Option::as_ref)?,
                Block::Leaf(slots) => {
                    return slots
                        .iter()
                        .rev()
                        .find_map(|entry| entry.as_ref().map(|e| e.0))
                }
            }
        }
    }

    /// Calls `visit(id, old, new)`, in ID order, for every key whose entry is
    /// missing from one map or for which `same` is false. Blocks that are the
    /// same allocation in both maps are skipped without being read, so two
    /// versions of one persistent map are compared in time proportional to what
    /// separates them, not to their size.
    pub(super) fn diff<'a>(
        &'a self,
        old: &'a Self,
        same: &impl Fn(&Node, &Node) -> bool,
        visit: &mut impl FnMut(NodeId, Option<&'a Node>, Option<&'a Node>),
    ) {
        match (&old.root, &self.root) {
            (Some(before), Some(after)) if old.shift == self.shift => {
                diff_blocks(Some(before), Some(after), same, visit);
            }
            (None, None) => {}
            // Different heights share no blocks: walk both in order.
            _ => {
                let mut before = old.iter().peekable();
                for (id, node) in self.iter() {
                    while let Some((gone, gone_node)) = before.next_if(|(key, _)| *key < id) {
                        visit(gone, Some(gone_node), None);
                    }
                    match before.next_if(|(key, _)| *key == id) {
                        Some((_, previous)) if same(previous, node) => {}
                        Some((_, previous)) => visit(id, Some(previous), Some(node)),
                        None => visit(id, None, Some(node)),
                    }
                }
                for (gone, gone_node) in before {
                    visit(gone, Some(gone_node), None);
                }
            }
        }
    }

    pub(super) fn iter(&self) -> Iter<'_> {
        let mut iter = Iter {
            branches: [(&[], 0); MAX_BRANCHES],
            depth: 0,
            leaf: [].iter(),
            remaining: self.len,
        };
        match &self.root {
            Some(Block::Branch(slots)) => {
                iter.branches[0] = (slots.as_slice(), 0);
                iter.depth = 1;
            }
            Some(Block::Leaf(slots)) => iter.leaf = slots.iter(),
            None => {}
        }
        iter
    }
}

fn diff_blocks<'a>(
    old: Option<&'a Block>,
    new: Option<&'a Block>,
    same: &impl Fn(&Node, &Node) -> bool,
    visit: &mut impl FnMut(NodeId, Option<&'a Node>, Option<&'a Node>),
) {
    match (old, new) {
        (None, None) => {}
        (Some(Block::Branch(before)), Some(Block::Branch(after))) => {
            if Arc::ptr_eq(before, after) {
                return;
            }
            for (before, after) in before.iter().zip(after.iter()) {
                diff_blocks(before.as_ref(), after.as_ref(), same, visit);
            }
        }
        (Some(Block::Leaf(before)), Some(Block::Leaf(after))) => {
            if Arc::ptr_eq(before, after) {
                return;
            }
            for (before, after) in before.iter().zip(after.iter()) {
                match (before, after) {
                    (Some((id, old)), Some((_, new))) if !same(old, new) => {
                        visit(*id, Some(old), Some(new));
                    }
                    (Some((id, old)), None) => visit(*id, Some(old), None),
                    (None, Some((id, new))) => visit(*id, None, Some(new)),
                    _ => {}
                }
            }
        }
        (Some(block), None) => each_entry(block, &mut |id, node| visit(id, Some(node), None)),
        (None, Some(block)) => each_entry(block, &mut |id, node| visit(id, None, Some(node))),
        // Blocks at one depth are all branches or all leaves.
        (Some(_), Some(_)) => unreachable!("trie blocks at one depth have one kind"),
    }
}

fn each_entry<'a>(block: &'a Block, f: &mut impl FnMut(NodeId, &'a Node)) {
    match block {
        Block::Branch(slots) => {
            for child in slots.iter().flatten() {
                each_entry(child, f);
            }
        }
        Block::Leaf(slots) => {
            for (id, node) in slots.iter().flatten() {
                f(*id, node);
            }
        }
    }
}

impl PartialEq for NodeMap {
    fn eq(&self, other: &Self) -> bool {
        self.len == other.len && self.iter().eq(other.iter())
    }
}

impl fmt::Debug for NodeMap {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.debug_map().entries(self.iter()).finish()
    }
}

/// In-order walk with a fixed stack: render and evidence iterate every node
/// each frame, so the walk itself must not allocate.
pub(super) struct Iter<'a> {
    branches: [(&'a [Option<Block>], usize); MAX_BRANCHES],
    depth: usize,
    leaf: std::slice::Iter<'a, Option<Entry>>,
    remaining: usize,
}

impl<'a> Iterator for Iter<'a> {
    type Item = (NodeId, &'a Node);

    fn next(&mut self) -> Option<Self::Item> {
        loop {
            if let Some((id, node)) = self.leaf.by_ref().find_map(Option::as_ref) {
                self.remaining -= 1;
                return Some((*id, node));
            }
            loop {
                let (slots, index) = *self.branches.get(self.depth.checked_sub(1)?)?;
                let Some(block) = slots.get(index) else {
                    self.depth -= 1;
                    continue;
                };
                self.branches[self.depth - 1].1 = index + 1;
                match block {
                    None => {}
                    Some(Block::Leaf(slots)) => {
                        self.leaf = slots.iter();
                        break;
                    }
                    Some(Block::Branch(slots)) => {
                        self.branches[self.depth] = (slots.as_slice(), 0);
                        self.depth += 1;
                    }
                }
            }
        }
    }

    fn size_hint(&self) -> (usize, Option<usize>) {
        (self.remaining, Some(self.remaining))
    }
}

impl ExactSizeIterator for Iter<'_> {}

#[cfg(test)]
mod tests;
