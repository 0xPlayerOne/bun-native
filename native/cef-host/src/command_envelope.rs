//! One admitted command remains owned by its ordinary CEF task. A native menu
//! wake may inspect a weak reference, but never dispatches or acknowledges it.
use crate::command_budget::CommandPermit;
use serde_json::Value;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

pub(super) struct CommandEnvelope {
    value: Value,
    dispatched: AtomicBool,
    _permit: Arc<CommandPermit>,
}
impl CommandEnvelope {
    pub fn new(value: Value, permit: Arc<CommandPermit>) -> Self {
        Self {
            value,
            dispatched: AtomicBool::new(false),
            _permit: permit,
        }
    }
    pub fn claim(&self) -> Option<&Value> {
        (!self.dispatched.swap(true, Ordering::SeqCst)).then_some(&self.value)
    }
    #[cfg(any(target_os = "macos", test))]
    pub fn pending(&self) -> Option<&Value> {
        (!self.dispatched.load(Ordering::SeqCst)).then_some(&self.value)
    }
}

#[cfg(any(target_os = "macos", test))]
#[derive(Default)]
pub(super) struct MenuWakeState(std::sync::atomic::AtomicU8);
#[cfg(any(target_os = "macos", test))]
impl MenuWakeState {
    const QUEUED: u8 = 1;
    const QUIT: u8 = 2;
    const STOPPED: u8 = 4;

    pub const fn new() -> Self {
        Self(std::sync::atomic::AtomicU8::new(0))
    }
    pub fn queue(&self) -> bool {
        self.0
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |state| {
                (state & (Self::QUEUED | Self::STOPPED) == 0).then_some(state | Self::QUEUED)
            })
            .is_ok()
    }
    pub fn begin_drain(&self) -> bool {
        self.0
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |state| {
                (state & Self::STOPPED == 0).then_some(state & !Self::QUEUED)
            })
            .is_ok()
    }
    pub fn request_quit(&self) -> bool {
        self.0
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |state| {
                (state & Self::STOPPED == 0).then_some(state | Self::QUIT)
            })
            .is_ok()
    }
    pub fn quit_dispatched(&self) {
        self.0.fetch_and(!Self::QUIT, Ordering::SeqCst);
    }
    pub fn quitting(&self) -> bool {
        self.0.load(Ordering::SeqCst) & Self::QUIT != 0
    }
    pub fn stopped(&self) -> bool {
        self.0.load(Ordering::SeqCst) & Self::STOPPED != 0
    }
    pub fn stop(&self) {
        // One atomic state prevents a racing producer from restoring pending
        // work or quit intent after the main thread starts host teardown.
        self.0.store(Self::STOPPED, Ordering::SeqCst);
    }
}

#[cfg(any(target_os = "macos", test))]
#[derive(Default)]
pub(super) struct MenuCleanupQueue {
    // This list never owns a command or its wire bytes. Expired and already
    // dispatched entries are pruned on both admission and inspection.
    pending: Vec<std::sync::Weak<CommandEnvelope>>,
}
#[cfg(any(target_os = "macos", test))]
impl MenuCleanupQueue {
    pub fn track(&mut self, command: &Arc<CommandEnvelope>) -> Result<bool, &'static str> {
        self.prune();
        let Some(value) = command.pending() else {
            return Ok(false);
        };
        if !matches!(
            value.get("op").and_then(Value::as_str),
            Some("commands.cancel" | "commands.dispose" | "quit")
        ) {
            return Ok(false);
        }
        let weak = Arc::downgrade(command);
        if !self.pending.iter().any(|entry| entry.ptr_eq(&weak)) {
            // Each live entry already has a native command permit. Keep the
            // explicit same-policy bound even if a future caller repeats track.
            if self.pending.len() >= crate::command_budget::native_request_limit() {
                return Err("Native menu cleanup admission unavailable");
            }
            self.pending.push(weak);
        }
        Ok(true)
    }
    fn prune(&mut self) {
        self.pending.retain(|entry| {
            entry
                .upgrade()
                .is_some_and(|command| command.pending().is_some())
        });
    }
    pub fn pending(&mut self) -> Vec<Arc<CommandEnvelope>> {
        self.prune();
        self.pending
            .iter()
            .filter_map(|entry| entry.upgrade())
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::command_budget::CommandBudget;
    use serde_json::json;

    fn command(budget: &Arc<CommandBudget>, operation: &str) -> Arc<CommandEnvelope> {
        Arc::new(CommandEnvelope::new(
            json!({"v":1,"id":1,"op":operation,"args":{}}),
            budget.reserve(operation, 128).unwrap(),
        ))
    }
    #[test]
    fn menu_wakes_coalesce_and_keep_quit_pending_across_early_callbacks() {
        let state = MenuWakeState::new();
        assert!(state.request_quit());
        let queued = std::thread::scope(|scope| {
            let producers: Vec<_> = (0..8).map(|_| scope.spawn(|| state.queue())).collect();
            producers
                .into_iter()
                .map(|producer| producer.join().unwrap())
                .filter(|queued| *queued)
                .count()
        });
        assert_eq!(queued, 1);
        assert!(state.begin_drain());
        assert!(state.quitting());
        // An early callback before MenuWillShow does not consume quit intent.
        assert!(state.queue());
        assert!(!state.queue());
        state.quit_dispatched();
        assert!(!state.quitting());
        assert!(state.begin_drain());
    }
    #[test]
    fn stopped_menu_wakes_cannot_be_revived_by_racing_producers_or_late_callbacks() {
        let state = MenuWakeState::new();
        assert!(state.queue());
        assert!(state.request_quit());
        let barrier = std::sync::Barrier::new(9);
        std::thread::scope(|scope| {
            let barrier = &barrier;
            for _ in 0..8 {
                let state = &state;
                scope.spawn(move || {
                    barrier.wait();
                    state.request_quit();
                    state.queue();
                });
            }
            barrier.wait();
            state.stop();
        });
        assert!(state.stopped());
        assert!(!state.quitting());
        assert!(!state.request_quit());
        assert!(!state.queue());
        // A CFRunLoop block retained outside the CEF queue cannot enter CEF.
        assert!(!state.begin_drain());
        state.quit_dispatched();
        assert!(state.stopped());
    }
    #[test]
    fn early_menu_wake_does_not_consume_the_command_or_release_its_permit() {
        let budget = Arc::new(CommandBudget::default());
        let command = command(&budget, "commands.cancel");
        let mut queue = MenuCleanupQueue::default();
        assert_eq!(queue.track(&command), Ok(true));
        // A wake before ShowMenu/its tracking loop has nothing to cancel. The
        // same command is still available when MenuWillShow schedules a wake.
        for _ in 0..2 {
            let observed = queue.pending();
            assert_eq!(observed.len(), 1);
            assert!(Arc::ptr_eq(&observed[0], &command));
            assert!(std::ptr::eq(
                observed[0].pending().unwrap(),
                command.pending().unwrap()
            ));
        }
        assert_eq!(budget.snapshot().retained_wire_bytes, 128);
        let posted = command.clone();
        assert!(posted.claim().is_some());
        assert!(command.claim().is_none());
        assert!(queue.pending().is_empty());
        drop(command);
        assert_eq!(budget.snapshot().requests, 1);
        drop(posted);
        assert_eq!(budget.snapshot().requests, 0);
    }
    #[test]
    fn weak_cleanup_entries_cannot_retain_discarded_tasks_or_grow_across_generations() {
        let budget = Arc::new(CommandBudget::default());
        let mut queue = MenuCleanupQueue::default();
        for _ in 0..1000 {
            let command = command(&budget, "commands.dispose");
            assert_eq!(queue.track(&command), Ok(true));
            assert_eq!(queue.track(&command), Ok(true));
            assert_eq!(queue.pending().len(), 1);
            drop(command);
            assert_eq!(budget.snapshot().requests, 0);
        }
        assert!(queue.pending().is_empty());
        for operation in [
            "commands.show",
            "view.dispose",
            "window.close",
            "view.navigate",
            "commands.cancel.extra",
        ] {
            assert_eq!(queue.track(&command(&budget, operation)), Ok(false));
        }
        assert!(queue.pending().is_empty());
    }
    #[test]
    fn saturated_cleanup_queue_obeys_native_admission_and_does_not_acknowledge_early() {
        let budget = Arc::new(CommandBudget::default());
        let mut queue = MenuCleanupQueue::default();
        let commands: Vec<_> = (0..crate::command_budget::native_request_limit())
            .map(|_| {
                let command = command(&budget, "quit");
                assert_eq!(queue.track(&command), Ok(true));
                command
            })
            .collect();
        assert_eq!(queue.pending().len(), commands.len());
        assert!(budget.reserve("quit", 128).is_err());
        for command in &commands {
            assert!(command.claim().is_some());
        }
        assert!(queue.pending().is_empty());
        assert_eq!(budget.snapshot().requests, commands.len());
        drop(commands);
        assert_eq!(budget.snapshot().retained_wire_bytes, 0);
    }
}
