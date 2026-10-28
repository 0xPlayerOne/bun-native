//! A window's BrowserHosts must accept closing as one UI-thread batch. CEF can
//! synchronously ask the same WindowDelegate to close while that batch runs.
use std::{cell::Cell, rc::Rc};

#[derive(Default)]
struct State {
    active: Cell<bool>,
    requested: Cell<bool>,
    queued: Cell<bool>,
}

#[derive(Clone, Default)]
pub(super) struct CloseBatch(Rc<State>);

pub(super) struct CloseGuard(Rc<State>);

impl CloseBatch {
    pub fn enter(&self) -> Option<CloseGuard> {
        if self.0.active.replace(true) {
            self.0.requested.set(true);
            return None;
        }
        Some(CloseGuard(Rc::clone(&self.0)))
    }

    pub fn retry_started(&self) {
        self.0.queued.set(false);
    }
}

impl CloseGuard {
    /// TryCloseBrowser can return false after synchronously requesting another
    /// parent close. Defer that actual request once; do not poll pending closes.
    pub fn finish(self, pending: bool) -> bool {
        let requested = self.0.requested.replace(false);
        pending && requested && !self.0.queued.replace(true)
    }
}

impl Drop for CloseGuard {
    fn drop(&mut self) {
        self.0.active.set(false);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recursive_close_waits_for_the_entire_batch_and_then_may_retry() {
        let window = CloseBatch::default();
        let callback = window.clone();
        let other_window = CloseBatch::default();
        let guard = window.enter().unwrap();
        let mut attempts = 0;
        for _ in 0..4 {
            attempts += 1;
            assert!(callback.enter().is_none());
            // An unrelated window has its own close lifecycle.
            assert!(other_window.enter().is_some());
        }
        assert_eq!(attempts, 4);
        drop(window);
        assert!(callback.enter().is_none());
        drop(guard);
        assert!(callback.enter().is_some());
        assert!(callback.enter().is_some());
    }

    #[test]
    fn accepted_synchronous_close_progresses_after_false_return_without_duplicate_tasks() {
        let window = CloseBatch::default();
        let guard = window.enter().unwrap();
        let mut accepted = [false; 4];
        for state in &mut accepted {
            // Pinned CEF can accept closing and reenter Window.CanClose, then
            // still return false from the original TryCloseBrowser call.
            *state = true;
            assert!(window.enter().is_none());
        }
        assert!(guard.finish(true));
        let another = window.enter().unwrap();
        assert!(window.enter().is_none());
        assert!(!another.finish(true), "Only one UI retry may be queued");
        window.retry_started();
        let retry = window.enter().unwrap();
        assert!(accepted.into_iter().all(|value| value));
        assert!(!retry.finish(false));
        let pending_without_callback = window.enter().unwrap();
        assert!(!pending_without_callback.finish(true), "No retry polling");
    }
}
