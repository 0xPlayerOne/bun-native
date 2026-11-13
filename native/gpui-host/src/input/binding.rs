use crate::view::NativeView;
use crate::{channel::EventSink, state::WindowState};
use bun_native_protocol::{Event, MAX_EVENT_FRAME_BYTES, NodeId, WindowId};
use gpui::{App, SharedString, WeakEntity};
use std::cell::RefCell;
use std::rc::Weak;

pub(crate) struct InputBinding {
    pub(crate) state: Weak<RefCell<WindowState>>,
    pub(crate) window_id: WindowId,
    pub(crate) node_id: NodeId,
    pub(crate) events: EventSink,
    /// Reveals the input when assistive technology focuses it.
    pub(crate) view: WeakEntity<NativeView>,
}

impl InputBinding {
    /// An assistive technology's focus request moves focus here; scroll the
    /// input into view as Tab would.
    pub(super) fn assistive_focus(&self, cx: &mut App) {
        let node_id = self.node_id;
        let _ = self
            .view
            .update(cx, |view, cx| view.reveal_control(node_id, cx));
    }

    /// Apply accepted native text before emitting its revision. A stale entity
    /// cannot resurrect a removed node or emit on a closed window. The model
    /// takes ownership of `value`; the returned string is the entity's copy.
    pub(super) fn edit(&self, value: String, cx: &mut App) -> Option<SharedString> {
        if !event_fits(&value) {
            return None;
        }
        let state = self.state.upgrade()?;
        let mut state = state.borrow_mut();
        if !state.active {
            return None;
        }
        let content = SharedString::new(&value);
        match state.tree.replace_input(self.node_id, value) {
            Ok(Some(input_revision)) => {
                self.events.ui(
                    |sequence| Event::Input {
                        sequence,
                        window_id: self.window_id,
                        node_id: self.node_id,
                        tree_revision: state.tree.revision(),
                        path: state
                            .tree
                            .path(self.node_id)
                            .expect("accepted edit has a committed route"),
                        value: content.to_string(),
                        input_revision,
                    },
                    cx,
                );
                Some(content)
            }
            Ok(None) => Some(content),
            Err(_) => None,
        }
    }
}

// JSON escaping can make a 16 KiB control-character value larger than a frame.
// Reserve the 65-ID path plus worst-case numeric/header overhead before committing
// an edit, so emitting the accepted edit cannot poison the output channel.
fn event_fits(value: &str) -> bool {
    let encoded_bytes: usize = value
        .bytes()
        .map(|byte| match byte {
            b'"' | b'\\' | 8 | 9 | 10 | 12 | 13 => 2,
            0..=31 => 6,
            _ => 1,
        })
        .sum();
    encoded_bytes + 1_536 <= MAX_EVENT_FRAME_BYTES
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escaped_native_text_fits_before_its_revision_is_committed() {
        assert!(event_fits(&"a".repeat(bun_native_protocol::MAX_TEXT_BYTES)));
        assert!(event_fits(
            &"\n".repeat(bun_native_protocol::MAX_TEXT_BYTES)
        ));
        assert!(!event_fits(
            &"\u{1}".repeat(bun_native_protocol::MAX_TEXT_BYTES)
        ));
        for value in ["界🌍", "\t\r\n\u{1}\"\\"] {
            let encoded = serde_json::to_string(value).unwrap();
            assert_eq!(
                event_fits(value),
                encoded.len() - 2 + 1_536 <= MAX_EVENT_FRAME_BYTES
            );
        }
    }

    #[test]
    fn maximum_route_metadata_fits_the_reserved_event_budget() {
        let max = bun_native_protocol::MAX_ID;
        let path: Vec<_> = (max - bun_native_protocol::MAX_EVENT_PATH_NODES as u64 + 1..=max)
            .map(|id| NodeId::try_from(id).unwrap())
            .collect();
        let event = Event::Input {
            sequence: bun_native_protocol::EventSequence::try_from(max).unwrap(),
            window_id: WindowId::try_from(max).unwrap(),
            node_id: NodeId::try_from(max).unwrap(),
            tree_revision: max,
            path,
            value: String::new(),
            input_revision: max,
        };
        assert!(serde_json::to_vec(&event).unwrap().len() < 1_536);
    }
}
