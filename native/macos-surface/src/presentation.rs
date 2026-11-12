//! A read-only snapshot of the borrowed GPUI surface's presentation state, for
//! the bounded paint diagnostics. Nothing here draws, presents, invalidates or
//! changes a layer, view or window property.
//!
//! The pinned GPUI macOS window (zed `ba63a022`, `crates/gpui_macos/src/window.rs`)
//! sets its `CAMetalLayer`'s `presentsWithTransaction` only around the
//! synchronous frames it draws from `displayLayer:` and `windowDidBecomeKey:`,
//! after detaching its `CAMetalDisplayLink`. A paint that observes it set was
//! therefore drawn by one of those synchronous passes and presented through
//! `nextDrawable` with the Core Animation transaction; a paint that observes it
//! clear was drawn by a display-link update or by GPUI's pre-dispatch draw for
//! a key event, which presents nothing itself.

use crate::{SurfaceError, appkit, main_thread};
use objc2_app_kit::{NSView, NSWindowOcclusionState};
use objc2_quartz_core::CAMetalLayer;
use raw_window_handle::WindowHandle;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PresentationState {
    /// The backing layer's `presentsWithTransaction`; `None` when the backing
    /// layer is not a `CAMetalLayer`.
    pub presents_with_transaction: Option<bool>,
    /// Whether a `setNeedsDisplay` is still waiting for its display pass.
    pub needs_display: bool,
    /// AppKit's occlusion state: GPUI stops its display link while not visible.
    pub occlusion_visible: bool,
    pub key_window: bool,
}

/// Read the presentation state of the borrowed GPUI view's backing layer and window.
#[allow(unsafe_code)] // The same reviewed borrowed-view dereference as the surface access.
pub fn presentation_state(handle: WindowHandle<'_>) -> Result<PresentationState, SurfaceError> {
    let _main_thread = main_thread()?;
    let handle = appkit(handle.as_raw())?;
    // SAFETY: WindowHandle borrows a live NSView for its AppKit variant. The
    // variant and UI-thread authority were checked before this dereference.
    let view = unsafe { handle.ns_view.cast::<NSView>().as_ref() };
    let layer = view.layer().ok_or(SurfaceError::MissingLayer)?;
    let window = view.window().ok_or(SurfaceError::MissingWindow)?;
    Ok(PresentationState {
        presents_with_transaction: layer
            .downcast_ref::<CAMetalLayer>()
            .map(|layer| layer.presentsWithTransaction()),
        needs_display: layer.needsDisplay(),
        occlusion_visible: window
            .occlusionState()
            .contains(NSWindowOcclusionState::Visible),
        key_window: window.isKeyWindow(),
    })
}
