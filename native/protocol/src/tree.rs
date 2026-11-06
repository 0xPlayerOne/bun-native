//! Atomic tree transactions independent of GPUI. Native UI mutation follows
//! successful preparation, so invalid input cannot partially alter a window.

use crate::{
    validate_text, Element, ErrorCode, NodeId, Operation, Style, MAX_DEPTH, MAX_ID,
    MAX_NODES_PER_WINDOW, MAX_OPERATIONS, MAX_TEXT_BYTES_PER_WINDOW,
};
use nodes::NodeMap;
use serde::Serialize;
use std::collections::HashSet;
use std::fmt;
use std::sync::Arc;
use std::time::Instant;

#[derive(Debug, Clone, PartialEq)]
pub struct Node {
    element: Arc<Element>,
    parent: Option<NodeId>,
    // Shared like `element`: a write copies its node, so a child list is
    // copied only when that batch actually reorders it.
    children: Arc<Vec<NodeId>>,
    input_revision: Option<u64>,
}

impl Node {
    pub fn element(&self) -> &Element {
        &self.element
    }
    pub fn children(&self) -> &[NodeId] {
        &self.children
    }
    pub fn input_revision(&self) -> Option<u64> {
        self.input_revision
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Tree {
    root_id: NodeId,
    revision: u64,
    text_bytes: usize,
    nodes: NodeMap,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ModelError {
    pub code: ErrorCode,
    pub message: &'static str,
}

impl fmt::Display for ModelError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.message)
    }
}
impl std::error::Error for ModelError {}

#[derive(Debug, Clone, Serialize)]
pub struct BatchMetrics {
    pub operation_count: usize,
    pub node_count: usize,
    pub text_bytes: usize,
    pub preflight_nanos: u64,
}

pub struct PreparedBatch {
    pub tree: Tree,
    pub last_node_id: u64,
    pub metrics: BatchMetrics,
}

fn error(code: ErrorCode, message: &'static str) -> ModelError {
    ModelError { code, message }
}
fn invalid_handle() -> ModelError {
    error(
        ErrorCode::InvalidHandle,
        "node is stale or is not owned by this window",
    )
}
fn next_revision(current: u64) -> Result<u64, ModelError> {
    if current >= MAX_ID {
        Err(error(ErrorCode::LimitExceeded, "revision exhausted"))
    } else {
        Ok(current + 1)
    }
}

fn text_budget(bytes: usize) -> Result<usize, ModelError> {
    if bytes > MAX_TEXT_BYTES_PER_WINDOW {
        Err(error(
            ErrorCode::LimitExceeded,
            "window text byte limit exceeded",
        ))
    } else {
        Ok(bytes)
    }
}

impl Tree {
    pub fn new(root_id: NodeId) -> Self {
        let mut nodes = NodeMap::default();
        nodes.insert(
            root_id,
            Node {
                element: Arc::new(Element::Box {
                    style: Style::default(),
                }),
                parent: None,
                children: Arc::default(),
                input_revision: None,
            },
        );
        Self {
            root_id,
            revision: 0,
            text_bytes: 0,
            nodes,
        }
    }

    pub fn root_id(&self) -> NodeId {
        self.root_id
    }
    pub fn revision(&self) -> u64 {
        self.revision
    }
    pub fn node(&self, id: NodeId) -> Option<&Node> {
        self.nodes.get(id)
    }
    pub fn nodes(&self) -> impl ExactSizeIterator<Item = (NodeId, &Node)> {
        self.nodes.iter()
    }

    /// Snapshot the committed root-to-target route before an event leaves the
    /// UI thread. A later move must not rewrite an already-emitted event path.
    pub fn path(&self, target: NodeId) -> Option<Vec<NodeId>> {
        // A committed tree is at most `MAX_DEPTH` edges deep, so its route
        // fits this stack buffer and costs one exact allocation per event.
        let mut route = [target; MAX_DEPTH + 1];
        let mut len = 0;
        let mut current = Some(target);
        while let Some(id) = current {
            let node = self.nodes.get(id)?;
            let Some(slot) = route.get_mut(len) else {
                return self.unbounded_path(target);
            };
            *slot = id;
            len += 1;
            current = node.parent;
        }
        Some(route[..len].iter().rev().copied().collect())
    }

    fn unbounded_path(&self, id: NodeId) -> Option<Vec<NodeId>> {
        let mut path = Vec::new();
        let mut current = Some(id);
        while let Some(id) = current {
            let node = self.nodes.get(id)?;
            path.push(id);
            current = node.parent;
        }
        path.reverse();
        Some(path)
    }

    /// `last_node_id` is the session-wide committed high-water mark. Neither
    /// this tree nor that counter changes when any operation is rejected.
    pub fn prepare(
        &self,
        base_revision: u64,
        operations: Vec<Operation>,
        mut last_node_id: u64,
    ) -> Result<PreparedBatch, ModelError> {
        let started = Instant::now();
        if base_revision != self.revision {
            return Err(error(
                ErrorCode::StaleRevision,
                "tree revision does not match",
            ));
        }
        if operations.is_empty() || operations.len() > MAX_OPERATIONS {
            return Err(error(
                ErrorCode::LimitExceeded,
                "batch must have between 1 and 256 operations",
            ));
        }
        if last_node_id > MAX_ID
            || self
                .nodes
                .last_id()
                .is_some_and(|id| id.get() > last_node_id)
        {
            return Err(error(
                ErrorCode::InvalidState,
                "session allocation state is inconsistent",
            ));
        }
        let operation_count = operations.len();
        // Node storage is persistent: this clone is a refcount, and each write
        // below copies only its own path, so the committed tree stays intact
        // and keeps sharing every untouched node and element `Arc`.
        let mut next = self.clone();
        // Created and moved nodes: the only places a batch can break the
        // committed, already validated ownership graph.
        let mut attached = Vec::new();
        for operation in operations {
            match operation {
                Operation::Create { node_id, element } => {
                    element
                        .validate()
                        .map_err(|message| error(ErrorCode::InvalidCommand, message))?;
                    if node_id.get() <= last_node_id {
                        return Err(error(
                            ErrorCode::InvalidHandle,
                            "node IDs must increase across the session and cannot be reused",
                        ));
                    }
                    if next.nodes.len() >= MAX_NODES_PER_WINDOW {
                        return Err(error(
                            ErrorCode::LimitExceeded,
                            "window node limit exceeded",
                        ));
                    }
                    let input_revision = matches!(element, Element::Input { .. }).then_some(0);
                    next.text_bytes = text_budget(next.text_bytes + element.text_bytes())?;
                    next.nodes.insert(
                        node_id,
                        Node {
                            element: Arc::new(element),
                            parent: None,
                            children: Arc::default(),
                            input_revision,
                        },
                    );
                    last_node_id = node_id.get();
                    attached.push(node_id);
                }
                Operation::Set {
                    node_id,
                    element,
                    expected_input_revision,
                } => {
                    element
                        .validate()
                        .map_err(|message| error(ErrorCode::InvalidCommand, message))?;
                    let node = next.nodes.get_mut(node_id).ok_or_else(invalid_handle)?;
                    if !node.element.same_kind(&element) {
                        return Err(error(
                            ErrorCode::InvalidState,
                            "set cannot change an element kind",
                        ));
                    }
                    match (node.input_revision, expected_input_revision) {
                        (Some(current), Some(expected)) if current == expected => {
                            node.input_revision = Some(next_revision(current)?);
                        }
                        (Some(_), Some(_)) => {
                            return Err(error(
                                ErrorCode::StaleRevision,
                                "input revision does not match",
                            ))
                        }
                        (Some(_), None) => {
                            return Err(error(
                                ErrorCode::InvalidCommand,
                                "input set requires expected_input_revision",
                            ))
                        }
                        (None, Some(_)) => {
                            return Err(error(
                                ErrorCode::InvalidCommand,
                                "expected_input_revision is only valid for input",
                            ))
                        }
                        (None, None) => {}
                    }
                    next.text_bytes = text_budget(
                        next.text_bytes - node.element.text_bytes() + element.text_bytes(),
                    )?;
                    node.element = Arc::new(element);
                }
                Operation::Insert {
                    parent_id,
                    child_id,
                    index,
                } => {
                    next.insert(parent_id, child_id, index)?;
                    attached.push(child_id);
                }
                Operation::Delete { node_id } => next.delete(node_id)?,
            }
        }
        let verdict = next.validate_attached(&attached);
        debug_assert_eq!(verdict, next.validate_graph());
        verdict?;
        next.revision = next_revision(self.revision)?;
        let metrics = BatchMetrics {
            operation_count,
            node_count: next.nodes.len(),
            text_bytes: next.text_bytes,
            preflight_nanos: u64::try_from(started.elapsed().as_nanos())
                .map_or(MAX_ID, |nanos| nanos.min(MAX_ID)),
        };
        Ok(PreparedBatch {
            tree: next,
            last_node_id,
            metrics,
        })
    }

    /// Native editing advances only this input's revision, so typing cannot
    /// invalidate an unrelated text/style transaction. Equal content is not an
    /// edit; composition selection updates may still repaint without an event.
    pub fn replace_input(
        &mut self,
        node_id: NodeId,
        value: String,
    ) -> Result<Option<u64>, ModelError> {
        validate_text(&value).map_err(|message| error(ErrorCode::InvalidCommand, message))?;
        let node = self.nodes.get_mut(node_id).ok_or_else(invalid_handle)?;
        let Element::Input { value: old, .. } = node.element.as_ref() else {
            return Err(error(ErrorCode::InvalidState, "node is not an input"));
        };
        if *old == value {
            return Ok(None);
        }
        let revision = next_revision(node.input_revision.ok_or_else(invalid_handle)?)?;
        let text_bytes = text_budget(self.text_bytes - old.len() + value.len())?;
        if let Element::Input { value: old, .. } = Arc::make_mut(&mut node.element) {
            *old = value;
        }
        node.input_revision = Some(revision);
        self.text_bytes = text_bytes;
        Ok(Some(revision))
    }

    fn insert(
        &mut self,
        parent_id: NodeId,
        child_id: NodeId,
        index: usize,
    ) -> Result<(), ModelError> {
        let parent = self.nodes.get(parent_id).ok_or_else(invalid_handle)?;
        if !matches!(parent.element.as_ref(), Element::Box { .. }) {
            return Err(error(
                ErrorCode::InvalidState,
                "only box elements can own children",
            ));
        }
        if child_id == self.root_id {
            return Err(error(
                ErrorCode::InvalidState,
                "the window root cannot be reparented",
            ));
        }
        let old_parent = self.nodes.get(child_id).ok_or_else(invalid_handle)?.parent;
        let mut ancestor = Some(parent_id);
        while let Some(id) = ancestor {
            if id == child_id {
                return Err(error(
                    ErrorCode::InvalidState,
                    "insert would create a cycle",
                ));
            }
            ancestor = self.nodes.get(id).ok_or_else(invalid_handle)?.parent;
        }
        if let Some(old_parent) = old_parent {
            let siblings = &mut self
                .nodes
                .get_mut(old_parent)
                .ok_or_else(invalid_handle)?
                .children;
            Arc::make_mut(siblings).retain(|id| *id != child_id);
        }
        let children = Arc::make_mut(
            &mut self
                .nodes
                .get_mut(parent_id)
                .ok_or_else(invalid_handle)?
                .children,
        );
        if index > children.len() {
            return Err(error(
                ErrorCode::InvalidCommand,
                "insert index exceeds child count after detaching",
            ));
        }
        children.insert(index, child_id);
        self.nodes
            .get_mut(child_id)
            .ok_or_else(invalid_handle)?
            .parent = Some(parent_id);
        Ok(())
    }

    fn delete(&mut self, node_id: NodeId) -> Result<(), ModelError> {
        if node_id == self.root_id {
            return Err(error(
                ErrorCode::InvalidState,
                "close the window to delete its root",
            ));
        }
        let parent = self.nodes.get(node_id).ok_or_else(invalid_handle)?.parent;
        if let Some(parent) = parent {
            let siblings = &mut self
                .nodes
                .get_mut(parent)
                .ok_or_else(invalid_handle)?
                .children;
            Arc::make_mut(siblings).retain(|id| *id != node_id);
        }
        let mut pending = vec![node_id];
        while let Some(id) = pending.pop() {
            let node = self.nodes.remove(id).ok_or_else(invalid_handle)?;
            self.text_bytes -= node.element.text_bytes();
            pending.extend(node.children.iter().copied());
        }
        Ok(())
    }

    /// Committed trees are validated graphs, and create, insert and delete keep
    /// parent and child links consistent and reject cycles. A batch can then
    /// break only depth or attachment, and only at or below a node it created
    /// or moved, so checking those subtrees reaches `validate_graph`'s verdict
    /// (depth before detachment, as its walk from the root reports them)
    /// without walking the untouched window.
    fn validate_attached(&self, attached: &[NodeId]) -> Result<(), ModelError> {
        let too_deep = || error(ErrorCode::LimitExceeded, "tree depth exceeds 64 edges");
        let mut detached = false;
        let mut seen = HashSet::new();
        let mut pending = Vec::new();
        for &id in attached {
            if seen.contains(&id) || self.nodes.get(id).is_none() {
                continue;
            }
            let mut depth = 0;
            let mut top = id;
            while let Some(parent) = self.nodes.get(top).ok_or_else(invalid_handle)?.parent {
                depth += 1;
                top = parent;
                if depth > self.nodes.len() {
                    return Err(error(
                        ErrorCode::InvalidState,
                        "tree contains duplicate ownership or a cycle",
                    ));
                }
            }
            if top != self.root_id {
                detached = true;
                continue;
            }
            pending.push((id, depth));
            while let Some((id, depth)) = pending.pop() {
                if depth > MAX_DEPTH {
                    return Err(too_deep());
                }
                if seen.insert(id) {
                    let node = self.nodes.get(id).ok_or_else(invalid_handle)?;
                    pending.extend(node.children.iter().map(|child| (*child, depth + 1)));
                }
            }
        }
        if detached {
            return Err(error(
                ErrorCode::InvalidState,
                "batch leaves detached nodes",
            ));
        }
        Ok(())
    }

    fn validate_graph(&self) -> Result<(), ModelError> {
        // One sized allocation; the ordered set rebalanced per node and
        // dominated small-update preflight on large trees.
        let mut seen = HashSet::with_capacity(self.nodes.len());
        let mut pending = vec![(self.root_id, None, 0)];
        while let Some((id, parent, depth)) = pending.pop() {
            if depth > MAX_DEPTH {
                return Err(error(
                    ErrorCode::LimitExceeded,
                    "tree depth exceeds 64 edges",
                ));
            }
            if !seen.insert(id) {
                return Err(error(
                    ErrorCode::InvalidState,
                    "tree contains duplicate ownership or a cycle",
                ));
            }
            let node = self.nodes.get(id).ok_or_else(invalid_handle)?;
            if node.parent != parent {
                return Err(error(
                    ErrorCode::InvalidState,
                    "tree parent and child ownership disagree",
                ));
            }
            pending.extend(
                node.children
                    .iter()
                    .map(|child| (*child, Some(id), depth + 1)),
            );
        }
        if seen.len() != self.nodes.len() {
            return Err(error(
                ErrorCode::InvalidState,
                "batch leaves detached nodes",
            ));
        }
        Ok(())
    }
}

mod nodes;

#[cfg(test)]
mod tests;
