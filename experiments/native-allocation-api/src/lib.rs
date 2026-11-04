//! Diagnostic-only selected allocation intervals. Compiled as a separate hashed
//! rlib; not a dependency or public API of the production host or frameworks.
#[cfg(not(all(target_os = "linux", target_env = "gnu")))]
compile_error!("the allocation diagnostic supports Linux GNU only");
mod abi;
mod config;
mod selection;
pub use selection::{Observation, Phase};
use std::cell::RefCell;
use std::ffi::CString;
use std::sync::atomic::{AtomicBool, AtomicU8, AtomicU64, Ordering};
use std::time::Instant;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Error(pub &'static str);
pub type Result<T> = std::result::Result<T, Error>;
impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.0)
    }
}
impl std::error::Error for Error {}

static PHASE: AtomicU8 = AtomicU8::new(0);
static ACTIVE: AtomicBool = AtomicBool::new(false);
static RENDERS: AtomicU64 = AtomicU64::new(0);
static OTHER_WINDOW_RENDERS: AtomicU64 = AtomicU64::new(0);
thread_local! { static GATE:RefCell<Option<Gate>>=const { RefCell::new(None) }; }
struct Gate {
    config: config::Config,
    api: abi::Api,
    output: CString,
    selection: selection::Selection,
    started: Option<Instant>,
    elapsed: Option<u128>,
}

/// First call in an instrumented host, before creating native/GPUI threads.
/// Disabled does not open files, re-exec or resolve any profiler ABI symbol.
pub fn initialize() -> Result<()> {
    let Some(mut config) = config::Config::parse(
        |name| std::env::var(name).ok(),
        option_env!("BUN_NATIVE_ALLOCATION_BUILD_ID").unwrap_or(""),
    )?
    else {
        return Ok(());
    };
    let output = config.prepare()?;
    let api = abi::Api::load(&config.library)?;
    config.report(
        "started.json",
        "\"status\":\"armed\",\"abi\":\"heaptrack-1.5.0\"",
    )?;
    let phase = config.phase;
    GATE.with(|slot| {
        let mut slot = slot.borrow_mut();
        if slot.is_some() {
            return Err(Error("allocation diagnostic initialized twice"));
        }
        *slot = Some(Gate {
            selection: selection::Selection::new(phase),
            config,
            api,
            output,
            started: None,
            elapsed: None,
        });
        PHASE.store(
            if phase == Phase::Individual { 1 } else { 2 },
            Ordering::Release,
        );
        Ok(())
    })
}
pub fn phase() -> Option<Phase> {
    match PHASE.load(Ordering::Acquire) {
        1 => Some(Phase::Individual),
        2 => Some(Phase::Batch),
        _ => None,
    }
}
fn with_gate(action: impl FnOnce(&mut Gate) -> Result<()>) -> Result<()> {
    if phase().is_none() {
        return Ok(());
    }
    GATE.with(|slot| {
        let mut slot = slot.borrow_mut();
        action(
            slot.as_mut()
                .ok_or(Error("diagnostic called from another thread"))?,
        )
    })
}
/// Immediately before the first selected Tree::prepare, after shape validation.
pub fn before_prepare(value: Observation) -> Result<()> {
    with_gate(|gate| {
        if gate.selection.before(value)? {
            RENDERS.store(0, Ordering::Relaxed);
            OTHER_WINDOW_RENDERS.store(0, Ordering::Relaxed);
            gate.api.start(&gate.output)?;
            gate.started = Some(Instant::now());
            ACTIVE.store(true, Ordering::Release);
        }
        Ok(())
    })
}
/// Directly after NativeView.apply, inside the update closure and before reply
/// enqueue. Capture covers all native threads and intervening scheduler work.
pub fn after_apply(id: u64, applied: bool) -> Result<()> {
    with_gate(|gate| {
        if gate.selection.after(id, applied)? {
            ACTIVE.store(false, Ordering::Release);
            gate.elapsed = gate.started.map(|started| started.elapsed().as_nanos());
            gate.api.close();
        }
        Ok(())
    })
}
/// Root render function entries, not GPU frames or display presentation. No
/// allocation/serialization occurs per entry; scope is recorded separately.
pub fn root_render(window_id: u64) {
    if ACTIVE.load(Ordering::Acquire) {
        let counter = if window_id == 1 {
            &RENDERS
        } else {
            &OTHER_WINDOW_RENDERS
        };
        counter.fetch_add(1, Ordering::Relaxed);
    }
}
pub fn finish() -> Result<()> {
    complete(None)
}
pub fn failed(error: Error) -> Result<()> {
    complete(Some(error))
}
fn complete(failure: Option<Error>) -> Result<()> {
    if phase().is_none() {
        return failure.map_or(Ok(()), Err);
    }
    GATE.with(|slot| {
        let mut gate=slot.borrow_mut().take().ok_or(Error("diagnostic completion has no owner"))?;
        ACTIVE.store(false,Ordering::Release);PHASE.store(0,Ordering::Release);gate.api.close();
        let outcome=failure.map_or_else(||gate.selection.finish(),Err);
        let status=if outcome.is_ok(){"complete"}else{"failed"};
        let (first,last)=gate.selection.phase.request_range();
        let fields=format!("\"status\":\"{status}\",\"firstRequest\":{first},\"lastRequest\":{last},\"appliedCommands\":{},\"operationsPerCommand\":{},\"rootRenderEntries\":{},\"otherWindowRenderEntries\":{},\"intervalNanoseconds\":{},\"scope\":\"whole-native-process-allocations-during-selected-interval\"",
            gate.selection.applied,gate.selection.phase.operation_count(),RENDERS.load(Ordering::Relaxed),
            OTHER_WINDOW_RENDERS.load(Ordering::Relaxed),gate.elapsed.map_or_else(||"null".to_owned(),|value|value.to_string()));
        gate.config.report("completed.json",&fields)?;outcome
    })
}
