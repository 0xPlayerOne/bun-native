//! Cached child views: re-render only the subtrees a frame changed.
//!
//! GPUI rebuilds, lays out and paints the whole window on every frame. While
//! caching is on, each Box, Text or Button child of a box renders through its
//! own GPUI view (a boundary, [`CachedNode`]), so its elements keep their ids
//! from frame to frame. A boundary whose subtree did not change since the last
//! frame is embedded with `Entity::cached` at its measured size: GPUI then
//! lays it out as one fixed box and replays its last prepaint and paint
//! (hitboxes, listeners, focus and Tab stops, the scene) without rebuilding
//! it. A changed subtree, and every boundary on its route, renders as usual.
//!
//! A boundary is cached only where its last measured size must still hold:
//! its subtree, its own place and every ancestor's element are unchanged, it
//! holds nothing that must render (the focused control, an input, split,
//! overlay or drop target), its own size cannot follow its siblings (no grow
//! or shrink, no fill against a content-sized parent) and its parent's cross
//! size does not follow content. Everything else the host renders from its
//! own state (window size, scale, modal route, popups, drop targets, reveals,
//! split ratios, culling corrections) renders the whole window uncached when
//! it changes. GPUI itself re-renders a cached boundary that was notified,
//! moved or clipped differently, and the whole window on a refresh (focus).
//!
//! Caching is off while assistive technology reads the window: GPUI
//! rebuilds the accessibility tree only from prepainted elements. The window
//! then renders without boundaries, exactly as before caching existed. Layout
//! evidence records the elements a frame prepaints and, for those inside a
//! view GPUI replayed, what the frame painted before recorded for them: a
//! replayed view keeps its bounds and content mask, so they keep theirs.
//! `BUN_NATIVE_VIEW_CACHE=0` turns caching off for comparisons.

use super::accessibility::Position;
use super::{DropScope, NativeView, culling::CullFrame, culling::Seed};
use crate::evidence::LayoutFrame;
use bun_native_protocol::{Dimension, Element as NativeElement, Node, NodeId, Tree};
use gpui::{
    AnyElement, App, AppContext, Bounds, Context, Element, ElementId, Entity, GlobalElementId,
    InspectorElementId, IntoElement, LayoutId, Pixels, Render, ScrollHandle, Size, Style,
    StyleRefinement, WeakEntity, Window, div, point, px,
};
use std::cell::{Cell, RefCell};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::rc::Rc;
use std::sync::OnceLock;

/// Whether this process caches views; read once. Only measured and
/// qualified on Linux so far: the macOS host refreshes the whole window on
/// every commit, which bypasses every cache.
pub(super) fn enabled() -> bool {
    static ENABLED: OnceLock<bool> = OnceLock::new();
    *ENABLED.get_or_init(|| {
        cfg!(target_os = "linux")
            && std::env::var_os("BUN_NATIVE_VIEW_CACHE").is_none_or(|value| value != "0")
    })
}

/// Which of a parent's sizes do not follow content, as its children see them.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(super) struct Sizing {
    /// The parent's width does not depend on any content.
    pub(super) width: bool,
    pub(super) height: bool,
    /// The parent lays its children out in a row.
    pub(super) row: bool,
    /// Children without a cross size stretch to the parent's.
    pub(super) stretch: bool,
    /// The parent places every child on whole device pixels: it sits on
    /// them itself and nothing in it centers, spreads, grows or shrinks.
    pub(super) whole: bool,
}

impl Sizing {
    /// Nothing is known: inside overlay layers and popups.
    pub(super) const NONE: Sizing = Sizing {
        width: false,
        height: false,
        row: false,
        stretch: false,
        whole: false,
    };

    /// What `element`, sized as given and placed on whole device pixels
    /// when `whole`, tells its own children; `fixed` when none of them grows
    /// or shrinks.
    pub(super) fn of_children(
        width: bool,
        height: bool,
        whole: bool,
        fixed: bool,
        element: &NativeElement,
    ) -> Self {
        let style = element.style();
        // A split's panes refine this (`view/split.rs`).
        let whole = whole
            && fixed
            && style.align_items != Some(bun_native_protocol::AlignItems::Center)
            && style.justify_content.is_none_or(|justify| {
                matches!(
                    justify,
                    bun_native_protocol::JustifyContent::Start
                        | bun_native_protocol::JustifyContent::End
                )
            });
        let row = match element {
            NativeElement::Split { .. } => {
                style.direction != Some(bun_native_protocol::Direction::Column)
            }
            _ => style.direction == Some(bun_native_protocol::Direction::Row),
        };
        let stretch = match element {
            NativeElement::Box { .. } => style
                .align_items
                .is_none_or(|align| align == bun_native_protocol::AlignItems::Stretch),
            _ => false,
        };
        Self {
            width,
            height,
            row,
            stretch,
            whole,
        }
    }

    /// Whether `element`, a child of this parent, keeps its size while its
    /// subtree and the parent's own size are unchanged: its main size does
    /// not follow its siblings and its cross size does not follow theirs
    /// through a content-sized parent. It must also sit on whole device
    /// pixels: GPUI lays a cached view out from its snapped origin, so
    /// content at a fraction from an unsnapped origin would round apart.
    pub(super) fn holds(&self, element: &NativeElement) -> bool {
        let style = element.style();
        let fixed = fixed(element);
        let (main, main_known, cross_known) = if self.row {
            (style.width, self.width, self.height)
        } else {
            (style.height, self.height, self.width)
        };
        self.whole
            && fixed
            && cross_known
            && (main_known || !matches!(main, Some(Dimension::Fill(_))))
    }

    /// Whether `element`, a child of this parent, has a width and height
    /// that do not depend on any content: `(width, height)`.
    pub(super) fn child(&self, element: &NativeElement) -> (bool, bool) {
        let style = element.style();
        let fixed = fixed(element);
        // A button is 44 px tall unless styled otherwise.
        let button = matches!(element, NativeElement::Button { .. });
        let known =
            |dimension: Option<Dimension>, parent: bool, cross: bool, height: bool| match dimension
            {
                Some(Dimension::Pixels(_)) => cross || fixed,
                Some(Dimension::Fill(_)) => parent && (cross || fixed),
                None if cross => (button && height) || (self.stretch && parent),
                None => button && height && fixed,
            };
        let width = known(style.width, self.width, !self.row, false);
        let height = known(style.height, self.height, self.row, true);
        (width, height)
    }
}

/// One frame's caching decisions, kept in its [`CullFrame`].
pub(super) struct CacheFrame {
    /// Render every boundary: something outside the tree changed.
    pub(super) full: bool,
    /// Root-to-modal route, as `ModalScope` reads it.
    pub(super) route: Vec<NodeId>,
    /// Boundaries this frame embedded cached.
    pub(super) cached: RefCell<Vec<NodeId>>,
    /// Of those, the ones GPUI rendered anyway (notified, moved or clipped).
    rendered: Cell<usize>,
}

impl CacheFrame {
    /// Boundaries GPUI replayed from the last frame instead of rendering.
    pub(super) fn reused(&self) -> usize {
        self.cached
            .borrow()
            .len()
            .saturating_sub(self.rendered.get())
    }

    /// A boundary embedded cached is rendering after all.
    pub(super) fn missed(&self) {
        self.rendered.set(self.rendered.get() + 1);
    }
}

/// What a boundary needs to render its node later in the frame, when GPUI
/// lays it out: the render state its parent had.
#[derive(Clone)]
pub(super) struct BoundaryScope {
    pub(super) frame: Rc<CullFrame>,
    /// Layout evidence, when the frame captures it.
    pub(super) layout: Option<LayoutFrame>,
    pub(super) drop_scope: DropScope,
    pub(super) modal: Position,
    pub(super) viewport: Seed,
    /// Embedded cached: the node fills the boundary's fixed box.
    pub(super) fills: bool,
}

/// A boundary's view: renders its node through the window's view.
pub(super) struct CachedNode {
    node_id: NodeId,
    view: WeakEntity<NativeView>,
    scope: Rc<RefCell<Option<BoundaryScope>>>,
}

impl Render for CachedNode {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let scope = self.scope.borrow().clone();
        let node_id = self.node_id;
        scope
            .and_then(|scope| {
                self.view
                    .update(cx, |view, cx| view.render_boundary(node_id, &scope, cx))
                    .ok()
                    .flatten()
            })
            .unwrap_or_else(|| div().into_any_element())
    }
}

struct Boundary {
    entity: Entity<CachedNode>,
    scope: Rc<RefCell<Option<BoundaryScope>>>,
}

/// A boundary's last laid-out size and the parent it was laid out in.
#[derive(Clone, Copy)]
pub(super) struct Measured {
    parent: NodeId,
    size: Size<Pixels>,
}

/// What renders outside the tree; any change renders every boundary.
#[derive(PartialEq)]
struct Outside {
    viewport: Size<Pixels>,
    scale: f32,
    route: Vec<NodeId>,
    drops: BTreeMap<NodeId, bun_native_protocol::DropTargetId>,
    popups: bool,
    exposure: u64,
}

/// Per-window caching state that outlives a frame.
pub(super) struct Caching {
    enabled: bool,
    boundaries: RefCell<HashMap<NodeId, Boundary>>,
    measured: Rc<RefCell<HashMap<NodeId, Measured>>>,
    /// Set by everything that changes the render outside the tree.
    stale: Rc<Cell<bool>>,
    /// Nodes moved into a parent, or whose element changed, since the last
    /// frame: their boundaries and every boundary inside them are measured
    /// again.
    moved: HashSet<NodeId>,
    outside: Option<Outside>,
    /// The frame being drawn, until its paint ends.
    pub(super) current: Option<Rc<CullFrame>>,
    /// The layout evidence of the frame painted last: what a view GPUI
    /// replays recorded then (`LayoutFrame::carry`).
    pub(super) painted_layout: Option<LayoutFrame>,
}

impl Default for Caching {
    fn default() -> Self {
        Self {
            enabled: enabled(),
            boundaries: RefCell::default(),
            measured: Rc::default(),
            stale: Rc::new(Cell::new(true)),
            moved: HashSet::new(),
            outside: None,
            current: None,
            painted_layout: None,
        }
    }
}

impl Caching {
    /// The next frame renders every boundary.
    pub(super) fn invalidate(&self) {
        self.stale.set(true);
    }

    /// What [`Self::invalidate`] sets, for a listener later in the frame.
    pub(super) fn stale(&self) -> Rc<Cell<bool>> {
        self.stale.clone()
    }

    /// Records one node a committed batch changed, from `Tree::diff_nodes`.
    pub(super) fn changed(&mut self, id: NodeId, before: Option<&Node>, after: Option<&Node>) {
        if !self.enabled {
            return;
        }
        let Some(after) = after else {
            self.boundaries.get_mut().remove(&id);
            self.measured.borrow_mut().remove(&id);
            return;
        };
        let Some(before) = before else {
            return;
        };
        if !std::ptr::eq(before.element(), after.element()) {
            self.moved.insert(id);
        }
        let (old, new) = (before.children(), after.children());
        if std::ptr::eq(old, new) {
            return;
        }
        if new.len() <= 8 {
            self.moved
                .extend(new.iter().filter(|child| !old.contains(child)).copied());
        } else {
            let old: HashSet<NodeId> = old.iter().copied().collect();
            self.moved
                .extend(new.iter().filter(|child| !old.contains(child)).copied());
        }
    }

    /// Starts a frame; `None` when this frame renders without boundaries.
    #[allow(clippy::too_many_arguments)]
    pub(super) fn frame(
        &mut self,
        tree: &Tree,
        active: bool,
        viewport: Size<Pixels>,
        scale: f32,
        route: &[NodeId],
        drops: &BTreeMap<NodeId, bun_native_protocol::DropTargetId>,
        popups: bool,
        exposure: u64,
        revealing: bool,
    ) -> Option<CacheFrame> {
        let moved = std::mem::take(&mut self.moved);
        if !self.enabled {
            return None;
        }
        if !active {
            // Changes this frame renders are not tracked: start over.
            self.measured.borrow_mut().clear();
            self.outside = None;
            self.stale.set(true);
            return None;
        }
        let outside = Outside {
            viewport,
            scale,
            route: route.to_vec(),
            drops: drops.clone(),
            popups,
            exposure,
        };
        let full =
            self.stale.replace(false) || revealing || self.outside.as_ref() != Some(&outside);
        self.outside = Some(outside);
        let mut measured = self.measured.borrow_mut();
        if full {
            measured.clear();
        } else if !moved.is_empty() && !measured.is_empty() {
            // A moved or restyled node may resize everything inside it.
            let mut pending: Vec<NodeId> = moved.into_iter().collect();
            while let Some(id) = pending.pop() {
                measured.remove(&id);
                if let Some(node) = tree.node(id) {
                    pending.extend(node.children());
                }
            }
        }
        Some(CacheFrame {
            full,
            route: route.to_vec(),
            cached: RefCell::default(),
            rendered: Cell::new(0),
        })
    }

    /// The parent's listener that records the laid-out size of its boundary
    /// children, given as `(element index, node)`. A scroll viewport's
    /// handle holds its children's bounds instead of the listener's list.
    pub(super) fn measuring(
        &self,
        parent: NodeId,
        children: Vec<(usize, NodeId)>,
        scroll: Option<ScrollHandle>,
    ) -> super::culling::ChildrenListener {
        let measured = self.measured.clone();
        Box::new(move |bounds: &[Bounds<Pixels>], _: &mut Window| {
            let mut measured = measured.borrow_mut();
            for (index, node) in &children {
                let size = match &scroll {
                    Some(handle) => handle.bounds_for_item(*index).map(|bounds| bounds.size),
                    None => bounds.get(*index).map(|bounds| bounds.size),
                };
                if let Some(size) = size {
                    measured.insert(*node, Measured { parent, size });
                }
            }
        })
    }

    /// The boundary element for `node`, a child of `parent`: cached at its
    /// measured size when `holds`, otherwise rendered in place.
    pub(super) fn boundary(
        &self,
        parent: NodeId,
        node_id: NodeId,
        holds: bool,
        scope: BoundaryScope,
        cx: &mut Context<NativeView>,
    ) -> AnyElement {
        let frame = scope.frame.clone();
        let cache = frame
            .cache
            .as_ref()
            .expect("boundaries render in a caching frame");
        let size = (holds && !cache.full && frame.unchanged(node_id))
            .then(|| self.measured.borrow().get(&node_id).copied())
            .flatten()
            .filter(|measured| measured.parent == parent)
            .map(|measured| measured.size);
        let mut boundaries = self.boundaries.borrow_mut();
        let boundary = boundaries.entry(node_id).or_insert_with(|| {
            let scope = Rc::new(RefCell::new(None));
            let view = cx.weak_entity();
            let entity = cx.new(|_| CachedNode {
                node_id,
                view,
                scope: scope.clone(),
            });
            Boundary { entity, scope }
        });
        *boundary.scope.borrow_mut() = Some(BoundaryScope {
            fills: size.is_some(),
            ..scope
        });
        let entity = boundary.entity.clone();
        drop(boundaries);
        match size {
            Some(size) => {
                cache.cached.borrow_mut().push(node_id);
                let mut style = StyleRefinement::default();
                style.size.width = Some(size.width.into());
                style.size.height = Some(size.height.into());
                style.flex_grow = Some(0.);
                style.flex_shrink = Some(0.);
                entity.cached(style).into_any_element()
            }
            None => entity.into_any_element(),
        }
    }
}

/// Whether `element` neither grows nor shrinks along its parent's main axis.
pub(super) fn fixed(element: &NativeElement) -> bool {
    let style = element.style();
    style.flex_grow.is_none_or(|grow| grow == 0.)
        && style.flex_shrink.is_none_or(|shrink| shrink == 0.)
}

/// Whether a node renders as a boundary of its own when caching.
pub(super) fn is_boundary(element: &NativeElement) -> bool {
    matches!(
        element,
        NativeElement::Box { .. } | NativeElement::Text { .. } | NativeElement::Button { .. }
    )
}

/// How far a cached boundary's node is laid out from its root, in each axis.
///
/// GPUI lays a cached view out on its own and snaps each edge to a device
/// pixel by rounding its position from the view's origin, half toward zero,
/// where the window rounds positions from its own origin. Content placed at
/// a negative half pixel (text taller than its box, centered) would land a
/// pixel off from where the uncached window draws it. Laid out this far from
/// the root, every edge rounds as the window rounds it while the boundary
/// sits on whole device pixels; [`Offset`] moves it back when it prepaints.
const OFFSET: f32 = 8192.;

/// The fill a cached boundary's node takes in place of its own size: the
/// whole boundary, laid out [`OFFSET`] from the root [`Offset`] gives it.
pub(super) fn fill(style: &mut StyleRefinement) {
    style.position = Some(gpui::Position::Absolute);
    style.inset.left = Some(px(OFFSET).into());
    style.inset.top = Some(px(OFFSET).into());
    style.size.width = Some(gpui::relative(1.).into());
    style.size.height = Some(gpui::relative(1.).into());
}

/// The root of a cached boundary's render: as large as the boundary, its
/// node laid out [`OFFSET`] away (see [`fill`]) and prepainted back in place.
pub(super) struct Offset(pub(super) AnyElement);

impl IntoElement for Offset {
    type Element = Self;

    fn into_element(self) -> Self {
        self
    }
}

impl Element for Offset {
    type RequestLayoutState = ();
    type PrepaintState = ();

    fn id(&self) -> Option<ElementId> {
        None
    }

    fn source_location(&self) -> Option<&'static std::panic::Location<'static>> {
        None
    }

    fn request_layout(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        window: &mut Window,
        cx: &mut App,
    ) -> (LayoutId, ()) {
        let child = self.0.request_layout(window, cx);
        let mut style = Style::default();
        style.size.width = gpui::relative(1.).into();
        style.size.height = gpui::relative(1.).into();
        (window.request_layout(style, [child], cx), ())
    }

    fn prepaint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        _: Bounds<Pixels>,
        _: &mut (),
        window: &mut Window,
        cx: &mut App,
    ) {
        window.with_element_offset(point(px(-OFFSET), px(-OFFSET)), |window| {
            self.0.prepaint(window, cx)
        });
    }

    fn paint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        _: Bounds<Pixels>,
        _: &mut (),
        _: &mut (),
        window: &mut Window,
        cx: &mut App,
    ) {
        self.0.paint(window, cx);
    }
}

#[cfg(test)]
mod tests;
