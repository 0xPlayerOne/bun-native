// AppKit protocol integration adapted from cef-rs cefsimple at
// 163744c8286d5f593d89202c7807751a7898db28. See provenance/cef-host.md.
use cef::application_mac::{CefAppProtocol, CrAppControlProtocol, CrAppProtocol};
use objc2::{
    define_class, extern_methods, msg_send,
    rc::Retained,
    runtime::{AnyObject, Bool},
    DefinedClass, MainThreadMarker,
};
use objc2_app_kit::{NSApplication, NSApplicationActivationPolicy, NSEvent};
use std::cell::Cell;
#[derive(Default)]
pub struct AppIvars {
    handling: Cell<Bool>,
}
define_class!(
    #[unsafe(super(NSApplication))]
    #[ivars = AppIvars]
    pub struct BunlyApplication;
    impl BunlyApplication {
        #[unsafe(method(sendEvent:))]
        unsafe fn send_event(&self, event: &NSEvent) {
            let previous = self.ivars().handling.replace(Bool::YES);
            let _: () = msg_send![super(self), sendEvent: event];
            self.ivars().handling.set(previous);
        }
        #[unsafe(method(terminate:))]
        unsafe fn terminate(&self, _sender: &AnyObject) { crate::host::request_quit(); }
    }
    unsafe impl CrAppControlProtocol for BunlyApplication {
        #[unsafe(method(setHandlingSendEvent:))]
        unsafe fn set_handling(&self, value: Bool) { self.ivars().handling.set(value); }
    }
    unsafe impl CrAppProtocol for BunlyApplication {
        #[unsafe(method(isHandlingSendEvent))]
        unsafe fn is_handling(&self) -> Bool { self.ivars().handling.get() }
    }
    unsafe impl CefAppProtocol for BunlyApplication {}
);
impl BunlyApplication {
    extern_methods!(
        #[unsafe(method(sharedApplication))]
        fn shared_application() -> Retained<Self>;
    );
}
pub fn setup() -> Retained<BunlyApplication> {
    let _main = MainThreadMarker::new().expect("AppKit must run on OS main thread");
    let app = BunlyApplication::shared_application();
    app.setActivationPolicy(NSApplicationActivationPolicy::Regular);
    app
}
