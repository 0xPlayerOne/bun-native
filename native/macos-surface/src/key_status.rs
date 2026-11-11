//! Repeat a GPUI window's key-window notification once AccessKit can see it.
//!
//! GPUI tells its AccessKit macOS adapter whether the window has keyboard focus
//! only from `windowDidBecomeKey:` and `windowDidResignKey:`, and only once the
//! adapter exists. The adapter is created after `MacWindow::open` returns, and
//! it starts out unfocused. A window that became key before then (opened while
//! the application was already active), or whose key notification GPUI set
//! aside as spurious while the application was inactive, stays unfocused for
//! AccessKit: `accessibilityFocusedUIElement` is nil and no
//! `AXFocusedUIElementChanged` notification is ever posted, so VoiceOver does
//! not follow keyboard focus.
//!
//! [`track`] re-sends `windowDidBecomeKey:` to a GPUI window's own delegate
//! after the window opens and whenever the application becomes active, but
//! only while that window really is the key window of the active application.
//! It never changes key status, ordering or focus.
#![allow(unsafe_code)] // Reviewed AppKit notification, block and view calls of this boundary.

use crate::{SurfaceError, appkit, main_thread};
use block2::RcBlock;
use objc2::rc::{Retained, Weak};
use objc2::runtime::{AnyObject, NSObjectProtocol, ProtocolObject};
use objc2::{MainThreadMarker, msg_send, sel};
use objc2_app_kit::{
    NSApplication, NSApplicationDidBecomeActiveNotification, NSView, NSWindow,
    NSWindowDidBecomeKeyNotification,
};
use objc2_foundation::{NSNotification, NSNotificationCenter, NSRunLoop};
use raw_window_handle::WindowHandle;
use std::cell::{OnceCell, RefCell};
use std::ptr::NonNull;

thread_local! {
    /// The windows handed to [`track`]; only these are ever notified.
    static WINDOWS: RefCell<Vec<Weak<NSWindow>>> = const { RefCell::new(Vec::new()) };
    /// The application-activation observer, installed once and kept for the
    /// process lifetime.
    static OBSERVER: OnceCell<Retained<ProtocolObject<dyn NSObjectProtocol>>> =
        const { OnceCell::new() };
}

/// Track the window of a borrowed GPUI view (call it once, after the window
/// opened) and repeat its key notification if it is already key.
pub fn track(handle: WindowHandle<'_>) -> Result<(), SurfaceError> {
    let main_thread = main_thread()?;
    let handle = appkit(handle.as_raw())?;
    // SAFETY: WindowHandle borrows a live NSView for its AppKit variant. The
    // variant and UI-thread authority were checked before this dereference.
    let view = unsafe { handle.ns_view.cast::<NSView>().as_ref() };
    let window = view.window().ok_or(SurfaceError::MissingWindow)?;
    WINDOWS.with_borrow_mut(|windows| {
        windows.retain(|tracked| tracked.load().is_some());
        windows.push(Weak::from_retained(&window));
    });
    OBSERVER.with(|observer| {
        observer.get_or_init(|| observe_activation(main_thread));
    });
    schedule(window);
    Ok(())
}

fn tracked(window: &NSWindow) -> bool {
    WINDOWS.with_borrow(|windows| {
        windows
            .iter()
            .filter_map(Weak::load)
            .any(|tracked| std::ptr::eq(&*tracked, window))
    })
}

fn observe_activation(
    main_thread: MainThreadMarker,
) -> Retained<ProtocolObject<dyn NSObjectProtocol>> {
    let block = RcBlock::new(move |_: NonNull<NSNotification>| {
        if let Some(window) = NSApplication::sharedApplication(main_thread).keyWindow()
            && tracked(&window)
        {
            schedule(window);
        }
    });
    // SAFETY: a nil object observes the notification from any sender, a nil
    // queue runs the block synchronously on the posting (main) thread, and the
    // block only reads AppKit state and queues a run-loop block.
    unsafe {
        NSNotificationCenter::defaultCenter().addObserverForName_object_queue_usingBlock(
            Some(NSApplicationDidBecomeActiveNotification),
            None,
            None,
            &block,
        )
    }
}

/// Run the notification from its own run-loop block, outside whatever GPUI or
/// AppKit work is on the stack now, as AppKit delivers its own.
fn schedule(window: Retained<NSWindow>) {
    let block = RcBlock::new(move || notify_if_key(&window));
    // SAFETY: the main run loop runs the block on this (the main) thread.
    unsafe { NSRunLoop::mainRunLoop().performBlock(&block) };
    // A queued run-loop block does not wake a sleeping run loop by itself.
    if let Some(main) = objc2_core_foundation::CFRunLoop::main() {
        main.wake_up();
    }
}

fn notify_if_key(window: &Retained<NSWindow>) {
    let Some(main_thread) = MainThreadMarker::new() else {
        return;
    };
    if !NSApplication::sharedApplication(main_thread).isActive() || !window.isKeyWindow() {
        return;
    }
    // GPUI's window is its own delegate and clears it when it closes.
    // SAFETY: `delegate` is an object getter with no preconditions.
    let delegate: Option<Retained<AnyObject>> = unsafe { msg_send![&**window, delegate] };
    let Some(delegate) = delegate else {
        return;
    };
    // SAFETY: respondsToSelector: is defined on every NSObject.
    let responds: bool =
        unsafe { msg_send![&*delegate, respondsToSelector: sel!(windowDidBecomeKey:)] };
    if !responds {
        return;
    }
    let object: &AnyObject = window;
    // SAFETY: the notification's object is the window it describes, as
    // AppKit's own NSWindowDidBecomeKeyNotification carries.
    let notification = unsafe {
        NSNotification::notificationWithName_object(NSWindowDidBecomeKeyNotification, Some(object))
    };
    // SAFETY: the delegate responds to this NSWindowDelegate method, which
    // takes one NSNotification and returns nothing.
    let () = unsafe { msg_send![&*delegate, windowDidBecomeKey: &*notification] };
}
