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
    sync::atomic::{AtomicU32, Ordering},
};

pub(super) struct LaunchCounter {
    count: AtomicU32,
    subtype: &'static str,
}
impl LaunchCounter {
    pub const fn new(subtype: &'static str) -> Self {
        Self {
            count: AtomicU32::new(0),
            subtype,
        }
    }
    pub fn observe(&self, process_type: Option<&str>, subtype: Option<&str>) {
        if process_type == Some("utility") && subtype == Some(self.subtype) {
            let _ = self
                .count
                .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |count| {
                    Some(count.saturating_add(1))
                });
        }
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
pub(super) struct Trace {
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
        file_util_launches: u32,
        before: bool,
        callback_owned: bool,
        request_completion: Option<RequestCompletion>,
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
        Some(json!({
            "event":"bunly.host.download-timeout",
            "schema":1,
            "before":before,
            "callbackOwned":callback_owned,
            "callbackCount":self.callbacks,
            "callbackCountSaturated":self.callbacks == u32::MAX,
            "lastCallback":self.last,
            "requestCompletion":request_completion,
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
        let receipt = trace.timeout(8, 4, true, true, Some(completion)).unwrap();
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
        assert!(encoded.len() < 1024);
        for private in ["private", "secret", "credential", "321", "payload"] {
            assert!(!encoded.contains(private));
        }
        assert!(trace.timeout(9, 3, true, true, None).is_none());
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
        let receipt = trace.timeout(0, 3, true, false, None).unwrap();
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
        let receipt = empty.timeout(4, 3, false, false, None).unwrap();
        assert_eq!(receipt["lastCallback"], Value::Null);
        assert_eq!(receipt["quarantineObservedLaunches"], 0);
        assert_eq!(receipt["fileUtilityObservedLaunches"], 1);
        assert_eq!(receipt["safeBrowsingEnabledAtAdmission"], Value::Null);
        assert_eq!(receipt["requestCompletion"], Value::Null);
        let mut unavailable = Trace::new(u32::MAX, u32::MAX, None);
        assert_eq!(
            unavailable
                .timeout(u32::MAX, u32::MAX, true, true, None)
                .unwrap()["quarantineObservedLaunches"],
            Value::Null
        );
    }
    #[test]
    fn completion_and_context_metadata_preserve_unknown_and_disabled_values() {
        let mut trace = Trace::new(3, 7, Some(false));
        let completion = RequestCompletion::new(RequestCompletionStatus::Failed, -1);
        let receipt = trace
            .timeout(2, u32::MAX, false, false, Some(completion))
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
}
