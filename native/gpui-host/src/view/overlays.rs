//! Overlay layers: GPUI deferred z-order, the modal focus scope and focus
//! return after dismissal. The model tree remains the only ownership graph;
//! these entries are derived on each commit and hold no native callbacks.

use super::NativeView;
use bun_native_protocol::{Element as NativeElement, NodeId, OverlayAnchor, Tree};
use gpui::{
    AnyElement, App, Context, Div, Focusable, Pixels, Size, Stateful, Window, anchored, deferred,
    div, prelude::*, px,
};
use std::collections::BTreeMap;

/// GPUI paints deferred layers by ascending priority after the ordinary tree.
/// Nested overlays are deferred again in a later prepaint round, so hit
/// testing also ranks them by (nesting depth, tree order). Paint uses depth.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
struct Layer {
    depth: usize,
    order: usize,
}

struct Entry {
    layer: Layer,
    /// The control focused when this overlay first committed.
    returns_to: Option<NodeId>,
}

#[derive(Default)]
pub(super) struct Overlays {
    live: BTreeMap<NodeId, Entry>,
    /// The topmost modal layer, if any. Tab order and key routing stay inside it.
    active_modal: Option<NodeId>,
}

/// Keep the native diagnostics observer after every overlay's mouse listeners.
pub(super) const OBSERVER_PRIORITY: usize = usize::MAX;

impl Overlays {
    pub(super) fn any(&self) -> bool {
        !self.live.is_empty()
    }

    pub(super) fn active_modal(&self) -> Option<NodeId> {
        self.active_modal
    }
}

/// Overlays in pre-order with their layer, and whether each is modal.
fn layers(tree: &Tree) -> Vec<(NodeId, Layer, bool)> {
    let mut result = Vec::new();
    let mut pending = vec![(tree.root_id(), 0)];
    while let Some((id, outer)) = pending.pop() {
        let Some(node) = tree.node(id) else { continue };
        let depth = if let NativeElement::Overlay { modal, .. } = node.element() {
            result.push((
                id,
                Layer {
                    depth: outer + 1,
                    order: result.len(),
                },
                *modal,
            ));
            outer + 1
        } else {
            outer
        };
        pending.extend(node.children().iter().rev().map(|child| (*child, depth)));
    }
    result
}

fn within(tree: &Tree, node: NodeId, ancestor: NodeId) -> bool {
    tree.path(node).is_some_and(|path| path.contains(&ancestor))
}

impl NativeView {
    /// Native control focus, independent of whether the OS window is active.
    pub(super) fn focused_control(&self, window: &Window, cx: &App) -> Option<NodeId> {
        self.buttons
            .iter()
            .find_map(|(id, focus)| focus.is_focused(window).then_some(*id))
            .or_else(|| {
                self.inputs.iter().find_map(|(id, input)| {
                    input.focus_handle(cx).is_focused(window).then_some(*id)
                })
            })
    }

    fn can_focus(&self, tree: &Tree, id: NodeId) -> bool {
        match tree.node(id).map(|node| node.element()) {
            Some(NativeElement::Button {
                disabled: false, ..
            }) => self.buttons.contains_key(&id),
            Some(NativeElement::Input { .. }) => self.inputs.contains_key(&id),
            _ => false,
        }
    }

    /// Enabled controls in rendered tree order beneath `scope`.
    fn focusable(&self, tree: &Tree, scope: NodeId) -> Vec<NodeId> {
        let mut result = Vec::new();
        let mut pending = vec![scope];
        while let Some(id) = pending.pop() {
            let Some(node) = tree.node(id) else { continue };
            if self.can_focus(tree, id) {
                result.push(id);
            }
            pending.extend(node.children().iter().rev().copied());
        }
        result
    }

    fn focus_control(&self, id: NodeId, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(focus) = self.buttons.get(&id) {
            window.focus(focus, cx);
        } else if let Some(input) = self.inputs.get(&id) {
            window.focus(&input.focus_handle(cx), cx);
        }
    }

    /// Called after a commit has reconciled controls. `before` is the control
    /// focused before the commit. Opening an overlay records it; closing one
    /// returns focus there when the closed layer took focus with it. A modal
    /// layer then owns focus: its first control, or none so keys reach it.
    pub(super) fn reconcile_overlays(
        &mut self,
        before: Option<NodeId>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let focused = self.focused_control(window, cx);
        // Decide under the model borrow; move focus only after releasing it.
        let target = {
            let state = self.state.borrow();
            let tree = &state.tree;
            let current = layers(tree);
            let mut closed: Vec<(Layer, Option<NodeId>)> = Vec::new();
            self.overlays.live.retain(|id, entry| {
                let alive = current.iter().any(|(live, ..)| live == id);
                if !alive {
                    closed.push((entry.layer, entry.returns_to));
                }
                alive
            });
            for (id, layer, _) in &current {
                self.overlays
                    .live
                    .entry(*id)
                    .and_modify(|entry| entry.layer = *layer)
                    .or_insert(Entry {
                        layer: *layer,
                        returns_to: before,
                    });
            }
            let modal = current
                .iter()
                .filter(|(_, _, modal)| *modal)
                .max_by_key(|(_, layer, _)| *layer)
                .map(|(id, ..)| *id);
            self.overlays.active_modal = modal;
            let allowed = |id: NodeId| modal.is_none_or(|modal| within(tree, id, modal));
            // Outermost closed layer first: closing nested layers together
            // returns to the control focused before the outermost one opened.
            closed.sort_by_key(|(layer, _)| *layer);
            let restore = focused.is_none().then(|| {
                closed
                    .iter()
                    .filter_map(|(_, target)| *target)
                    .find(|id| allowed(*id) && self.can_focus(tree, *id))
            });
            let effective = restore.flatten().or(focused);
            match modal {
                Some(modal) if !effective.is_some_and(|id| within(tree, id, modal)) => {
                    match self.focusable(tree, modal).first() {
                        Some(first) => Some(Some(*first)),
                        None if focused.is_some() => Some(None),
                        None => None,
                    }
                }
                _ => restore.flatten().map(Some),
            }
        };
        match target {
            Some(Some(id)) => self.focus_control(id, window, cx),
            Some(None) => window.blur(cx),
            None => {}
        }
    }

    /// Tab and Shift-Tab. A modal layer cycles only through its own controls.
    pub(super) fn focus_step(
        &mut self,
        forward: bool,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(modal) = self.overlays.active_modal else {
            if forward {
                window.focus_next(cx);
            } else {
                window.focus_prev(cx);
            }
            return;
        };
        let order = {
            let state = self.state.borrow();
            self.focusable(&state.tree, modal)
        };
        if order.is_empty() {
            return;
        }
        let count = order.len();
        let next = match self
            .focused_control(window, cx)
            .and_then(|id| order.iter().position(|candidate| *candidate == id))
        {
            Some(index) if forward => (index + 1) % count,
            Some(index) => (index + count - 1) % count,
            None if forward => 0,
            None => count - 1,
        };
        self.focus_control(order[next], window, cx);
    }

    /// Place an overlay's rendered container in its deferred layer. The
    /// in-flow placeholder is absolutely positioned, so it takes no space.
    pub(super) fn overlay_layer(
        &self,
        node_id: NodeId,
        anchor: OverlayAnchor,
        content: Stateful<Div>,
        viewport: Size<Pixels>,
    ) -> AnyElement {
        let priority = self
            .overlays
            .live
            .get(&node_id)
            .map_or(1, |entry| entry.layer.depth);
        match anchor {
            OverlayAnchor::Window => div()
                .absolute()
                .top_0()
                .left_0()
                .child(
                    deferred(
                        anchored()
                            .position(gpui::point(px(0.), px(0.)))
                            .child(content.w(viewport.width).h(viewport.height)),
                    )
                    .with_priority(priority),
                )
                .into_any_element(),
            OverlayAnchor::Parent => div()
                .absolute()
                .top_full()
                .left_0()
                .child(
                    deferred(anchored().snap_to_window_with_margin(px(8.)).child(content))
                        .with_priority(priority),
                )
                .into_any_element(),
        }
    }
}
