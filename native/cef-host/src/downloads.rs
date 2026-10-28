use super::*;
use crate::{
    download_access::{Access, Permit},
    download_files::{valid_name, Staging},
};
use serde::Deserialize;
use std::{
    path::PathBuf,
    time::{Duration, Instant},
};
#[path = "download_deadline.rs"]
mod deadline;
const MAX_OPERATIONS: usize = 8;
const MAX_BYTES: u64 = 1024 * 1024 * 1024;
#[derive(Deserialize, Clone)]
#[serde(deny_unknown_fields)]
struct Destination {
    root: PathBuf,
    name: String,
    overwrite: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Start {
    id: u64,
    scope: capability_policy::DocumentScope,
    url: String,
    destination: Destination,
    max_bytes: u64,
    timeout_ms: u64,
}
#[derive(Clone, Copy, PartialEq, Eq)]
enum Cancel {
    Requested,
    Revoked,
    Permission,
    Limit,
    Timeout,
}
impl Cancel {
    fn failure(self) -> Option<&'static str> {
        match self {
            Self::Requested | Self::Revoked => None,
            Self::Permission => Some("permission"),
            Self::Limit => Some("limit"),
            Self::Timeout => Some("timeout"),
        }
    }
}
#[derive(Clone, Copy)]
struct Terminal {
    status: &'static str,
    failure: Option<&'static str>,
    written: u64,
}
struct Record {
    id: u64,
    scope: capability_policy::DocumentScope,
    destination: Destination,
    permit: Arc<Permit>,
    access: Arc<Access>,
    staging: Option<Staging>,
    cef_id: Option<u32>,
    callback: Option<DownloadItemCallback>,
    before: bool,
    cancel: Option<Cancel>,
    cancel_notified: bool,
    received: u64,
    total: Option<u64>,
    max_bytes: u64,
    deadline: deadline::Deadline,
    settlement: Option<Instant>,
    terminal: Option<Terminal>,
    last_progress: Option<Value>,
}
#[derive(Default)]
struct Counts {
    admitted: u64,
    terminals: u64,
    completed: u64,
    cancelled: u64,
    failed: u64,
}
#[derive(Default)]
pub(super) struct Registry {
    entries: BTreeMap<u64, Record>,
    counts: Counts,
    shutdown_emitted: bool,
}
impl Registry {
    pub fn len(&self) -> usize {
        self.entries.len()
    }
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
    pub fn contains(&self, view: u64) -> bool {
        self.entries.contains_key(&view)
    }
    pub fn revoke(&mut self, view: u64) {
        if let Some(record) = self.entries.get_mut(&view) {
            mark_cancel(record, Cancel::Revoked);
        }
    }
}
fn mark_cancel(record: &mut Record, reason: Cancel) {
    if record.terminal.is_some() {
        return;
    }
    record.permit.revoke();
    if record.cancel.is_none() {
        record.cancel = Some(reason);
        record.settlement = Some(Instant::now() + crate::deadlines::current().shutdown());
        record
            .deadline
            .arm(1, crate::deadlines::current().shutdown());
    }
}
fn authorization(
    scope: &capability_policy::DocumentScope,
    destination: &Destination,
    actual: Option<&Browser>,
) -> Result<PathBuf, String> {
    if !live_view(scope.view) {
        return Err("PERMISSION_DENIED: download owner is not live".into());
    }
    let (grants, mut expected, mut context) = STATE.with(|s| {
        let s = s.borrow();
        captured_ready_scope(&s, scope.view, scope)?;
        let record = s.views.get(&scope.view).ok_or("INVALID_HANDLE: view")?;
        let session = s
            .sessions
            .get(&scope.session)
            .filter(|session| !session.busy && session.disposing.is_none())
            .ok_or("Download session is unavailable")?;
        Ok::<_, &str>((
            s.policy
                .native_grants(scope)
                .ok_or("Download authority was revoked")?,
            record.browser.clone().ok_or("Browser unavailable")?,
            session.context.clone(),
        ))
    })?;
    if let Some(actual) = actual {
        if actual.is_same(Some(&mut expected)) == 0 {
            return Err("Download browser identity changed".into());
        }
    }
    if expected
        .host()
        .and_then(|host| host.request_context())
        .is_none_or(|current| current.is_same(Some(&mut context)) == 0)
    {
        return Err("Download session identity changed".into());
    }
    let root = capability_policy::download_root(&grants, &destination.root, &destination.name)?;
    STATE.with(|s| captured_ready_scope(&s.borrow(), scope.view, scope))?;
    Ok(root)
}
pub(super) fn start(request: u64, args: &Value) -> Result<(), String> {
    let mut input: Start = serde_json::from_value(args.clone())
        .map_err(|_| "INVALID_ARGUMENT: invalid download request")?;
    if input.id != input.scope.view
        || !valid_name(&input.destination.name)
        || !matches!(input.destination.overwrite.as_str(), "deny" | "replace")
        || input.max_bytes == 0
        || input.max_bytes > MAX_BYTES
        || !(1000..=300_000).contains(&input.timeout_ms)
        || input.url.len() > 4000
        || input.url.bytes().any(|byte| byte <= 0x20 || byte == 0x7f)
    {
        return Err("INVALID_ARGUMENT: invalid download options".into());
    }
    let url = url::Url::parse(&input.url).map_err(|_| "INVALID_ARGUMENT: invalid download URL")?;
    if !matches!(url.scheme(), "http" | "https")
        || url.fragment().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || (url.scheme() == "http" && (url.host_str() != Some("127.0.0.1") || url.port().is_none()))
    {
        return Err("INVALID_ARGUMENT: downloads require HTTPS or exact loopback HTTP".into());
    }
    let url = view_network(input.id)?.navigation(url.as_str())?;
    let (browser, access) = STATE.with(|s| {
        let s = s.borrow();
        if s.downloads.len() >= MAX_OPERATIONS || s.downloads.contains(input.id) {
            return Err("RESOURCE_IN_USE: native download capacity exceeded");
        }
        let view = s.views.get(&input.id).ok_or("INVALID_HANDLE: view")?;
        Ok::<_, &str>((
            view.browser.clone().ok_or("Browser unavailable")?,
            view.download_access.clone(),
        ))
    })?;
    input.destination.root = authorization(&input.scope, &input.destination, Some(&browser))?;
    let host = browser.host().ok_or("Browser host unavailable")?;
    let mut staging = Staging::prepare(
        &input.destination.root,
        &input.destination.name,
        input.destination.overwrite == "replace",
    )?;
    let prepared = (|| {
        let permit = Permit::new(&url)?;
        let id = next_id()?;
        let deadline =
            deadline::Deadline::new(input.id, id, Duration::from_millis(input.timeout_ms))?;
        authorization(&input.scope, &input.destination, Some(&browser))?;
        staging.verify()?;
        access.install(permit.clone())?;
        Ok::<_, String>((id, permit, deadline))
    })();
    let (id, permit, deadline) = match prepared {
        Ok(value) => value,
        Err(error) => {
            staging.cleanup()?;
            return Err(error);
        }
    };
    let request_url = permit.request_url().to_owned();
    STATE.with(|s| {
        let mut s = s.borrow_mut();
        s.downloads.counts.admitted += 1;
        s.downloads.entries.insert(
            input.id,
            Record {
                id,
                scope: input.scope,
                destination: input.destination,
                permit,
                access,
                staging: Some(staging),
                cef_id: None,
                callback: None,
                before: false,
                cancel: None,
                cancel_notified: false,
                received: 0,
                total: None,
                max_bytes: input.max_bytes,
                deadline,
                settlement: None,
                terminal: None,
                last_progress: None,
            },
        );
    });
    // The short admission reply precedes any progress or synchronous CEF callback.
    reply(request, json!({"id":id}));
    emit(input.id, "starting", None);
    // CanDownload is deliberately not called by CEF for StartDownload. The
    // secret original URL and IO permit bind callbacks to this admitted operation.
    host.start_download(Some(&CefString::from(request_url.as_str())));
    Ok(())
}
pub(super) fn cancel(request: u64, args: &Value) -> Result<(), String> {
    let view = number(args, "id")?;
    let id = number(args, "download")?;
    if args.as_object().is_none_or(|args| args.len() != 2) {
        return Err("Invalid download cancellation".into());
    }
    STATE.with(|s| {
        let mut s = s.borrow_mut();
        if let Some(record) = s.downloads.entries.get_mut(&view) {
            if record.id != id {
                return Err("INVALID_HANDLE: download owner mismatch");
            }
            mark_cancel(record, Cancel::Requested);
        }
        // Idempotent monotone cancellation never grants access to a stale scope.
        Ok::<_, &str>(())
    })?;
    cancel_if_revoked(view);
    reply(request, Value::Null);
    Ok(())
}
pub(super) fn cancel_if_revoked(view: u64) {
    let (callback, notify) = STATE.with(|s| {
        let mut s = s.borrow_mut();
        let Some(record) = s.downloads.entries.get_mut(&view) else {
            return (None, false);
        };
        if record.cancel.is_none() || record.terminal.is_some() {
            return (None, false);
        }
        let notify = !record.cancel_notified;
        record.cancel_notified = true;
        (record.callback.clone(), notify)
    });
    if notify {
        emit(view, "cancelling", None);
    }
    if let Some(callback) = callback {
        callback.cancel();
    }
}
pub(super) fn invalidate_stale(view: u64) {
    STATE.with(|s| {
        let mut s = s.borrow_mut();
        let scope = s
            .downloads
            .entries
            .get(&view)
            .map(|record| record.scope.clone());
        if let Some(scope) = scope {
            if captured_ready_scope(&s, view, &scope).is_err() {
                s.downloads.revoke(view);
            }
        }
    });
}
fn request_cancel(view: u64, reason: Cancel) {
    STATE.with(|s| {
        if let Some(record) = s.borrow_mut().downloads.entries.get_mut(&view) {
            mark_cancel(record, reason);
        }
    });
    cancel_if_revoked(view);
}
fn emit(view: u64, status: &'static str, failure: Option<&'static str>) {
    let value = STATE.with(|s| {
        let mut s = s.borrow_mut();
        let record = s.downloads.entries.get_mut(&view)?;
        let progress = json!({"status":status,"bytesReceived":record.received,"totalBytes":record.total,"failure":failure});
        if record.last_progress.as_ref() == Some(&progress) { return None; }
        record.last_progress = Some(progress.clone());
        Some(json!({"id":record.id,"progress":progress}))
    });
    if let Some(value) = value {
        event("download.progress", view, value);
    }
}
struct Observation {
    id: u32,
    original: String,
    url: String,
    path: String,
    received: u64,
    total: Option<u64>,
    complete: bool,
    cancelled: bool,
    interrupted: bool,
}
fn observe(item: &DownloadItem) -> Option<Observation> {
    if item.is_valid() == 0 {
        return None;
    }
    let original = scheme::bounded_string(item.original_url(), 4096)?;
    let url = scheme::bounded_string(item.url(), 4096)?;
    let path = scheme::bounded_string(item.full_path(), 4096)?;
    let received = u64::try_from(item.received_bytes())
        .ok()
        .filter(|value| *value <= wire::MAX_ID)?;
    let total = u64::try_from(item.total_bytes())
        .ok()
        .filter(|value| *value > 0 && *value <= wire::MAX_ID);
    Some(Observation {
        id: item.id(),
        original,
        url,
        path,
        received,
        total,
        complete: item.is_complete() != 0,
        cancelled: item.is_canceled() != 0,
        interrupted: item.is_interrupted() != 0,
    })
}
fn bind(view: u64, observation: &Observation, callback: Option<&DownloadItemCallback>) -> bool {
    let (bound, previous) = STATE.with(|s| {
        let mut s = s.borrow_mut();
        let Some(record) = s.downloads.entries.get_mut(&view) else {
            return (false, None);
        };
        if observation.id == 0
            || observation.original != record.permit.request_url()
            || record.terminal.is_some()
            || record.cef_id.is_some_and(|id| id != observation.id)
        {
            return (false, None);
        }
        record.cef_id = Some(observation.id);
        let previous = callback.and_then(|callback| record.callback.replace(callback.clone()));
        // Chromium 156's InterruptAndDiscardPartialState resets its stored byte
        // counter before notifying cancellation/interruption observers. Retain
        // only bytes already observed; a discarded partial file is not negative
        // transfer progress. Running/completed counters and the raw observation
        // used by byte limits and final file verification remain unchanged.
        let discarded = !observation.complete && (observation.cancelled || observation.interrupted);
        record.received = if discarded {
            record.received.max(observation.received)
        } else {
            observation.received
        };
        record.total = observation
            .total
            .filter(|total| !discarded || *total >= record.received);
        (true, previous)
    });
    // A CEF reference may release native state; never drop one under STATE.
    drop(previous);
    bound
}
fn deny_callback(view: u64, phase: &'static str, reason: &'static str) {
    // One fixed-label receipt per newly denied operation. Never print the URL,
    // destination, native secret, callback payload, or filesystem error text.
    let first = STATE.with(|s| {
        s.borrow()
            .downloads
            .entries
            .get(&view)
            .is_some_and(|record| record.cancel.is_none() && record.terminal.is_none())
    });
    if first {
        eprintln!(
            "{}",
            json!({"event":"bunly.host.download-denied","schema":1,"phase":phase,"reason":reason})
        );
    }
    request_cancel(view, Cancel::Permission);
}
fn callback_allowed(
    view: u64,
    actual: Option<&Browser>,
    observation: &Observation,
    phase: &'static str,
) -> bool {
    let captured = STATE.with(|s| {
        s.borrow().downloads.entries.get(&view).map(|record| {
            (
                record.scope.clone(),
                record.destination.clone(),
                record.cancel,
                record.max_bytes,
                record.permit.clone(),
            )
        })
    });
    let Some((scope, destination, cancelled, maximum, permit)) = captured else {
        return false;
    };
    if cancelled.is_some() {
        return false;
    }
    let denial = if actual.is_none() {
        Some("browser-missing")
    } else if !permit.active() {
        Some("permit-revoked")
    } else if !permit.admitted() {
        Some("request-unclaimed")
    } else if authorization(&scope, &destination, actual).is_err() {
        Some("authority-rejected")
    } else if !view_network(view).is_ok_and(|network| network.navigation(&observation.url).is_ok())
    {
        Some("network-rejected")
    } else {
        None
    };
    if let Some(reason) = denial {
        deny_callback(view, phase, reason);
        return false;
    }
    if observation.received > maximum || observation.total.is_some_and(|total| total > maximum) {
        request_cancel(view, Cancel::Limit);
        return false;
    }
    true
}
fn before(
    view: u64,
    browser: Option<&Browser>,
    item: Option<&DownloadItem>,
    callback: Option<&BeforeDownloadCallback>,
) {
    let Some(observation) = item.and_then(observe) else {
        return;
    };
    if !bind(view, &observation, None) || !callback_allowed(view, browser, &observation, "before") {
        return;
    }
    let stage = STATE.with(|s| {
        let mut s = s.borrow_mut();
        let record = s.downloads.entries.get_mut(&view)?;
        if record.before || record.cancel.is_some() {
            return None;
        }
        record.staging.take()
    });
    let Some(mut stage) = stage else {
        deny_callback(view, "before", "staging-unavailable");
        return;
    };
    let path = stage.begin().ok().map(|()| stage.path());
    STATE.with(|s| {
        if let Some(record) = s.borrow_mut().downloads.entries.get_mut(&view) {
            record.before = path.is_some();
            record.staging = Some(stage);
        }
    });
    let Some(path) = path else {
        deny_callback(view, "before", "staging-rejected");
        return;
    };
    let Some(callback) = callback else {
        deny_callback(view, "before", "callback-missing");
        return;
    };
    let Some(path) = path.to_str() else {
        deny_callback(view, "before", "path-unrepresentable");
        return;
    };
    callback.cont(Some(&CefString::from(path)), 0);
    emit(view, "in-progress", None);
}
fn updated(
    view: u64,
    browser: Option<&Browser>,
    item: Option<&DownloadItem>,
    callback: Option<&DownloadItemCallback>,
) {
    let Some(observation) = item.and_then(observe) else {
        if let Some(callback) = callback {
            callback.cancel();
        }
        return;
    };
    if !bind(view, &observation, callback) {
        if let Some(callback) = callback {
            callback.cancel();
        }
        return;
    }
    let allowed = callback_allowed(view, browser, &observation, "updated");
    if observation.complete || observation.cancelled || observation.interrupted {
        terminal(view, allowed, observation);
    } else {
        if allowed {
            emit(view, "in-progress", None);
        }
        cancel_if_revoked(view);
    }
}
fn terminal(view: u64, allowed: bool, observation: Observation) {
    // Take the filesystem owner out of STATE before filesystem operations. Keep
    // the operation charged and the native browser alive throughout settlement.
    let taken = STATE.with(|s| {
        let mut s = s.borrow_mut();
        let record = s.downloads.entries.get_mut(&view)?;
        if record.terminal.is_some() {
            return None;
        }
        Some((
            record.staging.take()?,
            record.cancel,
            record.before,
            record.permit.clone(),
        ))
    });
    let Some((mut staging, cancelled, before, permit)) = taken else {
        return;
    };
    let result = if let Some(cancelled) = cancelled {
        Terminal {
            status: if cancelled.failure().is_some() {
                "failed"
            } else {
                "cancelled"
            },
            failure: cancelled.failure(),
            written: 0,
        }
    } else if observation.complete
        && allowed
        && before
        && observation.path == staging.path().to_string_lossy()
    {
        match staging.commit(observation.received) {
            Ok(written) => Terminal {
                status: "completed",
                failure: None,
                written,
            },
            Err(_) => Terminal {
                status: "failed",
                failure: Some("destination"),
                written: 0,
            },
        }
    } else if observation.cancelled {
        Terminal {
            status: "cancelled",
            failure: None,
            written: 0,
        }
    } else {
        Terminal {
            status: "failed",
            failure: Some(if permit.denied() {
                "permission"
            } else {
                "network"
            }),
            written: 0,
        }
    };
    permit.revoke();
    STATE.with(|s| {
        if let Some(record) = s.borrow_mut().downloads.entries.get_mut(&view) {
            record.staging = Some(staging);
            record.terminal = Some(result);
            record
                .settlement
                .get_or_insert(Instant::now() + crate::deadlines::current().shutdown());
        }
        s.borrow_mut().downloads.counts.terminals += 1;
    });
    finish(view);
}
fn finish(view: u64) {
    let stage = STATE.with(|s| {
        s.borrow_mut()
            .downloads
            .entries
            .get_mut(&view)
            .and_then(|record| record.staging.take())
    });
    let Some(mut stage) = stage else {
        return;
    };
    if let Err(error) = stage.cleanup() {
        let expired = STATE.with(|s| {
            let mut s = s.borrow_mut();
            let Some(record) = s.downloads.entries.get_mut(&view) else {
                return true;
            };
            record.staging = Some(stage);
            let expired = record
                .settlement
                .is_none_or(|deadline| Instant::now() >= deadline);
            if !expired {
                record.deadline.arm(2, Duration::from_millis(20));
            }
            expired
        });
        if expired {
            fail(&format!(
                "Download owned-file cleanup did not settle: {error}"
            ));
        }
        return;
    }
    drop(stage);
    let record = STATE.with(|s| s.borrow_mut().downloads.entries.remove(&view));
    let Some(record) = record else {
        return;
    };
    record.access.clear(&record.permit);
    let terminal = record.terminal.expect("terminal download settlement");
    event(
        "download.progress",
        view,
        json!({"id":record.id,"progress":{"status":terminal.status,"bytesReceived":record.received,"totalBytes":record.total,"failure":terminal.failure}}),
    );
    event(
        "download.finished",
        view,
        json!({"id":record.id,"outcome":{"status":terminal.status,"bytesWritten":terminal.written,"bytesReceived":record.received,"failure":terminal.failure}}),
    );
    drop(record);
    STATE.with(|s| {
        let mut s = s.borrow_mut();
        match terminal.status {
            "completed" => s.downloads.counts.completed += 1,
            "cancelled" => s.downloads.counts.cancelled += 1,
            _ => s.downloads.counts.failed += 1,
        }
    });
    let mut task = DownloadClosedTask::new(view);
    if post_task(ThreadId::UI, Some(&mut task)) == 0 {
        fail("Download close continuation unavailable");
    }
}
fn expired(view: u64, id: u64, serial: u64, phase: u8) {
    if !STATE.with(|s| {
        s.borrow()
            .downloads
            .entries
            .get(&view)
            .is_some_and(|record| record.id == id && record.deadline.matches(serial))
    }) {
        return;
    }
    match phase {
        0 => request_cancel(view, Cancel::Timeout),
        1 => fail("Native download cancellation did not settle before its deadline"),
        2 => finish(view),
        _ => fail("Invalid native download deadline phase"),
    }
}
wrap_task! {
    struct DownloadClosedTask { view: u64 }
    impl Task { fn execute(&self) { resume_after_download(self.view); } }
}
static RETIRED: OnceLock<Mutex<Vec<Staging>>> = OnceLock::new();
/// Runs at the existing UI fence, after all callback methods and context cleanup
/// have returned. This counts Bunly's owned resources, not Chromium internals.
pub(super) fn shutdown_receipt() {
    let receipt = STATE.with(|s| {
        let mut s = s.borrow_mut();
        let registry = &mut s.downloads;
        let callbacks = registry.entries.values().filter(|record| record.callback.is_some()).count();
        let staging_handles: usize = registry.entries.values().filter_map(|record| record.staging.as_ref()).map(Staging::handle_count).sum();
        let retired_handles: usize = RETIRED.get().map(|retired| retired.lock().unwrap().iter().map(Staging::handle_count).sum()).unwrap_or(0);
        let counts = &registry.counts;
        let passed = !registry.shutdown_emitted && registry.is_empty() && callbacks == 0 && staging_handles + retired_handles == 0
            && counts.admitted == counts.terminals && counts.terminals == counts.completed + counts.cancelled + counts.failed;
        let value = json!({"schema":1,"passed":passed,"admitted":counts.admitted,"terminalCallbacks":counts.terminals,
            "completed":counts.completed,"cancelled":counts.cancelled,"failed":counts.failed,
            "ownedTransfers":registry.len(),"ownedCallbacks":callbacks,"ownedStagingHandles":staging_handles + retired_handles,
            "ownedDeadlineWorkers":registry.len()});
        registry.shutdown_emitted = true;
        if !passed { FAILED.store(true, Ordering::SeqCst); }
        value
    });
    crate::process::emit(json!({"v":1,"event":"download.shutdown","data":receipt}));
    let mut diagnostic = receipt;
    diagnostic["event"] = json!("bunly.host.download-shutdown");
    eprintln!("{diagnostic}");
}
pub(super) fn retire(mut registry: Registry) {
    if registry.is_empty() {
        return;
    }
    FAILED.store(true, Ordering::SeqCst);
    for (_, mut record) in std::mem::take(&mut registry.entries) {
        record.permit.revoke();
        record.access.clear(&record.permit);
        if let Some(staging) = record.staging.take() {
            RETIRED
                .get_or_init(|| Mutex::new(Vec::new()))
                .lock()
                .unwrap()
                .push(staging);
        }
        // Release CEF callbacks and timer workers before CefShutdown. The files
        // remain owned until Chromium has actually stopped writing.
        drop(record);
    }
}
pub(super) fn cleanup_after_cef_shutdown() -> Result<(), String> {
    let Some(retired) = RETIRED.get() else {
        return Ok(());
    };
    let stages = std::mem::take(&mut *retired.lock().unwrap());
    let mut failure = None;
    for mut stage in stages {
        if let Err(error) = stage.cleanup() {
            failure.get_or_insert(error);
        }
    }
    failure.map_or(Ok(()), Err)
}
pub(super) fn handler(id: u64) -> DownloadHandler {
    BunlyDownloads::new(id)
}
wrap_download_handler! {
    struct BunlyDownloads { id: u64 }
    impl DownloadHandler {
        fn can_download(&self, _browser: Option<&mut Browser>, _url: Option<&CefString>, _method: Option<&CefString>) -> i32 {
            event("policy.download-denied", self.id, Value::Null); 0
        }
        fn on_before_download(&self, browser: Option<&mut Browser>, item: Option<&mut DownloadItem>, _name: Option<&CefString>, callback: Option<&mut BeforeDownloadCallback>) -> i32 {
            before(self.id, browser.as_deref(), item.as_deref(), callback.as_deref()); 1
        }
        fn on_download_updated(&self, browser: Option<&mut Browser>, item: Option<&mut DownloadItem>, callback: Option<&mut DownloadItemCallback>) {
            updated(self.id, browser.as_deref(), item.as_deref(), callback.as_deref());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture {
        view: u64,
        observation: Observation,
    }
    impl Fixture {
        fn new() -> Self {
            let view = 3;
            let permit = Permit::new("https://download.test/file").unwrap();
            let access = Arc::new(Access::default());
            access.install(permit.clone()).unwrap();
            let observation = Observation {
                id: 7,
                original: permit.request_url().to_owned(),
                url: "https://download.test/file".into(),
                path: String::new(),
                received: 8192,
                total: Some(32768),
                complete: false,
                cancelled: false,
                interrupted: false,
            };
            let record = Record {
                id: 100,
                scope: capability_policy::DocumentScope {
                    view,
                    session: 1,
                    generation: 1,
                    main_frame: "main".into(),
                    document: "native-3-1".into(),
                    origin: "app://ui".into(),
                },
                destination: Destination {
                    root: PathBuf::new(),
                    name: "test.bin".into(),
                    overwrite: "deny".into(),
                },
                permit,
                access,
                staging: None,
                cef_id: None,
                callback: None,
                before: false,
                cancel: None,
                cancel_notified: false,
                received: 0,
                total: None,
                max_bytes: MAX_BYTES,
                deadline: deadline::Deadline::new(view, 100, Duration::from_secs(300)).unwrap(),
                settlement: None,
                terminal: None,
                last_progress: None,
            };
            STATE.with(|state| {
                let mut state = state.borrow_mut();
                assert!(state.downloads.is_empty());
                state.downloads.entries.insert(view, record);
            });
            assert!(bind(view, &observation, None));
            Self { view, observation }
        }
        fn progress(&self) -> (u64, Option<u64>) {
            STATE.with(|state| {
                let state = state.borrow();
                let record = state.downloads.entries.get(&self.view).unwrap();
                (record.received, record.total)
            })
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let record =
                STATE.with(|state| state.borrow_mut().downloads.entries.remove(&self.view));
            if let Some(record) = record {
                record.access.clear(&record.permit);
                drop(record);
            }
        }
    }

    #[test]
    fn cancelled_partial_state_discard_preserves_observed_progress() {
        let mut fixture = Fixture::new();
        STATE.with(|state| {
            mark_cancel(
                state
                    .borrow_mut()
                    .downloads
                    .entries
                    .get_mut(&fixture.view)
                    .unwrap(),
                Cancel::Requested,
            );
        });
        fixture.observation.cancelled = true;
        fixture.observation.received = 0;
        assert!(bind(fixture.view, &fixture.observation, None));
        assert_eq!(fixture.progress(), (8192, Some(32768)));
        assert_eq!(fixture.observation.received, 0);

        // Bytes newly observed in a terminal callback remain real progress.
        fixture.observation.received = 12288;
        assert!(bind(fixture.view, &fixture.observation, None));
        assert_eq!(fixture.progress(), (12288, Some(32768)));
    }

    #[test]
    fn interrupted_partial_state_discard_never_invents_a_known_total() {
        let mut fixture = Fixture::new();
        fixture.observation.interrupted = true;
        fixture.observation.received = 0;
        for total in [None, Some(4096)] {
            fixture.observation.total = total;
            assert!(bind(fixture.view, &fixture.observation, None));
            assert_eq!(fixture.progress(), (8192, None));
            assert_eq!(fixture.observation.total, total);
        }
    }

    #[test]
    fn running_and_completed_counters_are_never_repaired() {
        for complete in [false, true] {
            let mut fixture = Fixture::new();
            fixture.observation.complete = complete;
            fixture.observation.received = 4096;
            assert!(bind(fixture.view, &fixture.observation, None));
            assert_eq!(fixture.progress(), (4096, Some(32768)));
            assert_eq!(fixture.observation.received, 4096);
        }
    }

    #[test]
    fn terminal_progress_correction_cannot_bind_another_download_identity() {
        let mut fixture = Fixture::new();
        fixture.observation.cancelled = true;
        fixture.observation.received = 16384;
        for id in [0, 8] {
            fixture.observation.id = id;
            assert!(!bind(fixture.view, &fixture.observation, None));
            assert_eq!(fixture.progress(), (8192, Some(32768)));
        }
        fixture.observation.id = 7;
        fixture.observation.original = "https://download.test/file".into();
        assert!(!bind(fixture.view, &fixture.observation, None));
        assert_eq!(fixture.progress(), (8192, Some(32768)));
    }
}
