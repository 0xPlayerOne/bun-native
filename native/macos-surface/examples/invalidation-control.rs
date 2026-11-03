//! Actual Core Animation delegate controls; not GPUI or display-presentation evidence.
#[cfg(target_os = "macos")]
#[allow(unsafe_code)] // Test-owned Objective-C objects and borrowed native handles.
mod control {
    use bun_native_macos_surface::{InvalidationError, invalidate};
    use objc2::rc::Retained;
    use objc2::runtime::ProtocolObject;
    use objc2::{DefinedClass, MainThreadMarker, MainThreadOnly, define_class, msg_send};
    use objc2_app_kit::NSView;
    use objc2_foundation::{NSObject, NSObjectProtocol, NSPoint, NSRect, NSSize};
    use objc2_quartz_core::{CALayer, CALayerDelegate};
    use raw_window_handle::{AppKitWindowHandle, RawWindowHandle, WindowHandle};
    use std::cell::Cell;
    use std::ptr::NonNull;

    define_class!(
        // SAFETY: NSObject has no subclassing requirements. State and methods
        // stay on the main thread, matching the native display callback.
        #[unsafe(super = NSObject)]
        #[thread_kind = MainThreadOnly]
        #[ivars = Cell<usize>]
        struct DisplayDelegate;
        unsafe impl NSObjectProtocol for DisplayDelegate {}
        unsafe impl CALayerDelegate for DisplayDelegate {
            #[unsafe(method(displayLayer:))]
            fn display_layer(&self, layer: &CALayer) {
                // Complete the delegate-managed empty contents update. A layer
                // delegate, unlike drawInContext:, owns committing its contents.
                // SAFETY: clearing contents passes no untyped native object.
                unsafe { layer.setContents(None) };
                self.ivars().set(self.ivars().get() + 1);
            }
        }
    );

    impl DisplayDelegate {
        fn new(marker: MainThreadMarker) -> Retained<Self> {
            let this = Self::alloc(marker).set_ivars(Cell::new(0));
            // SAFETY: NSObject's designated initializer is init.
            unsafe { msg_send![super(this), init] }
        }
    }

    struct Surface {
        view: Retained<NSView>,
        layer: Retained<CALayer>,
        delegate: Retained<DisplayDelegate>,
    }

    impl Surface {
        fn new(marker: MainThreadMarker) -> Self {
            let frame = NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(160.0, 80.0));
            let view = NSView::initWithFrame(NSView::alloc(marker), frame);
            let layer = CALayer::new();
            layer.setBounds(frame);
            view.setLayer(Some(&layer));
            view.setWantsLayer(true);
            let delegate = DisplayDelegate::new(marker);
            layer.setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
            // Establish a real display callback before testing invalidation.
            layer.setNeedsDisplay();
            layer.displayIfNeeded();
            assert_eq!(
                delegate.ivars().get(),
                1,
                "native delegate control did not initialize"
            );
            assert!(!layer.needsDisplay());
            Self {
                view,
                layer,
                delegate,
            }
        }

        fn handle(&self) -> WindowHandle<'_> {
            let raw = AppKitWindowHandle::new(NonNull::from(&*self.view).cast());
            // SAFETY: this Surface owns the NSView for the returned borrow.
            unsafe { WindowHandle::borrow_raw(RawWindowHandle::AppKit(raw)) }
        }

        fn draws(&self) -> usize {
            self.delegate.ivars().get()
        }
    }

    pub(super) fn run() {
        let arguments: Vec<_> = std::env::args().skip(1).collect();
        let omit = match arguments.as_slice() {
            [] => false,
            [flag] if flag == "--omit-invalidation" => true,
            _ => panic!("unknown invalidation control argument"),
        };
        let marker = MainThreadMarker::new().expect("control requires main thread");
        let target = Surface::new(marker);
        let unrelated = Surface::new(marker);
        let before = target.draws();
        if !omit {
            invalidate(target.handle()).unwrap();
        }
        assert!(
            target.layer.needsDisplay(),
            "committed surface did not become dirty"
        );
        assert_eq!(
            target.draws(),
            before,
            "invalidation must not draw re-entrantly"
        );
        assert!(
            !unrelated.layer.needsDisplay(),
            "unrelated layer was invalidated"
        );
        target.layer.displayIfNeeded();
        assert_eq!(
            target.draws(),
            before + 1,
            "normal display delegate did not run"
        );
        for _ in 0..1_000 {
            invalidate(target.handle()).unwrap();
        }
        assert_eq!(target.draws(), before + 1, "burst must remain deferred");
        target.layer.displayIfNeeded();
        assert_eq!(
            target.draws(),
            before + 2,
            "burst must coalesce into one display pass"
        );
        invalidate(target.handle()).unwrap();
        target.layer.displayIfNeeded();
        assert_eq!(
            target.draws(),
            before + 3,
            "later commits must re-arm display"
        );
        assert_eq!(unrelated.draws(), 1);
        let unbacked = NSView::new(marker);
        let raw = AppKitWindowHandle::new(NonNull::from(&*unbacked).cast());
        // SAFETY: unbacked owns this live NSView until after the call.
        let handle = unsafe { WindowHandle::borrow_raw(RawWindowHandle::AppKit(raw)) };
        assert_eq!(invalidate(handle), Err(InvalidationError::MissingLayer));
        println!(
            "Core Animation controls passed: deferred, delegate, isolated, coalesced, rearmed, unbacked"
        );
    }
}

#[cfg(target_os = "macos")]
fn main() {
    control::run();
}
#[cfg(not(target_os = "macos"))]
fn main() {
    eprintln!("Native layer controls require macOS");
    std::process::exit(2);
}
