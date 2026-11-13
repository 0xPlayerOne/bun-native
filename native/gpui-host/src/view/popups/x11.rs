//! Screen placement for owned popup windows on the local X server.
//!
//! GPUI's X11 `WindowKind::PopUp` is an override-redirect window created at an
//! absolute root position (pinned zed `ba63a02`,
//! `crates/gpui_linux/src/linux/x11/window.rs`), but GPUI neither exposes a
//! window's root position (its bounds come from unsynthesized
//! `ConfigureNotify` coordinates, which are frame-relative under a reparenting
//! window manager) nor offers X11 anchored popups. This owns one bounded
//! connection per native window that only translates coordinates and moves,
//! raises and labels the popup windows that window owns. It selects no events.

use crate::services::x11::{Budget, Display, XConnection};
use gpui::{App, Bounds, Point, Size, Window};
use std::cell::RefCell;
use std::rc::{Rc, Weak};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize};
use std::time::{Duration, Instant};
use x11rb::connection::Connection;
use x11rb::protocol::xproto::{
    AtomEnum, ConfigureWindowAux, ConnectionExt, PropMode, StackMode, Window as XWindow,
};
use x11rb::wrapper::ConnectionExt as _;

/// Every placement round trip runs on the UI thread, so it gets a short bound.
const PLACEMENT_TIMEOUT: Duration = Duration::from_millis(250);

/// One per process, shared by every window's [`Placement`]: atoms and the
/// screen belong to the display, not to a window.
struct Shared {
    connection: XConnection,
    root: XWindow,
    /// The X screen in device pixels. GPUI's X11 display is this same screen.
    screen: Size<i32>,
    window_type: u32,
    popup_menu: u32,
}

pub(crate) struct Placement(Rc<Shared>);

thread_local! {
    /// GPUI windows live on the UI thread, so the shared connection does too.
    static SHARED: RefCell<Weak<Shared>> = const { RefCell::new(Weak::new()) };
}

fn budget() -> Budget {
    Budget {
        deadline: Instant::now() + PLACEMENT_TIMEOUT,
        cancelled: Arc::new(AtomicBool::new(false)),
        stopping: Arc::new(AtomicBool::new(false)),
        inbound: Arc::new(AtomicUsize::new(0)),
    }
}

/// The X window behind a GPUI window, when GPUI runs on X11.
pub(crate) fn window_id(window: &Window) -> Option<XWindow> {
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};
    match HasWindowHandle::window_handle(window).ok()?.as_raw() {
        RawWindowHandle::Xcb(handle) => Some(handle.window.get()),
        RawWindowHandle::Xlib(handle) => u32::try_from(handle.window).ok(),
        _ => None,
    }
}

/// Whether this session can place popup windows at all.
pub(crate) fn available(cx: &App) -> bool {
    Display::from_app(cx).is_some()
}

impl Placement {
    pub(crate) fn connect(cx: &App) -> Option<Self> {
        if let Some(shared) = SHARED.with(|shared| shared.borrow().upgrade()) {
            return Some(Self(shared));
        }
        let shared = Rc::new(Shared::connect(cx)?);
        SHARED.with(|slot| *slot.borrow_mut() = Rc::downgrade(&shared));
        Some(Self(shared))
    }

    fn begin(&self) {
        self.0.connection.stream().set_budget(&budget());
    }
}

impl Shared {
    fn connect(cx: &App) -> Option<Self> {
        let display = Display::from_app(cx)?;
        let budget = budget();
        let connection = display.connect(&budget).ok()?;
        let screen = connection.setup().roots.get(display.screen)?;
        let (root, screen) = (
            screen.root,
            Size {
                width: i32::from(screen.width_in_pixels),
                height: i32::from(screen.height_in_pixels),
            },
        );
        let atom = |name: &[u8]| {
            connection
                .intern_atom(false, name)
                .ok()?
                .reply()
                .ok()
                .map(|reply| reply.atom)
        };
        let window_type = atom(b"_NET_WM_WINDOW_TYPE")?;
        let popup_menu = atom(b"_NET_WM_WINDOW_TYPE_POPUP_MENU")?;
        Some(Self {
            connection,
            root,
            screen,
            window_type,
            popup_menu,
        })
    }
}

impl Placement {
    pub(crate) fn screen(&self) -> Size<i32> {
        self.0.screen
    }

    /// The root-window position of a window's content origin, in device pixels.
    pub(crate) fn origin(&self, window: XWindow) -> Option<Point<i32>> {
        self.begin();
        let reply = self
            .0
            .connection
            .translate_coordinates(window, self.0.root, 0, 0)
            .ok()?
            .reply()
            .ok()?;
        Some(Point {
            x: i32::from(reply.dst_x),
            y: i32::from(reply.dst_y),
        })
    }

    /// Record the owner for the window manager and compositors, and describe
    /// the window as a popup menu instead of GPUI's notification type.
    pub(crate) fn own(&self, popup: XWindow, parent: XWindow) -> Option<()> {
        self.begin();
        self.0
            .connection
            .change_property32(
                PropMode::REPLACE,
                popup,
                AtomEnum::WM_TRANSIENT_FOR,
                AtomEnum::WINDOW,
                &[parent],
            )
            .ok()?
            .check()
            .ok()?;
        self.0
            .connection
            .change_property32(
                PropMode::REPLACE,
                popup,
                self.0.window_type,
                AtomEnum::ATOM,
                &[self.0.popup_menu],
            )
            .ok()?
            .check()
            .ok()
    }

    /// Move, size and raise a popup to exact device-pixel bounds. An
    /// override-redirect window is not managed, so the server applies it as is.
    pub(crate) fn place(&self, popup: XWindow, bounds: Bounds<i32>) -> Option<()> {
        self.begin();
        self.0
            .connection
            .configure_window(
                popup,
                &ConfigureWindowAux::new()
                    .x(bounds.origin.x)
                    .y(bounds.origin.y)
                    .width(bounds.size.width.max(1) as u32)
                    .height(bounds.size.height.max(1) as u32)
                    .stack_mode(StackMode::ABOVE),
            )
            .ok()?
            .check()
            .ok()
    }
}
