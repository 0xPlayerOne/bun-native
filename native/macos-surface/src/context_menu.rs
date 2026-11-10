//! OS context menus as `NSMenu` pop-ups at a point of a GPUI view.
//!
//! `popUpMenuPositioningItem:atLocation:inView:` tracks the menu in a nested
//! run loop and returns only when the menu closes. GPUI dispatches its main
//! thread work as blocks on the serial main dispatch queue, and a nested run
//! loop started from inside such a block never drains that queue. So the
//! menu is popped up from a run-loop block (`performBlock:`) instead: while
//! it tracks, GPUI's queued work, including a request to close the menu,
//! keeps running. The chosen item comes back through a private target object.
#![allow(unsafe_code)] // Reviewed AppKit target/action, block and view calls of this boundary.

use crate::{SurfaceError, appkit, main_thread};
use block2::RcBlock;
use objc2::rc::Retained;
use objc2::runtime::{AnyObject, NSObject};
use objc2::{DefinedClass as _, MainThreadOnly, Message as _, define_class, msg_send, sel};
pub use objc2_app_kit::NSEventModifierFlags;
use objc2_app_kit::{NSControlStateValueOff, NSControlStateValueOn, NSMenu, NSMenuItem, NSView};
use objc2_foundation::{NSPoint, NSRunLoop, NSString};
use raw_window_handle::WindowHandle;
use std::cell::Cell;
use std::rc::Rc;

/// One entry of a validated menu. `tag` is the application's item index plus
/// one; it is what the menu reports back.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MenuNode {
    Item {
        tag: u32,
        label: String,
        /// The key equivalent AppKit shows beside the item, if any.
        key: Option<(String, NSEventModifierFlags)>,
        enabled: bool,
        checked: bool,
    },
    Separator,
    Submenu {
        label: String,
        enabled: bool,
        items: Vec<MenuNode>,
    },
}

define_class!(
    // SAFETY: NSObject has no subclassing requirements and this class has no Drop.
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "BunNativeContextMenuTarget"]
    #[ivars = Cell<isize>]
    struct Target;

    impl Target {
        #[unsafe(method(choose:))]
        fn choose(&self, sender: &NSMenuItem) {
            self.ivars().set(sender.tag());
        }
    }
);

impl Target {
    fn new(main_thread: objc2::MainThreadMarker) -> Retained<Self> {
        let this = Self::alloc(main_thread).set_ivars(Cell::new(0));
        // SAFETY: NSObject's designated initializer on a freshly allocated object.
        unsafe { msg_send![super(this), init] }
    }
}

/// The view a context menu opens over.
#[derive(Clone, Debug)]
pub struct MenuOwner(Retained<NSView>);

/// The `NSView` of a borrowed GPUI window.
pub fn owner(handle: WindowHandle<'_>) -> Result<MenuOwner, SurfaceError> {
    let _main_thread = main_thread()?;
    let handle = appkit(handle.as_raw())?;
    // SAFETY: WindowHandle borrows a live NSView for its AppKit variant. The
    // variant and UI-thread authority were checked before this dereference.
    let view = unsafe { handle.ns_view.cast::<NSView>().as_ref() };
    Ok(MenuOwner(view.retain()))
}

fn build(
    nodes: &[MenuNode],
    target: &Target,
    main_thread: objc2::MainThreadMarker,
) -> Retained<NSMenu> {
    let menu = NSMenu::new(main_thread);
    // Enabled state is exactly what the application gave.
    menu.setAutoenablesItems(false);
    for node in nodes {
        match node {
            MenuNode::Item {
                tag,
                label,
                key,
                enabled,
                checked,
            } => {
                let item = NSMenuItem::new(main_thread);
                item.setTitle(&NSString::from_str(label));
                item.setTag(*tag as isize);
                // SAFETY: `target` outlives the menu's tracking (the pop-up
                // block retains it) and implements `choose:` with this signature.
                unsafe {
                    item.setTarget(Some(target as &AnyObject));
                    item.setAction(Some(sel!(choose:)));
                }
                if let Some((equivalent, modifiers)) = key {
                    item.setKeyEquivalent(&NSString::from_str(equivalent));
                    item.setKeyEquivalentModifierMask(*modifiers);
                }
                item.setEnabled(*enabled);
                item.setState(if *checked {
                    NSControlStateValueOn
                } else {
                    NSControlStateValueOff
                });
                menu.addItem(&item);
            }
            MenuNode::Separator => menu.addItem(&NSMenuItem::separatorItem(main_thread)),
            MenuNode::Submenu {
                label,
                enabled,
                items,
            } => {
                let item = NSMenuItem::new(main_thread);
                item.setTitle(&NSString::from_str(label));
                item.setEnabled(*enabled);
                let submenu = build(items, target, main_thread);
                submenu.setTitle(&NSString::from_str(label));
                item.setSubmenu(Some(&submenu));
                menu.addItem(&item);
            }
        }
    }
    menu
}

struct State {
    menu: Retained<NSMenu>,
    /// Set by `close`; a menu closed before it popped up never appears.
    closed: Cell<bool>,
}

/// A scheduled or tracking menu. Dropping it does not close the menu.
pub struct ContextMenu(Rc<State>);

impl ContextMenu {
    /// End tracking now, or stop a menu that has not popped up yet. The
    /// completion reports no item. Closing twice does nothing.
    pub fn close(&self) {
        self.0.closed.set(true);
        self.0.menu.cancelTracking();
    }
}

/// Schedule the menu at `(x, y)` (logical points from the view's top-left).
/// `tracking` runs just before the menu starts tracking. `done` runs once on
/// the main thread with the chosen item's tag, or `None` when the menu was
/// dismissed or closed.
pub fn show(
    owner: &MenuOwner,
    x: f64,
    y: f64,
    nodes: &[MenuNode],
    tracking: impl FnOnce() + 'static,
    done: impl FnOnce(Option<u32>) + 'static,
) -> Result<ContextMenu, SurfaceError> {
    let main_thread = main_thread()?;
    let target = Target::new(main_thread);
    let state = Rc::new(State {
        menu: build(nodes, &target, main_thread),
        closed: Cell::new(false),
    });
    let view = owner.0.clone();
    let done = Cell::new(Some(done));
    let tracking = Cell::new(Some(tracking));
    let block = RcBlock::new({
        let state = state.clone();
        move || {
            let Some(done) = done.take() else {
                return;
            };
            if state.closed.get() {
                return done(None);
            }
            let bounds = view.bounds();
            // GPUI's view is not flipped: AppKit's origin is its bottom-left.
            let location = NSPoint::new(
                x,
                if view.isFlipped() {
                    y
                } else {
                    bounds.size.height - y
                },
            );
            if let Some(tracking) = tracking.take() {
                tracking();
            }
            let chosen =
                state
                    .menu
                    .popUpMenuPositioningItem_atLocation_inView(None, location, Some(&view));
            let tag = target.ivars().get();
            done(
                u32::try_from(tag)
                    .ok()
                    .filter(|tag| chosen && !state.closed.get() && *tag > 0),
            );
        }
    });
    // SAFETY: the main run loop runs the block on this (the main) thread.
    unsafe { NSRunLoop::mainRunLoop().performBlock(&block) };
    // A queued run-loop block does not wake a sleeping run loop by itself.
    if let Some(main) = objc2_core_foundation::CFRunLoop::main() {
        main.wake_up();
    }
    Ok(ContextMenu(state))
}
