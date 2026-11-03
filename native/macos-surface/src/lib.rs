//! Private macOS backing-layer invalidation, without timers or input posting.
#![cfg(target_os = "macos")]

use objc2::MainThreadMarker;
use objc2_app_kit::NSView;
use raw_window_handle::{AppKitWindowHandle, RawWindowHandle, WindowHandle};
use std::fmt;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InvalidationError {
    WrongThread,
    WrongPlatform,
    MissingLayer,
}

impl fmt::Display for InvalidationError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::WrongThread => "surface invalidation requires the main thread",
            Self::WrongPlatform => "surface invalidation requires an AppKit handle",
            Self::MissingLayer => "surface invalidation requires a backing layer",
        })
    }
}
impl std::error::Error for InvalidationError {}

fn main_thread() -> Result<MainThreadMarker, InvalidationError> {
    MainThreadMarker::new().ok_or(InvalidationError::WrongThread)
}

fn appkit(handle: RawWindowHandle) -> Result<AppKitWindowHandle, InvalidationError> {
    match handle {
        RawWindowHandle::AppKit(handle) => Ok(handle),
        _ => Err(InvalidationError::WrongPlatform),
    }
}

/// Request the borrowed surface's ordinary deferred Core Animation display pass.
///
/// The borrowed WindowHandle guarantees the NSView remains valid for this call.
/// AppKit's view redraw policy is not changed. No raw pointer, callback, timer or
/// retained layer escapes the call; the OS coalesces the layer's dirty flag.
#[allow(unsafe_code)] // The sole production native dereference in this crate.
pub fn invalidate(handle: WindowHandle<'_>) -> Result<(), InvalidationError> {
    let _main_thread = main_thread()?;
    let handle = appkit(handle.as_raw())?;
    // SAFETY: WindowHandle borrows a live NSView for its AppKit variant. The
    // variant and UI-thread authority were checked before this dereference.
    let view = unsafe { handle.ns_view.cast::<NSView>().as_ref() };
    let layer = view.layer().ok_or(InvalidationError::MissingLayer)?;
    layer.setNeedsDisplay();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use raw_window_handle::WebWindowHandle;

    #[test]
    fn rejects_other_platforms_before_accessing_a_pointer() {
        assert_eq!(
            appkit(RawWindowHandle::Web(WebWindowHandle::new(1))).unwrap_err(),
            InvalidationError::WrongPlatform
        );
    }

    #[test]
    fn workers_cannot_gain_native_ui_authority() {
        std::thread::spawn(|| {
            assert_eq!(main_thread().err(), Some(InvalidationError::WrongThread));
        })
        .join()
        .unwrap();
    }
}
