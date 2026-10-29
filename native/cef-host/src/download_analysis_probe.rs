//! Temporary, contributor-only evidence for the first managed download.
//! This probe is not an acceptance path and must not be merged. Posting marker
//! tasks can perturb scheduling. Histogram snapshots are application-wide.
//! CEF 47dbc1d exposes the read-only Browser.getHistogram protocol operation;
//! Chromium 156.0.8078.17 records these three histograms in the browser process.
use super::*;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering as AtomicOrdering};

const HISTOGRAMS: [&str; 3] = [
    "SBClientDownload.CheckDownloadStats",
    "SBClientDownload.ZipArchiveAnalysisResult",
    "SBClientDownload.FileAnalysisDuration.Zip",
];
const MAX_JSON_BYTES: usize = 16 * 1024;
const MAX_BUCKETS: usize = 64;
const MAX_INTEGER: u64 = 9_007_199_254_740_991;
const MAX_ELAPSED_MS: u64 = 25_000;
const QUERY_MS: i64 = 1_000;
const PENDING: u64 = u64::MAX;

struct Marker {
    posted: AtomicBool,
    elapsed: AtomicU64,
}
impl Default for Marker {
    fn default() -> Self {
        Self {
            posted: AtomicBool::new(false),
            elapsed: AtomicU64::new(PENDING),
        }
    }
}
impl Marker {
    fn complete(&self, elapsed: Duration) {
        let bounded = elapsed.as_millis().min(u128::from(MAX_ELAPSED_MS + 1)) as u64;
        let _ = self.elapsed.compare_exchange(
            PENDING,
            bounded,
            AtomicOrdering::SeqCst,
            AtomicOrdering::SeqCst,
        );
    }
    fn snapshot(&self) -> Value {
        let elapsed = self.elapsed.load(AtomicOrdering::SeqCst);
        json!({
            "posted":self.posted.load(AtomicOrdering::SeqCst),
            "completed":elapsed != PENDING,
            "elapsedMs":(elapsed <= MAX_ELAPSED_MS).then_some(elapsed)
        })
    }
}
struct Markers {
    started: Instant,
    background: Marker,
    visible: Marker,
}
impl Markers {
    fn snapshot(&self) -> Value {
        json!({
            "taskPostingMayAffectScheduling":true,
            "fileBackground":self.background.snapshot(),
            "fileUserVisible":self.visible.snapshot()
        })
    }
}
wrap_task! {
    struct PriorityMarker { markers: Arc<Markers>, background: bool }
    impl Task {
        fn execute(&self) {
            let marker = if self.background { &self.markers.background } else { &self.markers.visible };
            marker.complete(self.markers.started.elapsed());
        }
    }
}

#[derive(Default)]
struct Flight {
    pending: Option<i32>,
    issuing: bool,
    early: Option<(i32, Option<Value>)>,
}
impl Flight {
    fn receive(&mut self, message: i32, value: Option<Value>) -> Option<Option<Value>> {
        if self.pending == Some(message) {
            self.pending = None;
            return Some(value);
        }
        if self.issuing && self.early.is_none() {
            self.early = Some((message, value));
        }
        None
    }
    fn submitted(&mut self, message: i32) -> Option<Option<Value>> {
        self.issuing = false;
        let early = self.early.take();
        if message <= 0 {
            return Some(None);
        }
        if let Some((received, value)) = early {
            if received == message {
                return Some(value);
            }
        }
        self.pending = Some(message);
        None
    }
}
struct Query {
    request: u64,
    registration: Option<Registration>,
    index: usize,
    histograms: [Option<Value>; 3],
    flight: Flight,
    queued: bool,
}
struct First {
    download: u64,
    scope: capability_policy::DocumentScope,
    destination: Destination,
    browser_id: i32,
    markers: Arc<Markers>,
    completed: bool,
    revoked: bool,
    used: bool,
    query: Option<Query>,
}
#[derive(Default)]
pub(super) struct Registry {
    first: Option<First>,
}
impl Registry {
    pub(super) fn revoke(&mut self, view: u64) {
        if let Some(first) = self.first.as_mut().filter(|first| first.scope.view == view) {
            first.revoked = true;
        }
    }
}

pub(super) fn admitted(view: u64, browser_id: i32) {
    let markers = STATE.with(|s| {
        let mut state = s.borrow_mut();
        if state.downloads.counts.admitted != 1 || state.downloads.analysis.first.is_some() {
            return None;
        }
        let record = state.downloads.entries.get(&view)?;
        let markers = Arc::new(Markers {
            started: Instant::now(),
            background: Marker::default(),
            visible: Marker::default(),
        });
        let first = First {
            download: record.id,
            scope: record.scope.clone(),
            destination: record.destination.clone(),
            browser_id,
            markers: markers.clone(),
            completed: false,
            revoked: false,
            used: false,
            query: None,
        };
        state.downloads.analysis.first = Some(first);
        Some(markers)
    });
    let Some(markers) = markers else {
        return;
    };
    // Exactly two tasks per process, with no CEF/browser/request owner captured.
    let mut background = PriorityMarker::new(markers.clone(), true);
    markers.background.posted.store(
        post_task(ThreadId::FILE_BACKGROUND, Some(&mut background)) != 0,
        AtomicOrdering::SeqCst,
    );
    let mut visible = PriorityMarker::new(markers.clone(), false);
    markers.visible.posted.store(
        post_task(ThreadId::FILE_USER_VISIBLE, Some(&mut visible)) != 0,
        AtomicOrdering::SeqCst,
    );
}
pub(super) fn terminal(view: u64, download: u64, completed: bool) {
    let receipt = STATE.with(|s| {
        let mut state = s.borrow_mut();
        let first = state.downloads.analysis.first.as_mut()?;
        if first.scope.view != view || first.download != download {
            return None;
        }
        first.completed = completed;
        Some(json!({
            "event":"bunly.host.download-priority-probe",
            "schema":1,
            "diagnosticOnly":true,
            "firstDownloadCompleted":completed,
            "markers":first.markers.snapshot()
        }))
    });
    if let Some(receipt) = receipt {
        eprintln!("{receipt}");
    }
}
fn scope_matches(
    first: &capability_policy::DocumentScope,
    supplied: &capability_policy::DocumentScope,
    view: u64,
    admitted: u64,
    completed: bool,
    revoked: bool,
) -> bool {
    first == supplied && first.view == view && admitted == 1 && completed && !revoked
}
fn current_browser(download: u64) -> Result<Browser, String> {
    let (scope, destination, browser) = STATE
        .with(|s| {
            let state = s.borrow();
            let first = state
                .downloads
                .analysis
                .first
                .as_ref()
                .ok_or("Diagnostic owner unavailable")?;
            if first.download != download
                || !scope_matches(
                    &first.scope,
                    &first.scope,
                    first.scope.view,
                    state.downloads.counts.admitted,
                    first.completed,
                    first.revoked,
                )
                || !state.downloads.entries.is_empty()
            {
                return Err("Diagnostic target is no longer the first completed download");
            }
            captured_ready_scope(&state, first.scope.view, &first.scope)?;
            let browser = state
                .views
                .get(&first.scope.view)
                .and_then(|view| view.browser.clone())
                .ok_or("Diagnostic browser unavailable")?;
            if browser.identifier() != first.browser_id {
                return Err("Diagnostic browser changed");
            }
            Ok((first.scope.clone(), first.destination.clone(), browser))
        })
        .map_err(|_| "PERMISSION_DENIED: download diagnostic target changed".to_string())?;
    authorization(&scope, &destination, Some(&browser))
        .map_err(|_| "PERMISSION_DENIED: download diagnostic authority changed".to_string())?;
    Ok(browser)
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Input {
    id: u64,
    scope: capability_policy::DocumentScope,
}
pub(super) fn query(request: u64, args: &Value) -> Result<(), String> {
    if currently_on(ThreadId::UI) == 0 {
        return Err("Download diagnostic requires the UI thread".into());
    }
    let input: Input =
        serde_json::from_value(args.clone()).map_err(|_| "Invalid download diagnostic scope")?;
    let download = STATE.with(|s| {
        let state = s.borrow();
        let first = state
            .downloads
            .analysis
            .first
            .as_ref()
            .ok_or("No first download")?;
        if first.used
            || first.query.is_some()
            || !scope_matches(
                &first.scope,
                &input.scope,
                input.id,
                state.downloads.counts.admitted,
                first.completed,
                first.revoked,
            )
        {
            return Err("Download diagnostic requires its first completed native scope");
        }
        Ok(first.download)
    })?;
    let browser = current_browser(download)?;
    let host = browser
        .host()
        .ok_or("Diagnostic browser host unavailable")?;
    STATE.with(|s| {
        let mut state = s.borrow_mut();
        let first = state.downloads.analysis.first.as_mut().unwrap();
        first.used = true;
        first.query = Some(Query {
            request,
            registration: None,
            index: 0,
            histograms: std::array::from_fn(|_| None),
            flight: Flight::default(),
            queued: false,
        });
    });
    let mut deadline = AnalysisDeadline::new(download);
    if post_delayed_task(ThreadId::UI, Some(&mut deadline), QUERY_MS) == 0 {
        finish(download, "unavailable");
        return Ok(());
    }
    // This is reached only by the explicit post-verification fixture request.
    // No observer or DevTools client is attached during the first transfer.
    let mut observer = AnalysisObserver::new(download);
    let mut registration = host.add_dev_tools_message_observer(Some(&mut observer));
    if registration.is_none() {
        finish(download, "unavailable");
        return Ok(());
    }
    let installed = STATE.with(|s| {
        let mut state = s.borrow_mut();
        let Some(first) = state.downloads.analysis.first.as_mut() else {
            return false;
        };
        if first.download != download {
            return false;
        }
        let Some(query) = first.query.as_mut() else {
            return false;
        };
        if query.registration.is_some() {
            return false;
        }
        query.registration = registration.take();
        true
    });
    // Even a rejected registration is released outside STATE.
    drop(registration);
    if !installed {
        finish(download, "unavailable");
        return Ok(());
    }
    schedule(download);
    Ok(())
}
fn schedule(download: u64) {
    let needed = STATE.with(|s| {
        let mut state = s.borrow_mut();
        let Some(first) = state.downloads.analysis.first.as_mut() else {
            return false;
        };
        if first.download != download {
            return false;
        }
        let Some(query) = first.query.as_mut() else {
            return false;
        };
        if query.queued {
            return false;
        }
        query.queued = true;
        true
    });
    if needed {
        let mut task = AnalysisPump::new(download);
        // The already-posted one-second cleanup task also bounds a failed pump.
        let _ = post_task(ThreadId::UI, Some(&mut task));
    }
}
fn pump(download: u64) {
    let next = STATE.with(|s| {
        let mut state = s.borrow_mut();
        let first = state.downloads.analysis.first.as_mut()?;
        if first.download != download {
            return None;
        }
        let query = first.query.as_mut()?;
        query.queued = false;
        Some((
            query.index,
            query.flight.pending.is_some() || query.flight.issuing,
        ))
    });
    let Some((index, waiting)) = next else {
        return;
    };
    let browser = match current_browser(download) {
        Ok(browser) => browser,
        Err(_) => {
            finish(download, "stale");
            return;
        }
    };
    if waiting {
        return;
    }
    if index == HISTOGRAMS.len() {
        finish(download, "complete");
        return;
    }
    let raw = serde_json::to_vec(&json!({"name":HISTOGRAMS[index],"delta":false})).unwrap();
    let mut params =
        parse_json_buffer(Some(&raw), JsonParserOptions::RFC).and_then(|value| value.dictionary());
    STATE.with(|s| {
        let mut state = s.borrow_mut();
        if let Some(first) = state.downloads.analysis.first.as_mut() {
            if first.download == download {
                first.query.as_mut().unwrap().flight.issuing = true;
            }
        }
    });
    let message = browser
        .host()
        .map(|host| {
            host.execute_dev_tools_method(
                0,
                Some(&CefString::from("Browser.getHistogram")),
                params.as_mut(),
            )
        })
        .unwrap_or(0);
    let advance = STATE.with(|s| {
        let mut state = s.borrow_mut();
        let first = state.downloads.analysis.first.as_mut()?;
        if first.download != download {
            return None;
        }
        let query = first.query.as_mut()?;
        if let Some(value) = query.flight.submitted(message) {
            query.histograms[index] = value;
            query.index += 1;
            Some(())
        } else {
            None
        }
    });
    if advance.is_some() {
        schedule(download);
    }
}
fn result(download: u64, browser: Option<&Browser>, message: i32, success: i32, raw: &[u8]) {
    let index = STATE.with(|s| {
        let state = s.borrow();
        let first = state.downloads.analysis.first.as_ref()?;
        if first.download != download {
            return None;
        }
        let query = first.query.as_ref()?;
        if query.flight.pending != Some(message) && !query.flight.issuing {
            return None;
        }
        Some(query.index)
    });
    let Some(index) = index.filter(|index| *index < HISTOGRAMS.len()) else {
        return;
    };
    let Ok(mut expected) = current_browser(download) else {
        schedule(download);
        return;
    };
    if browser.is_none_or(|browser| browser.is_same(Some(&mut expected)) == 0) {
        return;
    }
    let value = (success != 0)
        .then(|| accept_histogram(raw, index))
        .flatten();
    let advance = STATE.with(|s| {
        let mut state = s.borrow_mut();
        let first = state.downloads.analysis.first.as_mut()?;
        if first.download != download {
            return None;
        }
        let query = first.query.as_mut()?;
        if let Some(value) = query.flight.receive(message, value) {
            query.histograms[index] = value;
            query.index += 1;
            Some(())
        } else {
            None
        }
    });
    if advance.is_some() {
        schedule(download);
    }
}
fn finish(download: u64, status: &'static str) {
    let authorized = current_browser(download).is_ok();
    let first = STATE.with(|s| {
        let mut state = s.borrow_mut();
        if state
            .downloads
            .analysis
            .first
            .as_ref()
            .is_none_or(|first| first.download != download || first.query.is_none())
        {
            return None;
        }
        state.downloads.analysis.first.take()
    });
    let Some(mut first) = first else {
        return;
    };
    let mut query = first.query.take().unwrap();
    let response = json!({
        "schema":1,
        "diagnosticOnly":true,
        "applicationWideHistograms":true,
        "histogramDelta":false,
        "status":status,
        "markers":first.markers.snapshot(),
        "histograms":{
            "checkReasons":query.histograms[0],
            "zipAnalysisResults":query.histograms[1],
            "zipAnalysisDuration":query.histograms[2]
        },
        "observerReleased":true
    });
    let request = query.request;
    // Outside STATE and outside the observer's own callback. Release the CEF
    // registration before acknowledging this diagnostic to the fixture.
    drop(query.registration.take());
    drop(query);
    drop(first);
    if authorized {
        reply(request, response);
    } else {
        error(
            request,
            "PERMISSION_DENIED: download diagnostic scope retired",
        );
    }
}
pub(super) fn cancel_if_revoked(view: u64) {
    let download = STATE.with(|s| {
        let state = s.borrow();
        let first = state.downloads.analysis.first.as_ref()?;
        (first.scope.view == view && first.revoked && first.query.is_some())
            .then_some(first.download)
    });
    if let Some(download) = download {
        schedule(download);
    }
}
pub(super) fn shutdown() {
    let first = STATE.with(|s| s.borrow_mut().downloads.analysis.first.take());
    if let Some(mut first) = first {
        if let Some(mut query) = first.query.take() {
            let request = query.request;
            drop(query.registration.take());
            drop(query);
            error(request, "Download diagnostic ended with host shutdown");
        }
    }
}

fn accept_histogram(raw: &[u8], index: usize) -> Option<Value> {
    if raw.len() > MAX_JSON_BYTES || index >= HISTOGRAMS.len() {
        return None;
    }
    let value: Value = serde_json::from_slice(raw).ok()?;
    let root = value.as_object()?;
    if root.len() != 1 {
        return None;
    }
    let histogram = root.get("histogram")?.as_object()?;
    if histogram.len() != 4 || histogram.get("name")?.as_str()? != HISTOGRAMS[index] {
        return None;
    }
    let count = histogram.get("count")?.as_u64()?;
    let sum = histogram.get("sum")?.as_u64()?;
    if count > MAX_INTEGER || sum > MAX_INTEGER {
        return None;
    }
    let buckets = histogram.get("buckets")?.as_array()?;
    if buckets.len() > MAX_BUCKETS {
        return None;
    }
    let mut total = 0_u64;
    let mut previous_high = 0_u64;
    let mut minimum_sum = 0_u128;
    let mut maximum_sum = 0_u128;
    let mut fixed = Vec::with_capacity(buckets.len());
    for bucket in buckets {
        let bucket = bucket.as_object()?;
        if bucket.len() != 3 {
            return None;
        }
        let low = bucket.get("low")?.as_u64()?;
        let high = bucket.get("high")?.as_u64()?;
        let entries = bucket.get("count")?.as_u64()?;
        if high <= low
            || low < previous_high
            || high > i32::MAX as u64
            || entries == 0
            || entries > MAX_INTEGER
        {
            return None;
        }
        if (index == 0 && (low > 40 || high != low + 1))
            || (index == 1 && (low > 9 || high != low + 1))
        {
            return None;
        }
        total = total.checked_add(entries)?;
        if total > MAX_INTEGER {
            return None;
        }
        minimum_sum += u128::from(low) * u128::from(entries);
        maximum_sum += u128::from(high - 1) * u128::from(entries);
        previous_high = high;
        fixed.push(json!({"low":low,"high":high,"count":entries}));
    }
    if total != count || !(minimum_sum..=maximum_sum).contains(&u128::from(sum)) {
        return None;
    }
    Some(json!({"count":count,"sum":sum,"buckets":fixed}))
}

wrap_dev_tools_message_observer! {
    struct AnalysisObserver { download: u64 }
    impl DevToolsMessageObserver {
        fn on_dev_tools_method_result(&self, browser: Option<&mut Browser>, message_id: i32, success: i32, data: Option<&[u8]>) {
            result(self.download, browser.as_deref(), message_id, success, data.unwrap_or(b""));
        }
        fn on_dev_tools_agent_detached(&self, browser: Option<&mut Browser>) {
            STATE.with(|s| {
                let mut state = s.borrow_mut();
                if let Some(first) = state.downloads.analysis.first.as_mut() {
                    if first.download == self.download && browser.is_some_and(|browser| browser.identifier() == first.browser_id) {
                        first.revoked = true;
                    }
                }
            });
            schedule(self.download);
        }
    }
}
wrap_task! {
    struct AnalysisPump { download: u64 }
    impl Task { fn execute(&self) { pump(self.download); } }
}
wrap_task! {
    struct AnalysisDeadline { download: u64 }
    impl Task { fn execute(&self) { finish(self.download, "deadline"); } }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn histogram(index: usize, low: u64, high: u64, count: u64, sum: u64) -> Value {
        json!({"histogram":{"name":HISTOGRAMS[index],"count":count,"sum":sum,
            "buckets":[{"low":low,"high":high,"count":count}]}})
    }
    fn accepted(value: &Value, index: usize) -> Option<Value> {
        accept_histogram(&serde_json::to_vec(value).unwrap(), index)
    }

    #[test]
    fn accepts_only_fixed_bounded_histogram_samples() {
        let value = histogram(0, 8, 9, 1, 8);
        assert_eq!(
            accepted(&value, 0),
            Some(json!({
                "count":1,"sum":8,"buckets":[{"low":8,"high":9,"count":1}]
            }))
        );
        assert!(accepted(&histogram(1, 0, 1, 1, 0), 1).is_some());
        assert!(accepted(&histogram(2, 7000, 8000, 1, 7204), 2).is_some());
        let empty = json!({"histogram":{"name":HISTOGRAMS[0],"count":0,"sum":0,"buckets":[]}});
        assert!(accepted(&empty, 0).is_some());
    }

    #[test]
    fn rejects_wrong_histograms_extra_fields_and_unbounded_input() {
        let value = histogram(0, 8, 9, 1, 8);
        assert!(accepted(&value, 1).is_none());
        let mut changed = value.clone();
        changed["histogram"]["name"] = json!("SBClientDownload.*");
        assert!(accepted(&changed, 0).is_none());
        changed = value.clone();
        changed["histogram"]["url"] = json!("https://private.invalid/");
        assert!(accepted(&changed, 0).is_none());
        changed = value.clone();
        changed["arbitrary"] = json!(true);
        assert!(accepted(&changed, 0).is_none());
        assert!(accept_histogram(&vec![b' '; MAX_JSON_BYTES + 1], 0).is_none());
        assert!(accept_histogram(b"not json", 0).is_none());
    }

    #[test]
    fn rejects_inconsistent_counts_ranges_and_enum_values() {
        for (index, low, high, count, sum) in [
            (0, 41, 42, 1, 41),
            (1, 10, 11, 1, 10),
            (0, 8, 10, 1, 8),
            (2, 9000, 8000, 1, 8500),
            (2, 7000, 8000, 1, 8000),
            (2, 7000, 8000, 1, 6999),
            (0, 8, 9, 0, 0),
            (0, 8, 9, MAX_INTEGER + 1, 8),
        ] {
            assert!(accepted(&histogram(index, low, high, count, sum), index).is_none());
        }
        let mut value = histogram(0, 8, 9, 1, 8);
        value["histogram"]["count"] = json!(2);
        assert!(accepted(&value, 0).is_none());
        value["histogram"]["count"] = json!(-1);
        assert!(accepted(&value, 0).is_none());
        value = histogram(0, 8, 9, 1, 8);
        value["histogram"]["buckets"]
            .as_array_mut()
            .unwrap()
            .push(json!({"low":8,"high":9,"count":1}));
        value["histogram"]["count"] = json!(2);
        value["histogram"]["sum"] = json!(16);
        assert!(accepted(&value, 0).is_none());
        value = json!({"histogram":{"name":HISTOGRAMS[2],"count":MAX_BUCKETS+1,
            "sum":(0..=MAX_BUCKETS).sum::<usize>(),"buckets":
            (0..=MAX_BUCKETS).map(|n| json!({"low":n,"high":n+1,"count":1})).collect::<Vec<_>>()
        }});
        assert!(accepted(&value, 2).is_none());
    }

    #[test]
    fn matches_early_results_only_after_cef_assigns_the_exact_id() {
        let value = Some(json!({"count":1}));
        let mut flight = Flight {
            issuing: true,
            ..Default::default()
        };
        assert_eq!(flight.receive(17, value.clone()), None);
        assert_eq!(flight.submitted(17), Some(value));
        assert_eq!(flight.pending, None);

        let mut flight = Flight {
            issuing: true,
            ..Default::default()
        };
        assert_eq!(flight.receive(18, None), None);
        assert_eq!(flight.submitted(17), None);
        assert_eq!(flight.pending, Some(17));
        assert_eq!(flight.receive(18, Some(json!("foreign"))), None);
        assert_eq!(flight.receive(17, None), Some(None));
        assert_eq!(flight.pending, None);
    }

    #[test]
    fn unsupported_submission_and_duplicate_callbacks_do_not_create_samples() {
        let mut flight = Flight {
            issuing: true,
            ..Default::default()
        };
        assert_eq!(flight.submitted(0), Some(None));
        assert_eq!(flight.receive(1, Some(json!("foreign"))), None);
        assert!(flight.early.is_none());
        flight.issuing = true;
        assert_eq!(flight.submitted(19), None);
        assert_eq!(flight.receive(19, None), Some(None));
        assert_eq!(flight.receive(19, Some(json!("duplicate"))), None);
    }

    #[test]
    fn priority_markers_are_nullable_bounded_and_first_write_wins() {
        let marker = Marker::default();
        assert_eq!(
            marker.snapshot(),
            json!({"posted":false,"completed":false,"elapsedMs":null})
        );
        marker.posted.store(true, AtomicOrdering::SeqCst);
        marker.complete(Duration::from_millis(4));
        marker.complete(Duration::from_millis(9));
        assert_eq!(
            marker.snapshot(),
            json!({"posted":true,"completed":true,"elapsedMs":4})
        );
        let delayed = Marker::default();
        delayed.complete(Duration::from_secs(60));
        assert_eq!(delayed.snapshot()["completed"], true);
        assert!(delayed.snapshot()["elapsedMs"].is_null());
    }

    fn scope() -> capability_policy::DocumentScope {
        capability_policy::DocumentScope {
            view: 1,
            session: 2,
            generation: 3,
            main_frame: "frame".into(),
            document: "document".into(),
            origin: "http://127.0.0.1:1234".into(),
        }
    }

    #[test]
    fn rejects_early_foreign_and_retired_native_scopes() {
        let first = scope();
        assert!(scope_matches(&first, &first, 1, 1, true, false));
        for (view, admitted, completed, revoked) in [
            (4, 1, true, false),
            (1, 2, true, false),
            (1, 1, false, false),
            (1, 1, true, true),
        ] {
            assert!(!scope_matches(
                &first, &first, view, admitted, completed, revoked
            ));
        }
        for change in 0..6 {
            let mut supplied = first.clone();
            match change {
                0 => supplied.view += 1,
                1 => supplied.session += 1,
                2 => supplied.generation += 1,
                3 => supplied.main_frame.push('x'),
                4 => supplied.document.push('x'),
                _ => supplied.origin.push('x'),
            }
            assert!(!scope_matches(&first, &supplied, 1, 1, true, false));
        }
    }
}
