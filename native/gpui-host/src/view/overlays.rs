//! Overlay layers: GPUI deferred z-order, the modal focus scope and focus
//! return after dismissal. The model tree remains the only ownership graph;
//! these entries are derived on each commit and hold no native callbacks.

use super::{NativeView, split::tab_order};
use bun_native_protocol::{Element as NativeElement, NodeId, OverlayAnchor, Tree};
use gpui::{
    AnyElement, App, Context, Div, FocusHandle, Focusable, Pixels, Size, Stateful, Window,
    anchored, deferred, div, prelude::*, px,
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
    /// Counts modal layers that closed or were replaced. See [`Overlays::exposure`].
    exposure: u64,
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

    /// Changes whenever a modal layer stops being the active one, which
    /// re-exposes the content beneath it. The view folds it into every
    /// element id, so that content returns to the accessibility tree as new
    /// nodes. AccessKit 0.24's AT-SPI adapter marks a node it removes defunct
    /// and never clears that state when a node with the same id is added
    /// again; Orca then ignored every focus change beneath a closed dialog
    /// (measured with Orca 46.1 in `tests/native/screen-reader.ts`).
    pub(super) fn exposure(&self) -> u64 {
        self.exposure
    }
}

/// Overlays in pre-order with their layer, and whether each takes focus
/// when it opens without being modal.
fn layers(tree: &Tree) -> Vec<(NodeId, Layer, bool)> {
    let mut result = Vec::new();
    let mut pending = vec![(tree.root_id(), 0)];
    while let Some((id, outer)) = pending.pop() {
        let Some(node) = tree.node(id) else { continue };
        let depth = if let NativeElement::Overlay { autofocus, .. } = node.element() {
            result.push((
                id,
                Layer {
                    depth: outer + 1,
                    order: result.len(),
                },
                *autofocus,
            ));
            outer + 1
        } else {
            outer
        };
        pending.extend(node.children().iter().rev().map(|child| (*child, depth)));
    }
    result
}

impl NativeView {
    /// Native control focus, independent of whether the OS window is active.
    /// The control that holds window focus. Runs on every key and several
    /// times per batch, so it answers from the window's focus handle: O(1)
    /// with nothing focused or the same control focused as last time, and a
    /// scan of plain handle comparisons otherwise.
    pub(super) fn focused_control(&self, window: &Window, cx: &App) -> Option<NodeId> {
        let focused = window.focused(cx)?;
        if let Some(id) = self.focus_memo.get()
            && self.owns_focus(id, &focused, cx)
        {
            return Some(id);
        }
        let found = self
            .buttons
            .iter()
            .find_map(|(id, handle)| (*handle == focused).then_some(*id))
            .or_else(|| {
                self.inputs
                    .iter()
                    .find_map(|(id, input)| input.read(cx).owns_focus(&focused).then_some(*id))
            })
            .or_else(|| {
                self.splits
                    .focus_handles()
                    .find_map(|(id, handle)| (*handle == focused).then_some(id))
            });
        self.focus_memo.set(found);
        found
    }

    /// Whether `id` is a live control whose focus handle is `focused`.
    fn owns_focus(&self, id: NodeId, focused: &FocusHandle, cx: &App) -> bool {
        self.buttons.get(&id) == Some(focused)
            || self
                .inputs
                .get(&id)
                .is_some_and(|input| input.read(cx).owns_focus(focused))
            || self.splits.focus_handle(id) == Some(focused)
    }

    pub(super) fn can_focus(&self, tree: &Tree, id: NodeId) -> bool {
        match tree.node(id).map(|node| node.element()) {
            Some(NativeElement::Button {
                disabled: false, ..
            }) => self.buttons.contains_key(&id),
            Some(NativeElement::Input { .. }) => self.inputs.contains_key(&id),
            // The split's divider.
            Some(NativeElement::Split { .. }) => self.splits.contains(id),
            _ => false,
        }
    }

    /// Enabled controls in rendered tree order beneath `scope`.
    fn focusable(&self, tree: &Tree, scope: NodeId) -> Vec<NodeId> {
        tab_order(tree, scope, true, |id| self.can_focus(tree, id))
    }

    pub(super) fn focus_control(&self, id: NodeId, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(focus) = self.buttons.get(&id) {
            window.focus(focus, cx);
        } else if let Some(input) = self.inputs.get(&id) {
            window.focus(&input.focus_handle(cx), cx);
        } else if let Some(divider) = self.splits.focus_handle(id) {
            window.focus(divider, cx);
        }
    }

    /// Called after a commit has reconciled controls. `before` is the control
    /// focused before the commit. Opening an overlay records it; closing one
    /// returns focus there when the closed layer took focus with it. A modal
    /// layer then owns focus: its first control, or none so keys reach it.
    /// A newly opened `autofocus` layer allowed by the modal scope takes
    /// focus last, at its own first control.
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
            // Most windows have no overlay: skip both structural walks.
            let current = if self.index.overlays.is_empty() {
                Vec::new()
            } else {
                layers(tree)
            };
            let mut closed: Vec<(Layer, Option<NodeId>)> = Vec::new();
            let mut opened: Vec<(Layer, NodeId)> = Vec::new();
            self.overlays.live.retain(|id, entry| {
                let alive = current.iter().any(|(live, ..)| live == id);
                if !alive {
                    closed.push((entry.layer, entry.returns_to));
                }
                alive
            });
            for (id, layer, autofocus) in &current {
                self.overlays
                    .live
                    .entry(*id)
                    .and_modify(|entry| entry.layer = *layer)
                    .or_insert_with(|| {
                        if *autofocus {
                            opened.push((*layer, *id));
                        }
                        Entry {
                            layer: *layer,
                            returns_to: before,
                        }
                    });
            }
            let modal = if self.index.modals.is_empty() {
                None
            } else {
                tree.active_modal()
            };
            if self.overlays.active_modal.is_some() && self.overlays.active_modal != modal {
                self.overlays.exposure = self.overlays.exposure.wrapping_add(1);
            }
            self.overlays.active_modal = modal;
            let allowed = |id: NodeId| modal.is_none_or(|modal| tree.is_within(id, modal));
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
            let autofocus = opened
                .iter()
                .filter(|(_, id)| allowed(*id))
                .max_by_key(|(layer, _)| *layer)
                .and_then(|(_, id)| self.layer_controls(tree, *id).first().copied());
            match modal {
                _ if autofocus.is_some() => autofocus.map(Some),
                Some(modal) if !effective.is_some_and(|id| tree.is_within(id, modal)) => {
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
            Some(Some(id)) => self.move_focus(id, window, cx),
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
            if let Some(id) = self.run_stop_target(forward, window) {
                self.move_focus(id, window, cx);
            } else if let Some(id) = self.focused_control(window, cx) {
                self.reveal(id);
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
        self.move_focus(order[next], window, cx);
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
