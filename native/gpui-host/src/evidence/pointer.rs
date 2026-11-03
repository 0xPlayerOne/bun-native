//! Bounded, opt-in GPUI input diagnostics before application hit testing.

use super::{Evidence, append};
use bun_native_protocol::WindowId;
use gpui::{DispatchPhase, MouseDownEvent, MouseMoveEvent, MouseUpEvent, Window};
use serde_json::{Value, json};
use std::collections::BTreeSet;

const RECORD_LIMIT: u16 = 64;

#[derive(Default)]
pub(super) struct PointerTrace {
    records: u16,
    windows: BTreeSet<WindowId>,
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
