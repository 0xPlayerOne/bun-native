//! Recovers macOS frames that a wheel burst leaves undrawn (#586).
//!
//! On macOS 14+ the pinned GPUI paces frames with a `CAMetalDisplayLink` that
//! pauses while idle and is resumed only when the window first becomes dirty.
//! After a wheel burst at a scroll end the link can stay silent while the
//! window is dirty, so the scrolled content is never painted. A wheel event
//! that no paint follows within [`RECOVERY_DELAY`] dirties the view's backing
//! layer, the same deferred display pass that external commits already use:
//! GPUI then draws the pending frame and attaches a fresh display link.
//! A wheel event that changes nothing costs at most one such pass per delay.

use crate::evidence::Evidence;
use bun_native_protocol::WindowId;
use gpui::{App, DispatchPhase, ScrollEvent, Window};
use std::cell::Cell;
use std::rc::Rc;
use std::time::Duration;

/// Several display intervals: a live link paints well before this.
const RECOVERY_DELAY: Duration = Duration::from_millis(150);

#[derive(Clone, Default)]
pub(crate) struct FrameKeeper(Rc<FrameKeeperState>);

#[derive(Default)]
struct FrameKeeperState {
    paints: Cell<u64>,
    watching: Cell<bool>,
}

impl FrameKeeper {
    /// Called by a non-hitbox canvas during each paint of the window.
    pub(crate) fn painted(&self, window_id: WindowId, evidence: &Evidence, window: &mut Window) {
        let state = &self.0;
        state.paints.set(state.paints.get().wrapping_add(1));
        let keeper = self.clone();
        let evidence = evidence.clone();
        window.on_mouse_event(move |_: &ScrollEvent, phase, window, cx| {
            if phase == DispatchPhase::Capture {
                keeper.watch(window_id, &evidence, window, cx);
            }
        });
    }

    fn watch(&self, window_id: WindowId, evidence: &Evidence, window: &Window, cx: &App) {
        if self.0.watching.replace(true) {
            return;
        }
        let keeper = self.clone();
        let evidence = evidence.clone();
        let paints = self.0.paints.get();
        window
            .spawn(cx, async move |cx| {
                cx.background_executor().timer(RECOVERY_DELAY).await;
                keeper.0.watching.set(false);
                if keeper.0.paints.get() != paints {
                    return;
                }
                let _ = cx.update(|window, _| {
                    let handle = raw_window_handle::HasWindowHandle::window_handle(window)
                        .expect("an owned macOS GPUI window exposes its native view");
                    bun_native_macos_surface::invalidate(handle)
                        .expect("GPUI runs window tasks on the AppKit owner thread");
                    evidence.scroll_frame_recovery(window_id, paints);
                });
            })
            .detach();
    }
}
