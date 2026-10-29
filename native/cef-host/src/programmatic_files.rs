//! Development-only synthetic file interactions on the private CEF channel.
//! A terminal acknowledgement requires object-group cleanup, or the exact
//! browser's actual OnBeforeClose. Cancel and detach never release owners.
use super::*;
use capability_policy::{AdapterAvailability, DocumentScope, GateDecision, NativeRequest};
use std::{
    sync::Condvar,
    thread::JoinHandle,
    time::{Duration, Instant},
};
#[path = "programmatic_file_data.rs"]
mod data;
use data::{Kind, Metadata, Ownership, Transfer};

#[derive(Clone, Copy, PartialEq, Eq)]
enum Phase {
    Frames,
    Enable,
    World,
    WaitingContext,
    Prepare,
    Receiving,
    Writing,
    Commit,
    Clear,
    Release,
    Disable,
    Finished,
    Detached,
}
struct Write {
    request: u64,
    bytes: Vec<u8>,
}
struct Entry {
    owner: Ownership,
    scope: DocumentScope,
    browser: Browser,
    cef_frame: String,
    url: String,
    metadata: Metadata,
    transfer: Transfer,
    phase: Phase,
    registration: Option<Registration>,
    pending: Option<i32>,
    writing: Option<Write>,
    frame: String,
    context: Option<i64>,
    unique_context: Option<String>,
    world_context: Option<i64>,
    object: Option<String>,
    group: String,
    ready_sent: bool,
    commit_submitted: bool,
    dispatched: bool,
    queued: bool,
    failure: Option<&'static str>,
    _deadline: Deadline,
}
impl Entry {
    fn request(&self) -> NativeRequest {
        match self.metadata.kind {
            Kind::FileInput => NativeRequest::FileInput {
                element_id: self.metadata.element_id.clone(),
            },
            Kind::FileDrop => NativeRequest::FileDrop {
                element_id: self.metadata.element_id.clone(),
            },
        }
    }
    fn schedule(&mut self) {
        if self.queued {
            return;
        }
        self.queued = true;
        let mut task = ProgrammaticFilePump::new(self.scope.view, self.owner.operation);
        if post_task(ThreadId::UI, Some(&mut task)) == 0 {
            fail("Native file cleanup task unavailable");
        }
    }
    fn stop(&mut self, failure: &'static str) {
        self.failure.get_or_insert(failure);
        self.schedule();
    }
    fn await_close(&mut self) -> bool {
        self.phase = Phase::Detached;
        self.owner.await_close()
    }
}
#[derive(Default)]
pub(super) struct Registry {
    entries: BTreeMap<u64, Entry>,
    admitted: u64,
    prepared: u64,
    committed: u64,
    dispatched: u64,
    completed: u64,
    released: u64,
}
impl Registry {
    pub fn contains(&self, view: u64) -> bool {
        self.entries.contains_key(&view)
    }
    pub fn blocks_close(&self, view: u64) -> bool {
        self.entries
            .get(&view)
            .is_some_and(|entry| entry.owner.blocks_close())
    }
    pub fn len(&self) -> usize {
        self.entries.len()
    }
    pub fn reserved_bytes(&self) -> usize {
        self.entries
            .values()
            .map(|entry| entry.metadata.reservation())
            .sum()
    }
    pub fn revoke(&mut self, view: u64) {
        if let Some(entry) = self.entries.get_mut(&view) {
            entry.stop("stale-target");
        }
    }
    pub fn diagnostics(&self) -> Value {
        json!({"operations":self.len(),"registrations":self.entries.values().filter(|e|e.registration.is_some()).count(),
            "callbacks":self.entries.values().filter(|e|e.pending.is_some()).count(),
            "privateControllers":self.entries.values().filter(|e|e.object.is_some()).count(),
            "objectGroups":self.entries.values().filter(|e|!e.owner.group_released()).count(),
            "chunkBytes":self.entries.values().filter_map(|e|e.writing.as_ref()).map(|w|w.bytes.len()).sum::<usize>(),
            "reservedBytes":self.reserved_bytes(),"deadlineWorkers":self.len(),
            "admitted":self.admitted,"prepared":self.prepared,"committed":self.committed,
            "dispatched":self.dispatched,"completed":self.completed,"released":self.released})
    }
}
fn matching(registry: &mut Registry, view: u64, id: u64) -> Option<&mut Entry> {
    registry
        .entries
        .get_mut(&view)
        .filter(|entry| entry.owner.operation == id)
}
fn fields(args: &Value, expected: &[&str]) -> Result<(), String> {
    let value = args
        .as_object()
        .ok_or("INVALID_ARGUMENT: file interaction")?;
    if value.len() != expected.len() || !expected.iter().all(|key| value.contains_key(*key)) {
        return Err("INVALID_ARGUMENT: file interaction fields".into());
    }
    Ok(())
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
        .and_then(|view| view.browser.as_ref())
    else {
        return false;
    };
    if browser.identifier() != entry.owner.browser {
        return false;
    }
    let Some(frame) = browser.main_frame() else {
        return false;
    };
    frame.is_valid() != 0
        && scheme::bounded_string(frame.identifier(), 256).as_deref()
            == Some(entry.cef_frame.as_str())
        && scheme::bounded_string(frame.url(), 4096).as_deref() == Some(entry.url.as_str())
        && state.policy.authorize_native(
            &entry.scope,
            &entry.request(),
            AdapterAvailability::Available,
        ) == GateDecision::Authorized
}
pub(super) fn prepare(request: u64, args: &Value) -> Result<(), String> {
    fields(args, &["id", "scope", "metadata"])?;
    let view = number(args, "id")?;
    let scope = policy_scope(args)?;
    let metadata = Metadata::decode(&args["metadata"])?;
    let operation = match metadata.kind {
        Kind::FileInput => NativeRequest::FileInput {
            element_id: metadata.element_id.clone(),
        },
        Kind::FileDrop => NativeRequest::FileDrop {
            element_id: metadata.element_id.clone(),
        },
    };
    let (browser, frame, url) = STATE.with(|s| {
        let state = s.borrow();
        captured_ready_scope(&state, view, &scope)?;
        if RPC_STOPPED.load(Ordering::SeqCst)
            || QUITTING.load(Ordering::SeqCst)
            || state
                .policy
                .authorize_native(&scope, &operation, AdapterAvailability::Available)
                != GateDecision::Authorized
        {
            return Err("PERMISSION_DENIED: file interaction grant".into());
        }
        if !view_control_available(&state, view, metadata.reservation()) {
            return Err("RESOURCE_IN_USE: native view-control capacity".into());
        }
        let browser = state
            .views
            .get(&view)
            .and_then(|view| view.browser.clone())
            .ok_or("INVALID_HANDLE: file browser")?;
        let frame = browser
            .main_frame()
            .filter(|frame| frame.is_valid() != 0)
            .ok_or("UNSUPPORTED_CAPABILITY: file main frame")?;
        Ok::<_, String>((
            browser,
            scheme::bounded_string(frame.identifier(), 256)
                .ok_or("INVALID_ARGUMENT: file frame identity bound")?,
            scheme::bounded_string(frame.url(), 4096)
                .ok_or("INVALID_ARGUMENT: file document URL bound")?,
        ))
    })?;
    let id = next_id()?;
    let host = browser
        .host()
        .ok_or("UNSUPPORTED_CAPABILITY: file browser host")?;
    let deadline = Deadline::new(view, id)?;
    let browser_id = browser.identifier();
    STATE.with(|s| {
        let mut state = s.borrow_mut();
        if !view_control_available(&state, view, metadata.reservation()) {
            return Err("RESOURCE_IN_USE: native view-control capacity");
        }
        state.programmatic_files.admitted += 1;
        state.programmatic_files.entries.insert(
            view,
            Entry {
                owner: Ownership::new(id, browser_id),
                scope,
                browser,
                cef_frame: frame,
                url,
                metadata,
                transfer: Transfer::default(),
                phase: Phase::Frames,
                registration: None,
                pending: None,
                writing: None,
                frame: String::new(),
                context: None,
                unique_context: None,
                world_context: None,
                object: None,
                group: format!("bunly.programmatic-file.{id}"),
                ready_sent: false,
                commit_submitted: false,
                dispatched: false,
                queued: false,
                failure: None,
                _deadline: deadline,
            },
        );
        Ok::<_, &str>(())
    })?;
    let mut observer = ProgrammaticFileObserver::new(view, id);
    let mut registration = host.add_dev_tools_message_observer(Some(&mut observer));
    if registration.is_none() {
        let entry = STATE.with(|s| {
            let mut state = s.borrow_mut();
            let removed = state.programmatic_files.entries.remove(&view);
            state.programmatic_files.released += u64::from(removed.is_some());
            removed
        });
        drop(entry);
        return Err("UNSUPPORTED_CAPABILITY: file observer unavailable".into());
    }
    STATE.with(|s| {
        if let Some(entry) = matching(&mut s.borrow_mut().programmatic_files, view, id) {
            entry.registration = registration.take();
            entry.schedule();
        }
    });
    drop(registration);
    reply(request, json!({"id":id}));
    Ok(())
}
pub(super) fn write(request: u64, args: &Value) -> Result<(), String> {
    fields(args, &["id", "operation", "scope", "offset", "hex"])?;
    let (view, id) = (number(args, "id")?, number(args, "operation")?);
    let scope = policy_scope(args)?;
    let offset = args["offset"]
        .as_u64()
        .ok_or("INVALID_ARGUMENT: file chunk offset")?;
    let hex = args["hex"].as_str().ok_or("INVALID_ARGUMENT: file chunk")?;
    STATE.with(|s| {
        let mut state = s.borrow_mut();
        let live = state
            .programmatic_files
            .entries
            .get(&view)
            .is_some_and(|entry| {
                entry.owner.operation == id && entry.scope == scope && scope_live(&state, entry)
            });
        let entry = matching(&mut state.programmatic_files, view, id)
            .ok_or("INVALID_HANDLE: file interaction")?;
        if !live {
            entry.stop("stale-target");
            return Err("PERMISSION_DENIED: file target changed");
        }
        if entry.phase != Phase::Receiving
            || !entry.ready_sent
            || entry.failure.is_some()
            || entry.writing.is_some()
        {
            return Err("RESOURCE_IN_USE: file chunk is not ready");
        }
        let bytes = entry.transfer.chunk(&entry.metadata, offset, hex)?;
        entry.writing = Some(Write { request, bytes });
        entry.phase = Phase::Writing;
        entry.schedule();
        Ok::<_, &str>(())
    })?;
    Ok(())
}
pub(super) fn commit(request: u64, args: &Value) -> Result<(), String> {
    fields(args, &["id", "operation", "scope"])?;
    let (view, id) = (number(args, "id")?, number(args, "operation")?);
    let scope = policy_scope(args)?;
    STATE.with(|s| {
        let mut state = s.borrow_mut();
        let live = state
            .programmatic_files
            .entries
            .get(&view)
            .is_some_and(|entry| {
                entry.owner.operation == id && entry.scope == scope && scope_live(&state, entry)
            });
        let entry = matching(&mut state.programmatic_files, view, id)
            .ok_or("INVALID_HANDLE: file interaction")?;
        if !live {
            entry.stop("stale-target");
            return Err("PERMISSION_DENIED: file target changed");
        }
        if entry.phase != Phase::Receiving
            || entry.failure.is_some()
            || !entry.ready_sent
            || !entry.transfer.complete(&entry.metadata)
        {
            return Err("INVALID_ARGUMENT: incomplete file interaction");
        }
        entry.phase = Phase::Commit;
        entry.schedule();
        Ok::<_, &str>(())
    })?;
    reply(request, Value::Null);
    Ok(())
}
pub(super) fn cancel(request: u64, args: &Value) -> Result<(), String> {
    fields(args, &["id", "operation"])?;
    let (view, id) = (number(args, "id")?, number(args, "operation")?);
    STATE.with(|s| {
        if let Some(entry) = matching(&mut s.borrow_mut().programmatic_files, view, id) {
            entry.stop("cancelled");
        }
    });
    reply(request, Value::Null);
    Ok(())
}
fn method(entry: &Entry) -> Option<(&'static str, Value)> {
    let invoke = |function: &str, arguments: Value| {
        Some((
            "Runtime.callFunctionOn",
            json!({
                "objectId":entry.object.as_ref()?,"functionDeclaration":function,"arguments":arguments,
                "objectGroup":entry.group,"returnByValue":true,"awaitPromise":false,"userGesture":false,"silent":true,
            }),
        ))
    };
    Some(match entry.phase {
        Phase::Frames => ("Page.getFrameTree", json!({})),
        Phase::Enable => ("Runtime.enable", json!({})),
        Phase::World => (
            "Page.createIsolatedWorld",
            json!({"frameId":entry.frame,"worldName":data::WORLD,"grantUniveralAccess":false}),
        ),
        Phase::Prepare => (
            "Runtime.evaluate",
            json!({"expression":entry.metadata.preparation(&entry.url),
            "uniqueContextId":entry.unique_context.as_ref()?,"objectGroup":entry.group,"returnByValue":false,
            "awaitPromise":false,"timeout":1000,"userGesture":false,"allowUnsafeEvalBlockedByCSP":false,"silent":true}),
        ),
        Phase::Writing => {
            return invoke(
                data::WRITE,
                json!([{"value":entry.transfer.received()},{"value":data::encode(&entry.writing.as_ref()?.bytes)}]),
            )
        }
        Phase::Commit => return invoke(data::COMMIT, json!([])),
        Phase::Clear => return invoke(data::CLEAR, json!([])),
        Phase::Release => (
            "Runtime.releaseObjectGroup",
            json!({"objectGroup":entry.group}),
        ),
        Phase::Disable => ("Runtime.disable", json!({})),
        _ => return None,
    })
}
fn pump(view: u64, id: u64) {
    let (mut ready, mut finished, mut failed_write) = (false, false, None);
    let command = STATE.with(|s| {
        let mut state = s.borrow_mut();
        let live = state
            .programmatic_files
            .entries
            .get(&view)
            .is_some_and(|entry| entry.owner.operation == id && scope_live(&state, entry));
        let entry = matching(&mut state.programmatic_files, view, id)?;
        entry.queued = false;
        if !live {
            entry.failure.get_or_insert("stale-target");
        }
        if entry.pending.is_some() || entry.phase == Phase::Detached {
            return None;
        }
        if entry.failure.is_some()
            && !matches!(
                entry.phase,
                Phase::Clear | Phase::Release | Phase::Disable | Phase::Finished
            )
        {
            failed_write = entry.writing.take().map(|writing| writing.request);
            entry.phase = if entry.object.is_some() {
                Phase::Clear
            } else {
                Phase::Release
            };
        }
        if entry.phase == Phase::Finished {
            finished = true;
            return None;
        }
        if entry.phase == Phase::Receiving && !entry.ready_sent {
            entry.ready_sent = true;
            ready = true;
        }
        method(entry).map(|(method, params)| (entry.browser.clone(), entry.phase, method, params))
    });
    if let Some(request) = failed_write {
        error(request, "PERMISSION_DENIED: file interaction cancelled");
    }
    if finished {
        finish(view, id, None);
        return;
    }
    if ready {
        STATE.with(|s| s.borrow_mut().programmatic_files.prepared += 1);
        event("file.interaction.ready", view, json!({"id":id}));
    }
    let Some((browser, phase, name, params)) = command else {
        return;
    };
    let raw = serde_json::to_vec(&params).unwrap();
    let mut params =
        parse_json_buffer(Some(&raw), JsonParserOptions::RFC).and_then(|value| value.dictionary());
    let message = browser
        .host()
        .map(|host| host.execute_dev_tools_method(0, Some(&CefString::from(name)), params.as_mut()))
        .unwrap_or(0);
    let mut resume = false;
    STATE.with(|s| {
        let mut state = s.borrow_mut();
        let Some(entry) = matching(&mut state.programmatic_files, view, id) else {
            return;
        };
        if message > 0 {
            entry.pending = Some(message);
            if phase == Phase::Commit {
                entry.commit_submitted = true;
                state.programmatic_files.committed += 1;
            }
        } else {
            entry.failure.get_or_insert("adapter-error");
            resume = entry.await_close();
        }
    });
    if resume {
        resume_close(view);
    }
}
fn finish(view: u64, id: u64, closed_browser: Option<i32>) {
    let removed = STATE.with(|s| {
        let mut state = s.borrow_mut();
        if !state
            .programmatic_files
            .entries
            .get(&view)
            .is_some_and(|entry| {
                entry.owner.can_release(id, closed_browser)
                    && (closed_browser.is_some()
                        || (entry.phase == Phase::Finished
                            && entry.object.is_none()
                            && entry.pending.is_none()
                            && entry.writing.is_none()))
            })
        {
            return None;
        }
        let entry = state.programmatic_files.entries.remove(&view)?;
        state.programmatic_files.released += 1;
        if entry.failure.is_none() && entry.dispatched {
            state.programmatic_files.completed += 1;
        }
        Some(entry)
    });
    let Some(entry) = removed else {
        return;
    };
    let reason = entry
        .failure
        .or((!entry.dispatched).then_some("adapter-error"));
    let status = match reason {
        None => "completed",
        Some("cancelled") => "cancelled",
        _ => "failed",
    };
    let result = json!({"status":status,"failure":reason.filter(|reason| *reason != "cancelled"),"synthetic":true,"mayHaveExposedFile":entry.commit_submitted});
    let pending = entry.writing.as_ref().map(|writing| writing.request);
    // Drop registration, deadline and Browser outside STATE and outside their
    // DevTools observer callback. The UI pump or real OnBeforeClose owns this call.
    drop(entry);
    if let Some(request) = pending {
        error(request, "PERMISSION_DENIED: file interaction closed");
    }
    event(
        "file.interaction.finished",
        view,
        json!({"id":id,"result":result}),
    );
    if closed_browser.is_none() {
        resume_close(view);
    }
}
fn resume_close(view: u64) {
    let mut continuation = ProgrammaticFileClosed::new(view);
    if post_task(ThreadId::UI, Some(&mut continuation)) == 0 {
        fail("Native file close continuation unavailable");
    }
}
wrap_task! {
    struct ProgrammaticFileClosed { view: u64 }
    impl Task { fn execute(&self) { resume_after_owned_operation(self.view); } }
}
pub(super) fn before_close(view: u64, browser: Option<&Browser>) {
    let Some(browser_id) = browser.map(|browser| browser.identifier()) else {
        return;
    };
    let id = STATE.with(|s| {
        let mut state = s.borrow_mut();
        let entry = state.programmatic_files.entries.get_mut(&view)?;
        if browser_id != entry.owner.browser {
            return None;
        }
        entry.failure.get_or_insert("cancelled");
        Some(entry.owner.operation)
    });
    if let Some(id) = id {
        finish(view, id, Some(browser_id));
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
    let mut write_reply = None;
    let mut resume = false;
    STATE.with(|s| {
        let mut state = s.borrow_mut();
        let live = state
            .programmatic_files
            .entries
            .get(&view)
            .is_some_and(|entry| entry.owner.operation == id && scope_live(&state, entry));
        let entry = match matching(&mut state.programmatic_files, view, id) {
            Some(entry) => entry,
            None => return,
        };
        if entry.pending != Some(message)
            || !browser.is_some_and(|browser| entry.owner.matches(id, browser.identifier()))
        {
            return;
        }
        entry.pending = None;
        if !live {
            entry.failure.get_or_insert("stale-target");
        }
        match entry.phase {
            Phase::Clear => {
                if success == 0 || data::confirmed(raw).is_err() {
                    entry.failure.get_or_insert("adapter-error");
                }
                // No global bindings exist: release of the sole object-group
                // root is still required even when private reset reports failure.
                entry.phase = Phase::Release;
            }
            Phase::Release | Phase::Disable => {
                if success != 0 && data::acknowledged(raw).is_ok() {
                    if entry.phase == Phase::Release {
                        entry.object = None;
                        entry.owner.acknowledge_group();
                        entry.phase = Phase::Disable;
                    } else if entry.owner.acknowledge_disabled() {
                        entry.phase = Phase::Finished;
                    } else {
                        entry.failure.get_or_insert("adapter-error");
                        resume = entry.await_close();
                    }
                } else {
                    entry.failure.get_or_insert("adapter-error");
                    resume = entry.await_close();
                }
            }
            Phase::Writing => {
                let Some(writing) = entry.writing.take() else {
                    entry.stop("adapter-error");
                    return;
                };
                let confirmation = if success != 0 {
                    data::confirmed(raw)
                } else {
                    Err("unsupported-capability")
                };
                let ok = entry.failure.is_none() && confirmation.is_ok();
                if ok {
                    entry.transfer.acknowledged(&writing.bytes);
                }
                let digest_ok = entry.transfer.received() != entry.metadata.bytes
                    || entry.transfer.complete(&entry.metadata);
                write_reply = Some((writing.request, ok && digest_ok));
                if ok && digest_ok {
                    entry.phase = Phase::Receiving;
                } else {
                    entry
                        .failure
                        .get_or_insert(confirmation.err().unwrap_or("adapter-error"));
                    entry.phase = Phase::Clear;
                }
            }
            _ if entry.failure.is_none() => {
                let result = if success == 0 {
                    Err("unsupported-capability")
                } else {
                    accept_result(entry, raw)
                };
                if let Err(reason) = result {
                    entry.failure = Some(reason);
                    entry.phase = if entry.object.is_some() {
                        Phase::Clear
                    } else {
                        Phase::Release
                    };
                }
            }
            _ => {}
        }
        let dispatched = entry.dispatched && entry.phase == Phase::Clear && entry.failure.is_none();
        entry.schedule();
        if dispatched {
            state.programmatic_files.dispatched += 1;
        }
    });
    if resume {
        resume_close(view);
    }
    if let Some((request, ok)) = write_reply {
        if ok {
            reply(request, Value::Null);
        } else {
            error(request, "PERMISSION_DENIED: file chunk not accepted");
        }
    }
}
fn accept_result(entry: &mut Entry, raw: &[u8]) -> Result<(), &'static str> {
    match entry.phase {
        Phase::Frames => {
            let value = data::callback(raw)?;
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
            entry.frame = id.into();
            entry.phase = Phase::Enable;
        }
        Phase::Enable => {
            data::acknowledged(raw)?;
            entry.phase = Phase::World;
        }
        Phase::World => {
            let value = data::callback(raw)?;
            let context = value
                .get("executionContextId")
                .and_then(Value::as_i64)
                .filter(|id| *id > 0)
                .ok_or("adapter-error")?;
            entry.world_context = Some(context);
            entry.phase = if entry.context == Some(context) && entry.unique_context.is_some() {
                Phase::Prepare
            } else {
                Phase::WaitingContext
            };
        }
        Phase::Prepare => {
            entry.object = Some(data::controller(raw)?);
            entry.phase = Phase::Receiving;
        }
        Phase::Commit => {
            data::confirmed(raw)?;
            entry.dispatched = true;
            entry.phase = Phase::Clear;
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
    ) || raw.len() > data::MAX_CALLBACK
    {
        return;
    }
    STATE.with(|s| {
        let mut state = s.borrow_mut();
        let live = state
            .programmatic_files
            .entries
            .get(&view)
            .is_some_and(|entry| entry.owner.operation == id && scope_live(&state, entry));
        let Some(entry) = matching(&mut state.programmatic_files, view, id) else {
            return;
        };
        if !browser.is_some_and(|browser| entry.owner.matches(id, browser.identifier()))
            || entry.phase == Phase::Finished
        {
            return;
        }
        if !live {
            entry.stop("stale-target");
            return;
        }
        let Ok(value) = data::callback(raw) else {
            entry.stop("adapter-error");
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
                if entry.context.is_some()
                    && (entry.context != Some(context_id)
                        || entry.unique_context.as_deref() != Some(unique))
                {
                    entry.stop("stale-target");
                    return;
                }
                entry.context = Some(context_id);
                entry.unique_context = Some(unique.into());
                if entry.phase == Phase::WaitingContext && entry.world_context == Some(context_id) {
                    entry.phase = Phase::Prepare;
                    entry.schedule();
                }
            }
            "Runtime.executionContextDestroyed" => {
                if entry.context.is_some()
                    && value.get("executionContextId").and_then(Value::as_i64) == entry.context
                {
                    entry.stop("stale-target");
                }
            }
            "Runtime.executionContextsCleared" => {
                if entry.phase != Phase::Disable && entry.context.is_some() {
                    entry.stop("stale-target");
                }
            }
            _ => {}
        }
    });
}
wrap_dev_tools_message_observer! {
    struct ProgrammaticFileObserver { view: u64,id: u64 }
    impl DevToolsMessageObserver {
        fn on_dev_tools_method_result(&self,browser: Option<&mut Browser>,message_id: i32,success: i32,result: Option<&[u8]>) {
            method_result(self.view,self.id,browser,message_id,success,result.unwrap_or(b"{}"));
        }
        fn on_dev_tools_event(&self,browser: Option<&mut Browser>,method: Option<&CefString>,params: Option<&[u8]>) {
            if let Some(method) = method { context_event(self.view,self.id,browser,&method.to_string(),params.unwrap_or(b"{}")); }
        }
        fn on_dev_tools_agent_detached(&self,browser: Option<&mut Browser>) {
            let mut resume = false;
            STATE.with(|s| { if let Some(entry) = matching(&mut s.borrow_mut().programmatic_files,self.view,self.id) {
                if entry.phase != Phase::Finished && browser.is_some_and(|browser| entry.owner.matches(self.id, browser.identifier())) {
                    entry.failure.get_or_insert("adapter-error"); resume = entry.await_close();
                }
            } });
            if resume { resume_close(self.view); }
        }
    }
}
wrap_task! { struct ProgrammaticFilePump { view: u64,id: u64 } impl Task { fn execute(&self) { pump(self.view,self.id); } } }
struct Deadline {
    clock: Arc<(Mutex<bool>, Condvar)>,
    worker: Option<JoinHandle<()>>,
}
impl Deadline {
    fn new(view: u64, id: u64) -> Result<Self, String> {
        let clock = Arc::new((Mutex::new(false), Condvar::new()));
        let cloned = clock.clone();
        let worker = std::thread::Builder::new()
            .name("bunly-file-deadline".into())
            .spawn(move || {
                let end = Instant::now() + Duration::from_secs(8);
                let (lock, wake) = &*cloned;
                let mut stopped = lock.lock().unwrap();
                while !*stopped {
                    let now = Instant::now();
                    if now >= end {
                        drop(stopped);
                        let mut task = ProgrammaticFileDeadline::new(view, id);
                        if post_task(ThreadId::UI, Some(&mut task)) == 0 {
                            fail("File deadline lost its owner");
                        }
                        return;
                    }
                    stopped = wake.wait_timeout(stopped, end - now).unwrap().0;
                }
            })
            .map_err(|_| "Native file deadline unavailable")?;
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
    struct ProgrammaticFileDeadline { view: u64,id: u64 }
    impl Task { fn execute(&self) {
        let browser = STATE.with(|s| {
            let mut state = s.borrow_mut();
            let entry = matching(&mut state.programmatic_files,self.view,self.id)?;
            entry.stop("timeout"); entry.await_close(); Some(entry.browser.clone())
        });
        // A stuck callback retains its owners until this browser actually closes.
        if let Some(host) = browser.and_then(|browser| browser.host()) { host.close_browser(1); }
    } }
}
pub(super) fn invalidate_stale(view: u64) {
    STATE.with(|s| {
        let mut state = s.borrow_mut();
        if state
            .programmatic_files
            .entries
            .get(&view)
            .is_some_and(|entry| !scope_live(&state, entry))
        {
            state.programmatic_files.revoke(view);
        }
    });
}
pub(super) fn shutdown_ready() -> bool {
    STATE.with(|s| s.borrow().programmatic_files.entries.is_empty())
}
