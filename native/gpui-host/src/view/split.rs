//! Split panes: a host-owned ratio per split node and its draggable divider.
//!
//! The application declares a ratio; the host adopts each newly declared
//! value and otherwise keeps the user's latest drag, like a scroll offset.

use super::{DropScope, NativeView, interactions::PointerFrame};
use crate::evidence::LayoutFrame;
use bun_native_protocol::{
    Direction, Element as NativeElement, NodeId, SPLIT_DIVIDER, Style, Tree,
};
use gpui::{
    AnyElement, Context, Div, DragMoveEvent, ElementId, Empty, Pixels, Stateful, Window, div,
    prelude::*, px, rgb,
};
use std::collections::BTreeMap;

const DIVIDER_COLOR: u32 = 0xc8ced8;
const DIVIDER_ACTIVE_COLOR: u32 = 0x8792a2;

#[derive(Clone, Copy, PartialEq)]
struct SplitState {
    declared: f64,
    ratio: f64,
}

#[derive(Default)]
pub(super) struct Splits(BTreeMap<NodeId, SplitState>);

impl Splits {
    /// Keeps the dragged ratio while the declared ratio is unchanged and
    /// releases state for removed splits.
    pub(super) fn reconcile(&mut self, tree: &Tree) {
        let mut next = BTreeMap::new();
        for (id, node) in tree.nodes() {
            if let NativeElement::Split { ratio, .. } = node.element() {
                let state = self
                    .0
                    .remove(&id)
                    .filter(|state| state.declared == *ratio)
                    .unwrap_or(SplitState {
                        declared: *ratio,
                        ratio: *ratio,
                    });
                next.insert(id, state);
            }
        }
        self.0 = next;
    }

    fn ratio(&self, id: NodeId) -> f64 {
        self.0
            .get(&id)
            .expect("split reconciled before render")
            .ratio
    }
}

/// The drag payload identifies which split's divider is moving.
struct SplitDrag(NodeId);

/// GPUI draws a drag preview entity; a divider drag has none.
struct NoPreview;

impl Render for NoPreview {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        Empty
    }
}

/// The leading pane's share of the space after the divider, from a pointer
/// position along the main axis, honoring each pane's minimum size.
fn ratio_at(position: f64, start: f64, length: f64, min_size: f64) -> f64 {
    let available = length - SPLIT_DIVIDER;
    if available <= 0. {
        return 0.5;
    }
    let ratio = ((position - start - SPLIT_DIVIDER / 2.) / available).clamp(0., 1.);
    let minimum = min_size / available;
    if minimum <= 0.5 {
        ratio.clamp(minimum, 1. - minimum)
    } else {
        0.5
    }
}

fn pixels(value: Pixels) -> f64 {
    f64::from(f32::from(value))
}

impl NativeView {
    #[allow(clippy::too_many_arguments)]
    pub(super) fn split(
        &self,
        tree: &Tree,
        node_id: NodeId,
        base: Stateful<Div>,
        min_size: f64,
        properties: &Style,
        layout: Option<&LayoutFrame>,
        pointer: &PointerFrame,
        drop_scope: &DropScope,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let row = properties.direction != Some(Direction::Column);
        let ratio = self.splits.ratio(node_id);
        let children = tree
            .node(node_id)
            .expect("validated tree contains every split")
            .children();
        let pane = |child: Option<&NodeId>, grow: f64, cx: &mut Context<Self>| {
            let mut pane = div()
                .flex()
                .flex_col()
                .flex_basis(px(0.))
                .flex_grow(grow as f32)
                .flex_shrink(1.)
                .overflow_hidden();
            pane = if row {
                pane.min_w(px(min_size as f32))
            } else {
                pane.min_h(px(min_size as f32))
            };
            if let Some(child) = child {
                if let Some(layout) = layout {
                    pane = layout.children(pane, std::slice::from_ref(child), 0, None);
                }
                pane = pane.child(self.render_node(tree, *child, layout, pointer, drop_scope, cx));
            }
            pane
        };
        let leading = pane(children.first(), ratio, cx);
        let trailing = pane(children.get(1), 1. - ratio, cx);
        let divider = div()
            .id(ElementId::NamedInteger(
                "split-divider".into(),
                node_id.get(),
            ))
            .flex_shrink_0()
            .bg(rgb(DIVIDER_COLOR))
            .hover(|style| style.bg(rgb(DIVIDER_ACTIVE_COLOR)))
            .on_drag(SplitDrag(node_id), |_, _, _, cx| cx.new(|_| NoPreview));
        let divider = if row {
            divider.w(px(SPLIT_DIVIDER as f32)).cursor_col_resize()
        } else {
            divider.h(px(SPLIT_DIVIDER as f32)).cursor_row_resize()
        };
        // Padding and border inset the panes from the bounds GPUI reports.
        let inset = properties.padding.unwrap_or(0.) + properties.border_width.unwrap_or(0.);
        base.on_drag_move(
            cx.listener(move |view, event: &DragMoveEvent<SplitDrag>, _, cx| {
                if event.drag(cx).0 != node_id {
                    return;
                }
                let bounds = event.bounds;
                let (position, start, length) = if row {
                    (event.event.position.x, bounds.origin.x, bounds.size.width)
                } else {
                    (event.event.position.y, bounds.origin.y, bounds.size.height)
                };
                let ratio = ratio_at(
                    pixels(position),
                    pixels(start) + inset,
                    pixels(length) - 2. * inset,
                    min_size,
                );
                if let Some(state) = view.splits.0.get_mut(&node_id)
                    && state.ratio != ratio
                {
                    state.ratio = ratio;
                    cx.notify();
                }
            }),
        )
        .child(leading)
        .child(divider)
        .child(trailing)
        .into_any_element()
    }
}

#[cfg(test)]
mod tests {
    use super::ratio_at;

    #[test]
    fn divider_ratio_follows_the_pointer_and_minimum_sizes() {
        // 406 px with a 6 px divider leaves 400 px of pane space.
        assert_eq!(ratio_at(103., 0., 406., 0.), 0.25);
        assert_eq!(ratio_at(-50., 0., 406., 0.), 0.);
        assert_eq!(ratio_at(900., 0., 406., 0.), 1.);
        assert_eq!(ratio_at(13., 10., 406., 100.), 0.25);
        assert_eq!(ratio_at(10., 10., 406., 100.), 0.25);
        assert_eq!(ratio_at(400., 0., 406., 100.), 0.75);
        // Panes that cannot both reach their minimum keep an even split.
        assert_eq!(ratio_at(50., 0., 306., 200.), 0.5);
        assert_eq!(ratio_at(3., 0., 4., 0.), 0.5);
    }
}
