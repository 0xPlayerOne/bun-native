//! Private CEF transport for the portable browser action surface. No debug listener.
//! Each registration, in-flight callback and byte lease stays owned until its
//! release receipt, or the exact browser's actual OnBeforeClose callback.
use super::*;
use capability_policy::{AdapterAvailability, DocumentScope, GateDecision};
use sha2::{Digest, Sha256};
use std::{
    sync::Condvar,
    thread::JoinHandle,
    time::{Duration, Instant},
};
#[path = "browser_action_data.rs"]
mod data;
use data::{Action, MAX_JSON, RESERVATION};

#[derive(Clone, Copy, PartialEq, Eq)]
enum Phase {
    Enable,
    Frames,
    World,
    WaitingContext,
    Execute,
    Metrics,
    Screenshot,
    Accessibility,
    Cleanup,
    Disable,
    Ready,
    Detached,
}
struct Entry {
    id: u64,
    scope: DocumentScope,
    browser: Browser,
    browser_id: i32,
    cef_frame: String,
    url: String,
    action: Action,
    phase: Phase,
    pending: Option<i32>,
    registration: Option<Registration>,
    frame: String,
    context_id: Option<i64>,
    unique_context: Option<String>,
    world_context: Option<i64>,
    group: String,
    queued: bool,
    failure: Option<&'static str>,
    output: Vec<u8>,
    width: u32,
    height: u32,
    clip: Option<Value>,
    cursor: usize,
    ready_sent: bool,
    _deadline: Deadline,
}
impl Entry {
    fn schedule(&mut self) {
        if self.queued {
            return;
        }
        self.queued = true;
        let mut task = BrowserActionPump::new(self.scope.view, self.id);
        if post_task(ThreadId::UI, Some(&mut task)) == 0 {
            fail("Browser action could not reach its owner");
        }
    }
    fn stop(&mut self, reason: &'static str) {
        self.failure.get_or_insert(reason);
        self.schedule();
    }
    fn action_phase(&self) -> Phase {
        match self.action {
            Action::Screenshot { .. } => Phase::Metrics,
            Action::Accessibility => Phase::Accessibility,
            _ => Phase::Execute,
        }
    }
}
#[derive(Default)]
pub(super) struct Registry {
    entries: BTreeMap<u64, Entry>,
    admitted: u64,
    completed: u64,
    failed: u64,
}
impl Registry {
    pub fn contains(&self, view: u64) -> bool {
        self.entries.contains_key(&view)
    }
    pub fn len(&self) -> usize {
        self.entries.len()
    }
    pub fn reserved_bytes(&self) -> usize {
        self.entries.len() * RESERVATION
    }
    pub fn revoke(&mut self, view: u64) {
        if let Some(entry) = self.entries.get_mut(&view) {
            entry.stop("stale-target");
        }
    }
    pub fn diagnostics(&self) -> Value {
        json!({"operations":self.entries.len(), "registrations":self.entries.values().filter(|e|e.registration.is_some()).count(),
            "callbacks":self.entries.values().filter(|e|e.pending.is_some()).count(),
            "byteLeases":self.entries.values().filter(|e|!e.output.is_empty()).count(),
            "ownedBytes":self.entries.values().map(|e|e.output.len()).sum::<usize>(),
            "reservedBytes":self.reserved_bytes(), "deadlineWorkers":self.entries.len(),
            "admitted":self.admitted,"completed":self.completed,"failed":self.failed})
    }
}
fn scope_live(state: &HostState, entry: &Entry) -> bool {
    if RPC_STOPPED.load(Ordering::SeqCst)
        || QUITTING.load(Ordering::SeqCst)
        || captured_ready_scope(state, entry.scope.view, &entry.scope).is_err()
    {
        return false;
    }
    let Some(browser) = state
        .views
        .get(&entry.scope.view)
        .and_then(|record| record.browser.as_ref())
    else {
        return false;
    };
    if browser.identifier() != entry.browser_id {
        return false;
    }
    let Some(frame) = browser.main_frame() else {
        return false;
    };
    if frame.is_valid() == 0
        || CefString::from(&frame.identifier()).to_string() != entry.cef_frame
        || CefString::from(&frame.url()).to_string() != entry.url
    {
        return false;
    }
    state.policy.authorize_native(
        &entry.scope,
        &entry.action.request(),
        AdapterAvailability::Available,
    ) == GateDecision::Authorized
}
fn matching(registry: &mut Registry, view: u64, id: u64) -> Option<&mut Entry> {
    registry
        .entries
        .get_mut(&view)
        .filter(|entry| entry.id == id)
}
pub(super) fn start(request: u64, args: &Value) -> Result<(), String> {
    let view = number(args, "id")?;
    let scope = policy_scope(args)?;
    let action = Action::decode(
        args.get("action")
            .cloned()
            .ok_or("INVALID_ARGUMENT: browser action")?,
    )?;
    let (browser, frame, url) = STATE.with(|s| {
        let state = s.borrow();
        captured_ready_scope(&state, view, &scope)?;
        if state
            .policy
            .authorize_native(&scope, &action.request(), AdapterAvailability::Available)
            != GateDecision::Authorized
        {
            return Err("PERMISSION_DENIED: browser action grant required");
        }
        if !view_control_available(&state, view, RESERVATION) {
            return Err("RESOURCE_IN_USE: browser action capacity exceeded");
        }
        let browser = state
            .views
            .get(&view)
            .and_then(|record| record.browser.clone())
            .ok_or("UNSUPPORTED_CAPABILITY: browser unavailable")?;
        let frame = browser
            .main_frame()
            .filter(|frame| frame.is_valid() != 0 && frame.is_main() != 0)
            .ok_or("UNSUPPORTED_CAPABILITY: main frame unavailable")?;
        Ok((
            browser,
            CefString::from(&frame.identifier()).to_string(),
            CefString::from(&frame.url()).to_string(),
        ))
    })?;
    let id = next_id()?;
    let host = browser
        .host()
        .ok_or("UNSUPPORTED_CAPABILITY: browser host unavailable")?;
    let deadline = Deadline::new(view, id)?;
    let browser_id = browser.identifier();
    STATE.with(|s| {
        let mut state = s.borrow_mut();
        state.browser_actions.admitted += 1;
        state.browser_actions.entries.insert(
            view,
            Entry {
                id,
                scope,
                browser,
                browser_id,
                cef_frame: frame,
                url,
                action,
                phase: Phase::Frames,
                pending: None,
                registration: None,
                frame: String::new(),
                context_id: None,
                unique_context: None,
                world_context: None,
                group: format!("bunly.browser-action.{id}"),
                queued: false,
                failure: None,
                output: Vec::new(),
                width: 0,
                height: 0,
                clip: None,
                cursor: 0,
                ready_sent: false,
                _deadline: deadline,
            },
        );
    });
    let mut observer = BrowserActionObserver::new(view, id);
    let registration = host.add_dev_tools_message_observer(Some(&mut observer));
    if registration.is_none() {
        let entry = STATE.with(|s| {
            let mut state = s.borrow_mut();
            state.browser_actions.failed += 1;
            state.browser_actions.entries.remove(&view)
        });
        drop(entry);
        return Err("UNSUPPORTED_CAPABILITY: browser observer unavailable".into());
    }
    STATE.with(|s| {
        if let Some(entry) = matching(&mut s.borrow_mut().browser_actions, view, id) {
            entry.registration = registration;
            entry.schedule();
        }
    });
    reply(request, json!({"id":id}));
    Ok(())
}
fn method(entry: &Entry) -> Option<(&'static str, Value)> {
    Some(match entry.phase {
        Phase::Enable => ("Runtime.enable", json!({})),
        Phase::Frames => ("Page.getFrameTree", json!({})),
        Phase::World => (
            "Page.createIsolatedWorld",
            json!({"frameId":entry.frame,"worldName":data::WORLD_NAME,"grantUniveralAccess":false}),
        ),
        Phase::Execute | Phase::Metrics => (
            "Runtime.evaluate",
            json!({
            "expression":if entry.phase == Phase::Metrics { data::METRICS.to_string() } else { entry.action.expression()? },
            "uniqueContextId":entry.unique_context.as_ref()?, "objectGroup":entry.group,
            "returnByValue":true,"awaitPromise":false,"timeout":1000,"userGesture":false,
            "allowUnsafeEvalBlockedByCSP":false,"silent":true}),
        ),
        Phase::Screenshot => (
            "Page.captureScreenshot",
            json!({"format":"png","clip":entry.clip.as_ref()?,"fromSurface":true,"captureBeyondViewport":false,"optimizeForSpeed":true}),
        ),
        Phase::Accessibility => (
            "Accessibility.getFullAXTree",
            json!({"depth":4,"frameId":entry.frame}),
        ),
        Phase::Cleanup => (
            "Runtime.releaseObjectGroup",
            json!({"objectGroup":entry.group}),
        ),
        Phase::Disable => ("Runtime.disable", json!({})),
        _ => return None,
    })
}
fn pump(view: u64, id: u64) {
    let mut registration = None;
    let mut finished = None;
    let mut ready = None;
    let command = STATE.with(|s| {
        let mut state = s.borrow_mut();
        let live = state.browser_actions.entries.get(&view).is_some_and(|entry| entry.id == id && scope_live(&state, entry));
        let entry = matching(&mut state.browser_actions, view, id)?;
        entry.queued = false;
        if !live { entry.failure.get_or_insert("stale-target"); }
        if entry.pending.is_some() || entry.phase == Phase::Detached { return None; }
        if entry.failure.is_some() && !matches!(entry.phase, Phase::Ready | Phase::Disable) { entry.phase = Phase::Cleanup; }
        if entry.phase == Phase::Ready {
            registration = entry.registration.take();
            if let Some(reason) = entry.failure { finished = Some(reason); }
            else if !entry.ready_sent {
                entry.ready_sent = true;
                ready = Some(json!({"id":id,"bytes":entry.output.len(),"sha256":format!("{:x}",Sha256::digest(&entry.output)),"width":entry.width,"height":entry.height}));
            }
            return None;
        }
        method(entry).map(|(method, params)| (entry.browser.clone(), method, params))
    });
    // Never release a CEF registration from within its own callback or a STATE borrow.
    drop(registration);
    if let Some(reason) = finished {
        finish(view, id, reason);
        return;
    }
    if let Some(value) = ready {
        event("browser.action.ready", view, value);
    }
    let Some((browser, name, params)) = command else {
        return;
    };
    let raw = serde_json::to_vec(&params).unwrap();
    let mut params =
        parse_json_buffer(Some(&raw), JsonParserOptions::RFC).and_then(|value| value.dictionary());
    let message = browser
        .host()
        .map(|host| host.execute_dev_tools_method(0, Some(&CefString::from(name)), params.as_mut()))
        .unwrap_or(0);
    STATE.with(|s| {
        if let Some(entry) = matching(&mut s.borrow_mut().browser_actions, view, id) {
            if message > 0 {
                entry.pending = Some(message);
            } else {
                entry.failure.get_or_insert("adapter-error");
                entry.phase = Phase::Detached;
            }
        }
    });
}
fn finish(view: u64, id: u64, reason: &'static str) {
    let entry = STATE.with(|s| {
        let mut state = s.borrow_mut();
        if state
            .browser_actions
            .entries
            .get(&view)
            .is_none_or(|entry| entry.id != id)
        {
            return None;
        }
        state.browser_actions.failed += 1;
        state.browser_actions.entries.remove(&view)
    });
    if entry.is_some() {
        drop(entry);
        event(
            "browser.action.finished",
            view,
            json!({"id":id,"failure":reason}),
        );
    }
}
pub(super) fn cancel(request: u64, args: &Value) -> Result<(), String> {
    let (view, id) = (number(args, "id")?, number(args, "operation")?);
    STATE.with(|s| {
        if let Some(entry) = matching(&mut s.borrow_mut().browser_actions, view, id) {
            entry.stop("cancelled");
        }
    });
    reply(request, Value::Null);
    Ok(())
}
pub(super) fn read(request: u64, args: &Value) -> Result<(), String> {
    let (view, id) = (number(args, "id")?, number(args, "operation")?);
    let captured = policy_scope(args)?;
    let offset = args
        .get("offset")
        .and_then(Value::as_u64)
        .and_then(|n| usize::try_from(n).ok())
        .ok_or("INVALID_ARGUMENT: browser result offset")?;
    let chunk = STATE.with(|s| {
        let mut state = s.borrow_mut();
        let live = state
            .browser_actions
            .entries
            .get(&view)
            .is_some_and(|entry| {
                entry.id == id && entry.scope == captured && scope_live(&state, entry)
            });
        let entry = matching(&mut state.browser_actions, view, id)
            .ok_or("INVALID_HANDLE: browser action")?;
        if !live {
            entry.stop("stale-target");
            return Err("PERMISSION_DENIED: browser action target changed");
        }
        if entry.phase != Phase::Ready
            || !entry.ready_sent
            || entry.failure.is_some()
            || offset != entry.cursor
            || offset >= entry.output.len()
        {
            return Err("INVALID_ARGUMENT: browser result lease");
        }
        let end = (offset + 4096).min(entry.output.len());
        let mut hex = String::with_capacity((end - offset) * 2);
        const DIGITS: &[u8] = b"0123456789abcdef";
        for byte in &entry.output[offset..end] {
            hex.push(DIGITS[(byte >> 4) as usize] as char);
            hex.push(DIGITS[(byte & 15) as usize] as char);
        }
        entry.cursor = end;
        Ok(hex)
    })?;
    reply(request, json!({"id":id,"offset":offset,"hex":chunk}));
    Ok(())
}
pub(super) fn release(request: u64, args: &Value) -> Result<(), String> {
    let (view, id) = (number(args, "id")?, number(args, "operation")?);
    let entry = STATE.with(|s| {
        let mut state = s.borrow_mut();
        let entry = matching(&mut state.browser_actions, view, id)
            .ok_or("INVALID_HANDLE: browser action")?;
        if entry.phase != Phase::Ready
            || entry.registration.is_some()
            || entry.pending.is_some()
            || entry.cursor != entry.output.len()
        {
            return Err("INVALID_ARGUMENT: browser result not consumed");
        }
        state.browser_actions.completed += 1;
        Ok(state.browser_actions.entries.remove(&view))
    })?;
    drop(entry);
    reply(request, Value::Null);
    Ok(())
}
pub(super) fn before_close(view: u64, browser: Option<&Browser>) {
    let id = STATE.with(|s| {
        s.borrow()
            .browser_actions
            .entries
            .get(&view)
            .filter(|entry| {
                browser
                    .as_ref()
                    .is_some_and(|browser| browser.identifier() == entry.browser_id)
            })
            .map(|entry| (entry.id, entry.failure.unwrap_or("cancelled")))
    });
    if let Some((id, reason)) = id {
        finish(view, id, reason);
    }
}
fn method_result(
    view: u64,
    id: u64,
    browser: Option<&mut Browser>,
    message: i32,
    success: i32,
    raw: &[u8],
) {
    STATE.with(|s| {
        let mut state = s.borrow_mut();
        let live = state
            .browser_actions
            .entries
            .get(&view)
            .is_some_and(|entry| entry.id == id && scope_live(&state, entry));
        let Some(entry) = matching(&mut state.browser_actions, view, id) else {
            return;
        };
        if entry.pending != Some(message)
            || browser.is_none_or(|browser| browser.identifier() != entry.browser_id)
        {
            return;
        }
        entry.pending = None;
        if !live {
            entry.failure.get_or_insert("stale-target");
        }
        if matches!(entry.phase, Phase::Cleanup | Phase::Disable) {
            if success != 0 {
                entry.phase = if entry.phase == Phase::Cleanup {
                    Phase::Disable
                } else {
                    Phase::Ready
                };
            } else {
                entry.failure.get_or_insert("adapter-error");
                entry.phase = Phase::Detached;
            }
        } else if entry.failure.is_none() {
            let result = if success == 0 {
                Err("unsupported-capability")
            } else {
                accept_result(entry, raw)
            };
            if let Err(reason) = result {
                entry.failure = Some(reason);
                entry.phase = Phase::Cleanup;
            }
        }
        entry.schedule();
    });
}
fn accept_result(entry: &mut Entry, raw: &[u8]) -> Result<(), &'static str> {
    match entry.phase {
        Phase::Enable => {
            data::bounded_json(raw)?;
            entry.phase = Phase::World;
        }
        Phase::Frames => {
            let value = data::bounded_json(raw)?;
            let frame = value
                .get("frameTree")
                .and_then(|tree| tree.get("frame"))
                .ok_or("adapter-error")?;
            let id = frame
                .get("id")
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty() && id.len() <= 256)
                .ok_or("adapter-error")?;
            if frame.get("url").and_then(Value::as_str) != Some(entry.url.as_str()) {
                return Err("stale-target");
            }
            entry.frame = id.to_string();
            entry.phase = Phase::Enable;
        }
        Phase::World => {
            let value = data::bounded_json(raw)?;
            let context = value
                .get("executionContextId")
                .and_then(Value::as_i64)
                .filter(|id| *id > 0)
                .ok_or("adapter-error")?;
            entry.world_context = Some(context);
            entry.phase = if entry.context_id == Some(context) && entry.unique_context.is_some() {
                entry.action_phase()
            } else {
                Phase::WaitingContext
            };
        }
        Phase::Execute => {
            entry.output = data::evaluation_bytes(raw)?;
            entry.phase = Phase::Cleanup;
        }
        Phase::Metrics => {
            let raw = data::evaluation_bytes(raw)?;
            let value = data::bounded_json(&raw)?;
            let width = value
                .get("width")
                .and_then(Value::as_f64)
                .filter(|v| v.is_finite() && *v > 0.0 && *v <= 16384.0)
                .ok_or("unsupported-capability")?;
            let height = value
                .get("height")
                .and_then(Value::as_f64)
                .filter(|v| v.is_finite() && *v > 0.0 && *v <= 16384.0)
                .ok_or("unsupported-capability")?;
            let scale = value
                .get("scale")
                .and_then(Value::as_f64)
                .filter(|v| v.is_finite() && *v >= 0.25 && *v <= 8.0)
                .ok_or("unsupported-capability")?;
            let Action::Screenshot {
                width: max_width,
                height: max_height,
            } = entry.action
            else {
                return Err("adapter-error");
            };
            entry.clip = Some(
                json!({"x":0,"y":0,"width":width.floor().min(max_width as f64),"height":height.floor().min(max_height as f64),"scale":1.0/scale}),
            );
            entry.phase = Phase::Screenshot;
        }
        Phase::Screenshot => {
            let Action::Screenshot { width, height } = entry.action else {
                return Err("adapter-error");
            };
            let (bytes, width, height) = data::screenshot_bytes(raw, width, height)?;
            entry.output = bytes;
            entry.width = width;
            entry.height = height;
            entry.phase = Phase::Cleanup;
        }
        Phase::Accessibility => {
            entry.output = accessibility(raw, &entry.frame)?;
            entry.phase = Phase::Cleanup;
        }
        _ => return Err("adapter-error"),
    }
    Ok(())
}
fn context_event(view: u64, id: u64, browser: Option<&mut Browser>, name: &str, raw: &[u8]) {
    if !matches!(
        name,
        "Runtime.executionContextCreated"
            | "Runtime.executionContextDestroyed"
            | "Runtime.executionContextsCleared"
    ) || raw.len() > 8192
    {
        return;
    }
    STATE.with(|s| {
        let mut state = s.borrow_mut();
        let live = state
            .browser_actions
            .entries
            .get(&view)
            .is_some_and(|entry| entry.id == id && scope_live(&state, entry));
        let Some(entry) = matching(&mut state.browser_actions, view, id) else {
            return;
        };
        if !live {
            entry.stop("stale-target");
            return;
        }
        if entry.phase == Phase::Ready
            || browser.is_none_or(|browser| browser.identifier() != entry.browser_id)
        {
            return;
        }
        let Ok(value) = data::bounded_json(raw) else {
            return;
        };
        match name {
            "Runtime.executionContextCreated" => {
                let (context_id, unique) = match data::created_context(&value, &entry.frame) {
                    Ok(Some(context)) => context,
                    Ok(None) => return,
                    Err(reason) => {
                        entry.stop(reason);
                        return;
                    }
                };
                if entry.context_id.is_some()
                    && (entry.context_id != Some(context_id)
                        || entry.unique_context.as_deref() != Some(unique))
                {
                    entry.stop("stale-target");
                    return;
                }
                entry.context_id = Some(context_id);
                entry.unique_context = Some(unique.to_string());
                if entry.phase == Phase::WaitingContext && entry.world_context == Some(context_id) {
                    entry.phase = entry.action_phase();
                    entry.schedule();
                }
            }
            "Runtime.executionContextDestroyed" => {
                if value.get("executionContextId").and_then(Value::as_i64) == entry.context_id
                    && entry.context_id.is_some()
                {
                    entry.stop("stale-target");
                }
            }
            "Runtime.executionContextsCleared" => {
                if entry.phase != Phase::Disable && entry.context_id.is_some() {
                    entry.stop("stale-target");
                }
            }
            _ => {}
        }
    });
}
wrap_dev_tools_message_observer! {
    struct BrowserActionObserver { view: u64, id: u64 }
    impl DevToolsMessageObserver {
        fn on_dev_tools_method_result(&self, browser: Option<&mut Browser>, message_id: i32, success: i32, result: Option<&[u8]>) {
            method_result(self.view, self.id, browser, message_id, success, result.unwrap_or(b"{}"));
        }
        fn on_dev_tools_event(&self, browser: Option<&mut Browser>, method: Option<&CefString>, params: Option<&[u8]>) {
            let Some(method) = method else { return; };
            context_event(self.view, self.id, browser, &method.to_string(), params.unwrap_or(b"{}"));
        }
        fn on_dev_tools_agent_detached(&self, browser: Option<&mut Browser>) {
            STATE.with(|s| { if let Some(entry) = matching(&mut s.borrow_mut().browser_actions, self.view, self.id) {
                if entry.phase != Phase::Ready && browser.is_some_and(|browser| browser.identifier() == entry.browser_id) { entry.failure.get_or_insert("adapter-error"); entry.phase = Phase::Detached; }
            } });
        }
    }
}
wrap_task! { struct BrowserActionPump { view: u64, id: u64 } impl Task { fn execute(&self) { pump(self.view, self.id); } } }

struct Deadline {
    clock: Arc<(Mutex<bool>, Condvar)>,
    worker: Option<JoinHandle<()>>,
}
impl Deadline {
    fn new(view: u64, id: u64) -> Result<Self, String> {
        let clock = Arc::new((Mutex::new(false), Condvar::new()));
        let cloned = clock.clone();
        let worker = std::thread::Builder::new()
            .name("bunly-browser-deadline".into())
            .spawn(move || {
                let end = Instant::now() + Duration::from_secs(8);
                let (lock, wake) = &*cloned;
                let mut stopped = lock.lock().unwrap();
                while !*stopped {
                    let now = Instant::now();
                    if now >= end {
                        drop(stopped);
                        let mut task = BrowserActionDeadline::new(view, id);
                        if post_task(ThreadId::UI, Some(&mut task)) == 0 {
                            fail("Browser action deadline lost its owner");
                        }
                        return;
                    }
                    stopped = wake.wait_timeout(stopped, end - now).unwrap().0;
                }
            })
            .map_err(|_| "Browser action deadline unavailable")?;
        Ok(Self {
            clock,
            worker: Some(worker),
        })
    }
}
impl Drop for Deadline {
    fn drop(&mut self) {
        *self.clock.0.lock().unwrap() = true;
        self.clock.1.notify_one();
        if self
            .worker
            .take()
            .is_some_and(|worker| worker.join().is_err())
        {
            FAILED.store(true, Ordering::SeqCst);
        }
    }
}
wrap_task! {
    struct BrowserActionDeadline { view: u64, id: u64 }
    impl Task { fn execute(&self) {
        let close = STATE.with(|s| {
            let mut state = s.borrow_mut();
            let entry = matching(&mut state.browser_actions, self.view, self.id)?;
            entry.stop("timeout");
            (entry.phase != Phase::Ready).then(|| entry.browser.clone())
        });
        // A stuck/detached callback cannot be declared settled. Actual close is
        // the final owner receipt; the ordinary host shutdown deadline is intact.
        if let Some(host) = close.and_then(|browser| browser.host()) { host.close_browser(1); }
    } }
}

fn accessibility(raw: &[u8], frame: &str) -> Result<Vec<u8>, &'static str> {
    let value = data::bounded_json(raw)?;
    let input = value
        .get("nodes")
        .and_then(Value::as_array)
        .filter(|nodes| !nodes.is_empty() && nodes.len() <= 1024)
        .ok_or("unsupported-capability")?;
    let mut by_id = BTreeMap::new();
    for node in input {
        if node
            .get("frameId")
            .and_then(Value::as_str)
            .is_some_and(|id| id != frame)
        {
            return Err("unsupported-capability");
        }
        let id = node
            .get("nodeId")
            .and_then(Value::as_str)
            .filter(|id| !id.is_empty() && id.len() <= 256)
            .ok_or("adapter-error")?;
        if by_id.insert(id, node).is_some() {
            return Err("adapter-error");
        }
    }
    let root = input
        .iter()
        .find(|node| {
            node.get("frameId").and_then(Value::as_str) == Some(frame)
                && node.get("parentId").is_none()
        })
        .ok_or("unsupported-capability")?;
    let mut stack = vec![(root, None, 0_usize)];
    let mut seen = std::collections::BTreeSet::new();
    let mut nodes = Vec::new();
    let mut truncated = false;
    let mut output_budget = 64_usize;
    while let Some((node, parent, depth)) = stack.pop() {
        if nodes.len() >= 256 {
            truncated = true;
            break;
        }
        let source_id = node
            .get("nodeId")
            .and_then(Value::as_str)
            .ok_or("adapter-error")?;
        if !seen.insert(source_id) {
            return Err("adapter-error");
        }
        let id = nodes.len() + 1;
        let field = |name: &str| {
            node.get(name)
                .and_then(|value| value.get("value"))
                .and_then(Value::as_str)
                .unwrap_or("")
        };
        let mut bounded = |value: &str| {
            if value.chars().count() > 512 {
                truncated = true;
            }
            value.chars().take(512).collect::<String>()
        };
        let role = bounded(field("role"));
        let name = bounded(field("name"));
        let text = bounded(field("value"));
        // JSON escaping can expand one UTF-8 byte to six output bytes. Reserve
        // that upper bound before appending fields to the owned observation.
        let bound = 128 + 6 * (role.len() + name.len() + text.len());
        if output_budget + bound > MAX_JSON {
            truncated = true;
            break;
        }
        output_budget += bound;
        let mut output = json!({"id":id,"depth":depth,"role":role,"name":name,"text":text});
        if let Some(parent) = parent {
            output["parent"] = json!(parent);
        }
        nodes.push(output);
        // Frame surfaces are leaves; input and observations never target a child frame.
        if matches!(field("role"), "Iframe" | "IframePresentational") {
            continue;
        }
        if let Some(children) = node.get("childIds").and_then(Value::as_array) {
            if depth == 4 {
                truncated |= !children.is_empty();
                continue;
            }
            if children.len() > 1024 {
                return Err("payload-too-large");
            }
            for child in children.iter().rev() {
                let child = child
                    .as_str()
                    .and_then(|id| by_id.get(id))
                    .ok_or("adapter-error")?;
                if stack.len() >= 256 {
                    truncated = true;
                    break;
                }
                stack.push((*child, Some(id), depth + 1));
            }
        }
    }
    if nodes.is_empty() {
        return Err("payload-too-large");
    }
    let output =
        serde_json::to_vec(&json!({"kind":"accessibility","nodes":nodes,"truncated":truncated}))
            .map_err(|_| "adapter-error")?;
    if output.len() > MAX_JSON {
        return Err("payload-too-large");
    }
    Ok(output)
}

pub(super) fn invalidate_stale(view: u64) {
    STATE.with(|s| {
        let mut state = s.borrow_mut();
        let stale = state
            .browser_actions
            .entries
            .get(&view)
            .is_some_and(|entry| !scope_live(&state, entry));
        if stale {
            state.browser_actions.revoke(view);
        }
    });
}
pub(super) fn shutdown_ready() -> bool {
    if STATE.with(|s| s.borrow().browser_actions.entries.is_empty()) {
        return true;
    }
    fail("CEF shutdown attempted with owned browser actions");
    false
}
