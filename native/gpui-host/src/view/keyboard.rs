//! Host-initiated focus: batch focus requests, menu arrow navigation and
//! type-ahead inside `navigation: 'menu'` overlays, and scroll-into-view of
//! every control the host moves focus to. Pointer focus never scrolls.

use super::{NativeView, split::tab_order};
use bun_native_protocol::{Element as NativeElement, NodeId, OverlayNavigation, Tree, ViewRequest};
use gpui::{Context, Keystroke, Window, px};
use std::time::{Duration, Instant};

/// Keys typed within this interval extend one type-ahead search.
const TYPE_AHEAD_TIMEOUT: Duration = Duration::from_millis(1_000);

#[derive(Default)]
pub(super) struct TypeAhead {
    text: String,
    last: Option<Instant>,
}

#[derive(Clone, Copy)]
pub(super) enum MenuMove {
    Next,
    Previous,
    First,
    Last,
}

fn is_overlay(tree: &Tree, id: NodeId) -> bool {
    matches!(
        tree.node(id).map(|node| node.element()),
        Some(NativeElement::Overlay { .. })
    )
}

/// The innermost overlay on the node's route, when it navigates as a menu.
fn menu_scope(tree: &Tree, id: NodeId) -> Option<NodeId> {
    let path = tree.path(id)?;
    let layer = *path
        .iter()
        .rev()
        .find(|ancestor| is_overlay(tree, **ancestor))?;
    matches!(
        tree.node(layer)?.element(),
        NativeElement::Overlay {
            navigation: OverlayNavigation::Menu,
            ..
        }
    )
    .then_some(layer)
}

/// One printable, non-space character without command modifiers.
fn typed(key: &Keystroke) -> Option<char> {
    let modifiers = key.modifiers;
    if modifiers.control || modifiers.alt || modifiers.platform || modifiers.function {
        return None;
    }
    let mut chars = key.key_char.as_deref()?.chars();
    let first = chars.next()?;
    (chars.next().is_none() && !first.is_whitespace() && !first.is_control()).then_some(first)
}

impl NativeView {
    /// Enabled controls of one layer in tree order, excluding nested layers.
    pub(super) fn layer_controls(&self, tree: &Tree, layer: NodeId) -> Vec<NodeId> {
        tab_order(tree, layer, false, |id| self.can_focus(tree, id))
    }

    /// Focus a control for keyboard or programmatic reasons and reveal it.
    pub(super) fn move_focus(&self, id: NodeId, window: &mut Window, cx: &mut Context<Self>) {
        self.focus_control(id, window, cx);
        self.reveal(id);
    }

    /// Scroll each scrolling ancestor inside the node's own layer so the
    /// ancestor's child on the node's route is visible. GPUI resolves the
    /// request during the next prepaint, after any layout change this commit.
    pub(super) fn reveal(&self, id: NodeId) {
        let state = self.state.borrow();
        let tree = &state.tree;
        let Some(path) = tree.path(id) else { return };
        for pair in path.windows(2).rev() {
            let [ancestor, child] = [pair[0], pair[1]];
            if let Some(handle) = self.scrolls.get(&ancestor)
                && let Some(index) = tree
                    .node(ancestor)
                    .and_then(|node| node.children().iter().position(|item| *item == child))
            {
                handle.scroll_to_item(index);
                self.held_scrolls.borrow_mut().insert(ancestor);
            }
            // A layer is painted outside its parent's flow; stop at its edge.
            if is_overlay(tree, ancestor) {
                break;
            }
        }
    }

    /// Focus and scroll requests from a committed batch, in order. The model
    /// already validated each target against the committed tree.
    pub(super) fn apply_requests(
        &self,
        requests: &[ViewRequest],
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        for request in requests {
            match *request {
                ViewRequest::Focus(id) => self.move_focus(id, window, cx),
                ViewRequest::ScrollTo { node_id, x, y } => {
                    if let Some(handle) = self.scrolls.get(&node_id) {
                        // GPUI offsets grow negative toward the content end and
                        // are clamped to the laid-out maximum during prepaint.
                        let mut offset = handle.offset();
                        if let Some(x) = x {
                            offset.x = px(-(x as f32));
                        }
                        if let Some(y) = y {
                            offset.y = px(-(y as f32));
                        }
                        handle.set_offset(offset);
                        self.held_scrolls.borrow_mut().insert(node_id);
                    }
                }
                ViewRequest::ScrollIntoView(id) => self.reveal(id),
            }
        }
    }

    /// Arrow, Home and End keys inside a menu layer. Returns false when focus
    /// is not in a menu, so the key continues to other handlers.
    pub(super) fn menu_move(
        &mut self,
        step: MenuMove,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> bool {
        let Some(focused) = self.focused_control(window, cx) else {
            return false;
        };
        let target = {
            let state = self.state.borrow();
            let Some(scope) = menu_scope(&state.tree, focused) else {
                return false;
            };
            let items = self.layer_controls(&state.tree, scope);
            let Some(index) = items.iter().position(|item| *item == focused) else {
                return false;
            };
            let count = items.len();
            items[match step {
                MenuMove::Next => (index + 1) % count,
                MenuMove::Previous => (index + count - 1) % count,
                MenuMove::First => 0,
                MenuMove::Last => count - 1,
            }]
        };
        self.move_focus(target, window, cx);
        true
    }

    /// Printable keys while a menu button is focused move focus to the next
    /// button whose label starts with the typed text (case-insensitive).
    /// Repeating one character cycles through the labels it starts.
    pub(super) fn type_ahead(
        &mut self,
        key: &Keystroke,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(typed) = typed(key) else { return };
        let Some(focused) = self.focused_control(window, cx) else {
            return;
        };
        // An input keeps typed text for editing.
        if !self.buttons.contains_key(&focused) {
            return;
        }
        let now = Instant::now();
        let target = {
            let state = self.state.borrow();
            let tree = &state.tree;
            let Some(scope) = menu_scope(tree, focused) else {
                return;
            };
            if self
                .type_ahead
                .last
                .is_none_or(|last| now.duration_since(last) > TYPE_AHEAD_TIMEOUT)
            {
                self.type_ahead.text.clear();
            }
            self.type_ahead.last = Some(now);
            self.type_ahead.text.extend(typed.to_lowercase());
            let text = &self.type_ahead.text;
            let first = text.chars().next().expect("type-ahead text is not empty");
            let repeated = text.chars().all(|item| item == first);
            let needle = if repeated {
                first.to_string()
            } else {
                text.clone()
            };
            let items: Vec<(NodeId, String)> = self
                .layer_controls(tree, scope)
                .into_iter()
                .filter_map(|id| match tree.node(id)?.element() {
                    NativeElement::Button { text, .. } => {
                        Some((id, text.trim_start().to_lowercase()))
                    }
                    _ => None,
                })
                .collect();
            let count = items.len();
            let start = items.iter().position(|(id, _)| *id == focused).unwrap_or(0);
            // A new character keeps the current item if it still matches.
            let skip = usize::from(repeated);
            (0..count)
                .map(|step| &items[(start + skip + step) % count])
                .find(|(_, label)| label.starts_with(&needle))
                .map(|(id, _)| *id)
        };
        if let Some(target) = target
            && target != focused
        {
            self.move_focus(target, window, cx);
        }
    }
}
