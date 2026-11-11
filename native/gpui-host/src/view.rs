use crate::{
    channel::EventSink,
    evidence::{Evidence, LayoutFrame},
    input::{EditPolicy, InputBinding, TextInput},
    services::drops::Drops,
    state::SharedWindowState,
    style,
};
use bun_native_protocol::{
    DropTargetId, Element as NativeElement, Event, Node, NodeId, Overflow, OverlaySurface,
    ScrollAnchor, Tree, ViewRequest, WindowId,
};
use gpui::{
    AnyElement, AnyWindowHandle, App, Context, Div, ElementId, Entity, ExternalPaths, FocusHandle,
    Focusable, KeyBinding, MouseButton, Pixels, Role, ScrollHandle, SharedString, Size, Stateful,
    Subscription, WeakEntity, Window, actions, canvas, deferred, div, point, prelude::*, px, rgb,
};
use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet};
use std::rc::Rc;
use std::time::Instant;

actions!(native_button, [ActivateButton]);
actions!(native_window, [FocusNext, FocusPrevious]);
actions!(native_menu, [MenuNext, MenuPrevious, MenuFirst, MenuLast]);

pub(crate) fn bind_keys(cx: &mut App) {
    cx.bind_keys([
        KeyBinding::new("enter", ActivateButton, Some("NativeButton")),
        KeyBinding::new("space", ActivateButton, Some("NativeButton")),
        KeyBinding::new("tab", FocusNext, Some("NativeWindow")),
        KeyBinding::new("shift-tab", FocusPrevious, Some("NativeWindow")),
        // A focused input's own Home/End bindings are deeper and win.
        KeyBinding::new("down", MenuNext, Some("NativeWindow")),
        KeyBinding::new("up", MenuPrevious, Some("NativeWindow")),
        KeyBinding::new("home", MenuFirst, Some("NativeWindow")),
        KeyBinding::new("end", MenuLast, Some("NativeWindow")),
    ]);
    split::bind_keys(cx);
}

pub(crate) struct NativeView {
    window_id: WindowId,
    state: SharedWindowState,
    inputs: BTreeMap<NodeId, Entity<TextInput>>,
    buttons: BTreeMap<NodeId, FocusHandle>,
    scrolls: BTreeMap<NodeId, ScrollHandle>,
    index: NodeIndex,
    splits: Splits,
    /// Never a tab stop or reported node. Holding it keeps the window's key
    /// context on the dispatch path, so Tab still works after a focused
    /// control is disabled or removed, or before any control is focused.
    root_focus: FocusHandle,
    focus_subscriptions: BTreeMap<NodeId, [Subscription; 2]>,
    reported_focus: Option<NodeId>,
    overlays: Overlays,
    type_ahead: TypeAhead,
    /// Viewports with a pending programmatic scroll this frame; their end
    /// anchor does not re-pin them before GPUI resolves the request.
    held_scrolls: RefCell<BTreeSet<NodeId>>,
    popups: Popups,
    weak: WeakEntity<NativeView>,
    window_handle: AnyWindowHandle,
    viewport: Size<Pixels>,
    _subscriptions: [Subscription; 4],
    events: EventSink,
    drops: Drops,
    pressed: PressedButtons,
    evidence: Evidence,
    /// Whether the last render saw GPUI's active drag (for the drag trace).
    drag_seen: bool,
    #[cfg(target_os = "macos")]
    frame_keeper: frame_keeper::FrameKeeper,
}

impl NativeView {
    pub(crate) fn new(
        window_id: WindowId,
        state: SharedWindowState,
        events: EventSink,
        drops: Drops,
        evidence: Evidence,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let owned_window = window.window_handle();
        #[cfg(target_os = "linux")]
        key_forwarding::start(cx);
        let view = cx.weak_entity();
        let keyboard = cx.intercept_keystrokes(move |event, window, cx| {
            if window.window_handle() == owned_window {
                let _ = view.update(cx, |view, cx| {
                    // GPUI draws a dirty window before dispatching a key, and
                    // that draw presents nothing: mark where it happened.
                    #[cfg(target_os = "macos")]
                    view.evidence.surface_presentation(
                        "key_dispatched",
                        view.window_id,
                        &view.state.borrow().tree,
                        window,
                    );
                    view.key(&event.keystroke, true, window, cx);
                    view.type_ahead(&event.keystroke, window, cx);
                });
            }
        });
        let focus_lost = cx.on_focus_lost(window, |view, window, cx| view.sync_focus(window, cx));
        let deactivated = cx.observe_window_activation(window, |view, window, cx| {
            if !window.is_window_active() {
                view.dismiss_popups(cx);
            }
        });
        let moved = cx.observe_window_bounds(window, |view, window, cx| {
            view.popups.invalidate();
            view.place_popups(window, cx);
        });
        let index = NodeIndex::new(&state.borrow().tree);
        Self {
            window_id,
            state,
            inputs: BTreeMap::new(),
            buttons: BTreeMap::new(),
            scrolls: BTreeMap::new(),
            index,
            splits: Splits::default(),
            root_focus: cx.focus_handle(),
            focus_subscriptions: BTreeMap::new(),
            reported_focus: None,
            overlays: Overlays::default(),
            type_ahead: TypeAhead::default(),
            held_scrolls: RefCell::default(),
            popups: Popups::default(),
            weak: cx.weak_entity(),
            window_handle: window.window_handle(),
            viewport: window.viewport_size(),
            _subscriptions: [keyboard, focus_lost, deactivated, moved],
            events,
            drops,
            pressed: PressedButtons::default(),
            evidence,
            drag_seen: false,
            #[cfg(target_os = "macos")]
            frame_keeper: frame_keeper::FrameKeeper::default(),
        }
    }

    /// Called synchronously after complete transaction preflight. This method
    /// does not yield or dispatch native input between model and entity updates.
    pub(crate) fn apply(
        &mut self,
        tree: Tree,
        requests: &[ViewRequest],
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let focused_before = self.focused_control(window, cx);
        self.drops.retain_nodes(self.window_id, &tree);
        let previous = std::mem::replace(&mut self.state.borrow_mut().tree, tree);
        if self.splits.reconcile(&self.state.borrow().tree, window, cx) {
            window.focus(&self.root_focus, cx);
        }
        // Snapshot cheap Arc-backed control properties before focus/IME
        // notifications: native callbacks must never run while the shared
        // model is borrowed. Sorted by ID, like the index it is read from.
        let controls: Vec<(NodeId, Node)> = {
            let state = self.state.borrow();
            self.index.sync(&previous, &state.tree);
            self.index
                .controls
                .iter()
                .map(|id| {
                    let node = state.tree.node(*id).expect("indexed control is committed");
                    (*id, node.clone())
                })
                .collect()
        };
        drop(previous);
        self.scrolls
            .retain(|id, _| self.index.scroll_modes.contains_key(id));
        for (id, mode) in &self.index.scroll_modes {
            let handle = self.scrolls.entry(*id).or_default();
            let mut offset = handle.offset();
            if *mode == Overflow::ScrollX {
                offset.y = px(0.);
            } else if *mode == Overflow::ScrollY {
                offset.x = px(0.);
            }
            handle.set_offset(offset);
        }
        let control = |id: &NodeId| {
            controls
                .binary_search_by_key(id, |(id, _)| *id)
                .ok()
                .map(|position| &controls[position].1)
        };
        self.inputs.retain(|id, input| {
            if self.index.controls.contains(id) {
                return true;
            }
            if input.focus_handle(cx).is_focused(window) {
                window.focus(&self.root_focus, cx);
            }
            false
        });
        self.buttons.retain(|id, focus| {
            let node = control(id);
            let enabled = node.is_some_and(|node| {
                matches!(
                    node.element(),
                    NativeElement::Button {
                        disabled: false,
                        ..
                    }
                )
            });
            if !enabled && focus.is_focused(window) {
                window.focus(&self.root_focus, cx);
            }
            node.is_some()
        });
        for (node_id, node) in controls {
            match node.element() {
                NativeElement::Input {
                    value,
                    placeholder,
                    disabled,
                    read_only,
                    ..
                } => {
                    let policy = EditPolicy {
                        disabled: *disabled,
                        read_only: *read_only,
                    };
                    if let Some(input) = self.inputs.get(&node_id) {
                        input.update(cx, |input, cx| {
                            input.set_properties(value, placeholder, policy, window, cx)
                        });
                        if policy.disabled && input.focus_handle(cx).is_focused(window) {
                            window.focus(&self.root_focus, cx);
                        }
                    } else {
                        let binding = InputBinding {
                            state: Rc::downgrade(&self.state),
                            window_id: self.window_id,
                            node_id,
                            events: self.events.clone(),
                        };
                        let input = cx.new(|cx| {
                            TextInput::new(value.clone(), placeholder.clone(), policy, binding, cx)
                        });
                        if !policy.disabled
                            && window
                                .focused(cx)
                                .is_none_or(|focus| focus == self.root_focus)
                        {
                            window.focus(&input.focus_handle(cx), cx);
                        }
                        self.inputs.insert(node_id, input);
                    }
                }
                NativeElement::Button { .. } => {
                    self.buttons
                        .entry(node_id)
                        .or_insert_with(|| cx.focus_handle().tab_stop(true));
                }
                NativeElement::Box { .. }
                | NativeElement::Text { .. }
                | NativeElement::Split { .. }
                | NativeElement::Overlay { .. } => {}
            }
        }
        self.reconcile_overlays(focused_before, window, cx);
        self.sync_input_accessibility(cx);
        self.reconcile_popups(cx);
        if window.focused(cx).is_none() {
            window.focus(&self.root_focus, cx);
        }
        self.reconcile_focus(window, cx);
        self.apply_requests(requests, window, cx);
        cx.notify();
        #[cfg(target_os = "macos")]
        {
            window.refresh();
            // GPUI's Metal surface is a layer-backed view with a custom
            // displayLayer: delegate. Dirty the backing layer itself so its
            // normal deferred display pass also serves external commits when
            // the display link is idle. This never draws inside this update.
            let handle = raw_window_handle::HasWindowHandle::window_handle(window)
                .expect("an owned macOS GPUI window exposes its native view");
            bun_native_macos_surface::invalidate(handle)
                .expect("GPUI updates its backed surface on the AppKit owner thread");
            let state = self.state.borrow();
            self.evidence.frame_schedule(
                "layer_invalidated",
                self.window_id,
                state.tree.revision(),
            );
            self.evidence.surface_presentation(
                "layer_invalidated",
                self.window_id,
                &state.tree,
                window,
            );
        }
    }

    fn click(&self, node_id: NodeId, cx: &mut Context<Self>) {
        let state = self.state.borrow();
        if state.active
            && state.tree.node(node_id).is_some_and(|node| {
                matches!(
                    node.element(),
                    NativeElement::Button {
                        disabled: false,
                        ..
                    }
                )
            })
        {
            self.events.ui(
                |sequence| Event::Click {
                    sequence,
                    window_id: self.window_id,
                    node_id,
                    tree_revision: state.tree.revision(),
                    path: state
                        .tree
                        .path(node_id)
                        .expect("live button has a committed route"),
                },
                cx,
            );
        }
    }

    fn label(&self, node_id: NodeId) -> SharedString {
        self.index
            .labels
            .get(&node_id)
            .expect("label reconciled before render")
            .clone()
    }

    fn render_node(
        &self,
        tree: &Tree,
        node_id: NodeId,
        layout: Option<&LayoutFrame>,
        pointer: &PointerFrame,
        drop_scope: &DropScope,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let node = tree
            .node(node_id)
            .expect("validated tree contains every child");
        let mut base = div();
        // A split reports each pane's child from inside its pane wrapper.
        if let Some(layout) = layout
            && !matches!(node.element(), NativeElement::Split { .. })
        {
            base = layout.children(base, node.children(), 0, self.scrolls.get(&node_id));
        }
        pointer.target(&mut base, node_id);
        let mut base = base.id(node_id.get());
        style::element(base.style(), node.element(), node_id == tree.root_id());
        let drop_scope = drop_scope.enter(node_id);
        if let Some(chain) = drop_scope.target() {
            base = drop_target(base, chain, &self.drops);
        }
        let hidden = accessibility::beneath_modal(tree, node_id, self.overlays.active_modal());
        let base = accessibility::container(base, node.element(), hidden);
        match node.element() {
            NativeElement::Box { .. } => self
                .container(tree, node_id, base, layout, pointer, &drop_scope, cx)
                .into_any_element(),
            NativeElement::Overlay {
                surface: OverlaySurface::Window,
                ..
            } if self.popups.active() => self
                .popup_anchor(node_id)
                .unwrap_or_else(|| div().into_any_element()),
            NativeElement::Overlay { anchor, .. } => {
                // Occlusion keeps pointer input from reaching anything beneath
                // the layer; a window layer is itself the modal backdrop.
                let content = self
                    .container(tree, node_id, base, layout, pointer, &drop_scope, cx)
                    .occlude();
                self.overlay_layer(node_id, *anchor, content, self.viewport)
            }
            NativeElement::Split {
                min_size,
                style: properties,
                ..
            } => self.split(
                tree,
                node_id,
                base,
                *min_size,
                properties,
                layout,
                pointer,
                &drop_scope,
                cx,
            ),
            NativeElement::Text {
                accessible_live, ..
            } => accessibility::live_states(
                // AccessKit names labels from their value.
                base.role(Role::Label).aria_value(self.label(node_id)),
                false,
                hidden,
                *accessible_live,
            )
            .child(self.label(node_id))
            .into_any_element(),
            NativeElement::Button { disabled, .. } => {
                let mut button = accessibility::states(
                    base.role(Role::Button).aria_label(self.label(node_id)),
                    *disabled,
                    hidden,
                )
                .child(self.label(node_id));
                if !disabled {
                    let focus = self
                        .buttons
                        .get(&node_id)
                        .expect("button reconciled before render")
                        .clone();
                    button = button
                        .track_focus(&focus)
                        .focus_visible(|style| style.shadow(style::focus_ring()))
                        .key_context("NativeButton")
                        .cursor_pointer()
                        .on_mouse_down(MouseButton::Left, move |_, window, cx| {
                            window.focus(&focus, cx)
                        })
                        .on_click(cx.listener(move |view, _, _, cx| view.click(node_id, cx)))
                        .on_action(cx.listener(move |view, _: &ActivateButton, _, cx| {
                            view.click(node_id, cx)
                        }));
                }
                button.into_any_element()
            }
            NativeElement::Input { .. } => base
                .child(
                    self.inputs
                        .get(&node_id)
                        .expect("input reconciled before render")
                        .clone(),
                )
                .into_any_element(),
        }
    }
}

impl NativeView {
    #[allow(clippy::too_many_arguments)]
    fn container(
        &self,
        tree: &Tree,
        node_id: NodeId,
        base: Stateful<Div>,
        layout: Option<&LayoutFrame>,
        pointer: &PointerFrame,
        drop_scope: &DropScope,
        cx: &mut Context<Self>,
    ) -> Stateful<Div> {
        let node = tree
            .node(node_id)
            .expect("validated tree contains every container");
        let mut container = base;
        if let Some(handle) = self.scrolls.get(&node_id) {
            // A viewport already showing its end stays there as content or
            // the viewport changes; a user scroll away from the end releases it.
            if node.element().style().scroll_anchor == Some(ScrollAnchor::End)
                && !self.held_scrolls.borrow().contains(&node_id)
                && handle.offset().y <= -handle.max_offset().y + px(1.)
            {
                handle.scroll_to_bottom();
            }
            container = container.track_scroll(handle);
        }
        container.children(
            node.children()
                .iter()
                .map(|child| self.render_node(tree, *child, layout, pointer, drop_scope, cx)),
        )
    }
}

impl Render for NativeView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let render_started = Instant::now();
        let phase_started = crate::phases::now();
        self.viewport = window.viewport_size();
        // GPUI ends an external drag on drop, on the source's leave and when
        // the button is released outside every target; each refreshes.
        let dragging = cx.has_active_drag();
        if dragging != self.drag_seen {
            self.drag_seen = dragging;
            crate::phases::drag(if dragging {
                crate::phases::DragStep::Active
            } else {
                crate::phases::DragStep::Cleared
            });
        }
        if !dragging {
            self.drops.resume();
            self.drops.drag_ended(self.window_id, cx);
        }
        self.finish_divider_drags(cx);
        let drop_scope = DropScope::new(self.drops.targets(self.window_id));
        let state = self.state.borrow();
        let layout = self.evidence.layout_tracing().then(|| {
            let focus = self
                .buttons
                .iter()
                .map(|(id, focus)| (*id, focus.clone()))
                .chain(
                    self.splits
                        .focus_handles()
                        .map(|(id, focus)| (id, focus.clone())),
                )
                .chain(
                    self.inputs
                        .iter()
                        .map(|(id, input)| (*id, input.focus_handle(cx))),
                );
            let frame = LayoutFrame::new(state.tree.nodes().count(), &self.scrolls, focus);
            if self.evidence.input_viewport_tracing() {
                frame.with_inputs(
                    self.inputs
                        .iter()
                        .map(|(id, input)| (*id, input.downgrade())),
                )
            } else {
                frame
            }
        });
        let pointer = PointerFrame::default();
        let pressed = self.pressed.clone();
        let body = self.render_node(
            &state.tree,
            state.tree.root_id(),
            layout.as_ref(),
            &pointer,
            &drop_scope,
            cx,
        );
        // Requests issued before this frame resolve in its prepaint.
        self.held_scrolls.borrow_mut().clear();
        let phase_frame = phase_started.and_then(|started| {
            crate::phases::render(self.window_id, started, state.tree.nodes().count())
        });
        let view = cx.weak_entity();
        let evidence = self.evidence.clone();
        let paint_state = self.state.clone();
        let window_id = self.window_id;
        let pointer_trace = self.evidence.pointer_tracing().then(|| {
            let evidence = self.evidence.clone();
            canvas(
                |_, _, _| (),
                move |_, (), window, _| evidence.observe_pointer(window_id, window),
            )
            .absolute()
            .top_0()
            .left_0()
            .size(px(1.))
        });
        #[cfg(target_os = "macos")]
        let frame_keeper = self.frame_keeper.clone();
        let mut base = div();
        if let Some(layout) = &layout {
            base = layout.children(
                base,
                &[state.tree.root_id()],
                usize::from(pointer_trace.is_some()),
                None,
            );
        }
        base.id(ElementId::NamedInteger(
            "accessibility-exposure".into(),
            self.overlays.exposure(),
        ))
        .size_full()
        .relative()
        .overflow_hidden()
        .bg(rgb(0xffffff))
        .text_color(rgb(0x17212b))
        .text_size(px(18.))
        .key_context("NativeWindow")
        .track_focus(&self.root_focus)
        .capture_key_up(cx.listener(|view, event: &gpui::KeyUpEvent, window, cx| {
            view.key(&event.keystroke, false, window, cx)
        }))
        .on_action(cx.listener(|view, _: &FocusNext, window, cx| view.focus_step(true, window, cx)))
        .on_action(
            cx.listener(|view, _: &FocusPrevious, window, cx| view.focus_step(false, window, cx)),
        )
        .on_action(cx.listener(|view, _: &MenuNext, window, cx| {
            view.menu_action(MenuMove::Next, window, cx)
        }))
        .on_action(cx.listener(|view, _: &MenuPrevious, window, cx| {
            view.menu_action(MenuMove::Previous, window, cx)
        }))
        .on_action(cx.listener(|view, _: &MenuFirst, window, cx| {
            view.menu_action(MenuMove::First, window, cx)
        }))
        .on_action(cx.listener(|view, _: &MenuLast, window, cx| {
            view.menu_action(MenuMove::Last, window, cx)
        }))
        .children(pointer_trace)
        .child(body)
        .child(
            self.observer(
                canvas(
                    |_, _, _| (),
                    move |_, (), window, cx| {
                        // Registered after native children: capture has already
                        // selected the deepest GPUI hit before default actions.
                        pointer.observe(window, &view, point(px(0.), px(0.)), &pressed);
                        if let Some(frame) = phase_frame {
                            crate::phases::painted(frame);
                        }
                        #[cfg(target_os = "macos")]
                        frame_keeper.painted(window_id, &evidence, window);
                        let state = paint_state.borrow();
                        #[cfg(target_os = "macos")]
                        evidence.surface_presentation("painted", window_id, &state.tree, window);
                        evidence.frame(window_id, &state.tree, render_started);
                        evidence.painted(
                            window_id,
                            &state.tree,
                            layout.as_ref().map(|layout| layout.snapshot(window, cx)),
                        );
                    },
                )
                .absolute()
                .top_0()
                .left_0()
                .size(px(1.)),
            ),
        )
    }
}

impl NativeView {
    fn menu_action(&mut self, step: MenuMove, window: &mut Window, cx: &mut Context<Self>) {
        if !self.menu_move(step, window, cx) {
            cx.propagate();
        }
    }

    /// The final pointer observer must register after every overlay layer's
    /// capture listeners, so it is deferred above them while any overlay lives.
    fn observer(&self, observer: impl IntoElement) -> AnyElement {
        if self.overlays.any() {
            deferred(observer)
                .with_priority(OBSERVER_PRIORITY)
                .into_any_element()
        } else {
            observer.into_any_element()
        }
    }
}

/// The registered drop targets and, while rendering, the chain of target
/// ancestors above the current node, innermost first.
struct DropScope {
    targets: Rc<BTreeMap<NodeId, DropTargetId>>,
    chain: Rc<[DropTargetId]>,
    own: bool,
}

impl DropScope {
    fn new(targets: BTreeMap<NodeId, DropTargetId>) -> Self {
        Self {
            targets: Rc::new(targets),
            chain: Rc::new([]),
            own: false,
        }
    }

    fn enter(&self, node: NodeId) -> Self {
        let Some(target) = self.targets.get(&node) else {
            return Self {
                targets: self.targets.clone(),
                chain: self.chain.clone(),
                own: false,
            };
        };
        Self {
            targets: self.targets.clone(),
            chain: std::iter::once(*target)
                .chain(self.chain.iter().copied())
                .collect(),
            own: true,
        }
    }

    /// This node's own target and its ancestors, when it is a target.
    fn target(&self) -> Option<Rc<[DropTargetId]>> {
        self.own.then(|| self.chain.clone())
    }
}

/// GPUI hit tests the drop: the innermost hovered target takes it. Drag
/// enter/leave compare the pointer with the target's painted bounds.
fn drop_target(
    element: Stateful<gpui::Div>,
    chain: Rc<[DropTargetId]>,
    drops: &Drops,
) -> Stateful<gpui::Div> {
    let target = chain[0];
    let moved = drops.clone();
    let dropped = drops.clone();
    element
        .on_drag_move::<ExternalPaths>(move |event, _, cx| {
            crate::phases::drag(crate::phases::DragStep::TargetMove);
            moved.drag_moved(target, event.bounds.contains(&event.event.position), cx)
        })
        .on_drop::<ExternalPaths>(move |paths, _, cx| dropped.dropped(&chain, paths.paths(), cx))
}

mod accessibility;
#[cfg(target_os = "macos")]
mod frame_keeper;
mod index;
mod interactions;
#[cfg(target_os = "linux")]
mod key_forwarding;
mod keyboard;
mod overlays;
mod popups;
mod split;

use index::NodeIndex;
use interactions::{PointerFrame, PressedButtons};
use keyboard::{MenuMove, TypeAhead};
use overlays::{OBSERVER_PRIORITY, Overlays};
use popups::Popups;
pub(crate) use popups::available as popups_available;
use split::Splits;
