//! Screen placement for owned popup windows on macOS.
//!
//! GPUI opens a `WindowKind::PopUp` as a non-activating panel at the pop-up
//! menu level, positioned relative to the primary display, and neither owns
//! it to a parent nor moves it (pinned zed `ba63a02`,
//! `crates/gpui_macos/src/window.rs`; `AnchoredPopup` is rejected on macOS).
//! This makes each popup a borderless child window of its parent that never
//! becomes key, and moves it to exact bounds. Windows are named by AppKit
//! window number. Placement space is device pixels from the top-left corner
//! of the parent window's screen, recorded by [`Placement::origin`] for the
//! rest of the pass.

use super::cocoa::{Rect, Screen};
use bun_native_macos_surface::popup;
use gpui::{App, Bounds, Point, Size, Window};
use std::cell::Cell;

#[derive(Default)]
pub(crate) struct Placement {
    screen: Cell<Option<Screen>>,
}

/// The AppKit window number behind a GPUI window.
pub(crate) fn window_id(window: &Window) -> Option<u32> {
    use raw_window_handle::HasWindowHandle;
    popup::window_number(HasWindowHandle::window_handle(window).ok()?).ok()
}

/// Every macOS session can place its own popup panels.
pub(crate) fn available(_: &App) -> bool {
    true
}

fn rect(rect: popup::Rect) -> Rect {
    Rect {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
    }
}

impl Placement {
    pub(crate) fn connect(_: &App) -> Option<Self> {
        Some(Self::default())
    }

    /// The parent's screen, in device pixels, from the last [`Self::origin`].
    pub(crate) fn screen(&self) -> Size<i32> {
        self.screen
            .get()
            .map(|screen| screen.size())
            .unwrap_or_default()
    }

    /// The parent's content origin on its screen, in device pixels.
    pub(crate) fn origin(&self, window: u32) -> Option<Point<i32>> {
        let frame = popup::frame(window).ok()?;
        let screen = Screen {
            frame: rect(frame.screen),
            scale: frame.scale,
        };
        self.screen.set(Some(screen));
        Some(screen.origin(rect(frame.content)))
    }

    pub(crate) fn own(&self, popup: u32, parent: u32) -> Option<()> {
        popup::own(popup, parent).ok()
    }

    pub(crate) fn place(&self, popup: u32, bounds: Bounds<i32>) -> Option<()> {
        let frame = self.screen.get()?.frame(bounds);
        popup::place(
            popup,
            popup::Rect {
                x: frame.x,
                y: frame.y,
                width: frame.width,
                height: frame.height,
            },
        )
        .ok()
    }
}
