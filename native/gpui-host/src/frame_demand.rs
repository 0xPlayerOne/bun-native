//! One pending UI-thread frame request per owned view. Completion never owns the view.
use std::cell::Cell;
use std::rc::{Rc, Weak};

#[derive(Default)]
pub(crate) struct FrameDemand {
    pending: Rc<Cell<bool>>,
}

impl FrameDemand {
    pub(crate) fn begin(&self) -> Option<FrameCompletion> {
        if self.pending.replace(true) {
            return None;
        }
        Some(FrameCompletion(Rc::downgrade(&self.pending)))
    }
}

pub(crate) struct FrameCompletion(Weak<Cell<bool>>);

impl Drop for FrameCompletion {
    fn drop(&mut self) {
        if let Some(pending) = self.0.upgrade() {
            pending.set(false);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_burst_queues_one_frame_and_rearms_after_delivery() {
        let demand = FrameDemand::default();
        let completion = demand.begin().expect("first commit requests a frame");
        for _ in 0..1_000 {
            assert!(demand.begin().is_none());
        }
        drop(completion);
        let next = demand.begin().expect("a subsequent frame can be requested");
        assert!(demand.begin().is_none());
        drop(next);
    }

    #[test]
    fn a_dropped_callback_releases_only_its_own_pending_request() {
        let first = FrameDemand::default();
        let second = FrameDemand::default();
        let first_completion = first.begin().unwrap();
        let second_completion = second.begin().unwrap();
        drop(first_completion);
        let next_first = first.begin().unwrap();
        assert!(second.begin().is_none());
        drop(second_completion);
        assert!(second.begin().is_some());
        assert!(first.begin().is_none());
        drop(next_first);
    }

    #[test]
    fn pending_callback_does_not_retain_disposed_view_state() {
        let demand = FrameDemand::default();
        let witness = Rc::downgrade(&demand.pending);
        let completion = demand.begin().unwrap();
        assert_eq!(Rc::strong_count(&demand.pending), 1);
        drop(demand);
        assert!(witness.upgrade().is_none());
        drop(completion);
        assert!(witness.upgrade().is_none());
    }
}
