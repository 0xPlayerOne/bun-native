//! Bounded, opt-in GPUI input diagnostics before application hit testing.

use super::{Evidence, append};
use bun_native_protocol::WindowId;
use gpui::{
    App, DispatchPhase, MouseDownEvent, MouseMoveEvent, MouseUpEvent, ScrollDelta, ScrollEvent,
    Window,
};
use serde_json::{Value, json};
use std::{collections::BTreeSet, time::Duration};

const RECORD_LIMIT: u16 = 64;

#[derive(Default)]
pub(super) struct PointerTrace {
    records: u16,
    keys: u16,
    scrolls: u16,
    windows: BTreeSet<WindowId>,
    /// Paints observed while tracing; a wheel event that is never followed by
    /// one is reported, so a stalled frame source is not mistaken for an
    /// ignored wheel.
    paints: u64,
    last_scroll: (u16, u64),
    watching: bool,
    stalls: u16,
}

impl PointerTrace {
    pub(super) fn from_environment() -> Option<Self> {
        (std::env::var("BUN_NATIVE_POINTER_TRACE").as_deref() == Ok("1")).then(Self::default)
    }

    pub(super) fn closed(&mut self, window_id: WindowId) {
        self.windows.remove(&window_id);
    }

    fn claim(&mut self, window_id: WindowId, ready: bool) -> Option<u16> {
        if self.records == RECORD_LIMIT || (ready && !self.windows.insert(window_id)) {
            return None;
        }
        self.records += 1;
        Some(self.records)
    }
}

impl Evidence {
    pub(crate) fn pointer_tracing(&self) -> bool {
        self.0.as_ref().is_some_and(|log| {
            log.borrow()
                .pointer
                .as_ref()
                .is_some_and(|trace| trace.records < RECORD_LIMIT)
        })
    }

    /// Called by the first, non-hitbox canvas during paint. These listeners
    /// observe capture before the body and never mutate dispatch or focus.
    pub(crate) fn observe_pointer(&self, window_id: WindowId, window: &mut Window) {
        if let Some(log) = &self.0
            && let Some(trace) = log.borrow_mut().pointer.as_mut()
        {
            trace.paints += 1;
        }
        self.pointer_record(window_id, json!({"event":"ready"}), true, window);
        let moved = self.clone();
        window.on_mouse_event(move |event: &MouseMoveEvent, phase, window, _| {
            if phase == DispatchPhase::Capture {
                moved.pointer_record(
                    window_id,
                    json!({"event":"move",
                    "position":[f32::from(event.position.x),f32::from(event.position.y)],
                    "button":event.pressed_button.map(|button| format!("{button:?}"))}),
                    false,
                    window,
                );
            }
        });
        let down = self.clone();
        window.on_mouse_event(move |event: &MouseDownEvent, phase, window, _| {
            if phase == DispatchPhase::Capture {
                down.pointer_record(
                    window_id,
                    json!({"event":"down",
                    "position":[f32::from(event.position.x),f32::from(event.position.y)],
                    "button":format!("{:?}",event.button),"first_mouse":event.first_mouse}),
                    false,
                    window,
                );
            }
        });
        let scrolled = self.clone();
        window.on_mouse_event(move |event: &ScrollEvent, phase, window, cx| {
            if phase == DispatchPhase::Capture {
                scrolled.scroll_record(window_id, event, window);
                scrolled.watch_scroll_paint(window_id, window, cx);
            }
        });
        let up = self.clone();
        window.on_mouse_event(move |event: &MouseUpEvent, phase, window, _| {
            if phase == DispatchPhase::Capture {
                up.pointer_record(
                    window_id,
                    json!({"event":"up",
                    "position":[f32::from(event.position.x),f32::from(event.position.y)],
                    "button":format!("{:?}",event.button)}),
                    false,
                    window,
                );
            }
        });
    }

    /// Wheel events GPUI received in an owned window, before any element
    /// handles them, with their own bound so pointer moves cannot starve them.
    fn scroll_record(&self, window_id: WindowId, event: &ScrollEvent, window: &Window) {
        let Some(log) = &self.0 else { return };
        let mut log = log.borrow_mut();
        let Some(trace) = log.pointer.as_mut() else {
            return;
        };
        if trace.scrolls == RECORD_LIMIT {
            return;
        }
        trace.scrolls += 1;
        let index = trace.scrolls;
        let (unit, delta) = match event.delta {
            ScrollDelta::Lines(lines) => ("lines", [lines.x, lines.y]),
            ScrollDelta::Pixels(pixels) => ("pixels", [f32::from(pixels.x), f32::from(pixels.y)]),
        };
        let record = json!({
            "nonce": log.nonce,
            "type": "scroll_trace",
            "stage": "gpui-window-input",
            "window_id": window_id,
            "position": [f32::from(event.position.x), f32::from(event.position.y)],
            "unit": unit,
            "delta": delta,
            "touch_phase": format!("{:?}", event.touch_phase),
            "trace_index": index,
            "trace_limit": RECORD_LIMIT,
            "window_active": window.is_window_active(),
        });
        if let Err(error) = append(&mut log.file, &record) {
            eprintln!("Bun Native scroll trace unavailable: {error}");
        }
    }

    /// Checks, once per burst, that a paint follows the last wheel event. A
    /// wheel that moves no scroll offset needs no paint, so a stall record is
    /// read against the layout records around it. After a stall the window
    /// asks for one frame explicitly and records whether that frame arrives.
    fn watch_scroll_paint(&self, window_id: WindowId, window: &Window, cx: &App) {
        let Some(log) = &self.0 else { return };
        {
            let mut log = log.borrow_mut();
            let Some(trace) = log.pointer.as_mut() else {
                return;
            };
            trace.last_scroll = (trace.scrolls, trace.paints);
            if trace.watching || trace.stalls == RECORD_LIMIT {
                return;
            }
            trace.watching = true;
        }
        let evidence = self.clone();
        window
            .spawn(cx, async move |cx| {
                cx.background_executor()
                    .timer(Duration::from_millis(400))
                    .await;
                let _ = cx.update(|window, _| evidence.check_scroll_paint(window_id, window));
            })
            .detach();
    }

    fn check_scroll_paint(&self, window_id: WindowId, window: &Window) {
        let Some(log) = &self.0 else { return };
        let mut log = log.borrow_mut();
        let nonce = log.nonce.clone();
        let Some(trace) = log.pointer.as_mut() else {
            return;
        };
        trace.watching = false;
        let (scroll, paints) = trace.last_scroll;
        if trace.paints > paints || trace.stalls == RECORD_LIMIT {
            return;
        }
        trace.stalls += 1;
        let record = json!({
            "nonce": nonce,
            "type": "scroll_paint_stall",
            "stage": "gpui-window-input",
            "window_id": window_id,
            "scroll_index": scroll,
            "paints": paints,
            "waited_ms": 400,
            "window_active": window.is_window_active(),
        });
        if let Err(error) = append(&mut log.file, &record) {
            eprintln!("Bun Native scroll trace unavailable: {error}");
        }
        drop(log);
        let evidence = self.clone();
        window.on_next_frame(move |_, _| evidence.scroll_paint_woken(window_id, scroll));
    }

    fn scroll_paint_woken(&self, window_id: WindowId, scroll: u16) {
        let Some(log) = &self.0 else { return };
        let mut log = log.borrow_mut();
        let Some(paints) = log.pointer.as_ref().map(|trace| trace.paints) else {
            return;
        };
        let record = json!({
            "nonce": log.nonce,
            "type": "scroll_paint_woken",
            "stage": "gpui-window-input",
            "window_id": window_id,
            "scroll_index": scroll,
            "paints": paints,
        });
        if let Err(error) = append(&mut log.file, &record) {
            eprintln!("Bun Native scroll trace unavailable: {error}");
        }
    }

    /// Modified key downs (control, alt or platform) GPUI received in any
    /// owned window, before dispatch, with their own bound. With the close
    /// record this separates an OS close shortcut the window manager consumed
    /// from one delivered to the application instead. Plain typing is never
    /// recorded.
    pub(crate) fn observe_keys(&self, cx: &mut App) {
        if !self.pointer_tracing() {
            return;
        }
        let evidence = self.clone();
        cx.intercept_keystrokes(move |event, window, _| {
            let Some(log) = &evidence.0 else { return };
            let mut log = log.borrow_mut();
            let Some(trace) = log.pointer.as_mut() else {
                return;
            };
            let modifiers = &event.keystroke.modifiers;
            if trace.keys == RECORD_LIMIT
                || !(modifiers.control || modifiers.alt || modifiers.platform)
            {
                return;
            }
            trace.keys += 1;
            let index = trace.keys;
            let record = json!({
                "nonce": log.nonce,
                "type": "key_trace",
                "stage": "gpui-window-input",
                "key": event.keystroke.key,
                "modifiers": {
                    "control": modifiers.control,
                    "alt": modifiers.alt,
                    "shift": modifiers.shift,
                    "platform": modifiers.platform,
                },
                "trace_index": index,
                "trace_limit": RECORD_LIMIT,
                "window_active": window.is_window_active(),
            });
            if let Err(error) = append(&mut log.file, &record) {
                eprintln!("Bun Native key trace unavailable: {error}");
            }
        })
        .detach();
    }

    fn pointer_record(&self, window_id: WindowId, mut record: Value, ready: bool, window: &Window) {
        let Some(log) = &self.0 else {
            return;
        };
        let mut log = log.borrow_mut();
        let Some(index) = log
            .pointer
            .as_mut()
            .and_then(|trace| trace.claim(window_id, ready))
        else {
            return;
        };
        let viewport = window.viewport_size();
        record["nonce"] = json!(log.nonce);
        record["type"] = json!("pointer_trace");
        record["stage"] = json!("gpui-window-input");
        record["window_id"] = json!(window_id);
        record["trace_index"] = json!(index);
        record["trace_limit"] = json!(RECORD_LIMIT);
        record["limit_reached"] = json!(index == RECORD_LIMIT);
        record["viewport"] = json!([f32::from(viewport.width), f32::from(viewport.height)]);
        record["window_active"] = json!(window.is_window_active());
        if let Err(error) = append(&mut log.file, &record) {
            eprintln!("Bun Native pointer trace unavailable: {error}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trace_is_bounded_across_windows_and_repeated_paints() {
        let mut trace = PointerTrace::default();
        let first = WindowId::try_from(1).unwrap();
        let second = WindowId::try_from(2).unwrap();
        assert_eq!(trace.claim(first, true), Some(1));
        assert_eq!(trace.claim(first, true), None);
        assert_eq!(trace.claim(first, false), Some(2));
        trace.closed(first);
        assert!(trace.windows.is_empty());
        assert_eq!(trace.claim(second, true), Some(3));
        for expected in 4..=RECORD_LIMIT {
            assert_eq!(trace.claim(second, false), Some(expected));
        }
        trace.closed(second);
        assert_eq!(trace.claim(first, true), None);
        assert_eq!(trace.claim(first, false), None);
        assert!(trace.windows.is_empty());
        assert_eq!(trace.records, RECORD_LIMIT);
    }
}
