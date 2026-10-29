//! The AppKit target is weakly linked back to its Rust owner. The registry holds
//! the item, target and owner until removeStatusItem has returned on the UI thread.
use super::Definition;
use objc2::{
    define_class, msg_send, rc::Retained, runtime::AnyObject, sel, DefinedClass, MainThreadMarker,
    MainThreadOnly,
};
use objc2_app_kit::{NSStatusBar, NSStatusBarButton, NSStatusItem, NSVariableStatusItemLength};
use objc2_foundation::{NSObject, NSObjectProtocol, NSString};
use std::{
    cell::Cell,
    rc::{Rc, Weak},
};

struct CallbackOwner {
    token: String,
    birth: u64,
    live: Cell<bool>,
}
struct ActionIvars {
    owner: Weak<CallbackOwner>,
}
define_class!(
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[ivars = ActionIvars]
    struct StatusTarget;
    unsafe impl NSObjectProtocol for StatusTarget {}
    impl StatusTarget {
        #[unsafe(method(bunlyStatusItemClicked:))]
        fn clicked(&self, _sender: Option<&AnyObject>) {
            if let Some(owner) = self.ivars().owner.upgrade().filter(|owner| owner.live.get()) {
                super::clicked(&owner.token, owner.birth);
            }
        }
    }
);
pub(super) struct Item {
    bar: Retained<NSStatusBar>,
    item: Retained<NSStatusItem>,
    button: Retained<NSStatusBarButton>,
    _target: Retained<StatusTarget>,
    owner: Rc<CallbackOwner>,
}
impl Item {
    pub(super) fn create(
        token: String,
        birth: u64,
        definition: &Definition,
    ) -> Result<Self, String> {
        let mtm = MainThreadMarker::new().ok_or("Status item requires the native main thread")?;
        let owner = Rc::new(CallbackOwner {
            token,
            birth,
            live: Cell::new(true),
        });
        let target = StatusTarget::alloc(mtm).set_ivars(ActionIvars {
            owner: Rc::downgrade(&owner),
        });
        let target: Retained<StatusTarget> = unsafe { msg_send![super(target), init] };
        let bar = NSStatusBar::systemStatusBar();
        let item = bar.statusItemWithLength(NSVariableStatusItemLength);
        let Some(button) = item.button(mtm) else {
            bar.removeStatusItem(&item);
            return Err("Native status item button unavailable".into());
        };
        let result = Self {
            bar,
            item,
            button,
            _target: target,
            owner,
        };
        result.update(definition)?;
        // NSControl's target is non-owning. The retained target stays in Item.
        unsafe {
            result.button.setTarget(Some(&result._target));
            result.button.setAction(Some(sel!(bunlyStatusItemClicked:)));
        }
        Ok(result)
    }
    pub(super) fn update(&self, definition: &Definition) -> Result<(), String> {
        let _mtm = MainThreadMarker::new().ok_or("Status item requires the native main thread")?;
        if !self.owner.live.get() {
            return Err("DISPOSED: native status item removed".into());
        }
        self.button.setTitle(&NSString::from_str(&definition.title));
        let tooltip =
            (!definition.tooltip.is_empty()).then(|| NSString::from_str(&definition.tooltip));
        self.button.setToolTip(tooltip.as_deref());
        Ok(())
    }
    pub(super) fn remove(&self) -> Result<bool, String> {
        let _mtm =
            MainThreadMarker::new().ok_or("Status item removal requires the native main thread")?;
        if !self.owner.live.replace(false) {
            return Ok(false);
        }
        unsafe {
            self.button.setTarget(None);
            self.button.setAction(None);
        }
        self.bar.removeStatusItem(&self.item);
        Ok(true)
    }
    #[cfg(feature = "rpc-qualification")]
    pub(super) fn click(&self) -> Result<(), String> {
        let _mtm =
            MainThreadMarker::new().ok_or("Status item input requires the native main thread")?;
        if !self.owner.live.get() {
            return Err("DISPOSED: native status item removed".into());
        }
        // This is AppKit's actual target-action path, never a direct delegate call.
        unsafe {
            self.button.performClick(None);
        }
        Ok(())
    }
}
impl Drop for Item {
    fn drop(&mut self) {
        if self.owner.live.get() && self.remove().is_err() {
            super::super::FAILED.store(true, std::sync::atomic::Ordering::SeqCst);
        }
    }
}
