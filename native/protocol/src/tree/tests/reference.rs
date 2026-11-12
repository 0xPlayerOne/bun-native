//! The pre-persistent preflight, kept as a test oracle: clone the whole graph
//! into an ordered map, apply every operation, then walk the full graph. The
//! production path must reach the same verdict, error and committed state.

use crate::{
    Element, ErrorCode, NodeId, Operation, OverlaySurface, MAX_DEPTH, MAX_ID, MAX_NODES_PER_WINDOW,
    MAX_OPERATIONS, MAX_OVERLAY_DEPTH, MAX_TEXT_BYTES_PER_WINDOW,
};
use std::collections::{BTreeMap, BTreeSet};

#[derive(Debug, Clone, PartialEq)]
pub(super) struct Node {
    pub(super) element: Element,
    pub(super) parent: Option<NodeId>,
    pub(super) children: Vec<NodeId>,
    pub(super) input_revision: Option<u64>,
}

#[derive(Debug, Clone, PartialEq)]
pub(super) struct Model {
    pub(super) root_id: NodeId,
    pub(super) revision: u64,
    pub(super) text_bytes: usize,
    pub(super) nodes: BTreeMap<NodeId, Node>,
}

type Failure = (ErrorCode, &'static str);
const STALE: Failure = (
    ErrorCode::InvalidHandle,
    "node is stale or is not owned by this window",
);

fn budget(bytes: usize) -> Result<usize, Failure> {
    if bytes > MAX_TEXT_BYTES_PER_WINDOW {
        Err((ErrorCode::LimitExceeded, "window text byte limit exceeded"))
    } else {
        Ok(bytes)
    }
}

fn bump(current: u64) -> Result<u64, Failure> {
    if current >= MAX_ID {
        Err((ErrorCode::LimitExceeded, "revision exhausted"))
    } else {
        Ok(current + 1)
    }
}

impl Model {
    pub(super) fn new(root_id: NodeId) -> Self {
        let root = Node {
            element: Element::Box {
                accessibility: Default::default(),
                style: Default::default(),
            },
            parent: None,
            children: Vec::new(),
            input_revision: None,
        };
        Self {
            root_id,
            revision: 0,
            text_bytes: 0,
            nodes: BTreeMap::from([(root_id, root)]),
        }
    }

    pub(super) fn prepare(
        &self,
        base_revision: u64,
        operations: &[Operation],
        mut last_node_id: u64,
    ) -> Result<(Self, u64), Failure> {
        if base_revision != self.revision {
            return Err((ErrorCode::StaleRevision, "tree revision does not match"));
        }
        if operations.is_empty() || operations.len() > MAX_OPERATIONS {
            return Err((
                ErrorCode::LimitExceeded,
                "batch must have between 1 and 256 operations",
            ));
        }
        if last_node_id > MAX_ID || self.nodes.keys().next_back().unwrap().get() > last_node_id {
            return Err((
                ErrorCode::InvalidState,
                "session allocation state is inconsistent",
            ));
        }
        let mut next = self.clone();
        for operation in operations.iter().cloned() {
            match operation {
                Operation::Create { node_id, element } => {
                    element
                        .validate()
                        .map_err(|message| (ErrorCode::InvalidCommand, message))?;
                    if node_id.get() <= last_node_id {
                        return Err((
                            ErrorCode::InvalidHandle,
                            "node IDs must increase across the session and cannot be reused",
                        ));
                    }
                    if next.nodes.len() >= MAX_NODES_PER_WINDOW {
                        return Err((ErrorCode::LimitExceeded, "window node limit exceeded"));
                    }
                    let input_revision = matches!(element, Element::Input { .. }).then_some(0);
                    next.text_bytes = budget(next.text_bytes + element.text_bytes())?;
                    next.nodes.insert(
                        node_id,
                        Node {
                            element,
                            parent: None,
                            children: Vec::new(),
                            input_revision,
                        },
                    );
                    last_node_id = node_id.get();
                }
                Operation::Set {
                    node_id,
                    element,
                    expected_input_revision,
                } => {
                    element
                        .validate()
                        .map_err(|message| (ErrorCode::InvalidCommand, message))?;
                    let node = next.nodes.get_mut(&node_id).ok_or(STALE)?;
                    if !node.element.same_kind(&element) {
                        return Err((ErrorCode::InvalidState, "set cannot change an element kind"));
                    }
                    match (node.input_revision, expected_input_revision) {
                        (Some(current), Some(expected)) if current == expected => {
                            node.input_revision = Some(bump(current)?);
                        }
                        (Some(_), Some(_)) => {
                            return Err((ErrorCode::StaleRevision, "input revision does not match"))
                        }
                        (Some(_), None) => {
                            return Err((
                                ErrorCode::InvalidCommand,
                                "input set requires expected_input_revision",
                            ))
                        }
                        (None, Some(_)) => {
                            return Err((
                                ErrorCode::InvalidCommand,
                                "expected_input_revision is only valid for input",
                            ))
                        }
                        (None, None) => {}
                    }
                    next.text_bytes =
                        budget(next.text_bytes - node.element.text_bytes() + element.text_bytes())?;
                    node.element = element;
                }
                Operation::Insert {
                    parent_id,
                    child_id,
                    index,
                } => next.insert(parent_id, child_id, index)?,
                Operation::Delete { node_id } => next.delete(node_id)?,
                // View requests are checked against the final tree by the
                // production path alone; these batches never carry them.
                Operation::Focus { .. }
                | Operation::ScrollTo { .. }
                | Operation::ScrollIntoView { .. } => {}
            }
        }
        next.validate()?;
        next.revision = bump(self.revision)?;
        Ok((next, last_node_id))
    }

    fn insert(&mut self, parent_id: NodeId, child_id: NodeId, index: usize) -> Result<(), Failure> {
        let parent = self.nodes.get(&parent_id).ok_or(STALE)?;
        if !parent.element.is_container() {
            return Err((
                ErrorCode::InvalidState,
                "only box, split and overlay elements can own children",
            ));
        }
        if child_id == self.root_id {
            return Err((
                ErrorCode::InvalidState,
                "the window root cannot be reparented",
            ));
        }
        let old_parent = self.nodes.get(&child_id).ok_or(STALE)?.parent;
        let mut ancestor = Some(parent_id);
        while let Some(id) = ancestor {
            if id == child_id {
                return Err((ErrorCode::InvalidState, "insert would create a cycle"));
            }
            ancestor = self.nodes.get(&id).ok_or(STALE)?.parent;
        }
        if let Some(old_parent) = old_parent {
            let siblings = &mut self.nodes.get_mut(&old_parent).ok_or(STALE)?.children;
            siblings.retain(|id| *id != child_id);
        }
        let children = &mut self.nodes.get_mut(&parent_id).ok_or(STALE)?.children;
        if index > children.len() {
            return Err((
                ErrorCode::InvalidCommand,
                "insert index exceeds child count after detaching",
            ));
        }
        children.insert(index, child_id);
        self.nodes.get_mut(&child_id).ok_or(STALE)?.parent = Some(parent_id);
        Ok(())
    }

    fn delete(&mut self, node_id: NodeId) -> Result<(), Failure> {
        if node_id == self.root_id {
            return Err((
                ErrorCode::InvalidState,
                "close the window to delete its root",
            ));
        }
        if let Some(parent) = self.nodes.get(&node_id).ok_or(STALE)?.parent {
            let siblings = &mut self.nodes.get_mut(&parent).ok_or(STALE)?.children;
            siblings.retain(|id| *id != node_id);
        }
        let mut pending = vec![node_id];
        while let Some(id) = pending.pop() {
            let node = self.nodes.remove(&id).ok_or(STALE)?;
            self.text_bytes -= node.element.text_bytes();
            pending.extend(node.children);
        }
        Ok(())
    }

    fn validate(&self) -> Result<(), Failure> {
        let mut seen = BTreeSet::new();
        let mut pending = vec![(self.root_id, None, 0, 0, false)];
        while let Some((id, parent, depth, overlays, popup)) = pending.pop() {
            if depth > MAX_DEPTH {
                return Err((ErrorCode::LimitExceeded, "tree depth exceeds 64 edges"));
            }
            if !seen.insert(id) {
                return Err((
                    ErrorCode::InvalidState,
                    "tree contains duplicate ownership or a cycle",
                ));
            }
            let node = self.nodes.get(&id).ok_or(STALE)?;
            if node.children.len() > node.element.max_children() {
                return Err((ErrorCode::LimitExceeded, "a split owns at most two panes"));
            }
            let overlays = overlays + usize::from(matches!(node.element, Element::Overlay { .. }));
            if overlays > MAX_OVERLAY_DEPTH {
                return Err((ErrorCode::LimitExceeded, "overlay nesting exceeds 8 layers"));
            }
            if popup
                && matches!(
                    node.element,
                    Element::Input { .. } | Element::Overlay { .. }
                )
            {
                return Err((
                    ErrorCode::InvalidState,
                    "popup window content cannot contain inputs or overlays",
                ));
            }
            let popup = popup
                || matches!(
                    node.element,
                    Element::Overlay {
                        surface: OverlaySurface::Window,
                        ..
                    }
                );
            if node.parent != parent {
                return Err((
                    ErrorCode::InvalidState,
                    "tree parent and child ownership disagree",
                ));
            }
            pending.extend(
                node.children
                    .iter()
                    .map(|child| (*child, Some(id), depth + 1, overlays, popup)),
            );
        }
        if seen.len() != self.nodes.len() {
            return Err((ErrorCode::InvalidState, "batch leaves detached nodes"));
        }
        Ok(())
    }
}
