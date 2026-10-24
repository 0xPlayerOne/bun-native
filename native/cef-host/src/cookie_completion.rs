//! Complete enumeration only after CEF releases the last visitor reference.
//! FlushCookieStore is independent of GetCookieList and cannot fence its reply.
use std::sync::atomic::{AtomicBool, Ordering};

pub(crate) struct VisitCompletion {
    armed: AtomicBool,
    callback: Option<Box<dyn FnOnce() + Send + Sync>>,
}

impl VisitCompletion {
    pub(crate) fn new(callback: impl FnOnce() + Send + Sync + 'static) -> Self {
        Self {
            armed: AtomicBool::new(false),
            callback: Some(Box::new(callback)),
        }
    }

    /// The caller retains a reference until registration returns. Failed
    /// registration must never create a second completion or report an empty read.
    pub(crate) fn arm(&self) {
        self.armed.store(true, Ordering::Release);
    }
}

impl Drop for VisitCompletion {
    fn drop(&mut self) {
        if self.armed.load(Ordering::Acquire) {
            if let Some(callback) = self.callback.take() {
                callback();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{atomic::AtomicUsize, Arc};

    #[test]
    fn last_visitor_release_completes_exactly_once_even_for_empty_enumeration() {
        let calls = Arc::new(AtomicUsize::new(0));
        let output = calls.clone();
        let caller = Arc::new(VisitCompletion::new(move || {
            output.fetch_add(1, Ordering::SeqCst);
        }));
        let visitor = caller.clone();
        let native = visitor.clone();
        caller.arm();
        drop(caller);
        drop(visitor);
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        drop(native);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn rejected_registration_never_completes_a_successful_read() {
        let calls = Arc::new(AtomicUsize::new(0));
        let output = calls.clone();
        let caller = Arc::new(VisitCompletion::new(move || {
            output.fetch_add(1, Ordering::SeqCst);
        }));
        let visitor = caller.clone();
        drop(visitor);
        drop(caller);
        assert_eq!(calls.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn synchronous_native_release_waits_until_registration_is_known() {
        let calls = Arc::new(AtomicUsize::new(0));
        let output = calls.clone();
        let caller = Arc::new(VisitCompletion::new(move || {
            output.fetch_add(1, Ordering::SeqCst);
        }));
        drop(caller.clone());
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        caller.arm();
        drop(caller);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }
}
