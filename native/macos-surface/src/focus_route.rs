//! Answer AppKit's keyboard-focus and hit-test accessibility queries for a GPUI
//! window from its AccessKit adapter.
//!
//! The pinned GPUI creates its AccessKit adapter with
//! `accesskit_macos::SubclassingAdapter::for_window`, which dynamically
//! subclasses the window's *content view* and overrides
//! `accessibilityFocusedUIElement` and `accessibilityHitTest:` there. GPUI's own
//! `GPUIView` is not that content view: GPUI adds it as a *subview* of the
//! default content view and makes it the window's first responder. AppKit
//! resolves the application's `AXFocusedUIElement` through the key window and
//! its first responder, so the question reaches `GPUIView`, which inherits
//! `NSView`'s answer (its nearest unignored ancestor, the window) and never asks
//! AccessKit. The window is reported as focused whatever AccessKit's tree says,
//! and VoiceOver follows no keyboard focus.
//!
//! [`route`] adds `accessibilityFocusedUIElement` to the GPUI view's and
//! window's classes, and `accessibilityHitTest:` to the view's class. Each asks
//! the window's content view when that view is an AccessKit subclass and
//! returns its element when it has one; otherwise, and for every other view or
//! window of those classes, the inherited AppKit answer is returned unchanged.
//! Nothing about key status, first responder, ordering or focus is changed.
#![allow(unsafe_code)] // Reviewed Objective-C runtime method installation of this boundary.

use crate::{SurfaceError, appkit, main_thread};
use objc2::ffi::{
    class_addMethod, class_getInstanceMethod, method_getImplementation, method_getTypeEncoding,
};
use objc2::rc::Retained;
use objc2::runtime::{AnyClass, AnyObject, Imp, Sel};
use objc2::{Message, msg_send, sel};
use objc2_app_kit::{NSResponder, NSView, NSWindow};
use objc2_foundation::NSPoint;
use raw_window_handle::WindowHandle;
use std::cell::RefCell;

/// Name prefix of the classes `accesskit_macos` registers for the views it
/// subclasses (`AccessKitSubclassOf<original class>`).
const ACCESSKIT_SUBCLASS: &[u8] = b"AccessKitSubclassOf";

type FocusFn = unsafe extern "C-unwind" fn(*mut AnyObject, Sel) -> *mut AnyObject;
type HitFn = unsafe extern "C-unwind" fn(*mut AnyObject, Sel, NSPoint) -> *mut AnyObject;

/// One class this module added its methods to, with the implementations those
/// methods replace for instances of that class.
struct Routed {
    class: *const AnyClass,
    focus: FocusFn,
    /// Only views route hit tests: a window's hit test also covers its title
    /// bar, which AccessKit's tree does not contain.
    hit: Option<HitFn>,
}

thread_local! {
    /// Only the AppKit main thread installs or reads these.
    static ROUTED: RefCell<Vec<Routed>> = const { RefCell::new(Vec::new()) };
}

/// The classes [`route`] found, by name, and the window's first responder, for
/// evidence.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FocusRoute {
    /// The class of the borrowed GPUI view (`GPUIView`).
    pub view_class: String,
    /// The class of its window (`GPUIWindow` or `GPUIPanel`).
    pub window_class: String,
    /// The class of the window's content view: an AccessKit subclass once GPUI
    /// enabled accessibility for the window.
    pub content_view_class: String,
    /// Whether the GPUI view is the window's first responder.
    pub view_is_first_responder: bool,
}

/// Route AppKit's focus and hit-test accessibility queries for the window of a
/// borrowed GPUI view to the AccessKit adapter on its content view. Call it on
/// the main thread after GPUI opened the window.
pub fn route(handle: WindowHandle<'_>) -> Result<FocusRoute, SurfaceError> {
    let _main_thread = main_thread()?;
    let handle = appkit(handle.as_raw())?;
    // SAFETY: WindowHandle borrows a live NSView for its AppKit variant. The
    // variant and UI-thread authority were checked before this dereference.
    let view = unsafe { handle.ns_view.cast::<NSView>().as_ref() };
    let window = view.window().ok_or(SurfaceError::MissingWindow)?;
    let view_object: &AnyObject = view;
    let window_object: &AnyObject = &window;
    install(view_object.class(), true)?;
    install(window_object.class(), false)?;
    let content = window.contentView().ok_or(SurfaceError::MissingWindow)?;
    let content_object: &AnyObject = &content;
    let view_responder: &NSResponder = view;
    Ok(FocusRoute {
        view_class: class_name(view_object.class()),
        window_class: class_name(window_object.class()),
        content_view_class: class_name(content_object.class()),
        view_is_first_responder: window
            .firstResponder()
            .is_some_and(|responder| std::ptr::eq(&*responder, view_responder)),
    })
}

fn class_name(class: &AnyClass) -> String {
    class.name().to_string_lossy().into_owned()
}

fn install(class: &'static AnyClass, route_hit: bool) -> Result<(), SurfaceError> {
    let class_ptr: *const AnyClass = class;
    if ROUTED.with_borrow(|routed| routed.iter().any(|entry| entry.class == class_ptr)) {
        return Ok(());
    }
    let focus_sel = sel!(accessibilityFocusedUIElement);
    let hit_sel = sel!(accessibilityHitTest:);
    // SAFETY: the class is a registered, live NSView or NSWindow class. Both
    // selectors are NSAccessibility methods every NSView and NSWindow inherits;
    // the inherited Method, its implementation and type encoding are runtime
    // data that live as long as the class.
    let (focus_method, hit_method) = unsafe {
        (
            class_getInstanceMethod(class_ptr, focus_sel),
            class_getInstanceMethod(class_ptr, hit_sel),
        )
    };
    if focus_method.is_null() || hit_method.is_null() {
        return Err(SurfaceError::MissingAccessibility);
    }
    // SAFETY: both methods were found above.
    let (focus_imp, hit_imp, focus_types, hit_types) = unsafe {
        (
            method_getImplementation(focus_method),
            method_getImplementation(hit_method),
            method_getTypeEncoding(focus_method),
            method_getTypeEncoding(hit_method),
        )
    };
    let (Some(focus_imp), Some(hit_imp)) = (focus_imp, hit_imp) else {
        return Err(SurfaceError::MissingAccessibility);
    };
    // SAFETY: the inherited implementations have exactly these Objective-C
    // signatures: `- (id)accessibilityFocusedUIElement` and
    // `- (id)accessibilityHitTest:(NSPoint)point`.
    let (focus, hit) = unsafe {
        (
            std::mem::transmute::<Imp, FocusFn>(focus_imp),
            std::mem::transmute::<Imp, HitFn>(hit_imp),
        )
    };
    // Record the replaced implementations before AppKit can call the new ones.
    ROUTED.with_borrow_mut(|routed| {
        routed.push(Routed {
            class: class_ptr,
            focus,
            hit: route_hit.then_some(hit),
        })
    });
    // SAFETY: the new implementation has the inherited method's signature and
    // reuses its type encoding. class_addMethod only adds a method the class
    // does not define itself, so a class that already answers this query keeps
    // its own answer, and the failure is reported.
    let added_focus = unsafe {
        class_addMethod(
            class_ptr.cast_mut(),
            focus_sel,
            std::mem::transmute::<FocusFn, Imp>(routed_focus),
            focus_types,
        )
    }
    .as_bool();
    let added_hit = !route_hit
        // SAFETY: as above, for `accessibilityHitTest:`.
        || unsafe {
            class_addMethod(
                class_ptr.cast_mut(),
                hit_sel,
                std::mem::transmute::<HitFn, Imp>(routed_hit),
                hit_types,
            )
        }
        .as_bool();
    if !added_focus || !added_hit {
        return Err(SurfaceError::MissingAccessibility);
    }
    Ok(())
}

/// The replaced implementations for this object's class: its own class, or the
/// nearest routed superclass when AppKit or KVO subclassed it again.
fn inherited(this: &AnyObject) -> Option<(FocusFn, Option<HitFn>)> {
    ROUTED.with_borrow(|routed| {
        let mut class = Some(this.class());
        while let Some(current) = class {
            let current_ptr: *const AnyClass = current;
            if let Some(entry) = routed.iter().find(|entry| entry.class == current_ptr) {
                return Some((entry.focus, entry.hit));
            }
            class = current.superclass();
        }
        None
    })
}

/// The window's content view, when `accesskit_macos` subclassed it.
fn accesskit_view(this: &AnyObject) -> Option<Retained<NSView>> {
    let window = match this.downcast_ref::<NSWindow>() {
        Some(window) => window.retain(),
        None => this.downcast_ref::<NSView>()?.window()?,
    };
    let content = window.contentView()?;
    let content_object: &AnyObject = &content;
    let mut class = Some(content_object.class());
    while let Some(current) = class {
        if current.name().to_bytes().starts_with(ACCESSKIT_SUBCLASS) {
            return Some(content);
        }
        class = current.superclass();
    }
    None
}

unsafe extern "C-unwind" fn routed_focus(this: *mut AnyObject, cmd: Sel) -> *mut AnyObject {
    // SAFETY: AppKit sends this method to a live instance of a routed class.
    let object = unsafe { &*this };
    let Some((inherited_focus, _)) = inherited(object) else {
        return std::ptr::null_mut();
    };
    if let Some(content) = accesskit_view(object) {
        // SAFETY: AccessKit's subclass answers this NSAccessibility getter with
        // an autoreleased element, or nil when its tree has no focused node or
        // it believes the window is not focused.
        let element: *mut AnyObject =
            unsafe { msg_send![&*content, accessibilityFocusedUIElement] };
        if !element.is_null() {
            return element;
        }
    }
    // SAFETY: the inherited implementation for this object's class and selector.
    unsafe { inherited_focus(this, cmd) }
}

unsafe extern "C-unwind" fn routed_hit(
    this: *mut AnyObject,
    cmd: Sel,
    point: NSPoint,
) -> *mut AnyObject {
    // SAFETY: AppKit sends this method to a live instance of a routed class.
    let object = unsafe { &*this };
    let Some((_, Some(inherited_hit))) = inherited(object) else {
        return std::ptr::null_mut();
    };
    if let Some(content) = accesskit_view(object) {
        // SAFETY: AccessKit's subclass answers this NSAccessibility method with
        // an autoreleased element for a point in screen coordinates, the same
        // coordinates AppKit passes here.
        let element: *mut AnyObject = unsafe { msg_send![&*content, accessibilityHitTest: point] };
        if !element.is_null() {
            return element;
        }
    }
    // SAFETY: the inherited implementation for this object's class and selector.
    unsafe { inherited_hit(this, cmd, point) }
}
