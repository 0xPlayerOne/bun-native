//! Observe GPUI interaction without replacing its hit testing or native defaults.

use super::NativeView;
use bun_native_protocol::{Event, KeyModifiers, NodeId, PointerButton};
use gpui::{
    Context, DispatchPhase, Div, Focusable, InteractiveElement, Keystroke, Modifiers, MouseButton,
    MouseDownEvent, MouseUpEvent, NavigationDirection, Pixels, Point, WeakEntity, Window,
};
use std::{cell::Cell, rc::Rc};

fn modifiers(value: Modifiers) -> KeyModifiers {
    KeyModifiers {
        control: value.control,
        alt: value.alt,
        shift: value.shift,
        platform: value.platform,
        function: value.function,
    }
}

fn button(value: MouseButton) -> PointerButton {
    match value {
        MouseButton::Left => PointerButton::Left,
        MouseButton::Right => PointerButton::Right,
        MouseButton::Middle => PointerButton::Middle,
        MouseButton::Navigate(NavigationDirection::Back) => PointerButton::Back,
        MouseButton::Navigate(NavigationDirection::Forward) => PointerButton::Forward,
    }
}

/// Buttons this window has seen pressed, across frames. GPUI's macOS and
/// Windows backends synthesize a left release when a platform drag that
/// carries no files is dropped on the window (AppKit `performDragOperation:`,
/// OLE `IDropTarget::Drop`); no GPUI drag is active then. Such a release has
/// no press in this window and is never reported as a pointer release.
#[derive(Clone, Default)]
pub(super) struct PressedButtons(Rc<Cell<u8>>);

impl PressedButtons {
    fn bit(button: MouseButton) -> u8 {
        match button {
            MouseButton::Left => 1,
            MouseButton::Right => 2,
            MouseButton::Middle => 4,
            MouseButton::Navigate(NavigationDirection::Back) => 8,
            MouseButton::Navigate(NavigationDirection::Forward) => 16,
        }
    }

    fn press(&self, button: MouseButton) {
        self.0.set(self.0.get() | Self::bit(button));
    }

    /// Clears the button and reports whether this window saw it pressed.
    fn release(&self, button: MouseButton) -> bool {
        let pressed = self.0.get() & Self::bit(button) != 0;
        self.0.set(self.0.get() & !Self::bit(button));
        pressed
    }
}

/// GPUI runs capture in native paint order. Each hovered model element updates
/// this candidate, leaving the deepest visible native hit for the final observer.
/// The final capture observer consumes it before normal focus/edit/click actions.
#[derive(Default)]
pub(super) struct PointerFrame(Rc<Cell<Option<NodeId>>>);

impl PointerFrame {
    /// Registers in place: `InteractiveElement` builders move the >1 KB `Div`.
    pub(super) fn target(&self, element: &mut Div, node_id: NodeId) {
        let down = self.0.clone();
        let up = self.0.clone();
        let interactivity = element.interactivity();
        interactivity.capture_any_mouse_down(move |_, _, _| down.set(Some(node_id)));
        interactivity.capture_any_mouse_up(move |_, _, _| up.set(Some(node_id)));
    }

    /// `origin` is this window's content origin in the owning native window's
    /// coordinates: zero for the window itself, the offset for a popup window.
    pub(super) fn observe(
        &self,
        window: &mut Window,
        view: &WeakEntity<NativeView>,
        origin: Point<Pixels>,
        pressed: &PressedButtons,
    ) {
        let down = self.0.clone();
        let down_view = view.clone();
        let down_pressed = pressed.clone();
        window.on_mouse_event(move |event: &MouseDownEvent, phase, window, cx| {
            if phase == DispatchPhase::Capture {
                down_pressed.press(event.button);
            }
            if phase == DispatchPhase::Capture
                && let Some(node_id) = down.take()
                && !cx.has_active_drag()
                && in_viewport(event.position, window)
            {
                let _ = down_view.update(cx, |view, cx| {
                    view.pointer(
                        node_id,
                        true,
                        event.button,
                        event.position + origin,
                        event.modifiers,
                        cx,
                    )
                });
            }
        });
        let up = self.0.clone();
        let up_view = view.clone();
        let up_pressed = pressed.clone();
        window.on_mouse_event(move |event: &MouseUpEvent, phase, window, cx| {
            if phase == DispatchPhase::Capture
                && let Some(node_id) = up.take()
                && up_pressed.release(event.button)
                // An external file drop arrives as a synthesized button
                // release; it is a drop, never a pointer release.
                && !cx.has_active_drag()
                && in_viewport(event.position, window)
            {
                let _ = up_view.update(cx, |view, cx| {
                    view.pointer(
                        node_id,
                        false,
                        event.button,
                        event.position + origin,
                        event.modifiers,
                        cx,
                    )
                });
            }
        });
    }
}

fn in_viewport(position: Point<Pixels>, window: &Window) -> bool {
    let size = window.viewport_size();
    position.x >= gpui::px(0.)
        && position.y >= gpui::px(0.)
        && position.x < size.width
        && position.y < size.height
}

impl NativeView {
    pub(super) fn reconcile_focus(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.focus_subscriptions.retain(|id, _| {
            self.inputs.contains_key(id)
                || self.buttons.contains_key(id)
                || self.splits.contains(*id)
        });
        let ids: Vec<NodeId> = self
            .inputs
            .keys()
            .chain(self.buttons.keys())
            .copied()
            .chain(self.splits.focus_handles().map(|(id, _)| id))
            .collect();
        for id in &ids {
            if self.focus_subscriptions.contains_key(id) {
                continue;
            }
            let focus = self
                .inputs
                .get(id)
                .map(|input| input.focus_handle(cx))
                .or_else(|| self.buttons.get(id).cloned())
                .or_else(|| self.splits.focus_handle(*id).cloned())
                .expect("live control has focus ownership");
            let gained = cx.on_focus(&focus, window, |view, window, cx| {
                view.sync_focus(window, cx)
            });
            let lost = cx.on_blur(&focus, window, |view, window, cx| {
                view.sync_focus(window, cx)
            });
            self.focus_subscriptions.insert(*id, [gained, lost]);
        }
    }

    fn focused_node(&self, window: &Window, cx: &gpui::App) -> Option<NodeId> {
        if !window.is_window_active() {
            return None;
        }
        self.focused_control(window, cx)
    }

    pub(super) fn sync_focus(&mut self, window: &Window, cx: &mut Context<Self>) {
        let current = self.focused_node(window, cx);
        if current == self.reported_focus {
            return;
        }
        let previous = std::mem::replace(&mut self.reported_focus, current);
        let state = self.state.borrow();
        if !state.active {
            return;
        }
        // GPUI may notify several retained control subscriptions for one focus
        // transition. Report it once, blur before focus. Revoked targets emit no
        // new event; their already-queued application callbacks lose authority.
        if let Some(node_id) = previous
            && let Some(path) = state.tree.path(node_id)
        {
            self.events.ui(
                |sequence| Event::Blur {
                    sequence,
                    window_id: self.window_id,
                    node_id,
                    tree_revision: state.tree.revision(),
                    path,
                },
                cx,
            );
        }
        if let Some(node_id) = current
            && let Some(path) = state.tree.path(node_id)
        {
            self.events.ui(
                |sequence| Event::Focus {
                    sequence,
                    window_id: self.window_id,
                    node_id,
                    tree_revision: state.tree.revision(),
                    path,
                },
                cx,
            );
        }
    }

    pub(super) fn key(&self, key: &Keystroke, down: bool, window: &Window, cx: &mut Context<Self>) {
        // GPUI synthesizes standalone modifier keystrokes on release. They are
        // not physical key-down events and are outside this logical-key API.
        if key.is_modifier_key() {
            return;
        }
        let state = self.state.borrow();
        if !state.active {
            return;
        }
        // An open popup window holds the keyboard route, so Escape reaches it
        // while focus stays in this window. Without a focused control, a
        // modal layer receives keys such as Escape.
        let node_id = self
            .popups
            .topmost()
            .filter(|_| self.popups.active())
            .or_else(|| self.focused_node(window, cx))
            .or(self.overlays.active_modal())
            .unwrap_or_else(|| state.tree.root_id());
        let Some(path) = state.tree.path(node_id) else {
            return;
        };
        self.events.ui(
            |sequence| {
                if down {
                    Event::KeyDown {
                        sequence,
                        window_id: self.window_id,
                        node_id,
                        tree_revision: state.tree.revision(),
                        path,
                        key: key.key.clone(),
                        key_char: key.key_char.clone(),
                        modifiers: modifiers(key.modifiers),
                    }
                } else {
                    Event::KeyUp {
                        sequence,
                        window_id: self.window_id,
                        node_id,
                        tree_revision: state.tree.revision(),
                        path,
                        key: key.key.clone(),
                        key_char: key.key_char.clone(),
                        modifiers: modifiers(key.modifiers),
                    }
                }
            },
            cx,
        );
    }

    fn pointer(
        &self,
        node_id: NodeId,
        down: bool,
        mouse_button: MouseButton,
        position: Point<Pixels>,
        keys: Modifiers,
        cx: &mut Context<Self>,
    ) {
        let state = self.state.borrow();
        if !state.active {
            return;
        }
        let Some(path) = state.tree.path(node_id) else {
            return;
        };
        self.events.ui(
            |sequence| {
                if down {
                    Event::PointerDown {
                        sequence,
                        window_id: self.window_id,
                        node_id,
                        tree_revision: state.tree.revision(),
                        path,
                        button: button(mouse_button),
                        x: f32::from(position.x) as f64,
                        y: f32::from(position.y) as f64,
                        modifiers: modifiers(keys),
                    }
                } else {
                    Event::PointerUp {
                        sequence,
                        window_id: self.window_id,
                        node_id,
                        tree_revision: state.tree.revision(),
                        path,
                        button: button(mouse_button),
                        x: f32::from(position.x) as f64,
                        y: f32::from(position.y) as f64,
                        modifiers: modifiers(keys),
                    }
                }
            },
            cx,
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_native_modifier_maps_to_its_own_protocol_flag() {
        let none = KeyModifiers {
            control: false,
            alt: false,
            shift: false,
            platform: false,
            function: false,
        };
        assert_eq!(modifiers(Modifiers::default()), none);
        let cases: [(Modifiers, KeyModifiers); 5] = [
            (
                Modifiers {
                    control: true,
                    ..Default::default()
                },
                KeyModifiers {
                    control: true,
                    ..none
                },
            ),
            (
                Modifiers {
                    alt: true,
                    ..Default::default()
                },
                KeyModifiers { alt: true, ..none },
            ),
            (
                Modifiers {
                    shift: true,
                    ..Default::default()
                },
                KeyModifiers {
                    shift: true,
                    ..none
                },
            ),
            (
                Modifiers {
                    platform: true,
                    ..Default::default()
                },
                KeyModifiers {
                    platform: true,
                    ..none
                },
            ),
            (
                Modifiers {
                    function: true,
                    ..Default::default()
                },
                KeyModifiers {
                    function: true,
                    ..none
                },
            ),
        ];
        for (native, expected) in cases {
            assert_eq!(modifiers(native), expected);
        }
        let all = Modifiers {
            control: true,
            alt: true,
            shift: true,
            platform: true,
            function: true,
        };
        assert_eq!(
            modifiers(all),
            KeyModifiers {
                control: true,
                alt: true,
                shift: true,
                platform: true,
                function: true,
            }
        );
    }

    #[test]
    fn every_native_mouse_button_has_a_protocol_button() {
        for (native, expected) in [
            (MouseButton::Left, PointerButton::Left),
            (MouseButton::Right, PointerButton::Right),
            (MouseButton::Middle, PointerButton::Middle),
            (
                MouseButton::Navigate(NavigationDirection::Back),
                PointerButton::Back,
            ),
            (
                MouseButton::Navigate(NavigationDirection::Forward),
                PointerButton::Forward,
            ),
        ] {
            assert_eq!(button(native), expected);
        }
    }
}
