//! Private borrowed macOS surface access, without timers, input posting or device selection,
//! the window-owned alert sheets of OS message dialogs ([`alert`]) and OS context
//! menus ([`context_menu`]), plain text on the general pasteboard
//! ([`pasteboard`]), OS-wide Carbon hot keys ([`hot_keys`]), window-owned
//! open and save panel sheets ([`file_panel`]), and the two pieces that let assistive technology
//! follow keyboard focus into a GPUI window's AccessKit tree: routing AppKit's
//! focus and hit-test queries to the adapter ([`focus_route`]) and the repeated
//! key-window notification that keeps the adapter's focus state current
//! ([`key_status`]).
#![cfg(target_os = "macos")]

pub mod alert;
pub mod context_menu;
pub mod file_panel;
pub mod focus_route;
pub mod hot_keys;
pub mod key_status;
pub mod pasteboard;

use objc2::MainThreadMarker;
use objc2::rc::Retained;
use objc2_app_kit::NSView;
use objc2_metal::MTLDevice;
use objc2_quartz_core::{CALayer, CAMetalLayer};
use raw_window_handle::{AppKitWindowHandle, RawWindowHandle, WindowHandle};
use std::fmt;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SurfaceError {
    WrongThread,
    WrongPlatform,
    MissingLayer,
    NotMetalLayer,
    MissingDevice,
    MissingWindow,
    InvalidAlert,
    MissingAccessibility,
    PasteboardRefused,
    InvalidPanel,
}

impl fmt::Display for SurfaceError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::WrongThread => "native surface access requires the main thread",
            Self::WrongPlatform => "native surface access requires an AppKit handle",
            Self::MissingLayer => "native view has no backing layer",
            Self::NotMetalLayer => "native view backing layer is not a CAMetalLayer",
            Self::MissingDevice => "native Metal layer has no assigned device",
            Self::MissingWindow => "native view is not in a window",
            Self::InvalidAlert => "alert needs 1 to 4 buttons and at most one button per key",
            Self::MissingAccessibility => {
                "native view or window class already defines the accessibility focus methods"
            }
            Self::PasteboardRefused => "the pasteboard refused the plain-text write",
            Self::InvalidPanel => "a file panel filter names no content type",
        })
    }
}
impl std::error::Error for SurfaceError {}

fn main_thread() -> Result<MainThreadMarker, SurfaceError> {
    MainThreadMarker::new().ok_or(SurfaceError::WrongThread)
}

fn appkit(handle: RawWindowHandle) -> Result<AppKitWindowHandle, SurfaceError> {
    match handle {
        RawWindowHandle::AppKit(handle) => Ok(handle),
        _ => Err(SurfaceError::WrongPlatform),
    }
}

#[allow(unsafe_code)] // The sole production native dereference in this crate.
fn backing_layer(handle: WindowHandle<'_>) -> Result<Retained<CALayer>, SurfaceError> {
    let _main_thread = main_thread()?;
    let handle = appkit(handle.as_raw())?;
    // SAFETY: WindowHandle borrows a live NSView for its AppKit variant. The
    // variant and UI-thread authority were checked before this dereference.
    let view = unsafe { handle.ns_view.cast::<NSView>().as_ref() };
    view.layer().ok_or(SurfaceError::MissingLayer)
}

/// Request the borrowed surface's ordinary deferred Core Animation display pass.
///
/// AppKit's view redraw policy is not changed. No raw pointer, callback, timer or
/// retained layer escapes the call; the OS coalesces the layer's dirty flag.
pub fn invalidate(handle: WindowHandle<'_>) -> Result<(), SurfaceError> {
    backing_layer(handle)?.setNeedsDisplay();
    Ok(())
}

/// Copied identity of the device actually assigned to the borrowed native layer.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MetalDevice {
    pub name: String,
    pub registry_id: u64,
}

/// Read CAMetalLayer.device; never select a default or preferred device.
///
/// The pinned GPUI renderer sets this exact layer's device during construction.
/// Device identity does not establish software emulation, driver version, GPU
/// utilization or display presentation. Native objects remain inside this call.
pub fn metal_device(handle: WindowHandle<'_>) -> Result<MetalDevice, SurfaceError> {
    let layer = backing_layer(handle)?
        .downcast::<CAMetalLayer>()
        .map_err(|_| SurfaceError::NotMetalLayer)?;
    let device = layer.device().ok_or(SurfaceError::MissingDevice)?;
    Ok(MetalDevice {
        name: device.name().to_string(),
        registry_id: device.registryID(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use raw_window_handle::WebWindowHandle;

    #[test]
    fn rejects_other_platforms_before_accessing_a_pointer() {
        assert_eq!(
            appkit(RawWindowHandle::Web(WebWindowHandle::new(1))).unwrap_err(),
            SurfaceError::WrongPlatform
        );
    }

    #[test]
    fn workers_cannot_gain_native_ui_authority() {
        std::thread::spawn(|| {
            assert_eq!(main_thread().err(), Some(SurfaceError::WrongThread));
        })
        .join()
        .unwrap();
    }
}
