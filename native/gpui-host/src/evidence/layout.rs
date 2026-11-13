//! Bounded opt-in geometry captured from GPUI's actual prepaint/paint pass.
//! This adds no elements or layout nodes to the native tree.

use crate::input::{InputViewportSnapshot, TextInput};
use bun_native_protocol::NodeId;
use gpui::{App, Bounds, Div, FocusHandle, Pixels, ScrollHandle, WeakEntity, Window};
use serde_json::{Value, json};
use std::{cell::RefCell, collections::BTreeMap, rc::Rc};

const MAX_LAYOUT_NODES: usize = 128;

#[derive(Clone, PartialEq)]
struct NodeLayout {
    bounds: [f32; 4],
    ancestor_clip: [f32; 4],
}

#[derive(Clone, PartialEq)]
struct ScrollLayout {
    node_id: NodeId,
    offset: [f32; 2],
    maximum: [f32; 2],
    viewport: [f32; 4],
}

#[derive(Clone, PartialEq)]
pub(crate) struct LayoutSnapshot {
    viewport: [f32; 2],
    scale_factor: f32,
    node_count: usize,
    focused: Option<NodeId>,
    nodes: BTreeMap<NodeId, NodeLayout>,
    scrolls: Vec<ScrollLayout>,
    inputs: Option<BTreeMap<NodeId, InputViewportSnapshot>>,
}

#[derive(Clone)]
pub(crate) struct LayoutFrame {
    node_count: usize,
    nodes: Rc<RefCell<BTreeMap<NodeId, NodeLayout>>>,
    scrolls: BTreeMap<NodeId, ScrollHandle>,
    focus: Vec<(NodeId, FocusHandle)>,
    inputs: Option<Vec<(NodeId, WeakEntity<TextInput>)>>,
}

fn rectangle(bounds: Bounds<Pixels>) -> [f32; 4] {
    [
        bounds.origin.x.into(),
        bounds.origin.y.into(),
        bounds.size.width.into(),
        bounds.size.height.into(),
    ]
}

impl LayoutFrame {
    pub(crate) fn new(
        node_count: usize,
        scrolls: &BTreeMap<NodeId, ScrollHandle>,
        focus: impl Iterator<Item = (NodeId, FocusHandle)>,
    ) -> Self {
        let capture = node_count <= MAX_LAYOUT_NODES;
        Self {
            node_count,
            nodes: Rc::default(),
            scrolls: if capture {
                scrolls.clone()
            } else {
                BTreeMap::new()
            },
            focus: if capture { focus.collect() } else { Vec::new() },
            inputs: None,
        }
    }

    pub(crate) fn with_inputs(
        mut self,
        inputs: impl Iterator<Item = (NodeId, WeakEntity<TextInput>)>,
    ) -> Self {
        if self.node_count <= MAX_LAYOUT_NODES {
            self.inputs = Some(inputs.collect());
        }
        self
    }

    /// Whether this frame records layout: every node must then be rendered.
    pub(crate) fn captures(&self) -> bool {
        self.node_count <= MAX_LAYOUT_NODES
    }

    pub(crate) fn children(
        &self,
        element: Div,
        children: &[NodeId],
        child_offset: usize,
        scroll: Option<&ScrollHandle>,
    ) -> Div {
        if self.node_count > MAX_LAYOUT_NODES || children.is_empty() {
            return element;
        }
        let children = children.to_vec();
        let scroll = scroll.cloned();
        let nodes = self.nodes.clone();
        element.on_children_prepainted(move |bounds, window, _| {
            let ancestor_clip = rectangle(window.content_mask().bounds);
            let mut nodes = nodes.borrow_mut();
            for (index, child) in children.iter().enumerate() {
                // Optional diagnostic canvases are not model children.
                let index = child_offset + index;
                // A tracked Div stores bounds on its handle instead of in the
                // callback vector. Bounds include ancestor offsets, but GPUI
                // applies this container's own scroll translation afterward.
                let bounds = if let Some(scroll) = &scroll {
                    scroll.bounds_for_item(index).map(|mut bounds| {
                        bounds.origin += scroll.offset();
                        bounds
                    })
                } else {
                    bounds.get(index).copied()
                };
                if let Some(bounds) = bounds {
                    nodes.insert(
                        *child,
                        NodeLayout {
                            bounds: rectangle(bounds),
                            ancestor_clip,
                        },
                    );
                }
            }
        })
    }

    pub(crate) fn snapshot(&self, window: &Window, cx: &App) -> LayoutSnapshot {
        let viewport = window.viewport_size();
        LayoutSnapshot {
            viewport: [viewport.width.into(), viewport.height.into()],
            scale_factor: window.scale_factor(),
            node_count: self.node_count,
            focused: self
                .focus
                .iter()
                .find_map(|(id, focus)| focus.is_focused(window).then_some(*id)),
            nodes: self.nodes.borrow().clone(),
            scrolls: self
                .scrolls
                .iter()
                .map(|(id, handle)| {
                    let offset = handle.offset();
                    let maximum = handle.max_offset();
                    ScrollLayout {
                        node_id: *id,
                        offset: [offset.x.into(), offset.y.into()],
                        maximum: [maximum.x.into(), maximum.y.into()],
                        viewport: rectangle(handle.bounds()),
                    }
                })
                .collect(),
            inputs: self.inputs.as_ref().map(|inputs| {
                inputs
                    .iter()
                    .filter_map(|(id, input)| {
                        Some((*id, input.upgrade()?.read(cx).painted_viewport()?))
                    })
                    .collect()
            }),
        }
    }
}

impl LayoutSnapshot {
    pub(super) fn json(&self) -> Value {
        let mut value = json!({"viewport":self.viewport,"scale_factor":self.scale_factor,"node_count":self.node_count});
        if self.node_count > MAX_LAYOUT_NODES {
            value["status"] = json!("omitted");
            value["reason"] = json!("layout_node_limit");
            value["max_nodes"] = json!(MAX_LAYOUT_NODES);
            return value;
        }
        value["status"] = json!("complete");
        value["focused_node_id"] = json!(self.focused);
        value["nodes"] = self.nodes.iter().map(|(id, layout)| json!({"node_id":id,"bounds":layout.bounds,"ancestor_clip":layout.ancestor_clip})).collect();
        value["scrolls"] = self.scrolls.iter().map(|scroll| json!({"node_id":scroll.node_id,"offset":scroll.offset,"maximum":scroll.maximum,"viewport":scroll.viewport})).collect();
        if let Some(inputs) = &self.inputs {
            value["inputs"] = inputs
                .iter()
                .map(|(id, input)| {
                    json!({
                        "node_id": id,
                        "viewport": rectangle(input.viewport),
                        "offset": f32::from(input.offset),
                        "line_width": f32::from(input.line_width),
                        "clip": rectangle(input.decorations.clip),
                        "caret": input.decorations.caret.map(rectangle),
                        "selection": input.decorations.selection.map(rectangle),
                        "selected_bytes": input.decorations.selected_bytes,
                        "cursor_byte": input.decorations.cursor_byte,
                    })
                })
                .collect();
        }
        value
    }
}

#[cfg(test)]
mod paint_tests;
