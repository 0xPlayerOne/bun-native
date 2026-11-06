//! Opt-in, bounded UI-thread phase trace for the bridge investigation (#297).
//!
//! Disabled unless `BUN_NATIVE_PHASE_TRACE` names a new file. When disabled,
//! every hook is one thread-local `None` check: no clock reads, allocation or
//! I/O. When enabled, records stay in fixed-capacity memory and are written
//! once as JSON after the command loop ends, so file I/O never runs between
//! measured requests. The trace observes timing only; it never changes
//! dispatch, rendering, hit testing or event delivery.

use bun_native_protocol::{RequestId, WindowId};
use serde_json::json;
use std::cell::RefCell;
use std::fs::OpenOptions;
use std::io::Write;
use std::time::Instant;

const MAX_BATCHES: usize = 4096;
const MAX_FRAMES: usize = 16384;

struct Batch {
    id: RequestId,
    window_id: WindowId,
    operations: usize,
    started: u64,
    prepare: u64,
    apply: u64,
    reply: u64,
    renders_before: u64,
}

struct Frame {
    window_id: WindowId,
    started: u64,
    /// Root element construction, including the trace's own node count.
    render: u64,
    /// Root render start through the final native canvas paint callback.
    /// Includes GPUI layout/prepaint/paint; excludes GPU submit/presentation.
    paint_end: Option<u64>,
    nodes: usize,
}

struct Trace {
    path: String,
    origin: Instant,
    batches: Vec<Batch>,
    frames: Vec<Frame>,
    dropped_batches: u64,
    dropped_frames: u64,
    renders: u64,
}

impl Trace {
    fn nanos(&self, at: Instant) -> u64 {
        u64::try_from(at.duration_since(self.origin).as_nanos()).unwrap_or(u64::MAX)
    }
}

thread_local! {
    static TRACE: RefCell<Option<Trace>> = const { RefCell::new(None) };
}

/// Install from the environment. Refuses an existing path so trials never mix.
pub(crate) fn install_from_environment() {
    let Some(path) = std::env::var_os("BUN_NATIVE_PHASE_TRACE") else {
        return;
    };
    let Some(path) = path.to_str().map(str::to_owned) else {
        eprintln!("Bun Native phase trace path is not UTF-8; tracing disabled");
        return;
    };
    if let Err(error) = OpenOptions::new().write(true).create_new(true).open(&path) {
        eprintln!("Bun Native phase trace unavailable: {error}");
        return;
    }
    TRACE.with(|trace| {
        *trace.borrow_mut() = Some(Trace {
            path,
            origin: Instant::now(),
            batches: Vec::with_capacity(MAX_BATCHES),
            frames: Vec::with_capacity(MAX_FRAMES),
            dropped_batches: 0,
            dropped_frames: 0,
            renders: 0,
        });
    });
}

pub(crate) fn enabled() -> bool {
    TRACE.with(|trace| trace.borrow().is_some())
}

/// Clock read for a hook; `None` when tracing is disabled.
pub(crate) fn now() -> Option<Instant> {
    enabled().then(Instant::now)
}

/// Phase boundaries of one acknowledged batch on the UI thread.
pub(crate) struct BatchTimes {
    pub(crate) started: Instant,
    pub(crate) prepared: Instant,
    pub(crate) applied: Instant,
    pub(crate) replied: Instant,
}

pub(crate) fn batch(id: RequestId, window_id: WindowId, operations: usize, times: BatchTimes) {
    TRACE.with(|trace| {
        let mut trace = trace.borrow_mut();
        let Some(trace) = trace.as_mut() else {
            return;
        };
        if trace.batches.len() == MAX_BATCHES {
            trace.dropped_batches += 1;
            return;
        }
        let record = Batch {
            id,
            window_id,
            operations,
            started: trace.nanos(times.started),
            prepare: duration(times.started, times.prepared),
            apply: duration(times.prepared, times.applied),
            reply: duration(times.applied, times.replied),
            renders_before: trace.renders,
        };
        trace.batches.push(record);
    });
}

/// Record one root render. Returns the frame index for its paint callback.
pub(crate) fn render(window_id: WindowId, started: Instant, nodes: usize) -> Option<usize> {
    TRACE.with(|trace| {
        let mut trace = trace.borrow_mut();
        let trace = trace.as_mut()?;
        trace.renders += 1;
        if trace.frames.len() == MAX_FRAMES {
            trace.dropped_frames += 1;
            return None;
        }
        let record = Frame {
            window_id,
            started: trace.nanos(started),
            render: duration(started, Instant::now()),
            paint_end: None,
            nodes,
        };
        trace.frames.push(record);
        Some(trace.frames.len() - 1)
    })
}

pub(crate) fn painted(frame: usize) {
    TRACE.with(|trace| {
        let mut trace = trace.borrow_mut();
        let Some(trace) = trace.as_mut() else {
            return;
        };
        let end = trace.nanos(Instant::now());
        if let Some(record) = trace.frames.get_mut(frame)
            && record.paint_end.is_none()
        {
            record.paint_end = Some(end.saturating_sub(record.started));
        }
    });
}

fn duration(from: Instant, to: Instant) -> u64 {
    u64::try_from(to.duration_since(from).as_nanos()).unwrap_or(u64::MAX)
}

/// Write the trace once. Later calls do nothing.
pub(crate) fn write() {
    let Some(trace) = TRACE.with(|trace| trace.borrow_mut().take()) else {
        return;
    };
    let batches: Vec<_> = trace
        .batches
        .iter()
        .map(|batch| {
            json!([
                batch.id,
                batch.window_id,
                batch.operations,
                batch.started,
                batch.prepare,
                batch.apply,
                batch.reply,
                batch.renders_before
            ])
        })
        .collect();
    let frames: Vec<_> = trace
        .frames
        .iter()
        .map(|frame| {
            json!([
                frame.window_id,
                frame.started,
                frame.render,
                frame.paint_end,
                frame.nodes
            ])
        })
        .collect();
    let record = json!({
        "schemaVersion": 1,
        "clock": "host monotonic nanoseconds since trace installation",
        "batchColumns": ["id", "windowId", "operations", "startedNanos", "prepareNanos",
            "applyNanos", "replyEnqueueNanos", "rendersBefore"],
        "frameColumns": ["windowId", "startedNanos", "renderNanos", "renderToPaintNanos", "nodes"],
        "renders": trace.renders,
        "droppedBatches": trace.dropped_batches,
        "droppedFrames": trace.dropped_frames,
        "batches": batches,
        "frames": frames,
    });
    let written = OpenOptions::new()
        .write(true)
        .truncate(true)
        .open(&trace.path)
        .and_then(|mut file| file.write_all(record.to_string().as_bytes()));
    if let Err(error) = written {
        eprintln!("Bun Native phase trace write failed: {error}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn disabled_trace_records_nothing() {
        // Tests never install a trace; every hook must be inert.
        assert!(!enabled());
        assert!(now().is_none());
        assert!(render(WindowId::try_from(1).unwrap(), Instant::now(), 1).is_none());
        painted(0);
        write();
        assert!(!enabled());
    }
}
