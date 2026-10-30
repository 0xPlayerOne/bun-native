//! Timeout evidence only: fixed callback state and application-level launch
//! counts plus exact-request completion. No CEF item, path, URL, command line
//! or callback owner is retained.
use super::{CallbackPhase, Observation};
use crate::download_access::RequestCompletion;
use cef::{
    currently_on, BrowserHost, CefString, DownloadInterruptReason, ImplBrowserHost,
    ImplPreferenceManager, ImplValue, ThreadId, ValueType,
};
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    path::Path,
    sync::{
        atomic::{AtomicU32, Ordering},
        Mutex,
    },
    time::Instant,
};

pub(super) struct LaunchCounter {
    count: AtomicU32,
    subtype: &'static str,
    last_observed_at: Mutex<Option<Instant>>,
}
impl LaunchCounter {
    pub const fn new(subtype: &'static str) -> Self {
        Self {
            count: AtomicU32::new(0),
            subtype,
            last_observed_at: Mutex::new(None),
        }
    }
    pub fn observe(&self, process_type: Option<&str>, subtype: Option<&str>) {
        self.observe_at(process_type, subtype, Instant::now());
    }
    fn observe_at(&self, process_type: Option<&str>, subtype: Option<&str>, now: Instant) {
        if process_type == Some("utility") && subtype == Some(self.subtype) {
            if let Ok(mut last) = self.last_observed_at.lock() {
                *last = Some(last.map_or(now, |previous| previous.max(now)));
            }
            let _ = self
                .count
                .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |count| {
                    Some(count.saturating_add(1))
                });
        }
    }
    fn last_elapsed(&self, start: Instant, end: Instant) -> Option<u64> {
        if self.count() == u32::MAX {
            return None;
        }
        let last = self.last_observed_at.lock().ok().and_then(|last| *last)?;
        (last <= end).then(|| elapsed_ms(start, last)).flatten()
    }
    pub fn count(&self) -> u32 {
        self.count.load(Ordering::Relaxed)
    }
}
pub(super) static QUARANTINE_LAUNCHES: LaunchCounter =
    LaunchCounter::new("quarantine.mojom.Quarantine");
pub(super) static FILE_UTIL_LAUNCHES: LaunchCounter =
    LaunchCounter::new("chrome.mojom.FileUtilService");

/// A fixed read of the exact browser context, before admission and outside STATE.
/// An absent/non-boolean preference or wrong-thread call remains unobserved.
pub(super) fn safe_browsing_enabled(host: &BrowserHost) -> Option<bool> {
    if currently_on(ThreadId::UI) == 0 {
        return None;
    }
    let context = host.request_context()?;
    let preference = context.preference(Some(&CefString::from("safebrowsing.enabled")))?;
    (preference.get_type() == ValueType::BOOL).then(|| preference.bool() != 0)
}

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
/// Relative monotonic milliseconds; backwards or out-of-range observations stay unknown.
fn elapsed_ms(start: Instant, end: Instant) -> Option<u64> {
    let elapsed = end.checked_duration_since(start)?.as_millis();
    u64::try_from(elapsed)
        .ok()
        .filter(|value| *value <= super::wire::MAX_ID)
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct CallbackTiming {
    first_callback: Option<u64>,
    before_callback: Option<u64>,
    first_positive_bytes: Option<u64>,
    first_full_byte_count: Option<u64>,
    last_callback: Option<u64>,
}
pub(super) struct Trace {
    started: Instant,
    timing: CallbackTiming,
    callbacks: u32,
    last: Option<CallbackSnapshot>,
    quarantine_baseline: u32,
    file_util_baseline: u32,
    safe_browsing_enabled: Option<bool>,
    reported: bool,
}
impl Trace {
    pub fn new(
        quarantine_baseline: u32,
        file_util_baseline: u32,
        safe_browsing_enabled: Option<bool>,
    ) -> Self {
        Self {
            started: Instant::now(),
            timing: CallbackTiming::default(),
            callbacks: 0,
            last: None,
            quarantine_baseline,
            file_util_baseline,
            safe_browsing_enabled,
            reported: false,
        }
    }
    pub fn observe(
        &mut self,
        phase: CallbackPhase,
        observation: &Observation,
        expected_path: Option<&Path>,
    ) {
        self.observe_at(phase, observation, expected_path, Instant::now());
    }
    fn observe_at(
        &mut self,
        phase: CallbackPhase,
        observation: &Observation,
        expected_path: Option<&Path>,
        now: Instant,
    ) {
        let elapsed = elapsed_ms(self.started, now);
        self.timing.first_callback = self.timing.first_callback.or(elapsed);
        self.timing.last_callback = elapsed;
        if phase == CallbackPhase::Before {
            self.timing.before_callback = self.timing.before_callback.or(elapsed);
        }
        if observation.received > 0 {
            self.timing.first_positive_bytes = self.timing.first_positive_bytes.or(elapsed);
        }
        if observation
            .total
            .is_some_and(|total| total > 0 && total == observation.received)
        {
            self.timing.first_full_byte_count = self.timing.first_full_byte_count.or(elapsed);
        }
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
    #[cfg(feature = "rpc-qualification")]
    pub(super) fn terminal_timing_snapshot(&self, resource_complete: Option<Instant>) -> Value {
        let now = Instant::now();
        json!({
            "origin":"record-created-before-start-download",
            "capturedAtTerminal":elapsed_ms(self.started, now),
            "callbacks":self.timing,
            "resourceComplete":resource_complete.filter(|at| *at <= now).and_then(|at| elapsed_ms(self.started, at)),
            "fileUtilityLastLaunch":FILE_UTIL_LAUNCHES.last_elapsed(self.started, now),
            "quarantineLastLaunch":QUARANTINE_LAUNCHES.last_elapsed(self.started, now),
            "utilityObservationsAreApplicationWide":true,
        })
    }
    pub fn timeout(
        &mut self,
        quarantine_launches: u32,
        file_util_launches: u32,
        before: bool,
        callback_owned: bool,
        request_completion: (Option<RequestCompletion>, Option<Instant>),
    ) -> Option<Value> {
        if std::mem::replace(&mut self.reported, true) {
            return None;
        }
        // Saturation or a future counter reset is unknown, never a fabricated
        // zero. This application-wide delta does not identify one transfer.
        let delta = |current: u32, baseline: u32| {
            (current != u32::MAX)
                .then(|| current.checked_sub(baseline))
                .flatten()
        };
        let now = Instant::now();
        Some(json!({
            "event":"bunly.host.download-timeout",
            "schema":1,
            "before":before,
            "callbackOwned":callback_owned,
            "callbackCount":self.callbacks,
            "callbackCountSaturated":self.callbacks == u32::MAX,
            "lastCallback":self.last,
            "requestCompletion":request_completion.0,
            "timingMs":{
                "origin":"record-created-before-start-download",
                "timeoutObserved":elapsed_ms(self.started, now),
                "callbacks":self.timing,
                "resourceComplete":request_completion.1.filter(|at| *at <= now).and_then(|at| elapsed_ms(self.started, at)),
                "fileUtilityLastLaunch":FILE_UTIL_LAUNCHES.last_elapsed(self.started, now),
                "quarantineLastLaunch":QUARANTINE_LAUNCHES.last_elapsed(self.started, now),
            },
            "safeBrowsingEnabledAtAdmission":self.safe_browsing_enabled,
            "quarantineObservedLaunches":delta(quarantine_launches, self.quarantine_baseline),
            "fileUtilityObservedLaunches":delta(file_util_launches, self.file_util_baseline),
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::download_access::RequestCompletionStatus;

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
        let mut trace = Trace::new(7, 3, Some(true));
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
        let completion = RequestCompletion::new(RequestCompletionStatus::Success, 32768);
        let receipt = trace
            .timeout(8, 4, true, true, (Some(completion), None))
            .unwrap();
        assert_eq!(receipt["callbackCount"], 2);
        assert_eq!(receipt["quarantineObservedLaunches"], 1);
        assert_eq!(receipt["fileUtilityObservedLaunches"], 1);
        assert_eq!(receipt["safeBrowsingEnabledAtAdmission"], true);
        assert_eq!(
            receipt["requestCompletion"],
            json!({
                "status":"success","receivedContentLength":32768
            })
        );
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
        assert!(encoded.len() < 2048);
        for private in ["private", "secret", "credential", "321", "payload"] {
            assert!(!encoded.contains(private));
        }
        assert!(trace.timeout(9, 3, true, true, (None, None)).is_none());
    }
    #[test]
    fn snapshots_preserve_raw_callback_changes_without_inventing_progress_or_paths() {
        let mut trace = Trace::new(0, 0, None);
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
        let receipt = trace.timeout(0, 3, true, false, (None, None)).unwrap();
        assert_eq!(receipt["lastCallback"]["pathState"], "other");
        assert_eq!(receipt["lastCallback"]["percentComplete"], Value::Null);
        assert_eq!(receipt["lastCallback"]["inProgress"], false);
        assert_eq!(receipt["lastCallback"]["paused"], true);
        assert_eq!(receipt["lastCallback"]["interrupted"], true);
        assert_eq!(
            receipt["lastCallback"]["interruptReason"],
            "file-access-denied"
        );
        let mut empty = Trace::new(4, 2, None);
        let receipt = empty.timeout(4, 3, false, false, (None, None)).unwrap();
        assert_eq!(receipt["lastCallback"], Value::Null);
        assert_eq!(receipt["quarantineObservedLaunches"], 0);
        assert_eq!(receipt["fileUtilityObservedLaunches"], 1);
        assert_eq!(receipt["safeBrowsingEnabledAtAdmission"], Value::Null);
        assert_eq!(receipt["requestCompletion"], Value::Null);
        let mut unavailable = Trace::new(u32::MAX, u32::MAX, None);
        assert_eq!(
            unavailable
                .timeout(u32::MAX, u32::MAX, true, true, (None, None))
                .unwrap()["quarantineObservedLaunches"],
            Value::Null
        );
    }
    #[test]
    fn completion_and_context_metadata_preserve_unknown_and_disabled_values() {
        let mut trace = Trace::new(3, 7, Some(false));
        let completion = RequestCompletion::new(RequestCompletionStatus::Failed, -1);
        let receipt = trace
            .timeout(2, u32::MAX, false, false, (Some(completion), None))
            .unwrap();
        assert_eq!(receipt["quarantineObservedLaunches"], Value::Null);
        assert_eq!(receipt["fileUtilityObservedLaunches"], Value::Null);
        assert_eq!(receipt["safeBrowsingEnabledAtAdmission"], false);
        assert_eq!(
            receipt["requestCompletion"],
            json!({
                "status":"failed","receivedContentLength":null
            })
        );
        assert_eq!(receipt["lastCallback"], Value::Null);
    }
    #[test]
    fn file_utility_counter_is_independent_and_matches_only_its_fixed_subtype() {
        let quarantine = LaunchCounter::new("quarantine.mojom.Quarantine");
        let file_util = LaunchCounter::new("chrome.mojom.FileUtilService");
        for (process_type, subtype) in [
            (Some("utility"), Some("quarantine.mojom.Quarantine")),
            (Some("renderer"), Some("chrome.mojom.FileUtilService")),
            (Some("utility"), Some("chrome.mojom.FileUtilService.extra")),
            (Some("utility"), None),
        ] {
            file_util.observe(process_type, subtype);
        }
        assert_eq!(file_util.count(), 0);
        file_util.observe(Some("utility"), Some("chrome.mojom.FileUtilService"));
        assert_eq!(file_util.count(), 1);
        assert_eq!(quarantine.count(), 0);
        file_util.count.store(u32::MAX, Ordering::Relaxed);
        file_util.observe(Some("utility"), Some("chrome.mojom.FileUtilService"));
        assert_eq!(file_util.count(), u32::MAX);
    }
    #[test]
    fn quarantine_counter_requires_the_exact_native_utility_type_and_never_wraps() {
        let counter = LaunchCounter::new("quarantine.mojom.Quarantine");
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
        counter.count.store(u32::MAX, Ordering::Relaxed);
        counter.observe(Some("utility"), Some("quarantine.mojom.Quarantine"));
        assert_eq!(counter.count(), u32::MAX);
    }
    #[test]
    fn phase_timing_is_monotonic_first_observation_only_and_not_completion() {
        use std::time::Duration;
        let mut trace = Trace::new(0, 0, None);
        let start = trace.started;
        let mut item = observation();
        item.received = 0;
        item.total = Some(0);
        trace.observe_at(CallbackPhase::Updated, &item, None, start);
        trace.observe_at(
            CallbackPhase::Before,
            &item,
            None,
            start + Duration::from_millis(7),
        );
        item.received = 16;
        item.total = Some(32);
        trace.observe_at(
            CallbackPhase::Updated,
            &item,
            None,
            start + Duration::from_millis(11),
        );
        item.received = 32;
        trace.observe_at(
            CallbackPhase::Updated,
            &item,
            None,
            start + Duration::from_millis(13),
        );
        item.received = 0;
        item.total = None;
        trace.observe_at(
            CallbackPhase::Updated,
            &item,
            None,
            start + Duration::from_millis(19),
        );
        assert_eq!(
            serde_json::to_value(&trace.timing).unwrap(),
            json!({
                "firstCallback":0,"beforeCallback":7,"firstPositiveBytes":11,
                "firstFullByteCount":13,"lastCallback":19
            })
        );
        assert!(!trace.last.unwrap().complete);
        assert_eq!(elapsed_ms(start + Duration::from_millis(1), start), None);
    }
    #[test]
    fn launch_timing_is_scoped_to_the_observation_interval() {
        use std::time::Duration;
        let counter = LaunchCounter::new("chrome.mojom.FileUtilService");
        let start = Instant::now();
        assert_eq!(counter.last_elapsed(start, start), None);
        counter.observe_at(
            Some("renderer"),
            Some("chrome.mojom.FileUtilService"),
            start,
        );
        assert_eq!(counter.last_elapsed(start, start), None);
        counter.observe_at(Some("utility"), Some("chrome.mojom.FileUtilService"), start);
        assert_eq!(counter.last_elapsed(start, start), Some(0));
        assert_eq!(
            counter.last_elapsed(
                start + Duration::from_millis(1),
                start + Duration::from_millis(2)
            ),
            None
        );
        counter.observe_at(
            Some("utility"),
            Some("chrome.mojom.FileUtilService"),
            start + Duration::from_millis(9),
        );
        assert_eq!(
            counter.last_elapsed(start, start + Duration::from_millis(8)),
            None
        );
        assert_eq!(
            counter.last_elapsed(start, start + Duration::from_millis(10)),
            Some(9)
        );
        // A callback that acquired the lock later cannot move the last time backwards.
        counter.observe_at(
            Some("utility"),
            Some("chrome.mojom.FileUtilService"),
            start + Duration::from_millis(5),
        );
        assert_eq!(
            counter.last_elapsed(start, start + Duration::from_millis(10)),
            Some(9)
        );
        counter.count.store(u32::MAX, Ordering::Relaxed);
        assert_eq!(
            counter.last_elapsed(start, start + Duration::from_millis(10)),
            None
        );
    }
}
