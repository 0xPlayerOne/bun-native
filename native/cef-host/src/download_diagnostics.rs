//! Timeout evidence only: fixed callback state and application-level launch
//! counts. No CEF item, path, URL, command line or callback owner is retained.
use super::{CallbackPhase, Observation};
use cef::DownloadInterruptReason;
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    path::Path,
    sync::atomic::{AtomicU32, Ordering},
};

pub(super) struct LaunchCounter(AtomicU32);
impl LaunchCounter {
    pub const fn new() -> Self {
        Self(AtomicU32::new(0))
    }
    pub fn observe(&self, process_type: Option<&str>, subtype: Option<&str>) {
        if process_type == Some("utility") && subtype == Some("quarantine.mojom.Quarantine") {
            let _ = self
                .0
                .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |count| {
                    Some(count.saturating_add(1))
                });
        }
    }
    pub fn count(&self) -> u32 {
        self.0.load(Ordering::Relaxed)
    }
}
pub(super) static QUARANTINE_LAUNCHES: LaunchCounter = LaunchCounter::new();

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
struct CallbackSnapshot {
    phase: &'static str,
    valid: bool,
    in_progress: bool,
    paused: bool,
    complete: bool,
    cancelled: bool,
    interrupted: bool,
    interrupt_reason: &'static str,
    bytes_received: u64,
    total_bytes: Option<u64>,
    percent_complete: Option<u8>,
    path_state: &'static str,
}
fn interrupt_label(reason: DownloadInterruptReason) -> &'static str {
    match reason {
        DownloadInterruptReason::NONE => "none",
        DownloadInterruptReason::FILE_FAILED => "file-failed",
        DownloadInterruptReason::FILE_ACCESS_DENIED => "file-access-denied",
        DownloadInterruptReason::FILE_TRANSIENT_ERROR => "file-transient-error",
        DownloadInterruptReason::FILE_BLOCKED => "file-blocked",
        DownloadInterruptReason::FILE_SECURITY_CHECK_FAILED => "file-security-check-failed",
        DownloadInterruptReason::FILE_VIRUS_INFECTED => "file-virus-infected",
        DownloadInterruptReason::NETWORK_FAILED => "network-failed",
        DownloadInterruptReason::NETWORK_TIMEOUT => "network-timeout",
        DownloadInterruptReason::USER_CANCELED => "user-cancelled",
        _ => "other",
    }
}
pub(super) struct Trace {
    callbacks: u32,
    last: Option<CallbackSnapshot>,
    quarantine_baseline: u32,
    reported: bool,
}
impl Trace {
    pub fn new(quarantine_baseline: u32) -> Self {
        Self {
            callbacks: 0,
            last: None,
            quarantine_baseline,
            reported: false,
        }
    }
    pub fn observe(
        &mut self,
        phase: CallbackPhase,
        observation: &Observation,
        expected_path: Option<&Path>,
    ) {
        self.callbacks = self.callbacks.saturating_add(1);
        self.last = Some(CallbackSnapshot {
            phase: phase.label(),
            // observe() already required a valid CEF item and bind() matched
            // the exact admitted original URL and native download identity.
            valid: true,
            in_progress: observation.in_progress,
            paused: observation.paused,
            complete: observation.complete,
            cancelled: observation.cancelled,
            interrupted: observation.interrupted,
            interrupt_reason: interrupt_label(observation.interrupt_reason),
            bytes_received: observation.received,
            total_bytes: observation.total,
            percent_complete: u8::try_from(observation.percent_complete)
                .ok()
                .filter(|percent| *percent <= 100),
            path_state: if observation.path.is_empty() {
                "empty"
            } else {
                match expected_path {
                    Some(path) if observation.path == path.to_string_lossy() => "owned-stage",
                    Some(_) => "other",
                    None => "unavailable",
                }
            },
        });
    }
    pub fn timeout(
        &mut self,
        quarantine_launches: u32,
        before: bool,
        callback_owned: bool,
    ) -> Option<Value> {
        if std::mem::replace(&mut self.reported, true) {
            return None;
        }
        // Saturation or a future counter reset is unknown, never a fabricated
        // zero. This application-wide delta does not identify one transfer.
        let launches = (quarantine_launches != u32::MAX)
            .then(|| quarantine_launches.checked_sub(self.quarantine_baseline))
            .flatten();
        Some(json!({
            "event":"bunly.host.download-timeout",
            "schema":1,
            "before":before,
            "callbackOwned":callback_owned,
            "callbackCount":self.callbacks,
            "callbackCountSaturated":self.callbacks == u32::MAX,
            "lastCallback":self.last,
            "quarantineObservedLaunches":launches,
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn observation() -> Observation {
        Observation {
            id: 321,
            original: "https://private.invalid/file#native-secret".into(),
            url: "https://private.invalid/redirect?credential=secret".into(),
            path: "/private/download/stage/payload".into(),
            received: 32768,
            total: Some(32768),
            in_progress: true,
            paused: false,
            percent_complete: 100,
            complete: false,
            cancelled: false,
            interrupted: false,
            interrupt_reason: DownloadInterruptReason::NONE,
        }
    }
    #[test]
    fn timeout_receipt_keeps_only_finite_last_callback_state_and_emits_once() {
        let mut trace = Trace::new(7);
        let mut item = observation();
        item.path.clear();
        item.received = 0;
        item.percent_complete = -1;
        trace.observe(CallbackPhase::Before, &item, None);
        let first = serde_json::to_value(trace.last).unwrap();
        assert_eq!(first["phase"], "before");
        assert_eq!(first["pathState"], "empty");
        assert_eq!(first["percentComplete"], Value::Null);
        let item = observation();
        trace.observe(
            CallbackPhase::Updated,
            &item,
            Some(Path::new("/private/download/stage/payload")),
        );
        let receipt = trace.timeout(8, true, true).unwrap();
        assert_eq!(receipt["callbackCount"], 2);
        assert_eq!(receipt["quarantineObservedLaunches"], 1);
        assert_eq!(
            receipt["lastCallback"],
            json!({
                "phase":"updated","valid":true,"inProgress":true,"paused":false,
                "complete":false,"cancelled":false,"interrupted":false,
                "interruptReason":"none","bytesReceived":32768,"totalBytes":32768,
                "percentComplete":100,"pathState":"owned-stage"
            })
        );
        let encoded = receipt.to_string();
        assert!(encoded.len() < 1024);
        for private in ["private", "secret", "credential", "321", "payload"] {
            assert!(!encoded.contains(private));
        }
        assert!(trace.timeout(9, true, true).is_none());
    }
    #[test]
    fn snapshots_preserve_raw_callback_changes_without_inventing_progress_or_paths() {
        let mut trace = Trace::new(0);
        let mut item = observation();
        item.percent_complete = 101;
        item.in_progress = false;
        item.paused = true;
        item.interrupted = true;
        item.interrupt_reason = DownloadInterruptReason::FILE_ACCESS_DENIED;
        trace.observe(
            CallbackPhase::Updated,
            &item,
            Some(Path::new("/a/different/owned-stage")),
        );
        let receipt = trace.timeout(0, true, false).unwrap();
        assert_eq!(receipt["lastCallback"]["pathState"], "other");
        assert_eq!(receipt["lastCallback"]["percentComplete"], Value::Null);
        assert_eq!(receipt["lastCallback"]["inProgress"], false);
        assert_eq!(receipt["lastCallback"]["paused"], true);
        assert_eq!(receipt["lastCallback"]["interrupted"], true);
        assert_eq!(
            receipt["lastCallback"]["interruptReason"],
            "file-access-denied"
        );
        let mut empty = Trace::new(4);
        let receipt = empty.timeout(4, false, false).unwrap();
        assert_eq!(receipt["lastCallback"], Value::Null);
        assert_eq!(receipt["quarantineObservedLaunches"], 0);
        let mut unavailable = Trace::new(u32::MAX);
        assert_eq!(
            unavailable.timeout(u32::MAX, true, true).unwrap()["quarantineObservedLaunches"],
            Value::Null
        );
    }
    #[test]
    fn quarantine_counter_requires_the_exact_native_utility_type_and_never_wraps() {
        let counter = LaunchCounter::new();
        for (process_type, subtype) in [
            (None, Some("quarantine.mojom.Quarantine")),
            (Some("renderer"), Some("quarantine.mojom.Quarantine")),
            (Some("utility"), None),
            (Some("utility"), Some("network.mojom.NetworkService")),
            (Some("utility"), Some("quarantine.mojom.Quarantine.extra")),
            (Some("utility"), Some("private quarantine.mojom.Quarantine")),
        ] {
            counter.observe(process_type, subtype);
        }
        assert_eq!(counter.count(), 0);
        std::thread::scope(|scope| {
            for _ in 0..8 {
                scope.spawn(|| {
                    for _ in 0..16 {
                        counter.observe(Some("utility"), Some("quarantine.mojom.Quarantine"));
                    }
                });
            }
        });
        assert_eq!(counter.count(), 128);
        counter.0.store(u32::MAX, Ordering::Relaxed);
        counter.observe(Some("utility"), Some("quarantine.mojom.Quarantine"));
        assert_eq!(counter.count(), u32::MAX);
    }
}
