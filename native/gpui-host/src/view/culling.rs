//! Viewport culling for long content inside a scroll viewport.
//!
//! GPUI rebuilds, lays out and paints every element each frame. A box with at
//! least `MIN_CULLED_CHILDREN` children inside a scroll viewport renders each
//! run of consecutive children that lie more than one viewport outside the
//! visible area as one empty box of the run's last measured extent: no text
//! shaping, styles, listeners or descendants. Content size and every rendered
//! sibling's position are unchanged. Inside the run the host keeps what
//! cannot be skipped: one Tab stop for the run's enabled buttons, which
//! hands focus to its first (Tab) or last (Shift-Tab) button and reveals it,
//! so Tab order is unchanged, and, while assistive technology is active, an
//! accessible stand-in of every culled node (id, role, name, states and a
//! button's focus and click actions; the culled child at its measured
//! place, its descendants empty at its origin), so the accessibility tree is
//! unchanged.
//!
//! Culling is conservative. Nothing is culled while layout evidence is
//! captured, or in a scroll viewport whose reveal resolves in this frame's
//! prepaint. A child is always rendered when it was never measured, when its
//! subtree or child list changed since the last render, when it holds the
//! focused control, an input, split, overlay or drop target, or when its own
//! flex factors could make its size depend on its siblings. Only boxes laid
//! out from their start are culled. A box's measures are dropped when it or
//! an ancestor is restyled, the scale factor changes or a clean child's cross
//! size changes (the box was resized). After prepaint, if a culled run lies
//! in the viewport after all (the offset or layout moved further than the
//! one-viewport margin), the next frame renders it.

use super::NativeView;
use bun_native_protocol::{
    Direction, Element as NativeElement, JustifyContent, Node, NodeId, Tree,
};
use gpui::{Bounds, Pixels, ScrollHandle, Size, WeakEntity, Window, point, px, size};
use std::cell::{Cell, RefCell};
use std::collections::{HashMap, HashSet};
use std::ops::Range;
use std::rc::Rc;

/// Fewer children are rendered as they are: culling a short list saves little
/// and every fixture of fixed geometry stays on the plain path.
pub(super) const MIN_CULLED_CHILDREN: usize = 64;

/// Per-window culling state that outlives a frame.
#[derive(Default)]
pub(super) struct Culling {
    measures: HashMap<NodeId, Rc<RefCell<Measure>>>,
    /// Nodes whose subtree (element, child list or a descendant's) changed
    /// since the last render, with every ancestor.
    dirty: HashSet<NodeId>,
    /// Nodes whose own element changed since the last render: a restyle can
    /// change inherited text style and so every descendant's size.
    restyled: HashSet<NodeId>,
}

impl Culling {
    /// Records what a committed batch changed, from `Tree::diff_nodes`.
    pub(super) fn changed(&mut self, tree: &Tree, id: NodeId, restyled: bool) {
        if restyled {
            self.restyled.insert(id);
        }
        let mut current = Some(id);
        while let Some(node) = current {
            if !self.dirty.insert(node) {
                // Its ancestors were marked with it.
                break;
            }
            current = tree.parent(node);
        }
    }

    /// Starts a frame. `enabled` is false while assistive technology or
    /// layout evidence needs every element; measures cannot be kept then,
    /// since nothing tells them about the changes this frame forgets.
    /// `pinned` must stay rendered with every ancestor.
    pub(super) fn frame(
        &mut self,
        tree: &Tree,
        enabled: bool,
        accessible: bool,
        scale: f32,
        pinned: impl IntoIterator<Item = NodeId>,
        view: WeakEntity<NativeView>,
    ) -> CullFrame {
        let mut pins = HashSet::new();
        if enabled {
            for id in pinned {
                let mut current = Some(id);
                while let Some(node) = current {
                    if !pins.insert(node) {
                        break;
                    }
                    current = tree.parent(node);
                }
            }
        } else {
            self.measures.clear();
        }
        CullFrame {
            enabled,
            accessible,
            scale,
            view,
            measures: RefCell::new(std::mem::take(&mut self.measures)),
            visited: RefCell::default(),
            dirty: std::mem::take(&mut self.dirty),
            restyled: std::mem::take(&mut self.restyled),
            pins,
            culled: Cell::new(0),
        }
    }

    /// Ends a frame: keeps the measures of the boxes it measured. Changes
    /// recorded so far were all rendered in full and are measured in this
    /// frame's prepaint.
    pub(super) fn finish(&mut self, frame: CullFrame) -> usize {
        let visited = frame.visited.into_inner();
        let mut measures = frame.measures.into_inner();
        measures.retain(|id, _| visited.contains(id));
        self.measures = measures;
        frame.culled.get()
    }
}

/// One frame's culling decisions.
pub(super) struct CullFrame {
    enabled: bool,
    accessible: bool,
    scale: f32,
    view: WeakEntity<NativeView>,
    measures: RefCell<HashMap<NodeId, Rc<RefCell<Measure>>>>,
    visited: RefCell<HashSet<NodeId>>,
    dirty: HashSet<NodeId>,
    restyled: HashSet<NodeId>,
    /// Nodes that are, or hold, something that must stay rendered.
    pins: HashSet<NodeId>,
    culled: Cell<usize>,
}

/// The nearest scroll viewport above a node, in the viewport's content
/// coordinates (zero at the content origin, growing toward its end).
#[derive(Clone, Copy)]
pub(super) struct Viewport<'a> {
    frame: Option<&'a CullFrame>,
    scroll: Option<Scope<'a>>,
}

#[derive(Clone, Copy)]
struct Scope<'a> {
    handle: &'a ScrollHandle,
    /// The visible rectangle widened by one viewport on every side; `None`
    /// measures without culling.
    keep: Option<Bounds<Pixels>>,
}

/// The last measured layout of one culling box's children.
#[derive(Default)]
struct Measure {
    sizes: HashMap<NodeId, Size<Pixels>>,
    /// Reused for the next measurement.
    spare: HashMap<NodeId, Size<Pixels>>,
    /// Main-axis content coordinate of the first child.
    start: Pixels,
    /// Cross-axis content extent of all children.
    cross: (Pixels, Pixels),
    /// Mean main-axis size, the estimate for a child never measured.
    mean: Pixels,
    scale: f32,
}

/// Why a rendered child of a culling box is rendered.
#[derive(Clone, Copy, Debug, PartialEq)]
enum Fate {
    /// Measured before and unchanged since: near the viewport.
    Clean,
    /// New, changed or pinned.
    Fresh,
}

/// The elements a culling box renders this frame, in order.
pub(super) struct Plan {
    pub(super) slots: Vec<Slot>,
    /// Whether culled children keep their accessible nodes.
    pub(super) accessible: bool,
}

pub(super) enum Slot {
    /// The child at this index, rendered.
    Child(usize),
    /// Consecutive culled children, as one box of their extent.
    Run(Run),
}

pub(super) struct Run {
    pub(super) children: Range<usize>,
    /// Each child's main-axis offset in the run, and its measured size.
    pub(super) places: Vec<(Pixels, Size<Pixels>)>,
    pub(super) size: Size<Pixels>,
    pub(super) row: bool,
}

/// What the measuring listener reads from each element of a culling box.
#[derive(Clone, Debug, PartialEq)]
enum Laid {
    Child(usize, Fate),
    Run(Range<usize>),
}

impl<'a> Viewport<'a> {
    /// No culling anywhere below: popups and overlay layers.
    pub(super) const OFF: Viewport<'static> = Viewport {
        frame: None,
        scroll: None,
    };

    pub(super) fn of(frame: &'a CullFrame) -> Self {
        Self {
            frame: frame.enabled.then_some(frame),
            scroll: None,
        }
    }

    /// An overlay layer is drawn outside its parent's clip.
    pub(super) fn layer(self) -> Self {
        Self {
            scroll: None,
            ..self
        }
    }

    /// The viewport for this node's children. A scroll viewport starts a new
    /// scope; `held` defers culling while a reveal resolves in its prepaint;
    /// `at_end` pins it to its end this frame.
    pub(super) fn enter(self, handle: Option<&'a ScrollHandle>, held: bool, at_end: bool) -> Self {
        let (Some(_), Some(handle)) = (self.frame, handle) else {
            return self;
        };
        let viewport = handle.bounds().size;
        if viewport.width <= px(0.) || viewport.height <= px(0.) {
            // Never laid out: nothing to measure against yet.
            return Self {
                scroll: None,
                ..self
            };
        }
        let keep = (!held).then(|| {
            // GPUI clamps the offset to the content in prepaint.
            let max = handle.max_offset();
            let offset = handle.offset();
            let top = point(
                (-offset.x).clamp(px(0.), max.x.max(px(0.))),
                (-offset.y).clamp(px(0.), max.y.max(px(0.))),
            );
            let mut keep = Bounds::new(
                top - point(viewport.width, viewport.height),
                size(viewport.width * 3., viewport.height * 3.),
            );
            if at_end {
                // The end may move by any amount: keep everything after the
                // last frame's end viewport.
                let from = (max.y - viewport.height).min(keep.origin.y);
                keep = Bounds::new(
                    point(keep.origin.x, from),
                    size(keep.size.width, px(f32::MAX)),
                );
            }
            keep
        });
        Self {
            scroll: Some(Scope { handle, keep }),
            ..self
        }
    }

    /// Plans a box's children when it is long enough to cull, inside a scroll
    /// viewport, and laid out so a run of fixed sizes keeps its geometry.
    /// With the plan comes the listener that measures the rendered children;
    /// the box must run it on its children's prepainted bounds.
    pub(super) fn plan(
        self,
        tree: &Tree,
        node_id: NodeId,
        node: &Node,
        tracked: bool,
    ) -> Option<(Plan, ChildrenListener)> {
        let (Some(frame), Some(scope)) = (self.frame, self.scroll) else {
            return None;
        };
        let children = node.children();
        let NativeElement::Box { style, .. } = node.element() else {
            return None;
        };
        if children.len() < MIN_CULLED_CHILDREN
            || style
                .justify_content
                .is_some_and(|justify| justify != JustifyContent::Start)
        {
            return None;
        }
        let row = style.direction == Some(Direction::Row);
        let gap = px(style.gap.unwrap_or(0.) as f32);
        frame.visited.borrow_mut().insert(node_id);
        let measure = frame
            .measures
            .borrow_mut()
            .entry(node_id)
            .or_default()
            .clone();
        let (slots, laid) = {
            let mut measure = measure.borrow_mut();
            if measure.scale != frame.scale || restyled(frame, tree, node_id) {
                measure.sizes.clear();
                measure.scale = frame.scale;
            }
            let (slots, laid, culled) =
                lay_out(children, &measure, row, gap, scope.keep, |child| {
                    frame.clean(tree, child)
                });
            frame.culled.set(frame.culled.get() + culled);
            (slots, laid)
        };
        let measuring = Measuring {
            children: children.into(),
            laid: laid.into(),
            measure,
            handle: scope.handle.clone(),
            tracked,
            row,
            view: frame.view.clone(),
        };
        let plan = Plan {
            slots,
            accessible: frame.accessible,
        };
        Some((
            plan,
            Box::new(move |bounds, window| measuring.measured(bounds, window)),
        ))
    }
}

/// Runs on a box's children's prepainted bounds (`Div::on_children_prepainted`).
pub(super) type ChildrenListener = Box<dyn Fn(&[Bounds<Pixels>], &mut Window)>;

/// Splits a box's children into rendered children and runs of culled ones,
/// from the last measure: a child is culled when it was measured, is `clean`
/// and its estimated rectangle lies outside `keep`. Returns the slots, what
/// the measuring listener reads from each rendered element, and the number
/// of culled children.
fn lay_out(
    children: &[NodeId],
    measure: &Measure,
    row: bool,
    gap: Pixels,
    keep: Option<Bounds<Pixels>>,
    clean: impl Fn(NodeId) -> bool,
) -> (Vec<Slot>, Vec<Laid>, usize) {
    let mut slots = Vec::new();
    let mut laid = Vec::new();
    let mut culled = 0;
    let mut position = measure.start;
    for (index, child) in children.iter().enumerate() {
        let measured = measure.sizes.get(child).copied();
        let extent = measured.map_or(measure.mean, |size| main(size, row));
        let rectangle = if row {
            Bounds::from_corners(
                point(position, measure.cross.0),
                point(position + extent, measure.cross.1),
            )
        } else {
            Bounds::from_corners(
                point(measure.cross.0, position),
                point(measure.cross.1, position + extent),
            )
        };
        position += extent + gap;
        let fate = match measured {
            Some(size) if clean(*child) => {
                if keep.is_some_and(|keep| !keep.intersects(&rectangle)) {
                    if let Some(Slot::Run(run)) = slots.last_mut() {
                        let offset = main(run.size, row) + gap;
                        run.places.push((offset, size));
                        run.children.end = index + 1;
                        run.size = if row {
                            Size::new(offset + size.width, run.size.height.max(size.height))
                        } else {
                            Size::new(run.size.width.max(size.width), offset + size.height)
                        };
                    } else {
                        slots.push(Slot::Run(Run {
                            children: index..index + 1,
                            places: vec![(px(0.), size)],
                            size,
                            row,
                        }));
                    }
                    culled += 1;
                    continue;
                }
                Fate::Clean
            }
            _ => Fate::Fresh,
        };
        if let Some(Slot::Run(run)) = slots.last() {
            laid.push(Laid::Run(run.children.clone()));
        }
        slots.push(Slot::Child(index));
        laid.push(Laid::Child(index, fate));
    }
    if let Some(Slot::Run(run)) = slots.last() {
        laid.push(Laid::Run(run.children.clone()));
    }
    (slots, laid, culled)
}

impl CullFrame {
    /// Unchanged since its last measure, and nothing in it must render.
    fn clean(&self, tree: &Tree, child: NodeId) -> bool {
        if self.dirty.contains(&child) || self.pins.contains(&child) {
            return false;
        }
        let Some(node) = tree.node(child) else {
            return false;
        };
        let style = node.element().style();
        // Grow and shrink resolve against the siblings' sizes, which a
        // placeholder's fixed size would change.
        let fixed = style.flex_grow.is_none_or(|grow| grow == 0.)
            && style.flex_shrink.is_none_or(|shrink| shrink == 0.);
        fixed
            && matches!(
                node.element(),
                NativeElement::Box { .. }
                    | NativeElement::Text { .. }
                    | NativeElement::Button { .. }
            )
    }
}

/// Whether the box or an ancestor changed its own element since the last
/// render.
fn restyled(frame: &CullFrame, tree: &Tree, node: NodeId) -> bool {
    if frame.restyled.is_empty() {
        return false;
    }
    let mut current = Some(node);
    while let Some(id) = current {
        if frame.restyled.contains(&id) {
            return true;
        }
        current = tree.parent(id);
    }
    false
}

fn main(size: Size<Pixels>, row: bool) -> Pixels {
    if row { size.width } else { size.height }
}

fn cross(size: Size<Pixels>, row: bool) -> Pixels {
    if row { size.height } else { size.width }
}

struct Measuring {
    children: Rc<[NodeId]>,
    laid: Rc<[Laid]>,
    measure: Rc<RefCell<Measure>>,
    handle: ScrollHandle,
    /// The box is the viewport itself, whose handle holds the child bounds.
    tracked: bool,
    row: bool,
    view: WeakEntity<NativeView>,
}

impl Measuring {
    fn measured(&self, bounds: &[Bounds<Pixels>], window: &mut Window) {
        let row = self.row;
        let viewport = self.handle.bounds();
        let offset = self.handle.offset();
        let visible = Bounds::new(point(-offset.x, -offset.y), viewport.size);
        let content = |index: usize| -> Option<Bounds<Pixels>> {
            if self.tracked {
                // Stored before this viewport's own offset is applied.
                self.handle
                    .bounds_for_item(index)
                    .map(|bounds| Bounds::new(bounds.origin - viewport.origin, bounds.size))
            } else {
                bounds.get(index).map(|bounds| {
                    Bounds::new(bounds.origin - viewport.origin - offset, bounds.size)
                })
            }
        };
        let mut measure = self.measure.borrow_mut();
        let mut sizes = std::mem::take(&mut measure.spare);
        sizes.clear();
        let mut uncovered = false;
        let mut resized = false;
        let mut start = None;
        let (mut low, mut high) = (Pixels::MAX, Pixels::MIN);
        let mut total = px(0.);
        for (index, laid) in self.laid.iter().enumerate() {
            let Some(bounds) = content(index) else {
                continue;
            };
            start.get_or_insert(if row {
                bounds.origin.x
            } else {
                bounds.origin.y
            });
            let (from, to) = if row {
                (bounds.top(), bounds.bottom())
            } else {
                (bounds.left(), bounds.right())
            };
            low = low.min(from);
            high = high.max(to);
            match laid {
                Laid::Run(range) => {
                    // Culled children keep their sizes; the run must have
                    // stayed out of view.
                    uncovered |= bounds.intersects(&visible);
                    for child in &self.children[range.clone()] {
                        if let Some(size) = measure.sizes.get(child) {
                            total += main(*size, row);
                            sizes.insert(*child, *size);
                        }
                    }
                }
                Laid::Child(child, fate) => {
                    let child = self.children[*child];
                    resized |= *fate == Fate::Clean
                        && measure
                            .sizes
                            .get(&child)
                            .is_some_and(|size| cross(*size, row) != cross(bounds.size, row));
                    total += main(bounds.size, row);
                    sizes.insert(child, bounds.size);
                }
            }
        }
        let count = sizes.len();
        measure.spare = std::mem::replace(&mut measure.sizes, sizes);
        if resized {
            // The box changed size: every culled size may be stale.
            measure.sizes.clear();
        }
        measure.start = start.unwrap_or_default();
        measure.cross = if count == 0 {
            (px(0.), px(0.))
        } else {
            (low, high)
        };
        measure.mean = if count == 0 {
            px(0.)
        } else {
            total / count as f32
        };
        if uncovered || resized {
            let view = self.view.clone();
            window.on_next_frame(move |_, cx| {
                let _ = view.update(cx, |_, cx| cx.notify());
            });
        }
    }
}

#[cfg(test)]
mod tests;
