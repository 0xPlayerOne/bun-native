//! Bounded, opt-in paint cadence trace for soak fixtures. A paint callback is
//! not a presentation timestamp. With this trace the full-tree paint and layout
//! records are suppressed so the evidence writer does not dominate the frame.

use super::{Evidence, append};
use bun_native_protocol::{Tree, WindowId};
use serde_json::json;
use std::time::Instant;

pub(super) const RECORD_LIMIT: u32 = 16_384;

#[derive(Default)]
pub(super) struct FrameTrace {
    records: u32,
}

impl FrameTrace {
    pub(super) fn from_environment() -> Option<Self> {
        (std::env::var("BUN_NATIVE_FRAME_TRACE").as_deref() == Ok("1")).then(Self::default)
    }
}

impl Evidence {
    pub(crate) fn frame_tracing(&self) -> bool {
        self.0
            .as_ref()
            .is_some_and(|log| log.borrow().frames.is_some())
    }

    /// Geometry snapshots are paint-trace instrumentation, not frame tracing.
    pub(crate) fn layout_tracing(&self) -> bool {
        self.enabled() && !self.frame_tracing()
    }

    /// One compact record per native paint callback, bounded per process.
    /// `render_started` is when this frame's element tree began building.
    pub(crate) fn frame(&self, window_id: WindowId, tree: &Tree, render_started: Instant) {
        let Some(log) = &self.0 else {
            return;
        };
        let mut log = log.borrow_mut();
        let Some(frames) = &mut log.frames else {
            return;
        };
        if frames.records >= RECORD_LIMIT {
            return;
        }
        frames.records += 1;
        let index = frames.records;
        let record = if index == RECORD_LIMIT {
            json!({"nonce":log.nonce,"type":"frame_limit","stage":"native-paint","max_records":RECORD_LIMIT})
        } else {
            json!({
                "nonce": log.nonce,
                "type": "frame",
                "stage": "native-paint",
                "clock": "native_evidence_initialization_relative",
                "index": index,
                "window_id": window_id,
                "tree_revision": tree.revision(),
                "node_count": tree.nodes().count(),
                "elapsed_ns": log.started.elapsed().as_nanos().to_string(),
                "render_to_paint_ns": render_started.elapsed().as_nanos().to_string(),
            })
        };
        if let Err(error) = append(&mut log.file, &record) {
            eprintln!("Bun Native frame evidence unavailable: {error}");
            log.frames = None;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::evidence::frame_schedule_tests::make_log;
    use bun_native_protocol::NodeId;
    use serde_json::Value;

    fn rows(path: &std::path::Path) -> Vec<Value> {
        std::fs::read_to_string(path)
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }

    #[test]
    fn frame_records_are_opt_in_compact_and_bounded() {
        let window = WindowId::try_from(1).unwrap();
        let tree = Tree::new(NodeId::try_from(1).unwrap());
        let (disabled_file, disabled) = make_log(false);
        assert!(!disabled.frame_tracing());
        assert!(disabled.layout_tracing());
        disabled.frame(window, &tree, Instant::now());
        assert!(rows(&disabled_file.0).is_empty());

        let (file, evidence) = make_log(false);
        evidence.0.as_ref().unwrap().borrow_mut().frames = Some(FrameTrace::default());
        assert!(evidence.frame_tracing());
        assert!(!evidence.layout_tracing());
        // The full-tree paint record is suppressed while frame tracing.
        evidence.painted(window, &tree, None);
        evidence.frame(window, &tree, Instant::now());
        let written = rows(&file.0);
        assert_eq!(written.len(), 1);
        assert_eq!(written[0]["type"], "frame");
        assert_eq!(written[0]["index"], 1);
        assert_eq!(written[0]["node_count"], 1);
        assert!(written[0].get("nodes").is_none());

        evidence
            .0
            .as_ref()
            .unwrap()
            .borrow_mut()
            .frames
            .as_mut()
            .unwrap()
            .records = RECORD_LIMIT - 1;
        evidence.frame(window, &tree, Instant::now());
        evidence.frame(window, &tree, Instant::now());
        let written = rows(&file.0);
        assert_eq!(written.len(), 2);
        assert_eq!(written[1]["type"], "frame_limit");
    }
}
