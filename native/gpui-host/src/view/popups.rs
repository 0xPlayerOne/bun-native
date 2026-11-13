//! Owned popup windows for `overlay` elements with `surface: window`.
//!
//! The popup's content stays in its parent window's model tree and is drawn
//! by the same `NativeView` renderer; only the GPUI window it paints into is
//! different. Each popup is a GPUI `WindowKind::PopUp` window owned by the
//! parent view: it is closed when its node leaves the tree and when the parent
//! view is released (window close or shutdown). Placement is below the parent
//! node in screen coordinates, flipped above it when only that fits, and
//! shifted onto the screen: the X screen on Linux, and the parent window's
//! screen on macOS. Keyboard focus never moves to a popup.

use super::{DropScope, ModalScope, NativeView, PointerFrame, PressedButtons};
use crate::style;
use bun_native_protocol::{
    DismissReason, Element as NativeElement, Event, NodeId, OverlaySurface, Tree,
};
use gpui::{
    AnyElement, App, Bounds, Context, Entity, IntoElement, ParentElement, Pixels, Point, Render,
    Size, Styled, TitlebarOptions, WeakEntity, Window, WindowBounds, WindowHandle, WindowKind,
    WindowOptions, canvas, div, point, prelude::*, px, rgb, size,
};
use std::cell::Cell;
use std::collections::BTreeMap;
use std::rc::Rc;

#[cfg(any(target_os = "macos", test))]
mod cocoa;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
use macos as backend;
#[cfg(target_os = "linux")]
mod x11;
#[cfg(target_os = "linux")]
use x11 as backend;
#[cfg(not(any(target_os = "linux", target_os = "macos")))]
mod backend {
    use gpui::{App, Bounds, Point, Size, Window};
    pub(crate) struct Placement;
    pub(crate) fn window_id(_: &Window) -> Option<u32> {
        None
    }
    pub(crate) fn available(_: &App) -> bool {
        false
    }
    impl Placement {
        pub(crate) fn connect(_: &App) -> Option<Self> {
            None
        }
        pub(crate) fn screen(&self) -> Size<i32> {
            Size::default()
        }
        pub(crate) fn origin(&self, _: u32) -> Option<Point<i32>> {
            None
        }
        pub(crate) fn own(&self, _: u32, _: u32) -> Option<()> {
            None
        }
        pub(crate) fn place(&self, _: u32, _: Bounds<i32>) -> Option<()> {
            None
        }
    }
}

use backend::Placement;
pub(crate) use backend::available;

/// The popup's title, for window-manager diagnostics and test discovery.
const POPUP_TITLE: &str = "Bun Native popup";

/// Below the anchor's bottom-left corner; flipped above the anchor when only
/// that fits vertically; otherwise shifted. Every value is in device pixels.
pub(super) fn place(anchor: Bounds<i32>, popup: Size<i32>, screen: Size<i32>) -> Bounds<i32> {
    let shift = |value: i32, extent: i32, limit: i32| value.min(limit - extent).max(0);
    let below = anchor.origin.y + anchor.size.height;
    let above = anchor.origin.y - popup.height;
    let fits = |y: i32| y >= 0 && y + popup.height <= screen.height;
    let y = if fits(below) {
        below
    } else if fits(above) {
        above
    } else {
        shift(below, popup.height, screen.height)
    };
    Bounds {
        origin: Point {
            x: shift(anchor.origin.x, popup.width, screen.width),
            y,
        },
        size: popup,
    }
}

struct Popup {
    size: Size<Pixels>,
    /// The parent node's bounds in parent-window coordinates, from its paint.
    anchor: Rc<Cell<Option<Bounds<Pixels>>>>,
    /// The popup origin in parent-window coordinates, for pointer events.
    origin: Rc<Cell<Point<Pixels>>>,
    window: Option<WindowHandle<PopupView>>,
    opening: bool,
    placed: Option<Bounds<i32>>,
}

#[derive(Default)]
pub(super) struct Popups {
    live: BTreeMap<NodeId, Popup>,
    /// Tree order of live popups; the last one is topmost.
    order: Vec<NodeId>,
    placement: Option<Placement>,
    unavailable: bool,
}

impl Popups {
    /// The popup that receives the parent window's key events, if any.
    pub(super) fn topmost(&self) -> Option<NodeId> {
        self.order.last().copied()
    }

    /// Whether popup surfaces render as owned windows in this session.
    pub(super) fn enabled(&mut self, cx: &App) -> bool {
        if self.placement.is_none() && !self.unavailable {
            self.placement = Placement::connect(cx);
            self.unavailable = self.placement.is_none();
        }
        self.placement.is_some()
    }

    /// Whether popup surfaces currently render as owned windows.
    pub(super) fn active(&self) -> bool {
        self.placement.is_some()
    }

    /// Forget every placement, so the next pass moves each popup again.
    pub(super) fn invalidate(&mut self) {
        for popup in self.live.values_mut() {
            popup.placed = None;
        }
    }
}

fn popup_sizes(tree: &Tree) -> Vec<(NodeId, Size<Pixels>)> {
    let mut result = Vec::new();
    let mut pending = vec![tree.root_id()];
    while let Some(id) = pending.pop() {
        let Some(node) = tree.node(id) else { continue };
        if let NativeElement::Overlay {
            surface: OverlaySurface::Window,
            style,
            ..
        } = node.element()
        {
            let pixels = |value| match value {
                Some(bun_native_protocol::Dimension::Pixels(value)) => px(value as f32),
                _ => px(1.),
            };
            result.push((id, size(pixels(style.width), pixels(style.height))));
        }
        pending.extend(node.children().iter().rev().copied());
    }
    result
}

impl NativeView {
    /// Called after every commit: open entries for new popup surfaces, resize
    /// changed ones, and close the windows of popups that left the tree.
    pub(super) fn reconcile_popups(&mut self, cx: &mut Context<Self>) {
        if !self.popups.enabled(cx) {
            return;
        }
        let current = if self.index.popups.is_empty() {
            Vec::new()
        } else {
            popup_sizes(&self.state.borrow().tree)
        };
        let mut closed = Vec::new();
        self.popups.live.retain(|id, popup| {
            let alive = current.iter().any(|(live, _)| live == id);
            if !alive && let Some(window) = popup.window.take() {
                closed.push(window);
            }
            alive
        });
        for (id, popup_size) in &current {
            let popup = self.popups.live.entry(*id).or_insert_with(|| Popup {
                size: *popup_size,
                anchor: Rc::default(),
                origin: Rc::default(),
                window: None,
                opening: false,
                placed: None,
            });
            if popup.size != *popup_size {
                popup.size = *popup_size;
                popup.placed = None;
            }
        }
        self.popups.order = current.into_iter().map(|(id, _)| id).collect();
        for window in closed {
            let _ = window.update(cx, |_, window, _| window.remove_window());
        }
    }

    /// The in-flow placeholder of a popup surface: it occupies no space and
    /// measures its parent so the popup can be placed in screen coordinates.
    pub(super) fn popup_anchor(&self, node_id: NodeId) -> Option<AnyElement> {
        let popup = self.popups.live.get(&node_id)?;
        let anchor = popup.anchor.clone();
        let stale = popup.placed.is_none();
        let view = self.weak.clone();
        Some(
            canvas(
                move |bounds, window, cx| {
                    if anchor.replace(Some(bounds)) != Some(bounds) || stale {
                        window.defer(cx, move |window, cx| {
                            let _ = view.update(cx, |view, cx| view.place_popups(window, cx));
                        });
                    }
                },
                |_, (), _, _| {},
            )
            .absolute()
            .top_0()
            .left_0()
            .size_full()
            .into_any_element(),
        )
    }

    /// Place every measured popup; open those without a window. Deferred
    /// opening keeps this view unleased while the popup draws its first frame.
    pub(super) fn place_popups(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(placement) = self.popups.placement.as_ref() else {
            return;
        };
        let Some(parent) = backend::window_id(window) else {
            return;
        };
        let Some(origin) = placement.origin(parent) else {
            return;
        };
        let scale = window.scale_factor();
        let device = |value: Pixels| (f32::from(value) * scale).round() as i32;
        let screen = placement.screen();
        for (id, popup) in &mut self.popups.live {
            let Some(anchor) = popup.anchor.get() else {
                continue;
            };
            let target = place(
                Bounds {
                    origin: Point {
                        x: origin.x + device(anchor.origin.x),
                        y: origin.y + device(anchor.origin.y),
                    },
                    size: Size {
                        width: device(anchor.size.width),
                        height: device(anchor.size.height),
                    },
                },
                Size {
                    width: device(popup.size.width),
                    height: device(popup.size.height),
                },
                screen,
            );
            popup.origin.set(point(
                px((target.origin.x - origin.x) as f32 / scale),
                px((target.origin.y - origin.y) as f32 / scale),
            ));
            match popup.window {
                Some(handle) if popup.placed != Some(target) => {
                    let placed = handle
                        .update(cx, |_, popup_window, _| {
                            backend::window_id(popup_window)
                                .and_then(|xid| placement.place(xid, target))
                        })
                        .ok()
                        .flatten();
                    if placed.is_some() {
                        popup.placed = Some(target);
                    }
                }
                Some(_) => {}
                None if !popup.opening => {
                    popup.opening = true;
                    let node_id = *id;
                    let size = popup.size;
                    let logical = point(
                        px(target.origin.x as f32 / scale),
                        px(target.origin.y as f32 / scale),
                    );
                    let origin = popup.origin.clone();
                    let view = self.weak.clone();
                    cx.defer(move |cx| open(view, node_id, logical, size, origin, cx));
                }
                None => {}
            }
        }
    }

    fn popup_opened(
        &mut self,
        node_id: NodeId,
        handle: WindowHandle<PopupView>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(popup) = self.popups.live.get_mut(&node_id) else {
            // Removed while opening.
            let _ = handle.update(cx, |_, window, _| window.remove_window());
            return;
        };
        popup.opening = false;
        popup.window = Some(handle);
        popup.placed = None;
        if let (Some(placement), Some(parent)) =
            (self.popups.placement.as_ref(), backend::window_id(window))
        {
            let _ = handle.update(cx, |_, popup_window, _| {
                backend::window_id(popup_window).and_then(|xid| placement.own(xid, parent))
            });
        }
        self.place_popups(window, cx);
    }

    /// The parent window stopped being active: ask the application to close
    /// every open popup, outermost first. The host does not remove nodes.
    pub(super) fn dismiss_popups(&self, cx: &mut Context<Self>) {
        let state = self.state.borrow();
        if !state.active {
            return;
        }
        for node_id in &self.popups.order {
            if self
                .popups
                .live
                .get(node_id)
                .is_none_or(|popup| popup.window.is_none())
            {
                continue;
            }
            let Some(path) = state.tree.path(*node_id) else {
                continue;
            };
            self.events.ui(
                |sequence| Event::Dismiss {
                    sequence,
                    window_id: self.window_id,
                    node_id: *node_id,
                    tree_revision: state.tree.revision(),
                    path,
                    reason: DismissReason::WindowBlur,
                },
                cx,
            );
        }
    }

    /// The popup's content, drawn by this view into the popup window.
    fn render_popup(
        &self,
        node_id: NodeId,
        pointer: &PointerFrame,
        cx: &mut Context<Self>,
    ) -> Option<AnyElement> {
        let state = self.state.borrow();
        let tree = &state.tree;
        let element = tree.node(node_id)?.element();
        let NativeElement::Overlay {
            surface: OverlaySurface::Window,
            ..
        } = element
        else {
            return None;
        };
        let mut base = div();
        pointer.target(&mut base, node_id);
        let mut base = super::accessibility::container(base.id(node_id.get()), element, false);
        style::element(base.style(), element, false);
        // External drags target the parent window; a popup surface holds no
        // drop target of its own.
        let drop_scope = DropScope::new(Default::default());
        let modal_route = self.modal_route(tree);
        let modal = ModalScope::of(tree, &modal_route, node_id);
        Some(
            self.container(tree, node_id, base, None, pointer, &drop_scope, modal, cx)
                .size_full()
                .into_any_element(),
        )
    }
}

fn open(
    view: WeakEntity<NativeView>,
    node_id: NodeId,
    origin: Point<Pixels>,
    popup_size: Size<Pixels>,
    pointer_origin: Rc<Cell<Point<Pixels>>>,
    cx: &mut App,
) {
    let Some(parent) = view.upgrade() else {
        return;
    };
    let result = cx.open_window(
        WindowOptions {
            window_bounds: Some(WindowBounds::Windowed(Bounds {
                origin,
                size: popup_size,
            })),
            titlebar: Some(TitlebarOptions {
                title: Some(POPUP_TITLE.into()),
                ..Default::default()
            }),
            focus: false,
            kind: WindowKind::PopUp,
            is_movable: false,
            is_resizable: false,
            is_minimizable: false,
            app_id: Some("dev.bunnative.host".into()),
            ..Default::default()
        },
        {
            let parent = parent.clone();
            move |window, cx| {
                cx.new(|cx| PopupView::new(parent, node_id, pointer_origin, window, cx))
            }
        },
    );
    let Ok(handle) = result else {
        eprintln!("Bun Native popup window creation failed");
        parent.update(cx, |view, _| {
            if let Some(popup) = view.popups.live.get_mut(&node_id) {
                popup.opening = false;
            }
        });
        return;
    };
    let parent_window = parent.read(cx).window_handle;
    let _ = parent_window.update(cx, |_, window, cx| {
        parent.update(cx, |view, cx| {
            view.popup_opened(node_id, handle, window, cx)
        })
    });
}

pub(crate) struct PopupView {
    parent: WeakEntity<NativeView>,
    node_id: NodeId,
    origin: Rc<Cell<Point<Pixels>>>,
    pressed: PressedButtons,
    _subscriptions: [gpui::Subscription; 2],
}

impl PopupView {
    fn new(
        parent: Entity<NativeView>,
        node_id: NodeId,
        origin: Rc<Cell<Point<Pixels>>>,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let changed = cx.observe(&parent, |_, _, cx| cx.notify());
        // The parent view is released when its window closes or the session
        // ends; the popup never outlives it.
        let released =
            cx.observe_release_in(&parent, window, |_, _, window, _| window.remove_window());
        Self {
            parent: parent.downgrade(),
            node_id,
            origin,
            pressed: PressedButtons::default(),
            _subscriptions: [changed, released],
        }
    }
}

impl Render for PopupView {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let pointer = PointerFrame::default();
        let node_id = self.node_id;
        let body = self
            .parent
            .update(cx, |view, cx| view.render_popup(node_id, &pointer, cx))
            .ok()
            .flatten();
        let parent = self.parent.clone();
        let origin = self.origin.clone();
        let pressed = self.pressed.clone();
        div()
            .size_full()
            .relative()
            .overflow_hidden()
            .bg(rgb(0xffffff))
            .text_color(rgb(0x17212b))
            .text_size(px(18.))
            .children(body)
            .child(
                canvas(
                    |_, _, _| (),
                    move |_, (), window, _| {
                        pointer.observe(window, &parent, origin.get(), &pressed)
                    },
                )
                .absolute()
                .top_0()
                .left_0()
                .size(px(1.)),
            )
    }
}

#[cfg(test)]
mod tests {
    use super::place;
    use gpui::{Bounds, Point, Size};

    fn bounds(x: i32, y: i32, width: i32, height: i32) -> Bounds<i32> {
        Bounds {
            origin: Point { x, y },
            size: Size { width, height },
        }
    }
    const SCREEN: Size<i32> = Size {
        width: 1280,
        height: 800,
    };

    #[test]
    fn popups_open_below_flip_above_and_shift_onto_the_screen() {
        let popup = Size {
            width: 200,
            height: 150,
        };
        // Below the anchor, even beyond the parent window.
        assert_eq!(
            place(bounds(100, 100, 80, 40), popup, SCREEN),
            bounds(100, 140, 200, 150)
        );
        // Off the right edge: shifted left, still below.
        assert_eq!(
            place(bounds(1200, 100, 80, 40), popup, SCREEN),
            bounds(1080, 140, 200, 150)
        );
        // No room below: flipped above the anchor.
        assert_eq!(
            place(bounds(100, 700, 80, 40), popup, SCREEN),
            bounds(100, 550, 200, 150)
        );
        // Off the left/top edges: shifted onto the screen.
        assert_eq!(
            place(bounds(-50, -100, 80, 40), popup, SCREEN),
            bounds(0, 0, 200, 150)
        );
        // Taller than the space above and below: shifted to fit the bottom.
        let tall = Size {
            width: 200,
            height: 700,
        };
        assert_eq!(
            place(bounds(100, 300, 80, 40), tall, SCREEN),
            bounds(100, 100, 200, 700)
        );
        // Larger than the screen: pinned to its origin.
        let huge = Size {
            width: 2000,
            height: 900,
        };
        assert_eq!(
            place(bounds(100, 300, 80, 40), huge, SCREEN),
            bounds(0, 0, 2000, 900)
        );
    }
}
