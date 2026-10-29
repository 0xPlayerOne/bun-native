//! The process owns only its empty-slot application delegate. It neither chains
//! an unknown delegate nor registers URL types with Launch Services.
use objc2::{
    define_class, msg_send, rc::Retained, runtime::ProtocolObject, DefinedClass, MainThreadMarker,
    MainThreadOnly,
};
use objc2_app_kit::{NSApplication, NSApplicationDelegate, NSWorkspace};
use objc2_foundation::{NSArray, NSObject, NSObjectProtocol, NSString, NSURL};
use std::{
    cell::{Cell, RefCell},
    rc::Rc,
};

struct DelegateIvars {
    live: Cell<bool>,
}
define_class!(
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[ivars = DelegateIvars]
    struct LinkDelegate;
    unsafe impl NSObjectProtocol for LinkDelegate {}
    unsafe impl NSApplicationDelegate for LinkDelegate {
        #[unsafe(method(application:openURLs:))]
        fn open_urls(&self, _application: &NSApplication, urls: &NSArray<NSURL>) {
            if !self.ivars().live.get() {
                return;
            }
            // Bound work and allocation before copying any untrusted NSString.
            let count = urls.count();
            for url in urls.iter().take(super::MAX_ENTRIES) {
                if !self.ivars().live.get() {
                    break;
                }
                if let Some(value) = url
                    .absoluteString()
                    .filter(|value| value.length() <= super::MAX_URL)
                {
                    super::receive_macos(&value.to_string());
                } else {
                    super::reject_macos(1);
                }
            }
            if count > super::MAX_ENTRIES {
                super::overflow_macos(count - super::MAX_ENTRIES);
            }
        }
    }
);
struct Owner {
    application: Retained<NSApplication>,
    delegate: Retained<LinkDelegate>,
}
thread_local! { static OWNER: RefCell<Option<Rc<Owner>>> = const { RefCell::new(None) }; }
impl Owner {
    fn installed(&self) -> bool {
        self.application
            .delegate()
            .as_deref()
            .is_some_and(|current| std::ptr::eq(current, ProtocolObject::from_ref(&*self.delegate)))
    }
}
pub(super) fn install() -> Result<(), String> {
    let main = MainThreadMarker::new()
        .ok_or("Application link delegate requires the native main thread")?;
    if OWNER.with(|owner| owner.borrow().is_some()) {
        return Err("Application link delegate already installed".into());
    }
    let application = NSApplication::sharedApplication(main);
    if application.delegate().is_some() {
        return Err("Application link delegate slot already owned".into());
    }
    let delegate = LinkDelegate::alloc(main).set_ivars(DelegateIvars {
        live: Cell::new(true),
    });
    let delegate: Retained<LinkDelegate> = unsafe { msg_send![super(delegate), init] };
    let owner = Rc::new(Owner {
        application,
        delegate,
    });
    // Keep the target alive across setDelegate and any native reentrant callback.
    OWNER.with(|slot| *slot.borrow_mut() = Some(owner.clone()));
    owner
        .application
        .setDelegate(Some(ProtocolObject::from_ref(&*owner.delegate)));
    if !owner.installed() {
        remove()?;
        return Err("Application link delegate installation failed".into());
    }
    Ok(())
}
pub(super) fn remove() -> Result<(), String> {
    let _main = MainThreadMarker::new()
        .ok_or("Application link delegate requires the native main thread")?;
    let Some(owner) = OWNER.with(|slot| slot.borrow().clone()) else {
        return Ok(());
    };
    owner.delegate.ivars().live.set(false);
    if owner.installed() {
        owner.application.setDelegate(None);
    }
    if owner.installed() {
        return Err("Application link delegate removal failed".into());
    }
    // A foreign replacement remains installed. Release only our detached owner,
    // after the real AppKit setter returned and no RefCell borrow is active.
    let retired = OWNER.with(|slot| {
        let mut slot = slot.borrow_mut();
        if slot
            .as_ref()
            .is_some_and(|current| Rc::ptr_eq(current, &owner))
        {
            slot.take()
        } else {
            None
        }
    });
    drop(retired);
    Ok(())
}
pub(super) fn owners() -> usize {
    OWNER.with(|slot| usize::from(slot.borrow().is_some()))
}
pub(super) fn open(input: &str) -> Result<(), String> {
    let _main =
        MainThreadMarker::new().ok_or("External URL submission requires the native main thread")?;
    let url = NSURL::URLWithString(&NSString::from_str(input))
        .ok_or("Native external URL construction failed")?;
    if !NSWorkspace::sharedWorkspace().openURL(&url) {
        return Err("Native external URL submission failed".into());
    }
    Ok(())
}
