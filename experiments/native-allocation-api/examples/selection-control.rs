//! Standalone owned-process control; no Bun, GPUI, X11 or application timings.
use bun_native_allocation_diagnostic::{self as diagnostic, Observation, Phase};

#[inline(never)]
fn outside_region() {
    std::hint::black_box(vec![1_u8; 12_345]);
}
#[inline(never)]
fn selected_allocation() {
    std::hint::black_box(vec![2_u8; 23_456]);
}

fn run() -> diagnostic::Result<()> {
    diagnostic::initialize()?;
    let phase = diagnostic::phase().unwrap_or(Phase::Batch);
    let (first, last) = phase.request_range();
    // The controller proves the exact current PID/executable/library before
    // releasing this test-only barrier. It is not in the historical adapter.
    if let Some(path) = std::env::var_os("BUN_NATIVE_ALLOCATION_CONTROL_GRANT") {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        while !std::path::Path::new(&path).is_file() {
            if std::time::Instant::now() >= deadline {
                return Err(diagnostic::Error("control identity grant timed out"));
            }
            std::thread::sleep(std::time::Duration::from_millis(1));
        }
    }
    let mismatch = std::env::args().any(|value| value == "--mismatch");
    let hold = std::env::args().any(|value| value == "--hold");
    let flood = std::env::args().any(|value| value == "--flood");
    outside_region();
    for id in first..=last {
        diagnostic::before_prepare(Observation {
            id: id + u64::from(mismatch),
            window: 1,
            base_revision: if phase == Phase::Individual { 33 } else { 1033 } + id - first,
            operation_count: phase.operation_count(),
            valid_sets: true,
            root: 1,
            retained_nodes: 1001,
        })?;
        selected_allocation();
        if hold {
            // Positive phase witness before the parent exercises timeout
            // cleanup. Heaptrack's buffered trace may still be empty when
            // SIGTERM arrives; the file size cannot prove this boundary.
            use std::io::Write;
            std::io::stdout()
                .write_all(b"selection-control: active region\n")
                .map_err(|_| diagnostic::Error("control phase witness failed"))?;
            loop {
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
        }
        if flood {
            for _ in 0..1_000_000 {
                selected_allocation();
            }
        }
        diagnostic::root_render(1);
        diagnostic::after_apply(id, true)?;
    }
    outside_region();
    diagnostic::finish()
}
fn main() {
    if let Err(error) = run() {
        let _ = diagnostic::failed(error);
        eprintln!("Allocation control failed: {error}");
        std::process::exit(78);
    }
}
