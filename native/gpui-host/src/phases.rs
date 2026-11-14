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
const MAX_DRAG_STEPS: usize = 512;

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
    /// Children rendered as placeholders (`view/culling.rs`).
    culled: usize,
    cached: usize,
}

struct Trace {
    path: String,
    origin: Instant,
    batches: Vec<Batch>,
    frames: Vec<Frame>,
    dropped_batches: u64,
    foreground: Vec<(RequestId, u64, u64)>,
    dropped_foreground: u64,
    dropped_frames: u64,
    renders: u64,
    drag: Vec<(u64, DragStep)>,
    dropped_drag: u64,
}

/// Where an external file drag was observed on the host's UI thread. GPUI's
/// platform layer turns the OS drag-entered callback into an active drag; the
/// steps tell a drag the platform never delivered from one it delivered and a
/// target never saw (#303).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum DragStep {
    /// A render found GPUI's active drag newly set.
    Active,
    /// A drop target's drag-move handler ran.
    TargetMove,
    /// A render found GPUI's active drag newly cleared.
    Cleared,
}

impl DragStep {
    fn name(self) -> &'static str {
        match self {
            Self::Active => "active",
            Self::TargetMove => "target_move",
            Self::Cleared => "cleared",
        }
    }
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
            foreground: Vec::with_capacity(MAX_BATCHES),
            dropped_foreground: 0,
            dropped_frames: 0,
            renders: 0,
            drag: Vec::with_capacity(MAX_DRAG_STEPS),
            dropped_drag: 0,
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

/// Time from completion of command reading and validation on the worker to
/// entry on the foreground executor. Includes channel enqueue/backpressure.
pub(crate) fn foreground(
    id: RequestId,
    received: Instant,
    previous_yield: Option<(Instant, Instant)>,
) {
    TRACE.with(|trace| {
        let mut trace = trace.borrow_mut();
        let Some(trace) = trace.as_mut() else { return };
        if trace.foreground.len() == MAX_BATCHES {
            trace.dropped_foreground += 1;
            return;
        }
        let overlap = previous_yield.map_or(0, |(start, end)| {
            if received >= end {
                0
            } else {
                duration(received.max(start), end)
            }
        });
        trace
            .foreground
            .push((id, duration(received, Instant::now()), overlap));
    });
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
            culled: 0,
            cached: 0,
        };
        trace.frames.push(record);
        Some(trace.frames.len() - 1)
    })
}

/// Record one external-drag observation. Inert when tracing is disabled.
pub(crate) fn drag(step: DragStep) {
    TRACE.with(|trace| {
        let mut trace = trace.borrow_mut();
        let Some(trace) = trace.as_mut() else {
            return;
        };
        if trace.drag.len() == MAX_DRAG_STEPS {
            trace.dropped_drag += 1;
            return;
        }
        let at = trace.nanos(Instant::now());
        trace.drag.push((at, step));
    });
}

/// Record the end of a frame's paint, the children it culled, including
/// those of views GPUI laid out after the root render, and the cached views
/// GPUI replayed without rendering them.
pub(crate) fn painted(frame: usize, culled: usize, cached: usize) {
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
            record.culled = culled;
            record.cached = cached;
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
                frame.nodes,
                frame.culled,
                frame.cached
            ])
        })
        .collect();
    let record = json!({
        "schemaVersion": 1,
        "clock": "host monotonic nanoseconds since trace installation",
        "batchColumns": ["id", "windowId", "operations", "startedNanos", "prepareNanos",
            "applyNanos", "replyEnqueueNanos", "rendersBefore"],
        "frameColumns": ["windowId", "startedNanos", "renderNanos", "renderToPaintNanos", "nodes",
            "culledNodes", "cachedViews"],
        "renders": trace.renders,
        "droppedBatches": trace.dropped_batches,
        "foregroundColumns": ["id", "readToForegroundNanos", "previousYieldOverlapNanos"],
        "droppedForeground": trace.dropped_foreground,
        "foreground": trace.foreground.iter().map(|(id, delay, overlap)| json!([id, delay, overlap])).collect::<Vec<_>>(),
        "droppedFrames": trace.dropped_frames,
        "dragColumns": ["atNanos", "step"],
        "droppedDrag": trace.dropped_drag,
        "drag": trace.drag.iter().map(|(at, step)| json!([at, step.name()])).collect::<Vec<_>>(),
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
        painted(0, 0, 0);
        drag(DragStep::Active);
        write();
        assert!(!enabled());
    }

    #[test]
    fn drag_steps_are_recorded_in_order_and_bounded() {
        let (file, _) = install();
        drag(DragStep::Active);
        drag(DragStep::TargetMove);
        for _ in 0..MAX_DRAG_STEPS {
            drag(DragStep::TargetMove);
        }
        write();
        let record = read(&file.0);
        let steps = record["drag"].as_array().unwrap();
        assert_eq!(steps.len(), MAX_DRAG_STEPS);
        assert_eq!(steps[0][1], "active");
        assert_eq!(steps[1][1], "target_move");
        assert!(steps[0][0].as_u64().unwrap() <= steps[1][0].as_u64().unwrap());
        assert_eq!(record["droppedDrag"], 2);
        assert_eq!(record["dragColumns"], json!(["atNanos", "step"]));
        assert_eq!(DragStep::Cleared.name(), "cleared");
    }

    static NEXT_FILE: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

    struct TemporaryTrace(std::path::PathBuf);

    impl Drop for TemporaryTrace {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.0);
        }
    }

    /// Installs a trace on this test thread, as `install_from_environment` does.
    fn install() -> (TemporaryTrace, Instant) {
        let path = std::env::temp_dir().join(format!(
            "bun-native-phase-trace-test-{}-{}.json",
            std::process::id(),
            NEXT_FILE.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .unwrap();
        let origin = Instant::now();
        TRACE.with(|trace| {
            *trace.borrow_mut() = Some(Trace {
                path: path.to_str().unwrap().to_owned(),
                origin,
                batches: Vec::with_capacity(MAX_BATCHES),
                frames: Vec::with_capacity(MAX_FRAMES),
                dropped_batches: 0,
                foreground: Vec::with_capacity(MAX_BATCHES),
                dropped_foreground: 0,
                dropped_frames: 0,
                renders: 0,
                drag: Vec::new(),
                dropped_drag: 0,
            });
        });
        (TemporaryTrace(path), origin)
    }

    fn times(started: Instant, step: u64) -> BatchTimes {
        let at = |steps: u64| started + std::time::Duration::from_nanos(step * steps);
        BatchTimes {
            started,
            prepared: at(1),
            applied: at(3),
            replied: at(6),
        }
    }

    fn paint_end(frame: usize) -> Option<u64> {
        TRACE.with(|trace| trace.borrow().as_ref().unwrap().frames[frame].paint_end)
    }

    fn read(path: &std::path::Path) -> serde_json::Value {
        serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap()
    }

    #[test]
    fn foreground_yield_overlap_is_clipped_to_the_command_wait() {
        let (file, origin) = install();
        let delta = std::time::Duration::from_millis;
        let base = origin - delta(10);
        let start = base + delta(2);
        let end = base + delta(6);
        foreground(RequestId::try_from(1).unwrap(), base, Some((start, end)));
        foreground(
            RequestId::try_from(2).unwrap(),
            base + delta(4),
            Some((start, end)),
        );
        foreground(
            RequestId::try_from(3).unwrap(),
            base + delta(8),
            Some((start, end)),
        );
        foreground(RequestId::try_from(4).unwrap(), base, None);
        write();
        let record = read(&file.0);
        let rows = record["foreground"].as_array().unwrap();
        assert_eq!(rows.len(), 4);
        assert_eq!(rows[0][2], 4_000_000);
        assert_eq!(rows[1][2], 2_000_000);
        assert_eq!(rows[2][2], 0);
        assert_eq!(rows[3][2], 0);
    }

    #[test]
    fn enabled_trace_writes_batches_frames_and_render_counts_once() {
        let (file, origin) = install();
        assert!(enabled());
        assert!(now().is_some());
        let window = WindowId::try_from(1).unwrap();
        let yielded_until = Instant::now();
        foreground(
            RequestId::try_from(7).unwrap(),
            origin,
            Some((origin, yielded_until)),
        );
        batch(
            RequestId::try_from(7).unwrap(),
            window,
            1,
            times(origin, 1_000),
        );
        let frame = render(window, origin, 1001).unwrap();
        assert_eq!(frame, 0);
        painted(frame, 7, 5);
        let first_paint = paint_end(frame).unwrap();
        // Only the first paint callback after a render ends its frame.
        std::thread::sleep(std::time::Duration::from_millis(1));
        painted(frame, 8, 6);
        assert_eq!(paint_end(frame), Some(first_paint));
        // An unknown frame index is ignored.
        painted(99, 0, 0);
        let unpainted = render(WindowId::try_from(2).unwrap(), origin, 3).unwrap();
        assert_eq!(unpainted, 1);
        batch(
            RequestId::try_from(8).unwrap(),
            window,
            100,
            times(origin, 10),
        );
        write();
        assert!(!enabled());
        assert!(now().is_none());

        let record = read(&file.0);
        assert_eq!(record["schemaVersion"], 1);
        assert_eq!(record["renders"], 2);
        assert_eq!(record["droppedBatches"], 0);
        assert_eq!(record["droppedForeground"], 0);
        assert_eq!(record["foreground"][0][0], 7);
        assert!(record["foreground"][0][1].as_u64().is_some());
        assert_eq!(record["foreground"][0][2], duration(origin, yielded_until));
        assert_eq!(record["droppedFrames"], 0);
        assert_eq!(
            record["batchColumns"],
            json!([
                "id",
                "windowId",
                "operations",
                "startedNanos",
                "prepareNanos",
                "applyNanos",
                "replyEnqueueNanos",
                "rendersBefore"
            ])
        );
        assert_eq!(
            record["batches"],
            json!([
                [7, 1, 1, 0, 1_000, 2_000, 3_000, 0],
                [8, 1, 100, 0, 10, 20, 30, 2]
            ])
        );
        let frames = record["frames"].as_array().unwrap();
        assert_eq!(frames.len(), 2);
        assert_eq!(frames[0][0], 1);
        assert_eq!(frames[0][1], 0);
        assert_eq!(frames[0][4], 1001);
        assert_eq!(frames[0][5], 7);
        assert_eq!(frames[0][6], 5);
        let render_nanos = frames[0][2].as_u64().unwrap();
        let paint_nanos = frames[0][3].as_u64().unwrap();
        assert!(paint_nanos >= render_nanos);
        assert_eq!(paint_nanos, first_paint);
        assert_eq!(frames[1][0], 2);
        assert!(frames[1][3].is_null());
        assert_eq!(frames[1][4], 3);
        assert_eq!(frames[1][5], 0);
        assert_eq!(frames[1][6], 0);

        // Later writes do nothing and leave the file intact.
        write();
        assert_eq!(read(&file.0), record);
    }

    #[test]
    fn full_trace_counts_dropped_records_instead_of_growing() {
        let (file, origin) = install();
        let window = WindowId::try_from(1).unwrap();
        let id = RequestId::try_from(1).unwrap();
        for _ in 0..=MAX_BATCHES {
            batch(id, window, 1, times(origin, 1));
        }
        for _ in 0..MAX_FRAMES {
            assert!(render(window, origin, 1).is_some());
        }
        assert!(render(window, origin, 1).is_none());
        assert!(render(window, origin, 1).is_none());
        TRACE.with(|trace| {
            let trace = trace.borrow();
            let trace = trace.as_ref().unwrap();
            assert_eq!(trace.batches.len(), MAX_BATCHES);
            assert_eq!(trace.batches.capacity(), MAX_BATCHES);
            assert_eq!(trace.frames.len(), MAX_FRAMES);
            assert_eq!(trace.frames.capacity(), MAX_FRAMES);
        });
        write();
        let record = read(&file.0);
        assert_eq!(record["droppedBatches"], 1);
        assert_eq!(record["droppedFrames"], 2);
        assert_eq!(record["renders"], MAX_FRAMES + 2);
        assert_eq!(record["batches"].as_array().unwrap().len(), MAX_BATCHES);
        assert_eq!(record["frames"].as_array().unwrap().len(), MAX_FRAMES);
    }

    #[test]
    fn failed_write_disables_the_trace_without_panicking() {
        let (file, _) = install();
        std::fs::remove_file(&file.0).unwrap();
        // The trace never recreates a removed file.
        write();
        assert!(!enabled());
        assert!(!file.0.exists());
    }
}
