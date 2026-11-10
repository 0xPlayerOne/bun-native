//! OS context menus at a point of an owned window: `NSMenu` pop-ups on macOS
//! and Win32 popup menus on Windows. Both platforms track a menu in a nested
//! loop that keeps dispatching GPUI's queued work, so the menu is entered from
//! outside any GPUI borrow and a close request ends it while it is open. One
//! menu is live per application. The registry decides delivery: a menu that
//! is closing, or whose owner closed, never produces a completion event.

use crate::channel::EventSink;
use crate::services::context_menu_model as model;
use bun_native_protocol::{AppMenuEntry, ContextMenuId, ErrorCode, Event, RequestId, WindowId};
use gpui::{App, Task, Window};
use std::cell::{Cell, RefCell};
use std::rc::Rc;

type Failure = (ErrorCode, &'static str);

#[cfg(target_os = "macos")]
mod platform {
    use super::model;
    use bun_native_macos_surface::context_menu::{
        self, ContextMenu, MenuNode, MenuOwner, NSEventModifierFlags,
    };
    use bun_native_protocol::{AppMenuEntry, MenuShortcut};

    pub(crate) type Owner = Option<MenuOwner>;
    pub(crate) type Closer = ContextMenu;

    pub(crate) fn owner(window: &gpui::Window) -> Owner {
        use raw_window_handle::HasWindowHandle;
        HasWindowHandle::window_handle(window)
            .ok()
            .and_then(|handle| context_menu::owner(handle).ok())
    }

    fn key(shortcut: &MenuShortcut) -> (String, NSEventModifierFlags) {
        let modifiers = shortcut.modifiers;
        let mut flags = NSEventModifierFlags::empty();
        for (on, flag) in [
            (modifiers.control, NSEventModifierFlags::Control),
            (modifiers.alt, NSEventModifierFlags::Option),
            (modifiers.shift, NSEventModifierFlags::Shift),
            (modifiers.platform, NSEventModifierFlags::Command),
        ] {
            if on {
                flags |= flag;
            }
        }
        (model::macos_key_equivalent(&shortcut.key), flags)
    }

    /// Schedule the menu; `done` receives the chosen tag once it closes.
    pub(crate) fn show(
        owner: &MenuOwner,
        (x, y): (f64, f64),
        items: &[AppMenuEntry],
        done: impl FnOnce(Option<u32>) + 'static,
    ) -> Result<Closer, ()> {
        let nodes = model::map(
            items,
            &mut |tag, label, shortcut, enabled, checked| MenuNode::Item {
                tag,
                label: label.to_owned(),
                key: shortcut.map(key),
                enabled,
                checked,
            },
            &|| MenuNode::Separator,
            &|label, enabled, items| MenuNode::Submenu {
                label: label.to_owned(),
                enabled,
                items,
            },
            &mut 0,
        );
        context_menu::show(owner, x, y, &nodes, done).map_err(|_| ())
    }

    pub(crate) fn close(closer: &Closer) {
        closer.close();
    }
}

#[cfg(windows)]
mod platform {
    use super::model;
    use bun_native_protocol::AppMenuEntry;
    use bun_native_windows_services::context_menu;
    use bun_native_windows_services::context_menu_spec::{MenuNode, menu_text};
    use std::cell::Cell;
    use std::rc::Rc;

    /// The owner `HWND` (0 when none) and its scale factor.
    pub(crate) type Owner = (isize, f32);
    /// Set once the menu is being closed; a menu closed before it is entered
    /// never appears.
    pub(crate) type Closer = Rc<Cell<bool>>;

    pub(crate) fn owner(window: &gpui::Window) -> Owner {
        use raw_window_handle::{HasWindowHandle, RawWindowHandle};
        let handle = match HasWindowHandle::window_handle(window).map(|handle| handle.as_raw()) {
            Ok(RawWindowHandle::Win32(handle)) => handle.hwnd.get(),
            _ => 0,
        };
        (handle, window.scale_factor())
    }

    /// Enter the menu from a GPUI task, outside any borrow, and report the
    /// chosen tag when it closes.
    pub(crate) fn show(
        owner: &Owner,
        (x, y): (f64, f64),
        items: &[AppMenuEntry],
        done: impl FnOnce(Option<u32>) + 'static,
        cx: &mut gpui::App,
    ) -> Result<Closer, ()> {
        let (window, scale) = *owner;
        if window == 0 {
            return Err(());
        }
        let nodes = model::map(
            items,
            &mut |command, label, shortcut, enabled, checked| MenuNode::Item {
                command,
                text: menu_text(label, shortcut.map(model::windows_hint).as_deref()),
                enabled,
                checked,
            },
            &|| MenuNode::Separator,
            &|label, enabled, items| MenuNode::Submenu {
                text: menu_text(label, None),
                enabled,
                items,
            },
            &mut 0,
        );
        let physical = |value: f64| (value * f64::from(scale)).round() as i32;
        let (x, y) = (physical(x), physical(y));
        let closed: Closer = Rc::new(Cell::new(false));
        let gate = closed.clone();
        cx.spawn(async move |_| {
            let chosen = if gate.get() {
                None
            } else {
                context_menu::show(window, x, y, &nodes).ok().flatten()
            };
            done(chosen.filter(|_| !gate.get()));
        })
        .detach();
        Ok(closed)
    }

    pub(crate) fn close(closer: &Closer) {
        if !closer.replace(true) {
            context_menu::end();
        }
    }
}

pub(crate) use platform::Owner;

enum State {
    Live,
    /// Ending. Holds the close request to answer once the menu is gone.
    Closing(Option<RequestId>),
}

struct Live {
    window: WindowId,
    menu: ContextMenuId,
    ids: Vec<String>,
    state: State,
    closer: platform::Closer,
}

struct Inner {
    live: RefCell<Option<Live>>,
    last_menu: Cell<u64>,
    stopping: Cell<bool>,
    events: EventSink,
}

#[derive(Clone)]
pub(crate) struct ContextMenus(Rc<Inner>);

impl ContextMenus {
    pub(crate) fn new(events: EventSink, _cx: &App) -> Self {
        Self(Rc::new(Inner {
            live: RefCell::new(None),
            last_menu: Cell::new(0),
            stopping: Cell::new(false),
            events,
        }))
    }

    pub(crate) fn available(&self) -> bool {
        true
    }

    pub(crate) fn owner(window: &Window) -> Owner {
        platform::owner(window)
    }

    pub(crate) fn show(
        &self,
        request: (RequestId, WindowId, ContextMenuId),
        position: (f64, f64),
        items: &[AppMenuEntry],
        owner: Owner,
        cx: &mut App,
    ) -> Result<(), Failure> {
        let (id, window, menu) = request;
        if menu.get() <= self.0.last_menu.get() {
            return Err((
                ErrorCode::InvalidHandle,
                "context menu IDs must increase across the session",
            ));
        }
        if self.0.live.borrow().is_some() {
            return Err((
                ErrorCode::LimitExceeded,
                "another context menu is already open",
            ));
        }
        if self.0.stopping.get() {
            return Err((
                ErrorCode::Cancelled,
                "context menu service is shutting down",
            ));
        }
        let (sender, receiver) = async_channel::bounded::<Option<u32>>(1);
        let done = move |tag| {
            let _ = sender.try_send(tag);
        };
        #[cfg(target_os = "macos")]
        let closer = {
            let Some(owner) = owner else {
                return Err((ErrorCode::InvalidHandle, "native window has no handle"));
            };
            platform::show(&owner, position, items, done)
        };
        #[cfg(windows)]
        let closer = platform::show(&owner, position, items, done, cx);
        let closer = closer.map_err(|()| {
            (
                ErrorCode::InvalidHandle,
                "native window has no handle for a context menu",
            )
        })?;
        self.0.last_menu.set(menu.get());
        *self.0.live.borrow_mut() = Some(Live {
            window,
            menu,
            ids: model::item_ids(items),
            state: State::Live,
            closer,
        });
        self.0.events.send(
            Event::ContextMenuOpened {
                id,
                window_id: window,
                menu_id: menu,
            },
            cx,
        );
        let this = self.clone();
        cx.spawn(async move |cx| {
            // A menu dropped without a completion counts as dismissed.
            let tag = receiver.recv().await.ok().flatten();
            cx.update(|cx| this.finished(menu, tag, cx));
        })
        .detach();
        Ok(())
    }

    /// The menu closed. What the application hears depends on who closed it.
    fn finished(&self, menu: ContextMenuId, tag: Option<u32>, cx: &mut App) {
        let live = {
            let mut slot = self.0.live.borrow_mut();
            if slot.as_ref().is_none_or(|live| live.menu != menu) {
                return;
            }
            slot.take()
        };
        let Some(live) = live else {
            return;
        };
        match live.state {
            State::Live => {
                let item_id = model::chosen(&live.ids, tag);
                self.0.events.ui(
                    |sequence| Event::ContextMenuCompleted {
                        sequence,
                        window_id: live.window,
                        menu_id: menu,
                        item_id,
                    },
                    cx,
                );
            }
            // The application closed it; no completion follows.
            State::Closing(Some(id)) => self.0.events.send(
                Event::ContextMenuClosed {
                    id,
                    window_id: live.window,
                    menu_id: menu,
                },
                cx,
            ),
            State::Closing(None) => {}
        }
    }

    /// End a live menu. It is answered once the menu is gone.
    pub(crate) fn close(
        &self,
        id: RequestId,
        window: WindowId,
        menu: ContextMenuId,
        _cx: &mut App,
    ) -> Result<(), Failure> {
        let mut slot = self.0.live.borrow_mut();
        match slot.as_mut() {
            Some(live)
                if live.window == window
                    && live.menu == menu
                    && matches!(live.state, State::Live) =>
            {
                live.state = State::Closing(Some(id));
                platform::close(&live.closer);
                Ok(())
            }
            _ => Err((
                ErrorCode::InvalidHandle,
                "context menu is not live for this window",
            )),
        }
    }

    /// Owner close revokes delivery now and ends the menu.
    pub(crate) fn close_window(&self, window: WindowId, _cx: &mut App) {
        if let Some(live) = self
            .0
            .live
            .borrow_mut()
            .as_mut()
            .filter(|live| live.window == window)
        {
            // A pending close request is answered when the menu ends.
            if !matches!(live.state, State::Closing(Some(_))) {
                live.state = State::Closing(None);
            }
            platform::close(&live.closer);
        }
    }

    /// Revoke and end the live menu. Nothing runs on another thread.
    pub(crate) fn stop(&self, _cx: &mut App) -> Option<Task<()>> {
        self.0.stopping.set(true);
        if let Some(live) = self.0.live.borrow_mut().as_mut() {
            live.state = State::Closing(None);
            platform::close(&live.closer);
        }
        None
    }
}
