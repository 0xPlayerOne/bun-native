//! Cocoa menu tracking suppresses ordinary CEF UI tasks. This coalesced main
//! run-loop wake only cancels an exactly owned popup; it never dispatches a
//! command, replies, removes accelerators or destroys a browser/window.
use super::command_envelope::{CommandEnvelope, MenuCleanupQueue, MenuWakeState};
use block2::RcBlock;
use objc2::MainThreadMarker;
use objc2_core_foundation::{kCFRunLoopCommonModes, CFRunLoop};
use std::sync::{Arc, Mutex, OnceLock};

static WAKE: MenuWakeState = MenuWakeState::new();
fn pending() -> &'static Mutex<MenuCleanupQueue> {
    static PENDING: OnceLock<Mutex<MenuCleanupQueue>> = OnceLock::new();
    PENDING.get_or_init(|| Mutex::new(MenuCleanupQueue::default()))
}
pub(super) fn track(command: &Arc<CommandEnvelope>) {
    let tracked = {
        let mut pending = pending().lock().unwrap();
        if WAKE.stopped() {
            return;
        }
        pending.track(command)
    };
    match tracked {
        Ok(true) => wake(),
        Ok(false) => {}
        Err(reason) => super::fail(reason),
    }
}
pub(super) fn request_quit() {
    // Do not clear this on a wake before ShowMenu: the queued QuitTask still
    // owns this intent, including a later MenuWillShow before that task runs.
    if WAKE.request_quit() {
        wake();
    }
}
pub(super) fn quit_dispatched() {
    WAKE.quit_dispatched();
}
pub(super) fn stop() {
    // CEF's final task fence does not drain CFRunLoop blocks. Stop on the main
    // thread before releasing any host owners; late blocks must not enter CEF.
    WAKE.stop();
    *pending().lock().unwrap() = MenuCleanupQueue::default();
}
pub(super) fn wake() {
    if !WAKE.queue() {
        return;
    }
    let Some(run_loop) = CFRunLoop::main() else {
        // Leave the coalescing flag set so fail/request_quit cannot recurse.
        super::fail("Native menu main run loop unavailable");
        return;
    };
    // SAFETY: Apple's immutable mode constant is a CFString. CFRunLoop copies
    // the block before returning; it captures no borrowed Rust/CEF objects.
    // Scheduling and waking this main run loop from the pipe thread are allowed.
    let Some(mode) = (unsafe { kCFRunLoopCommonModes }) else {
        super::fail("Native menu common run-loop modes unavailable");
        return;
    };
    let block = RcBlock::new(drain);
    unsafe { run_loop.perform_block(Some(mode), Some(&block)) };
    run_loop.wake_up();
}
fn drain() {
    // This callback and host teardown both run on the main thread, so stopping
    // cannot interleave after this check but before the following CEF call.
    if WAKE.stopped() {
        return;
    }
    if MainThreadMarker::new().is_none() || cef::currently_on(cef::ThreadId::UI) == 0 {
        super::fail("Native menu cancellation requires the native main thread");
        return;
    }
    // A concurrent producer may now queue one more wake. No callback captures
    // a payload, and at most one additional block can wait behind this callback.
    if !WAKE.begin_drain() {
        return;
    }
    super::window_commands::cancel_retired_tracking(WAKE.quitting());
    let commands = pending().lock().unwrap().pending();
    for command in commands {
        if let Some(value) = command.pending() {
            super::window_commands::cancel_tracking_for_command(value);
        }
    }
}
