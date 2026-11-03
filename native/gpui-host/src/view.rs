use crate::{
    channel::EventSink,
    evidence::{Evidence, LayoutFrame},
    input::{InputBinding, TextInput},
    state::SharedWindowState,
    style,
};
use bun_native_protocol::{Element as NativeElement, Event, NodeId, Overflow, Tree, WindowId};
use gpui::{
    AnyElement, App, Context, Entity, FocusHandle, Focusable, KeyBinding, MouseButton,
    ScrollHandle, Subscription, Window, actions, canvas, div, prelude::*, px, rgb,
};
use std::collections::BTreeMap;
use std::rc::Rc;

actions!(native_button, [ActivateButton]);
actions!(native_window, [FocusNext, FocusPrevious]);

pub(crate) fn bind_keys(cx: &mut App) {
    cx.bind_keys([
        KeyBinding::new("enter", ActivateButton, Some("NativeButton")),
        KeyBinding::new("space", ActivateButton, Some("NativeButton")),
        KeyBinding::new("tab", FocusNext, Some("NativeWindow")),
        KeyBinding::new("shift-tab", FocusPrevious, Some("NativeWindow")),
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
                let _ = view.update(cx, |view, cx| view.key(&event.keystroke, true, window, cx));
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
            _subscriptions: [keyboard, focus_lost],
            events,
            evidence,
        }
    }

    /// Called synchronously after complete transaction preflight. This method
    /// does not yield or dispatch native input between model and entity updates.
    pub(crate) fn apply(&mut self, tree: Tree, window: &mut Window, cx: &mut Context<Self>) {
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
                NativeElement::Box { .. } | NativeElement::Text { .. } => {}
            }
        }
        self.reconcile_focus(window, cx);
        cx.notify();
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
            base = layout.children(base, node.children(), self.scrolls.get(&node_id));
        }
        let base = pointer.target(base, node_id).id(node_id.get());
        match node.element() {
            NativeElement::Box { style: properties } => {
                let base = if node_id == tree.root_id() {
                    base.size_full()
                } else {
                    base
                };
                let mut container = style::apply(base.flex().flex_col(), properties);
                if let Some(handle) = self.scrolls.get(&node_id) {
                    container = container.track_scroll(handle);
                }
                container
                    .children(
                        node.children()
                            .iter()
                            .map(|child| self.render_node(tree, *child, layout, pointer, cx)),
                    )
                    .into_any_element()
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
            } => style::apply(base, properties)
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

impl Render for NativeView {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
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
            LayoutFrame::new(state.tree.nodes().count(), &self.scrolls, focus)
        });
        let pointer = PointerFrame::default();
        let body = self.render_node(
            &state.tree,
            state.tree.root_id(),
            layout.as_ref(),
            &pointer,
            cx,
        );
        let view = cx.weak_entity();
        let evidence = self.evidence.clone();
        let paint_state = self.state.clone();
        let window_id = self.window_id;
        let mut base = div();
        if let Some(layout) = &layout {
            base = layout.children(base, &[state.tree.root_id()], None);
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
            .on_action(|_: &FocusNext, window, cx| window.focus_next(cx))
            .on_action(|_: &FocusPrevious, window, cx| window.focus_prev(cx))
            .child(body)
            .child(
                canvas(
                    |_, _, _| (),
                    move |_, (), window, _| {
                        // Registered after native children: capture has already
                        // selected the deepest GPUI hit before default actions.
                        pointer.observe(window, &view);
                        let state = paint_state.borrow();
                        evidence.painted(window_id, &state.tree);
                        if let Some(layout) = &layout {
                            evidence.layout(window_id, state.tree.revision(), layout, window);
                        }
                    },
                )
                .absolute()
                .top_0()
                .left_0()
                .size(px(1.)),
            )
    }
}
mod interactions;

use interactions::PointerFrame;
