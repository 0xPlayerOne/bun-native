//! Placement of GPUI `WindowKind::PopUp` panels owned by a GPUI window.
//!
//! GPUI's macOS popup is a non-activating `NSPanel` at the pop-up menu level,
//! opened with a title bar at a position relative to the primary display, and
//! GPUI offers no way to own or move it (pinned zed `ba63a02`,
//! `crates/gpui_macos/src/window.rs`). These calls name windows by their
//! AppKit window number, which only finds this application's own windows, and
//! work in Cocoa screen points (origin at the bottom left of the primary
//! screen). Nothing here posts input or changes another process's window.
#![allow(unsafe_code)] // Reviewed borrowed-view dereference and child-window ordering.

use crate::{SurfaceError, appkit, main_thread};
use objc2::rc::Retained;
use objc2_app_kit::{
    NSApplication, NSPanel, NSView, NSWindow, NSWindowOrderingMode, NSWindowStyleMask,
};
use objc2_foundation::{NSPoint, NSRect, NSSize};
use raw_window_handle::WindowHandle;

/// A rectangle in Cocoa screen points: `y` is the bottom edge.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl From<NSRect> for Rect {
    fn from(rect: NSRect) -> Self {
        Self {
            x: rect.origin.x,
            y: rect.origin.y,
            width: rect.size.width,
            height: rect.size.height,
        }
    }
}

/// Where a window's content is, on which screen, at which backing scale.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Frame {
    pub content: Rect,
    pub screen: Rect,
    pub scale: f64,
}

/// The window number of a borrowed GPUI view's window.
pub fn window_number(handle: WindowHandle<'_>) -> Result<u32, SurfaceError> {
    let _main_thread = main_thread()?;
    let handle = appkit(handle.as_raw())?;
    // SAFETY: WindowHandle borrows a live NSView for its AppKit variant. The
    // variant and UI-thread authority were checked before this dereference.
    let view = unsafe { handle.ns_view.cast::<NSView>().as_ref() };
    let window = view.window().ok_or(SurfaceError::MissingWindow)?;
    u32::try_from(window.windowNumber()).map_err(|_| SurfaceError::MissingWindow)
}

/// One of this application's windows by number.
fn window(number: u32) -> Result<Retained<NSWindow>, SurfaceError> {
    let main_thread = main_thread()?;
    NSApplication::sharedApplication(main_thread)
        .windowWithWindowNumber(number as isize)
        .ok_or(SurfaceError::MissingWindow)
}

/// The content rectangle of a window, the frame of the screen that holds it
/// (the main screen when none does) and its backing scale factor.
pub fn frame(number: u32) -> Result<Frame, SurfaceError> {
    let main_thread = main_thread()?;
    let window = window(number)?;
    let view = window.contentView().ok_or(SurfaceError::MissingWindow)?;
    let content = window.convertRectToScreen(view.frame());
    let screen = window
        .screen()
        .or_else(|| objc2_app_kit::NSScreen::mainScreen(main_thread))
        .ok_or(SurfaceError::MissingWindow)?;
    Ok(Frame {
        content: content.into(),
        screen: screen.frame().into(),
        scale: window.backingScaleFactor(),
    })
}

/// Make `popup` a borderless child of `parent` that stays above it and moves
/// with it, and that never takes key status from it: clicking the popup
/// leaves keyboard focus and the active window where they were.
pub fn own(popup: u32, parent: u32) -> Result<(), SurfaceError> {
    let (popup, parent) = (window(popup)?, window(parent)?);
    if popup == parent {
        return Err(SurfaceError::MissingWindow);
    }
    let panel = popup
        .downcast::<NSPanel>()
        .map_err(|_| SurfaceError::MissingWindow)?;
    let nonactivating = panel.styleMask() & NSWindowStyleMask::NonactivatingPanel;
    panel.setStyleMask(NSWindowStyleMask::Borderless | nonactivating);
    panel.setBecomesKeyOnlyIfNeeded(true);
    panel.setHasShadow(true);
    // SAFETY: both are live windows of this application on the main thread,
    // and a window is never made its own child (checked above).
    unsafe { parent.addChildWindow_ordered(&panel, NSWindowOrderingMode::Above) };
    Ok(())
}

/// Move and size a popup to an exact frame. For a borderless window the frame
/// is its content.
pub fn place(popup: u32, frame: Rect) -> Result<(), SurfaceError> {
    let popup = window(popup)?;
    popup.setFrame_display(
        NSRect::new(
            NSPoint::new(frame.x, frame.y),
            NSSize::new(frame.width, frame.height),
        ),
        true,
    );
    Ok(())
}
