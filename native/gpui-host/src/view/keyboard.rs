//! Host-initiated focus: batch focus requests, menu arrow navigation and
//! type-ahead inside `navigation: 'menu'` overlays, and scroll-into-view of
//! every control the host or assistive technology moves focus to. Pointer
//! focus never scrolls.
//!
//! A scroll viewport reveals the node on its route in one frame when that
//! node is its child, or a child that fits the viewport holds it: GPUI
//! scrolls to a child during the viewport's prepaint. A deeper node inside a
//! larger child, such as a row of a list that wraps the rows, is only placed
//! during its parent's prepaint, after the viewport's offset was applied, so
//! the parent's listener scrolls the viewport by the least amount that shows
//! it and the next frame paints it.

use super::{
    NativeView,
    culling::{ChildrenListener, Plan, Slot},
    split::tab_order,
};
use bun_native_protocol::{
    Element as NativeElement, NodeId, Overflow, OverlayNavigation, Tree, ViewRequest,
};
use gpui::{Bounds, Context, Keystroke, Pixels, Point, ScrollHandle, Size, Window, point, px};
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

/// A node a viewport must scroll to once its parent has placed it.
pub(super) struct Reveal {
    item: NodeId,
    viewport: NodeId,
}

/// The axes a viewport scrolls.
#[derive(Clone, Copy, Debug)]
struct Axes {
    x: bool,
    y: bool,
}

fn fits(item: Size<Pixels>, viewport: Size<Pixels>) -> bool {
    item.width <= viewport.width && item.height <= viewport.height
}

/// The offset that shows `item` in `viewport` (both in window coordinates,
/// `item` placed at the current `offset`) by the least scroll, GPUI's rule
/// for a child: an item larger than the viewport aligns its start.
fn revealed_offset(
    viewport: Bounds<Pixels>,
    offset: Point<Pixels>,
    max: Point<Pixels>,
    item: Bounds<Pixels>,
    axes: Axes,
) -> Point<Pixels> {
    let axis =
        |offset: Pixels, start: Pixels, end: Pixels, from: Pixels, to: Pixels, max: Pixels| {
            let shift = if to - from > end - start || from < start {
                start - from
            } else if to > end {
                end - to
            } else {
                px(0.)
            };
            (offset + shift).clamp(-max.max(px(0.)), px(0.))
        };
    point(
        if axes.x {
            axis(
                offset.x,
                viewport.left(),
                viewport.right(),
                item.left(),
                item.right(),
                max.x,
            )
        } else {
            offset.x
        },
        if axes.y {
            axis(
                offset.y,
                viewport.top(),
                viewport.bottom(),
                item.top(),
                item.bottom(),
                max.y,
            )
        } else {
            offset.y
        },
    )
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

    /// Reveal a control that assistive technology focused, from outside the
    /// view (an input's own element).
    pub(crate) fn reveal_control(&mut self, id: NodeId, cx: &mut Context<Self>) {
        self.reveal(id);
        cx.notify();
    }

    /// Scroll each scrolling ancestor inside the node's own layer so the
    /// node is visible in it. GPUI resolves the request during the next
    /// prepaint, after any layout change this commit.
    pub(super) fn reveal(&self, id: NodeId) {
        let state = self.state.borrow();
        let tree = &state.tree;
        let Some(path) = tree.path(id) else { return };
        for (depth, pair) in path.windows(2).enumerate().rev() {
            let [ancestor, child] = [pair[0], pair[1]];
            if let Some(handle) = self.scrolls.get(&ancestor)
                && let Some(index) = tree
                    .node(ancestor)
                    .and_then(|node| node.children().iter().position(|item| *item == child))
            {
                // What this viewport shows: the node, or the next viewport
                // on its route, which shows the node in turn.
                let item = path[depth + 1..]
                    .iter()
                    .copied()
                    .find(|node| *node == id || self.scrolls.contains_key(node))
                    .unwrap_or(id);
                let parent = tree.parent(item);
                let nested = item != child
                    && parent.is_some_and(|parent| {
                        !matches!(
                            tree.node(parent).map(|node| node.element()),
                            Some(NativeElement::Split { .. })
                        )
                    });
                // A larger child, such as a list wrapping the rows, would
                // only scroll to its own start.
                if !nested
                    || handle
                        .bounds_for_item(index)
                        .is_some_and(|bounds| fits(bounds.size, handle.bounds().size))
                {
                    handle.scroll_to_item(index);
                }
                if nested && let Some(parent) = parent {
                    self.nested_reveals
                        .borrow_mut()
                        .entry(parent)
                        .or_default()
                        .push(Reveal {
                            item,
                            viewport: ancestor,
                        });
                }
                self.held_scrolls.borrow_mut().insert(ancestor);
                self.revealing.borrow_mut().insert(ancestor);
            }
            // A layer is painted outside its parent's flow; stop at its edge.
            if is_overlay(tree, ancestor) {
                break;
            }
        }
    }

    /// The listener that scrolls viewports to the children of `parent` that
    /// a reveal could not place before their prepaint. `plan` maps a culling
    /// box's children to its rendered elements.
    pub(super) fn reveal_listener(
        &self,
        tree: &Tree,
        parent: NodeId,
        plan: Option<&Plan>,
        cx: &Context<Self>,
    ) -> Option<ChildrenListener> {
        let reveals = self.nested_reveals.borrow_mut().remove(&parent)?;
        let children = tree.node(parent)?.children();
        let targets: Vec<(usize, ScrollHandle, Axes)> = reveals
            .into_iter()
            .filter_map(|reveal| {
                let index = children.iter().position(|child| *child == reveal.item)?;
                let element = match plan {
                    Some(plan) => plan
                        .slots
                        .iter()
                        .position(|slot| matches!(slot, Slot::Child(child) if *child == index))?,
                    None => index,
                };
                let axes = match tree.node(reveal.viewport)?.element().style().overflow? {
                    Overflow::ScrollX => Axes { x: true, y: false },
                    Overflow::ScrollY => Axes { x: false, y: true },
                    Overflow::Scroll => Axes { x: true, y: true },
                    Overflow::Visible | Overflow::Hidden => return None,
                };
                Some((element, self.scrolls.get(&reveal.viewport)?.clone(), axes))
            })
            .collect();
        if targets.is_empty() {
            return None;
        }
        let view = cx.weak_entity();
        Some(Box::new(move |bounds, window| {
            let moves: Vec<(ScrollHandle, Point<Pixels>)> = targets
                .iter()
                .filter_map(|(index, handle, axes)| {
                    let item = bounds.get(*index)?;
                    let offset = handle.offset();
                    let revealed =
                        revealed_offset(handle.bounds(), offset, handle.max_offset(), *item, *axes);
                    (revealed != offset).then(|| (handle.clone(), revealed))
                })
                .collect();
            if moves.is_empty() {
                return;
            }
            // Culling boxes measure against this frame's offsets after this
            // listener, so the scroll waits for the next frame.
            let view = view.clone();
            window.on_next_frame(move |_, cx| {
                for (handle, offset) in &moves {
                    handle.set_offset(*offset);
                }
                let _ = view.update(cx, |_, cx| cx.notify());
            });
        }))
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

#[cfg(test)]
mod tests {
    use super::{Axes, revealed_offset};
    use gpui::{Bounds, point, px, size};

    const Y: Axes = Axes { x: false, y: true };

    /// A 300 px tall viewport at window y 40 over 3,840 px of content.
    fn reveal(offset: f32, top: f32, height: f32) -> f32 {
        let viewport = Bounds::new(point(px(0.), px(40.)), size(px(480.), px(300.)));
        let item = Bounds::new(point(px(10.), px(top)), size(px(60.), px(height)));
        let max = point(px(0.), px(3_540.));
        f32::from(revealed_offset(viewport, point(px(0.), px(offset)), max, item, Y).y)
    }

    #[test]
    fn scrolls_by_the_least_amount_that_shows_the_item() {
        // Visible: unchanged.
        assert_eq!(reveal(-100., 200., 24.), -100.);
        // Below the viewport: its bottom meets the viewport's bottom.
        assert_eq!(reveal(-100., 1_000., 24.), -100. - (1_024. - 340.));
        // Above: its top meets the viewport's top.
        assert_eq!(reveal(-500., 10., 24.), -470.);
        // Larger than the viewport: its top aligns, as GPUI does for a child.
        assert_eq!(reveal(0., 600., 400.), -560.);
    }

    #[test]
    fn stays_within_the_content() {
        assert_eq!(reveal(-3_500., 10_000., 24.), -3_540.);
        assert_eq!(reveal(-10., 45., 24.), -10.);
        assert_eq!(reveal(-10., 20., 24.), 0.);
    }

    #[test]
    fn leaves_axes_that_do_not_scroll() {
        let viewport = Bounds::new(point(px(0.), px(0.)), size(px(100.), px(100.)));
        let item = Bounds::new(point(px(500.), px(500.)), size(px(10.), px(10.)));
        let max = point(px(1_000.), px(1_000.));
        let offset = point(px(0.), px(0.));
        assert_eq!(
            revealed_offset(viewport, offset, max, item, Y),
            point(px(0.), px(-410.))
        );
        assert_eq!(
            revealed_offset(viewport, offset, max, item, Axes { x: true, y: false }),
            point(px(-410.), px(0.))
        );
    }
}
