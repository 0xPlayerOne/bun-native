use crate::{
    channel::EventSink,
    evidence::{Evidence, LayoutFrame},
    input::{InputBinding, TextInput},
    state::SharedWindowState,
    style,
};
use bun_native_protocol::{
    Element as NativeElement, Event, NodeId, Overflow, ScrollAnchor, Style, Tree, ViewRequest,
    WindowId,
};
use gpui::{
    AnyElement, App, Context, Div, Entity, FocusHandle, Focusable, KeyBinding, MouseButton, Pixels,
    ScrollHandle, Size, Stateful, Subscription, Window, actions, canvas, deferred, div, prelude::*,
    px, rgb,
};
use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet};
use std::rc::Rc;

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
}

pub(crate) struct NativeView {
    window_id: WindowId,
    state: SharedWindowState,
    inputs: BTreeMap<NodeId, Entity<TextInput>>,
    buttons: BTreeMap<NodeId, FocusHandle>,
    scrolls: BTreeMap<NodeId, ScrollHandle>,
    focus_subscriptions: BTreeMap<NodeId, [Subscription; 2]>,
    reported_focus: Option<NodeId>,
    overlays: Overlays,
    type_ahead: TypeAhead,
    /// Viewports with a pending programmatic scroll this frame; their end
    /// anchor does not re-pin them before GPUI resolves the request.
    held_scrolls: RefCell<BTreeSet<NodeId>>,
    viewport: Size<Pixels>,
    _subscriptions: [Subscription; 2],
    events: EventSink,
    evidence: Evidence,
}

impl NativeView {
    pub(crate) fn new(
        window_id: WindowId,
        state: SharedWindowState,
        events: EventSink,
        evidence: Evidence,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let owned_window = window.window_handle();
        let view = cx.weak_entity();
        let keyboard = cx.intercept_keystrokes(move |event, window, cx| {
            if window.window_handle() == owned_window {
                let _ = view.update(cx, |view, cx| {
                    view.key(&event.keystroke, true, window, cx);
                    view.type_ahead(&event.keystroke, window, cx);
                });
            }
        });
        let focus_lost = cx.on_focus_lost(window, |view, window, cx| view.sync_focus(window, cx));
        Self {
            window_id,
            state,
            inputs: BTreeMap::new(),
            buttons: BTreeMap::new(),
            scrolls: BTreeMap::new(),
            focus_subscriptions: BTreeMap::new(),
            reported_focus: None,
            overlays: Overlays::default(),
            type_ahead: TypeAhead::default(),
            held_scrolls: RefCell::default(),
            viewport: window.viewport_size(),
            _subscriptions: [keyboard, focus_lost],
            events,
            evidence,
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
        self.state.borrow_mut().tree = tree;
        // Snapshot cheap Arc-backed properties before focus/IME notifications:
        // native callbacks must never run while the shared model is borrowed.
        let (controls, scroll_modes) = {
            let state = self.state.borrow();
            let mut controls = BTreeMap::new();
            let mut scroll_modes = BTreeMap::new();
            for (id, node) in state.tree.nodes() {
                if matches!(
                    node.element(),
                    NativeElement::Input { .. } | NativeElement::Button { .. }
                ) {
                    controls.insert(id, node.clone());
                }
                if let Some(mode) = node
                    .element()
                    .style()
                    .overflow
                    .filter(|mode| mode.scrolls())
                {
                    scroll_modes.insert(id, mode);
                }
            }
            (controls, scroll_modes)
        };
        self.scrolls.retain(|id, _| scroll_modes.contains_key(id));
        for (id, mode) in scroll_modes {
            let handle = self.scrolls.entry(id).or_default();
            let mut offset = handle.offset();
            if mode == Overflow::ScrollX {
                offset.y = px(0.);
            } else if mode == Overflow::ScrollY {
                offset.x = px(0.);
            }
            handle.set_offset(offset);
        }
        self.inputs.retain(|id, input| {
            if controls.contains_key(id) {
                return true;
            }
            if input.focus_handle(cx).is_focused(window) {
                window.blur(cx);
            }
            false
        });
        self.buttons.retain(|id, focus| {
            let enabled = controls.get(id).is_some_and(|node| {
                matches!(
                    node.element(),
                    NativeElement::Button {
                        disabled: false,
                        ..
                    }
                )
            });
            if !enabled && focus.is_focused(window) {
                window.blur(cx);
            }
            controls.contains_key(id)
        });
        for (node_id, node) in controls {
            match node.element() {
                NativeElement::Input {
                    value, placeholder, ..
                } => {
                    if let Some(input) = self.inputs.get(&node_id) {
                        input.update(cx, |input, cx| {
                            input.set_properties(value, placeholder, window, cx)
                        });
                    } else {
                        let binding = InputBinding {
                            state: Rc::downgrade(&self.state),
                            window_id: self.window_id,
                            node_id,
                            events: self.events.clone(),
                        };
                        let input = cx.new(|cx| {
                            TextInput::new(value.clone(), placeholder.clone(), binding, cx)
                        });
                        if window.focused(cx).is_none() {
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
                | NativeElement::Overlay { .. } => {}
            }
        }
        self.reconcile_overlays(focused_before, window, cx);
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
            self.evidence.frame_schedule(
                "layer_invalidated",
                self.window_id,
                self.state.borrow().tree.revision(),
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

    fn render_node(
        &self,
        tree: &Tree,
        node_id: NodeId,
        layout: Option<&LayoutFrame>,
        pointer: &PointerFrame,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let node = tree
            .node(node_id)
            .expect("validated tree contains every child");
        let mut base = div().flex_shrink_0();
        if let Some(layout) = layout {
            base = layout.children(base, node.children(), 0, self.scrolls.get(&node_id));
        }
        let base = pointer.target(base, node_id).id(node_id.get());
        match node.element() {
            NativeElement::Box { style: properties } => {
                let base = if node_id == tree.root_id() {
                    base.size_full()
                } else {
                    base
                };
                self.container(tree, node_id, base, properties, layout, pointer, cx)
                    .into_any_element()
            }
            NativeElement::Overlay {
                anchor,
                style: properties,
                ..
            } => {
                // Occlusion keeps pointer input from reaching anything beneath
                // the layer; a window layer is itself the modal backdrop.
                let content = self
                    .container(tree, node_id, base, properties, layout, pointer, cx)
                    .occlude();
                self.overlay_layer(node_id, *anchor, content, self.viewport)
            }
            NativeElement::Text {
                text,
                style: properties,
            } => style::apply(base, properties)
                .child(text.clone())
                .into_any_element(),
            NativeElement::Button {
                text,
                disabled,
                style: properties,
            } => {
                let mut button = style::apply(
                    base.flex()
                        .items_center()
                        .justify_center()
                        .h(px(44.))
                        .px(px(12.))
                        .bg(rgb(if *disabled { 0x7a8396 } else { 0x2255cc }))
                        .text_color(rgb(0xffffff)),
                    properties,
                )
                .child(text.clone());
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
            NativeElement::Input {
                style: properties, ..
            } => style::apply(base.bg(rgb(0xffffff)), properties)
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
        properties: &Style,
        layout: Option<&LayoutFrame>,
        pointer: &PointerFrame,
        cx: &mut Context<Self>,
    ) -> Stateful<Div> {
        let mut container = style::apply(base.flex().flex_col(), properties);
        if let Some(handle) = self.scrolls.get(&node_id) {
            // A viewport already showing its end stays there as content or
            // the viewport changes; a user scroll away from the end releases it.
            if properties.scroll_anchor == Some(ScrollAnchor::End)
                && !self.held_scrolls.borrow().contains(&node_id)
                && handle.offset().y <= -handle.max_offset().y + px(1.)
            {
                handle.scroll_to_bottom();
            }
            container = container.track_scroll(handle);
        }
        container.children(
            tree.node(node_id)
                .expect("validated tree contains every child")
                .children()
                .iter()
                .map(|child| self.render_node(tree, *child, layout, pointer, cx)),
        )
    }
}

impl Render for NativeView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.viewport = window.viewport_size();
        let state = self.state.borrow();
        let layout = self.evidence.enabled().then(|| {
            let focus = self
                .buttons
                .iter()
                .map(|(id, focus)| (*id, focus.clone()))
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
        let body = self.render_node(
            &state.tree,
            state.tree.root_id(),
            layout.as_ref(),
            &pointer,
            cx,
        );
        // Requests issued before this frame resolve in its prepaint.
        self.held_scrolls.borrow_mut().clear();
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
        let mut base = div();
        if let Some(layout) = &layout {
            base = layout.children(
                base,
                &[state.tree.root_id()],
                usize::from(pointer_trace.is_some()),
                None,
            );
        }
        base.size_full()
            .relative()
            .overflow_hidden()
            .bg(rgb(0xffffff))
            .text_color(rgb(0x17212b))
            .text_size(px(18.))
            .key_context("NativeWindow")
            .capture_key_up(cx.listener(|view, event: &gpui::KeyUpEvent, window, cx| {
                view.key(&event.keystroke, false, window, cx)
            }))
            .on_action(
                cx.listener(|view, _: &FocusNext, window, cx| view.focus_step(true, window, cx)),
            )
            .on_action(
                cx.listener(|view, _: &FocusPrevious, window, cx| {
                    view.focus_step(false, window, cx)
                }),
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
                            pointer.observe(window, &view);
                            let state = paint_state.borrow();
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
mod interactions;
mod keyboard;
mod overlays;

use interactions::PointerFrame;
use keyboard::{MenuMove, TypeAhead};
use overlays::{OBSERVER_PRIORITY, Overlays};
