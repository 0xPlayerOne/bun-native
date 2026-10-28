//! Admission for the private Bun -> CEF command pipe, not renderer authorization.
//! Wire bytes stay reserved through the lifetime of the posted task. FIFO dispatch
//! is unchanged: lifecycle side effects are not reordered to obtain priority.
use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex, OnceLock};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Limits {
    schema: u32,
    frame_bytes: usize,
    requests: usize,
    ordinary_requests: usize,
    queued_bytes: usize,
    ordinary_queued_bytes: usize,
    native_requests: usize,
    native_ordinary_requests: usize,
    native_queued_bytes: usize,
    native_ordinary_queued_bytes: usize,
    control_frame_bytes: usize,
    control_operations: Vec<String>,
}
fn limits() -> &'static Limits {
    static LIMITS: OnceLock<Limits> = OnceLock::new();
    LIMITS.get_or_init(|| {
        let value: Limits = serde_json::from_str(include_str!(
            "../../../packages/runtime/src/native-capacity.json"
        ))
        .expect("Invalid compiled command admission policy");
        assert_eq!(value.schema, 1);
        assert!(value.ordinary_requests < value.requests);
        assert!(value.ordinary_queued_bytes < value.queued_bytes);
        assert!(value.control_frame_bytes <= value.frame_bytes);
        assert!(value.native_requests > value.requests);
        assert!(value.native_ordinary_requests > value.ordinary_requests);
        assert!(value.native_ordinary_requests < value.native_requests);
        assert!(value.native_queued_bytes > value.queued_bytes);
        assert!(value.native_ordinary_queued_bytes > value.ordinary_queued_bytes);
        assert!(value.native_ordinary_queued_bytes < value.native_queued_bytes);
        value
    })
}

#[derive(Default, Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub requests: usize,
    pub ordinary_requests: usize,
    pub retained_wire_bytes: usize,
    pub ordinary_wire_bytes: usize,
    pub peak_requests: usize,
    pub peak_wire_bytes: usize,
}
#[derive(Debug, PartialEq, Eq)]
pub enum AdmissionError {
    Capacity,
    InvalidFrame,
    Unavailable,
}

#[derive(Default)]
pub struct CommandBudget {
    state: Mutex<Snapshot>,
}
/// Shared by any cloned CEF task wrapper. Only final destruction releases it,
/// including failed posts and tasks discarded without ever executing.
pub struct CommandPermit {
    budget: Arc<CommandBudget>,
    bytes: usize,
    ordinary: bool,
}
impl CommandBudget {
    pub fn reserve(
        self: &Arc<Self>,
        operation: &str,
        bytes: usize,
    ) -> Result<Arc<CommandPermit>, AdmissionError> {
        let limit = limits();
        if bytes == 0 || bytes > limit.frame_bytes {
            return Err(AdmissionError::InvalidFrame);
        }
        let ordinary = !(bytes <= limit.control_frame_bytes
            && limit
                .control_operations
                .iter()
                .any(|name| name == operation));
        let mut state = self.state.lock().map_err(|_| AdmissionError::Unavailable)?;
        if state.requests >= limit.native_requests
            || bytes > limit.native_queued_bytes - state.retained_wire_bytes
            || (ordinary
                && (state.ordinary_requests >= limit.native_ordinary_requests
                    || bytes > limit.native_ordinary_queued_bytes - state.ordinary_wire_bytes))
        {
            return Err(AdmissionError::Capacity);
        }
        state.requests += 1;
        state.retained_wire_bytes += bytes;
        if ordinary {
            state.ordinary_requests += 1;
            state.ordinary_wire_bytes += bytes;
        }
        state.peak_requests = state.peak_requests.max(state.requests);
        state.peak_wire_bytes = state.peak_wire_bytes.max(state.retained_wire_bytes);
        Ok(Arc::new(CommandPermit {
            budget: self.clone(),
            bytes,
            ordinary,
        }))
    }
    pub fn snapshot(&self) -> Snapshot {
        *self.state.lock().expect("Command admission poisoned")
    }
}
impl Drop for CommandPermit {
    fn drop(&mut self) {
        let mut state = self
            .budget
            .state
            .lock()
            .expect("Command admission poisoned");
        state.requests -= 1;
        state.retained_wire_bytes -= self.bytes;
        if self.ordinary {
            state.ordinary_requests -= 1;
            state.ordinary_wire_bytes -= self.bytes;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn empty(budget: &CommandBudget) {
        let state = budget.snapshot();
        assert_eq!(state.requests, 0);
        assert_eq!(state.ordinary_requests, 0);
        assert_eq!(state.retained_wire_bytes, 0);
        assert_eq!(state.ordinary_wire_bytes, 0);
    }
    #[test]
    fn shared_policy_keeps_exact_bounded_control_operations() {
        let l = limits();
        assert_eq!((l.requests, l.ordinary_requests), (128, 96));
        assert_eq!(
            (l.queued_bytes, l.ordinary_queued_bytes),
            (1_048_576, 786_432)
        );
        assert_eq!((l.frame_bytes, l.control_frame_bytes), (65_536, 1024));
        assert_eq!((l.native_requests, l.native_ordinary_requests), (256, 192));
        assert_eq!(
            (l.native_queued_bytes, l.native_ordinary_queued_bytes),
            (2_097_152, 1_572_864)
        );
        assert_eq!(
            l.control_operations,
            [
                "quit",
                "rpc.ack",
                "rpc.disconnect",
                "stream.ack",
                "stream.disconnect",
                "view.dispose",
                "window.close",
                "session.dispose",
                "credentials.discard",
                "download.cancel"
            ]
        );
    }
    #[test]
    fn ordinary_saturation_preserves_all_control_slots_and_the_total_bound() {
        let budget = Arc::new(CommandBudget::default());
        let mut permits: Vec<_> = (0..192)
            .map(|_| budget.reserve("rpc.deliver", 64).unwrap())
            .collect();
        assert!(budget.reserve("rpc.deliver", 64).is_err());
        assert!(budget.reserve("diagnostics", 64).is_err());
        for i in 0..64 {
            permits.push(
                budget
                    .reserve(
                        &limits().control_operations[i % limits().control_operations.len()],
                        128,
                    )
                    .unwrap(),
            );
        }
        assert_eq!(budget.snapshot().requests, 256);
        assert!(budget.reserve("quit", 128).is_err());
        drop(permits);
        empty(&budget);
    }
    #[test]
    fn byte_saturation_cannot_consume_control_headroom() {
        let budget = Arc::new(CommandBudget::default());
        let permits: Vec<_> = (0..24)
            .map(|_| budget.reserve("rpc.deliver", 65_536).unwrap())
            .collect();
        assert_eq!(budget.snapshot().ordinary_wire_bytes, 1_572_864);
        assert!(budget.reserve("rpc.deliver", 1).is_err());
        let control = budget.reserve("rpc.ack", 1024).unwrap();
        assert_eq!(budget.snapshot().retained_wire_bytes, 1_573_888);
        drop(permits);
        assert_eq!(budget.snapshot().ordinary_wire_bytes, 0);
        drop(control);
        empty(&budget);
    }
    #[test]
    fn unknown_operations_and_oversized_control_spelling_get_no_reserved_capacity() {
        let budget = Arc::new(CommandBudget::default());
        let permits: Vec<_> = (0..192)
            .map(|_| budget.reserve("view.create", 64).unwrap())
            .collect();
        for operation in [
            "rpc.ack.more",
            "rpc.ACK",
            "quit ",
            "window.resize",
            "view.navigate",
        ] {
            assert!(budget.reserve(operation, 64).is_err());
        }
        for operation in &limits().control_operations {
            assert!(budget.reserve(operation, 1025).is_err());
            drop(budget.reserve(operation, 1024).unwrap());
        }
        drop(permits);
        empty(&budget);
    }
    #[test]
    fn acknowledged_wrappers_do_not_consume_the_runtime_replacement_headroom() {
        let budget = Arc::new(CommandBudget::default());
        let acknowledged: Vec<_> = (0..limits().ordinary_requests)
            .map(|_| budget.reserve("rpc.deliver", 128).unwrap())
            .collect();
        // Replies can be consumed before CEF drops its last task reference.
        // A full ordinary runtime generation may submit replacements meanwhile.
        let replacements: Vec<_> = (0..limits().ordinary_requests)
            .map(|_| budget.reserve("rpc.deliver", 128).unwrap())
            .collect();
        assert_eq!(budget.snapshot().ordinary_requests, 192);
        assert!(matches!(
            budget.reserve("rpc.deliver", 128),
            Err(AdmissionError::Capacity)
        ));
        let control = budget.reserve("quit", 128).unwrap();
        drop(acknowledged);
        drop(replacements);
        drop(control);
        empty(&budget);
    }
    #[test]
    fn invalid_frame_sizes_do_not_change_admission() {
        let budget = Arc::new(CommandBudget::default());
        for bytes in [0, 65_537, usize::MAX] {
            assert!(budget.reserve("quit", bytes).is_err());
            assert_eq!(budget.snapshot(), Snapshot::default());
        }
    }
    #[test]
    fn cloned_or_cancelled_tasks_keep_capacity_until_last_owner_drops() {
        let budget = Arc::new(CommandBudget::default());
        let original = budget.reserve("rpc.deliver", 200).unwrap();
        let posted = original.clone();
        drop(original); // Caller cancellation is not CEF task destruction.
        assert_eq!(budget.snapshot().retained_wire_bytes, 200);
        drop(posted);
        empty(&budget);
        // Failed posts and discarded tasks use the same ownership release path.
        for _ in 0..1000 {
            drop(budget.reserve("view.create", 200).unwrap());
        }
        empty(&budget);
        assert_eq!(budget.snapshot().peak_requests, 1);
    }
    #[test]
    fn concurrent_control_admission_is_atomic_and_does_not_leak() {
        let budget = Arc::new(CommandBudget::default());
        let ordinary: Vec<_> = (0..192)
            .map(|_| budget.reserve("rpc.deliver", 64).unwrap())
            .collect();
        let workers: Vec<_> = (0..8)
            .map(|_| {
                let budget = budget.clone();
                std::thread::spawn(move || {
                    (0..8)
                        .map(|_| budget.reserve("quit", 128).unwrap())
                        .collect::<Vec<_>>()
                })
            })
            .collect();
        let controls: Vec<_> = workers
            .into_iter()
            .flat_map(|worker| worker.join().unwrap())
            .collect();
        assert_eq!(budget.snapshot().requests, 256);
        assert!(budget.reserve("quit", 1).is_err());
        drop(ordinary);
        drop(controls);
        empty(&budget);
    }
}
