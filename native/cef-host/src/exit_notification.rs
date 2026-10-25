//! One retained observation from the existing OS exit watcher. A notification
//! does not reap the child, authorize process signalling, or imply output EOF.
use std::{
    sync::{Condvar, Mutex},
    time::Instant,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ExitWait {
    Exited,
    ObservationFailed,
    DeadlineExceeded,
}

#[derive(Default)]
pub struct ExitNotification {
    observed: Mutex<Option<(bool, Instant)>>,
    changed: Condvar,
}
impl ExitNotification {
    pub const fn new() -> Self {
        Self {
            observed: Mutex::new(None),
            changed: Condvar::new(),
        }
    }

    /// Called once by the already-owned OS watcher. Keep the first observation;
    /// a later callback cannot repair an error or replace an earlier identity.
    pub fn publish(&self, exited: bool) {
        if let Ok(mut observed) = self.observed.lock() {
            if observed.is_none() {
                *observed = Some((exited, Instant::now()));
            }
        }
        self.changed.notify_all();
    }

    /// The original absolute monotonic deadline is never extended by a wakeup.
    /// Timestamping publication also prevents a delayed lock reacquisition from
    /// accepting an observation first published after the deadline.
    pub fn wait_until(&self, deadline: Instant) -> ExitWait {
        let Ok(observed) = self.observed.lock() else {
            return ExitWait::ObservationFailed;
        };
        let Ok((observed, _)) = self.changed.wait_timeout_while(
            observed,
            deadline.saturating_duration_since(Instant::now()),
            |value| value.is_none(),
        ) else {
            return ExitWait::ObservationFailed;
        };
        match *observed {
            Some((true, at)) if at <= deadline => ExitWait::Exited,
            Some((false, at)) if at <= deadline => ExitWait::ObservationFailed,
            _ => ExitWait::DeadlineExceeded,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{sync::Arc, thread, time::Duration};

    #[test]
    fn exit_published_before_waiting_is_not_a_lost_wakeup() {
        let notification = ExitNotification::new();
        notification.publish(true);
        let deadline = Instant::now();
        assert_eq!(notification.wait_until(deadline), ExitWait::Exited);
        assert_eq!(notification.wait_until(deadline), ExitWait::Exited);
    }

    #[test]
    fn first_observation_is_final_and_cannot_be_repaired_by_a_later_success() {
        let failed = ExitNotification::new();
        failed.publish(false);
        failed.publish(true);
        assert_eq!(
            failed.wait_until(Instant::now()),
            ExitWait::ObservationFailed
        );
        let exited = ExitNotification::new();
        exited.publish(true);
        exited.publish(false);
        assert_eq!(exited.wait_until(Instant::now()), ExitWait::Exited);
    }

    #[test]
    fn missing_or_late_observation_cannot_pass_an_expired_deadline() {
        let notification = ExitNotification::new();
        let expired = Instant::now() - Duration::from_secs(1);
        assert_eq!(notification.wait_until(expired), ExitWait::DeadlineExceeded);
        notification.publish(true);
        assert_eq!(notification.wait_until(expired), ExitWait::DeadlineExceeded);
    }

    #[test]
    fn actual_notification_wakes_waiters_without_fixed_rate_polling() {
        let notification = Arc::new(ExitNotification::new());
        let barrier = Arc::new(std::sync::Barrier::new(3));
        let workers: Vec<_> = (0..2)
            .map(|_| {
                let notification = notification.clone();
                let barrier = barrier.clone();
                thread::spawn(move || {
                    barrier.wait();
                    notification.wait_until(Instant::now() + Duration::from_secs(5))
                })
            })
            .collect();
        barrier.wait();
        notification.publish(true);
        for worker in workers {
            assert_eq!(worker.join().unwrap(), ExitWait::Exited);
        }
    }

    #[test]
    fn a_pending_observation_expires_without_any_wakeup() {
        let notification = ExitNotification::new();
        assert_eq!(
            notification.wait_until(Instant::now() + Duration::from_millis(1)),
            ExitWait::DeadlineExceeded
        );
    }

    #[test]
    fn notification_without_observed_exit_is_not_success() {
        let notification = ExitNotification::new();
        notification.changed.notify_all();
        assert_eq!(
            notification.wait_until(Instant::now()),
            ExitWait::DeadlineExceeded
        );
    }

    #[test]
    fn poisoned_observation_is_a_failure_not_an_exit() {
        let notification = Arc::new(ExitNotification::new());
        let worker = {
            let notification = notification.clone();
            thread::spawn(move || {
                let _lock = notification.observed.lock().unwrap();
                panic!("controlled poisoned observation");
            })
        };
        assert!(worker.join().is_err());
        notification.publish(true);
        assert_eq!(
            notification.wait_until(Instant::now()),
            ExitWait::ObservationFailed
        );
    }
}
