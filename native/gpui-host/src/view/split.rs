//! Split panes: a host-owned ratio per split node and its divider, which a
//! pointer drags and the keyboard steps.
//!
//! The application declares a ratio; the host adopts each newly declared
//! value and otherwise keeps the user's latest move, like a scroll offset.
//! Each finished drag and each keyboard step that changed the ratio is
//! reported once as `split_resize`.

use super::{DropScope, NativeView, interactions::PointerFrame};
use crate::{evidence::LayoutFrame, style};
use bun_native_protocol::{
    Direction, Element as NativeElement, Event, NodeId, ResizeSource, SPLIT_DIVIDER, Style, Tree,
};
use gpui::{
    AnyElement, App, Context, Div, DragMoveEvent, ElementId, Empty, FocusHandle, KeyBinding,
    MouseButton, Pixels, Role, Stateful, Window, actions, canvas, div, prelude::*, px, rgb,
};
use std::cell::Cell;
use std::collections::BTreeMap;
use std::rc::Rc;

const DIVIDER_COLOR: u32 = 0xc8ced8;
const DIVIDER_ACTIVE_COLOR: u32 = 0x8792a2;
/// An arrow key moves the divider by 1% of the pane space; Shift by 10%.
const KEYBOARD_STEP: f64 = 0.01;
const KEYBOARD_PAGE: f64 = 0.1;

actions!(
    native_split,
    [
        DividerLeft,
        DividerRight,
        DividerUp,
        DividerDown,
        DividerPageLeft,
        DividerPageRight,
        DividerPageUp,
        DividerPageDown,
        DividerMinimum,
        DividerMaximum,
    ]
);

pub(super) fn bind_keys(cx: &mut App) {
    let context = Some("NativeSplitDivider");
    cx.bind_keys([
        KeyBinding::new("left", DividerLeft, context),
        KeyBinding::new("right", DividerRight, context),
        KeyBinding::new("up", DividerUp, context),
        KeyBinding::new("down", DividerDown, context),
        KeyBinding::new("shift-left", DividerPageLeft, context),
        KeyBinding::new("shift-right", DividerPageRight, context),
        KeyBinding::new("shift-up", DividerPageUp, context),
        KeyBinding::new("shift-down", DividerPageDown, context),
        KeyBinding::new("home", DividerMinimum, context),
        KeyBinding::new("end", DividerMaximum, context),
    ]);
}

/// One keyboard request on a divider.
#[derive(Clone, Copy, Debug, PartialEq)]
enum Step {
    /// Along the split's main axis (row: Left/Right, column: Up/Down).
    By {
        row: bool,
        delta: f64,
    },
    Minimum,
    Maximum,
}

struct SplitState {
    declared: f64,
    ratio: f64,
    min_size: f64,
    /// The divider's keyboard focus; a Tab stop between the two panes.
    focus: FocusHandle,
    /// The panes' main-axis sizes at the latest prepaint.
    panes: Rc<[Cell<f64>; 2]>,
    /// The ratio when the current pointer drag started.
    drag_start: Option<f64>,
}

impl SplitState {
    fn available(&self) -> Option<f64> {
        let total = self.panes[0].get() + self.panes[1].get();
        (total > 0.).then_some(total)
    }
}

#[derive(Default)]
pub(super) struct Splits(BTreeMap<NodeId, SplitState>);

impl Splits {
    /// Keeps the user's ratio while the declared ratio is unchanged and
    /// releases state for removed splits. Returns whether a removed divider
    /// held keyboard focus.
    pub(super) fn reconcile(&mut self, tree: &Tree, window: &Window, cx: &mut App) -> bool {
        let mut next = BTreeMap::new();
        for (id, node) in tree.nodes() {
            if let NativeElement::Split {
                ratio, min_size, ..
            } = node.element()
            {
                let mut state = self.0.remove(&id).unwrap_or_else(|| SplitState {
                    declared: *ratio,
                    ratio: *ratio,
                    min_size: *min_size,
                    focus: cx.focus_handle().tab_stop(true),
                    panes: Rc::default(),
                    drag_start: None,
                });
                if state.declared != *ratio {
                    state.declared = *ratio;
                    state.ratio = *ratio;
                    // An adopted declaration is the application's own value.
                    state.drag_start = state.drag_start.map(|_| *ratio);
                }
                state.min_size = *min_size;
                next.insert(id, state);
            }
        }
        let removed = std::mem::replace(&mut self.0, next);
        removed.values().any(|state| state.focus.is_focused(window))
    }

    pub(super) fn contains(&self, id: NodeId) -> bool {
        self.0.contains_key(&id)
    }

    pub(super) fn focus_handle(&self, id: NodeId) -> Option<&FocusHandle> {
        self.0.get(&id).map(|state| &state.focus)
    }

    pub(super) fn focus_handles(&self) -> impl Iterator<Item = (NodeId, &FocusHandle)> {
        self.0.iter().map(|(id, state)| (*id, &state.focus))
    }

    pub(super) fn focused(&self, window: &Window) -> Option<NodeId> {
        self.0
            .iter()
            .find_map(|(id, state)| state.focus.is_focused(window).then_some(*id))
    }

    /// Finished pointer drags whose ratio differs from where they started.
    fn finished_drags(&mut self) -> Vec<(NodeId, f64)> {
        self.0
            .iter_mut()
            .filter_map(|(id, state)| {
                let start = state.drag_start.take()?;
                (state.ratio != start).then_some((*id, state.ratio))
            })
            .collect()
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

/// The ratios each pane's minimum size allows within `available` pane space.
/// Panes that cannot both reach their minimum keep an even split.
fn limits(available: f64, min_size: f64) -> (f64, f64) {
    if available <= 0. {
        return (0.5, 0.5);
    }
    let minimum = min_size / available;
    if minimum <= 0.5 {
        (minimum, 1. - minimum)
    } else {
        (0.5, 0.5)
    }
}

/// The leading pane's share of the space after the divider, from a pointer
/// position along the main axis, honoring each pane's minimum size.
fn ratio_at(position: f64, start: f64, length: f64, min_size: f64) -> f64 {
    let available = length - SPLIT_DIVIDER;
    let (low, high) = limits(available, min_size);
    if available <= 0. {
        return 0.5;
    }
    ((position - start - SPLIT_DIVIDER / 2.) / available)
        .clamp(0., 1.)
        .clamp(low, high)
}

/// The ratio after one keyboard step, within the same minimum-size limits as
/// a drag. Arrow steps are rounded to 1/10,000 so repeated steps stay exact
/// decimals. `None` when the key is not on the split's axis.
fn stepped(
    ratio: f64,
    step: Step,
    row: bool,
    available: Option<f64>,
    min_size: f64,
) -> Option<f64> {
    let (low, high) = available.map_or((0., 1.), |available| limits(available, min_size));
    let target = match step {
        Step::By { row: axis, .. } if axis != row => return None,
        Step::By { delta, .. } => ((ratio + delta) * 10_000.).round() / 10_000.,
        Step::Minimum => low,
        Step::Maximum => high,
    };
    Some(target.clamp(low, high))
}

/// Route one divider key action to a keyboard step on this split.
fn bind<A: gpui::Action>(
    divider: Stateful<Div>,
    node_id: NodeId,
    step: Step,
    row: bool,
    cx: &mut Context<NativeView>,
) -> Stateful<Div> {
    divider
        .on_action(cx.listener(move |view, _: &A, _, cx| view.step_divider(node_id, step, row, cx)))
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
        let state = self
            .splits
            .0
            .get(&node_id)
            .expect("split reconciled before render");
        let ratio = state.ratio;
        let panes = state.panes.clone();
        let focus = state.focus.clone();
        let (low, high) = state
            .available()
            .map_or((0., 1.), |available| limits(available, min_size));
        let node = tree
            .node(node_id)
            .expect("validated tree contains every split");
        let children = node.children();
        let pane = |index: usize, grow: f64, cx: &mut Context<Self>| {
            let mut pane = div()
                .relative()
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
            if let Some(child) = children.get(index) {
                if let Some(layout) = layout {
                    pane = layout.children(pane, std::slice::from_ref(child), 0, None);
                }
                pane = pane.child(self.render_node(tree, *child, layout, pointer, drop_scope, cx));
            }
            // Measures the pane for keyboard steps; it paints nothing and
            // follows the model child, so layout evidence keeps index 0.
            let panes = panes.clone();
            pane.child(
                canvas(
                    move |bounds, window, _| {
                        let size = if row {
                            bounds.size.width
                        } else {
                            bounds.size.height
                        };
                        let size = pixels(size);
                        // The divider's accessible limits follow the
                        // measured panes; render them on the next frame.
                        if panes[index].replace(size) != size {
                            window.on_next_frame(|window, _| window.refresh());
                        }
                    },
                    |_, (), _, _| {},
                )
                .absolute()
                .top_0()
                .left_0()
                .size_full(),
            )
        };
        let leading = pane(0, ratio, cx);
        let trailing = pane(1, 1. - ratio, cx);
        let mut divider = div()
            .id(ElementId::NamedInteger(
                "split-divider".into(),
                node_id.get(),
            ))
            .role(Role::Splitter)
            .aria_orientation(if row {
                accesskit::Orientation::Vertical
            } else {
                accesskit::Orientation::Horizontal
            })
            .aria_numeric_value(ratio * 100.)
            .aria_min_numeric_value(low * 100.)
            .aria_max_numeric_value(high * 100.)
            .aria_numeric_value_step(KEYBOARD_STEP * 100.)
            .track_focus(&focus)
            .key_context("NativeSplitDivider")
            .focus_visible(style::filled_focus_ring)
            .flex_shrink_0()
            .bg(rgb(DIVIDER_COLOR))
            .hover(|style| style.bg(rgb(DIVIDER_ACTIVE_COLOR)))
            // A press starts a drag without taking keyboard focus from the
            // control the user is working in; only Tab reaches the divider.
            .on_mouse_down(MouseButton::Left, |_, window, _| window.prevent_default())
            .on_drag(SplitDrag(node_id), |_, _, _, cx| cx.new(|_| NoPreview));
        if let Some(label) = node.element().accessible_label() {
            divider = divider.aria_label(label.to_owned());
        }
        let step = |delta: f64, axis: bool| Step::By { row: axis, delta };
        let divider = bind::<DividerLeft>(divider, node_id, step(-KEYBOARD_STEP, true), row, cx);
        let divider = bind::<DividerRight>(divider, node_id, step(KEYBOARD_STEP, true), row, cx);
        let divider = bind::<DividerUp>(divider, node_id, step(-KEYBOARD_STEP, false), row, cx);
        let divider = bind::<DividerDown>(divider, node_id, step(KEYBOARD_STEP, false), row, cx);
        let divider =
            bind::<DividerPageLeft>(divider, node_id, step(-KEYBOARD_PAGE, true), row, cx);
        let divider =
            bind::<DividerPageRight>(divider, node_id, step(KEYBOARD_PAGE, true), row, cx);
        let divider = bind::<DividerPageUp>(divider, node_id, step(-KEYBOARD_PAGE, false), row, cx);
        let divider =
            bind::<DividerPageDown>(divider, node_id, step(KEYBOARD_PAGE, false), row, cx);
        let divider = bind::<DividerMinimum>(divider, node_id, Step::Minimum, row, cx);
        let divider = bind::<DividerMaximum>(divider, node_id, Step::Maximum, row, cx);
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
                if let Some(state) = view.splits.0.get_mut(&node_id) {
                    state.drag_start.get_or_insert(state.ratio);
                    if state.ratio != ratio {
                        state.ratio = ratio;
                        cx.notify();
                    }
                }
            }),
        )
        .child(leading)
        .child(divider)
        .child(trailing)
        .into_any_element()
    }

    fn step_divider(&mut self, node_id: NodeId, step: Step, row: bool, cx: &mut Context<Self>) {
        let Some(state) = self.splits.0.get_mut(&node_id) else {
            return;
        };
        let Some(ratio) = stepped(state.ratio, step, row, state.available(), state.min_size) else {
            // A cross-axis arrow is not a divider key here.
            cx.propagate();
            return;
        };
        if ratio == state.ratio {
            return;
        }
        state.ratio = ratio;
        cx.notify();
        self.report_resize(node_id, ratio, ResizeSource::Keyboard, cx);
    }

    /// GPUI ends a pointer drag on button release and then renders: report
    /// each finished divider drag that moved the ratio once.
    pub(super) fn finish_divider_drags(&mut self, cx: &mut Context<Self>) {
        if cx.has_active_drag() {
            return;
        }
        for (node_id, ratio) in self.splits.finished_drags() {
            self.report_resize(node_id, ratio, ResizeSource::Pointer, cx);
        }
    }

    fn report_resize(&self, node_id: NodeId, ratio: f64, source: ResizeSource, cx: &mut App) {
        let state = self.state.borrow();
        if !state.active {
            return;
        }
        let Some(path) = state.tree.path(node_id) else {
            return;
        };
        self.events.ui(
            |sequence| Event::SplitResize {
                sequence,
                window_id: self.window_id,
                node_id,
                tree_revision: state.tree.revision(),
                path,
                ratio,
                source,
            },
            cx,
        );
    }
}

/// Focusable nodes beneath `scope` in rendered order: a split's divider sits
/// between its two panes. `nested_layers` false skips overlays below `scope`.
pub(super) fn tab_order(
    tree: &Tree,
    scope: NodeId,
    nested_layers: bool,
    mut focusable: impl FnMut(NodeId) -> bool,
) -> Vec<NodeId> {
    enum Visit {
        Node(NodeId),
        Divider(NodeId),
    }
    let mut result = Vec::new();
    let mut pending = vec![Visit::Node(scope)];
    while let Some(visit) = pending.pop() {
        let id = match visit {
            Visit::Divider(id) => {
                if focusable(id) {
                    result.push(id);
                }
                continue;
            }
            Visit::Node(id) => id,
        };
        let Some(node) = tree.node(id) else { continue };
        if id != scope && !nested_layers && matches!(node.element(), NativeElement::Overlay { .. })
        {
            continue;
        }
        let children = node.children();
        if matches!(node.element(), NativeElement::Split { .. }) {
            pending.extend(children.get(1).map(|child| Visit::Node(*child)));
            pending.push(Visit::Divider(id));
            pending.extend(children.first().map(|child| Visit::Node(*child)));
            continue;
        }
        if focusable(id) {
            result.push(id);
        }
        pending.extend(children.iter().rev().map(|child| Visit::Node(*child)));
    }
    result
}

#[cfg(test)]
mod tests {
    use super::{Step, limits, ratio_at, stepped};

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
        assert_eq!(limits(400., 100.), (0.25, 0.75));
        assert_eq!(limits(300., 200.), (0.5, 0.5));
    }

    #[test]
    fn keyboard_steps_use_the_drag_limits_and_their_own_axis() {
        let right = Step::By {
            row: true,
            delta: 0.01,
        };
        let down_page = Step::By {
            row: false,
            delta: 0.1,
        };
        assert_eq!(stepped(0.4, right, true, Some(400.), 0.), Some(0.41));
        // Repeated steps stay exact decimals.
        let mut ratio = 0.4;
        for _ in 0..7 {
            ratio = stepped(ratio, right, true, Some(400.), 0.).unwrap();
        }
        assert_eq!(ratio, 0.47);
        // An arrow on the other axis is left to other handlers.
        assert_eq!(stepped(0.4, right, false, Some(400.), 0.), None);
        assert_eq!(stepped(0.4, down_page, true, Some(400.), 0.), None);
        assert_eq!(stepped(0.4, down_page, false, Some(400.), 0.), Some(0.5));
        // Minimum sizes bound arrows, Home and End exactly like a drag.
        assert_eq!(stepped(0.74, right, true, Some(400.), 100.), Some(0.75));
        assert_eq!(stepped(0.75, right, true, Some(400.), 100.), Some(0.75));
        assert_eq!(
            stepped(0.5, Step::Minimum, true, Some(400.), 100.),
            Some(0.25)
        );
        assert_eq!(
            stepped(0.5, Step::Maximum, true, Some(400.), 100.),
            Some(0.75)
        );
        assert_eq!(
            stepped(0.5, Step::Maximum, true, Some(300.), 200.),
            Some(0.5)
        );
        // Before the first layout only the 0-1 range applies.
        assert_eq!(stepped(0.5, Step::Minimum, false, None, 100.), Some(0.));
        assert_eq!(stepped(0.995, right, true, None, 0.), Some(1.));
    }
}
