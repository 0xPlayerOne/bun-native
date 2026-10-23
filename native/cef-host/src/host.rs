use crate::{policy, process, rpc_authority, rpc_protocol as wire, scheme, session};
use cef::*;
use serde_json::{json, Value};
use std::{
    cell::RefCell,
    collections::BTreeMap,
    rc::Rc,
    sync::atomic::{AtomicBool, AtomicUsize, Ordering},
};
#[path = "navigation.rs"]
mod navigation;
pub static FAILED: AtomicBool = AtomicBool::new(false);
pub static QUITTING: AtomicBool = AtomicBool::new(false);
static PENDING: AtomicUsize = AtomicUsize::new(0);
static FINALIZING: AtomicBool = AtomicBool::new(false);
// Failure can arrive on the pipe thread before its UI teardown task runs.
// Fence application dispatch immediately; receipt/discard cleanup may still drain.
static RPC_STOPPED: AtomicBool = AtomicBool::new(false);
static SHUTDOWN_DEADLINE: AtomicBool = AtomicBool::new(false);
struct WindowRecord {
    window: Option<Window>,
    request: u64,
    closing: Option<u64>,
}
struct ViewRecord {
    view: Option<BrowserView>,
    browser: Option<Browser>,
    window: u64,
    session: u64,
    create: u64,
    navigate: navigation::Navigation,
    close: Option<u64>,
    rpc: rpc_authority::Authority,
    #[cfg(feature = "rpc-qualification")]
    previous_rpc: Option<wire::Identity>,
}
struct SessionRecord {
    context: RequestContext,
    profile: Option<session::ProfileLease>,
    partition: String,
    persistent: bool,
    cookies_supported: bool,
    creating: Option<u64>,
    busy: bool,
    disposing: Option<u64>,
}
#[derive(Default)]
struct HostState {
    next: u64,
    windows: BTreeMap<u64, WindowRecord>,
    views: BTreeMap<u64, ViewRecord>,
    sessions: BTreeMap<u64, SessionRecord>,
    rpc_deliveries: rpc_authority::Deliveries,
}
thread_local! { static STATE: RefCell<HostState> = RefCell::new(HostState::default()); }
fn number(value: &Value, key: &str) -> Result<u64, String> {
    value
        .get(key)
        .and_then(Value::as_u64)
        .filter(|n| *n > 0 && *n <= wire::MAX_ID)
        .ok_or_else(|| format!("Invalid {key}"))
}
fn string<'a>(value: &'a Value, key: &str) -> Result<&'a str, String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|s| s.len() <= 4096 && !s.contains('\0'))
        .ok_or_else(|| format!("Invalid {key}"))
}
fn packet_string<'a>(value: &'a Value, key: &str) -> Result<&'a str, String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|s| s.len() <= rpc_authority::MAX_PACKET_BYTES * 2 && !s.contains('\0'))
        .ok_or_else(|| format!("Invalid {key}"))
}
fn application_origin(value: &Value) -> Result<Option<String>, String> {
    let trust = value
        .get("trust")
        .and_then(Value::as_object)
        .ok_or("Invalid trust policy")?;
    match trust.get("kind").and_then(Value::as_str) {
        Some("remote") if trust.len() == 1 => Ok(None),
        Some("application") if trust.len() == 2 => {
            let origin = trust
                .get("origin")
                .and_then(Value::as_str)
                .ok_or("Invalid application origin")?;
            if origin.len() > 256
                || origin == "null"
                || rpc_authority::exact_origin(origin).as_deref() != Some(origin)
            {
                return Err("Invalid application origin".into());
            }
            Ok(Some(origin.to_owned()))
        }
        _ => Err("Invalid trust policy".into()),
    }
}
fn reply(id: u64, value: Value) {
    process::emit(json!({"v":1,"id":id,"ok":true,"value":value}));
}
fn error(id: u64, message: &str) {
    process::emit(json!({"v":1,"id":id,"ok":false,"error":message}));
}
fn next_id() -> Result<u64, String> {
    STATE.with(|s| {
        let mut state = s.borrow_mut();
        state.next = wire::next(state.next).ok_or("Native identity exhausted")?;
        Ok(state.next)
    })
}
fn event(kind: &str, target: u64, data: Value) {
    process::emit(json!({"v":1,"event":kind,"target":target,"data":data}));
}
fn revoke_renderer(id: u64, binding: Option<rpc_authority::Binding>) {
    let Some(binding) = binding else {
        return;
    };
    let (browser, requests) = STATE.with(|s| {
        let mut state = s.borrow_mut();
        #[cfg(feature = "rpc-qualification")]
        if let Some(view) = state.views.get_mut(&id) {
            view.previous_rpc = Some(binding.identity());
        }
        let requests = state.rpc_deliveries.retire(binding.identity());
        (
            state.views.get(&id).and_then(|r| r.browser.clone()),
            requests,
        )
    });
    // CEF owns the already-sent bytes until an exact DELIVERED/DISCARDED record
    // returns. Revocation settles Bun waiters but does not erase this budget.
    for request in requests {
        error(request, "RPC document authority was revoked");
    }
    if let Some(frame) = browser.and_then(|browser| browser.main_frame()) {
        if let Some(mut message) = wire::message(wire::REVOKE, binding.identity(), 0, None) {
            frame.send_process_message(ProcessId::RENDERER, Some(&mut message));
        }
    }
    event(
        "rpc.revoked",
        id,
        json!({"connection":binding.connection,"context":binding.context,"generation":binding.generation,"documentId":binding.document}),
    );
}
fn observed(browser: &Browser, frame: &Frame) -> rpc_authority::Observed {
    rpc_authority::Observed {
        browser: browser.identifier(),
        frame: CefString::from(&frame.identifier()).to_string(),
        url: CefString::from(&frame.url()).to_string(),
        main: frame.is_main() != 0 && frame.is_valid() != 0,
    }
}
fn rpc_target(
    args: &Value,
) -> Result<(u64, rpc_authority::Binding, Frame, rpc_authority::Observed), String> {
    if RPC_STOPPED.load(Ordering::SeqCst) || QUITTING.load(Ordering::SeqCst) {
        return Err("RPC host is shutting down".into());
    }
    let identity = wire::Identity {
        connection: number(args, "connection")?,
        context: number(args, "context")?,
        generation: number(args, "generation")?,
    };
    let (id, binding, browser) = STATE
        .with(|s| {
            let state = s.borrow();
            state.views.iter().find_map(|(id, record)| {
                let binding = record.rpc.binding()?;
                (binding.identity() == identity).then(|| (*id, binding, record.browser.clone()))
            })
        })
        .ok_or("Stale RPC connection")?;
    let browser = browser.ok_or("RPC browser unavailable")?;
    let frame = browser.main_frame().ok_or("RPC frame unavailable")?;
    let context = observed(&browser, &frame);
    STATE.with(|s| {
        s.borrow()
            .views
            .get(&id)
            .ok_or("RPC view unavailable")?
            .rpc
            .authorize(&context, identity)
    })?;
    Ok((id, binding, frame, context))
}
fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut result = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        result.push(DIGITS[(byte >> 4) as usize] as char);
        result.push(DIGITS[(byte & 15) as usize] as char);
    }
    result
}
fn unhex(value: &str) -> Result<Vec<u8>, String> {
    if value.is_empty()
        || !value.len().is_multiple_of(2)
        || value.len() / 2 > rpc_authority::MAX_PACKET_BYTES
    {
        return Err("Invalid RPC packet encoding".into());
    }
    fn nibble(value: u8) -> Option<u8> {
        match value {
            b'0'..=b'9' => Some(value - b'0'),
            b'a'..=b'f' => Some(value - b'a' + 10),
            _ => None,
        }
    }
    value
        .as_bytes()
        .chunks_exact(2)
        .map(|pair| {
            Ok(nibble(pair[0]).ok_or("Invalid RPC packet encoding")? << 4
                | nibble(pair[1]).ok_or("Invalid RPC packet encoding")?)
        })
        .collect::<Result<Vec<_>, &str>>()
        .map_err(str::to_owned)
}
fn renderer_message(
    id: u64,
    browser: Option<&mut Browser>,
    frame: Option<&mut Frame>,
    source: ProcessId,
    message: Option<&mut ProcessMessage>,
) -> i32 {
    if source != ProcessId::RENDERER {
        return 0;
    }
    let (Some(browser), Some(frame), Some(message)) = (browser, frame, message) else {
        return 1;
    };
    let name = CefString::from(&message.name()).to_string();
    if (RPC_STOPPED.load(Ordering::SeqCst) || QUITTING.load(Ordering::SeqCst))
        && ![wire::RELEASE, wire::DELIVERED, wire::DISCARDED].contains(&name.as_str())
    {
        return 1;
    }
    #[cfg(feature = "rpc-qualification")]
    if name == "bunly.rpc.qualification" {
        if let Some((identity, sequence)) = wire::read(message, false) {
            let context = observed(browser, frame);
            let valid = STATE.with(|s| {
                s.borrow()
                    .views
                    .get(&id)
                    .is_some_and(|r| r.rpc.authorize(&context, identity).is_ok())
            });
            let case = match sequence {
                1 => Some("stale-grant"),
                2 => Some("stale-ack"),
                3 => Some("stale-revoke"),
                4 => Some("stale-result"),
                _ => None,
            };
            if valid {
                if let Some(case) = case {
                    event("rpc.qualification", id, json!({"case":case}));
                }
            }
        }
        return 1;
    }
    if ![
        wire::READY,
        wire::SUBSCRIBED,
        wire::RELEASE,
        wire::PACKET,
        wire::DELIVERED,
        wire::DISCARDED,
    ]
    .contains(&name.as_str())
    {
        return 0;
    }
    let context = observed(browser, frame);
    let Some((identity, sequence)) = wire::read(message, name == wire::PACKET) else {
        #[cfg(feature = "rpc-qualification")]
        {
            let binding = STATE.with(|s| s.borrow().views.get(&id).and_then(|r| r.rpc.binding()));
            if let (Some(binding), Some(args)) = (binding, message.argument_list()) {
                if context.main
                    && binding.browser == context.browser
                    && binding.frame == context.frame
                    && args.double(0) == binding.context as f64
                    && args.double(1) == binding.connection as f64
                    && args.double(2) == binding.generation as f64
                {
                    event("rpc.qualification", id, json!({"case":"invalid-number"}));
                }
            }
        }
        return 1;
    };
    if name == wire::READY {
        if sequence != 0 || identity.connection != 0 || identity.generation != 0 {
            return 1;
        }
        let owned_browser = STATE.with(|s| {
            s.borrow()
                .views
                .get(&id)
                .and_then(|record| record.browser.clone())
        });
        if owned_browser.is_none_or(|owned| owned.identifier() != context.browser) {
            return 1;
        }
        // Replay an actual old grant after the replacement's OnContextCreated,
        // not merely a made-up serial while an already-bound context is active.
        // The return-to-origin fixture must still observe no usable bridge.
        #[cfg(feature = "rpc-qualification")]
        if context.main {
            if let Some(previous) = STATE
                .with(|s| s.borrow().views.get(&id).and_then(|view| view.previous_rpc))
                .filter(|previous| previous.context != identity.context)
            {
                crate::rpc_qualification::replay_browser_messages(frame, previous);
            }
        }
        #[cfg(feature = "rpc-qualification")]
        if STATE.with(|s| {
            s.borrow()
                .views
                .get(&id)
                .and_then(|r| r.rpc.binding())
                .is_some_and(|b| {
                    b.context == identity.context && b.frame == context.frame && context.main
                })
        }) {
            event("rpc.qualification", id, json!({"case":"duplicate-ready"}));
        }
        let Ok(connection) = next_id() else {
            fail("Native identity exhausted");
            return 1;
        };
        let (old, binding) = STATE.with(|s| {
            let mut state = s.borrow_mut();
            let allowed = !QUITTING.load(Ordering::SeqCst)
                && context.main
                && state.views.get(&id).is_some_and(|record| {
                    record.close.is_none()
                        && state
                            .windows
                            .get(&record.window)
                            .is_some_and(|window| window.closing.is_none())
                });
            if !allowed {
                return (None, None);
            }
            let record = state.views.get_mut(&id).unwrap();
            if let Some(binding) = record.rpc.binding() {
                if binding.browser == context.browser
                    && binding.frame == context.frame
                    && identity.context > binding.context
                {
                    return (record.rpc.revoke(), None);
                }
                return (None, None);
            }
            (
                None,
                record.rpc.bind(connection, &context, identity.context),
            )
        });
        revoke_renderer(id, old);
        if let Some(binding) = binding {
            if let Some(mut grant) = wire::message(wire::GRANT, binding.identity(), 0, None) {
                frame.send_process_message(ProcessId::RENDERER, Some(&mut grant));
            }
        }
        return 1;
    }
    if name == wire::RELEASE && sequence == 0 {
        let old = STATE.with(|s| {
            s.borrow_mut()
                .views
                .get_mut(&id)
                .and_then(|record| record.rpc.release(&context, identity))
        });
        revoke_renderer(id, old);
        return 1;
    }
    if [wire::DELIVERED, wire::DISCARDED].contains(&name.as_str()) && sequence > 0 {
        let completed = STATE.with(|s| {
            let mut state = s.borrow_mut();
            let delivery = state
                .rpc_deliveries
                .complete(&context, identity, sequence)?;
            if let Some(record) = state.views.get_mut(&id) {
                let _ = record.rpc.finish_delivery(identity, sequence);
            }
            Some(delivery)
        });
        if let Some(delivery) = completed {
            if let Some(request) = delivery.request {
                let live = STATE.with(|s| {
                    s.borrow()
                        .views
                        .get(&id)
                        .is_some_and(|r| r.rpc.authorize(&context, identity).is_ok())
                });
                if name == wire::DELIVERED && live {
                    reply(request, Value::Null);
                } else {
                    error(request, "RPC delivery discarded");
                }
            }
        }
        return 1;
    }
    if name == wire::SUBSCRIBED && sequence == 0 {
        let binding = STATE.with(|s| {
            s.borrow_mut()
                .views
                .get_mut(&id)?
                .rpc
                .subscribe(&context, identity)
                .ok()
        });
        if let Some(binding) = binding {
            event(
                "rpc.connected",
                id,
                json!({"connection":binding.connection,"context":binding.context,"frameId":binding.frame,"documentId":binding.document,"generation":binding.generation,"origin":rpc_authority::exact_origin(&context.url)}),
            );
            #[cfg(feature = "rpc-qualification")]
            crate::rpc_qualification::stale_browser_messages(frame, identity);
        } else {
            #[cfg(feature = "rpc-qualification")]
            if STATE.with(|s| {
                s.borrow()
                    .views
                    .get(&id)
                    .is_some_and(|r| r.rpc.authorize(&context, identity).is_ok())
            }) {
                event(
                    "rpc.qualification",
                    id,
                    json!({"case":"duplicate-subscription"}),
                );
            }
        }
        return 1;
    }
    if name == wire::PACKET && sequence > 0 {
        let Some(bytes) = wire::binary(message) else {
            return 1;
        };
        let accepted = STATE.with(|s| {
            let mut state = s.borrow_mut();
            let retained: usize = state.views.values().map(|r| r.rpc.incoming_bytes()).sum();
            if retained + bytes.len() > rpc_authority::MAX_GLOBAL_BYTES {
                return false;
            }
            state.views.get_mut(&id).is_some_and(|r| {
                r.rpc
                    .authenticate(&context, identity, sequence, bytes.len())
                    .is_ok()
            })
        });
        if accepted {
            event(
                "rpc.packet",
                id,
                json!({"connection":identity.connection,"context":identity.context,"generation":identity.generation,"sequence":sequence,"packet":hex(&bytes),"copiedBytes":bytes.len()}),
            );
        } else {
            #[cfg(feature = "rpc-qualification")]
            if let Some(binding) =
                STATE.with(|s| s.borrow().views.get(&id).and_then(|r| r.rpc.binding()))
            {
                let case = if !context.main || context.frame != binding.frame {
                    "wrong-frame"
                } else if identity.context != binding.context {
                    "wrong-context"
                } else if identity.connection != binding.connection {
                    "wrong-connection"
                } else if identity.generation != binding.generation {
                    "stale-generation"
                } else {
                    "queue-or-sequence"
                };
                event("rpc.qualification", id, json!({"case":case}));
            }
        }
    }
    1
}
pub fn fail(message: &str) {
    FAILED.store(true, Ordering::SeqCst);
    eprintln!("{}", json!({"event":"bunly.host.failure","error":message}));
    request_quit();
}
pub fn enqueue(value: Value) {
    if PENDING.fetch_add(1, Ordering::SeqCst) >= 256 {
        PENDING.fetch_sub(1, Ordering::SeqCst);
        fail("Command queue capacity exceeded");
        return;
    }
    let mut task = CommandTask::new(value);
    if post_task(ThreadId::UI, Some(&mut task)) == 0 {
        PENDING.fetch_sub(1, Ordering::SeqCst);
        fail("CEF command dispatch unavailable");
    }
}
pub fn request_quit() {
    RPC_STOPPED.store(true, Ordering::SeqCst);
    let mut task = QuitTask::new();
    post_task(ThreadId::UI, Some(&mut task));
}
static SHUTDOWN_WAIT: std::sync::OnceLock<(std::sync::Mutex<bool>, std::sync::Condvar)> =
    std::sync::OnceLock::new();
static SHUTDOWN_THREAD: std::sync::OnceLock<std::sync::Mutex<Option<std::thread::JoinHandle<()>>>> =
    std::sync::OnceLock::new();
fn shutdown_acknowledged() {
    if let Some((lock, wake)) = SHUTDOWN_WAIT.get() {
        *lock.lock().unwrap() = true;
        wake.notify_all();
    }
}
fn bound_shutdown() {
    if !SHUTDOWN_DEADLINE.swap(true, Ordering::SeqCst) {
        let (lock, wake) =
            SHUTDOWN_WAIT.get_or_init(|| (std::sync::Mutex::new(false), std::sync::Condvar::new()));
        // Never leave a delayed CEF task queued into CefShutdown: its pending-task
        // drain may wait for that task and collide with Chromium's own watchdog.
        let worker = std::thread::spawn(move || {
            let (done, timeout) = wake
                .wait_timeout_while(
                    lock.lock().unwrap(),
                    crate::deadlines::current().shutdown(),
                    |done| !*done,
                )
                .unwrap();
            if !*done && timeout.timed_out() {
                drop(done);
                let mut deadline = ShutdownDeadline::new();
                post_task(ThreadId::UI, Some(&mut deadline));
            }
        });
        *SHUTDOWN_THREAD
            .get_or_init(|| std::sync::Mutex::new(None))
            .lock()
            .unwrap() = Some(worker);
    }
}
wrap_task! { struct ShutdownDeadline; impl Task { fn execute(&self) {
    if SHUTDOWN_WAIT.get().is_some_and(|(lock, _)| *lock.lock().unwrap()) { return; }
    FAILED.store(true, Ordering::SeqCst);
    eprintln!("{}", json!({"event":"bunly.host.failure","error":"Native shutdown acknowledgement deadline exceeded"}));
    shutdown_acknowledged(); quit_message_loop();
} } }
fn quit_on_ui() {
    RPC_STOPPED.store(true, Ordering::SeqCst);
    if QUITTING.swap(true, Ordering::SeqCst) {
        return;
    }
    bound_shutdown();
    let (windows, browsers, revocations) = STATE.with(|s| {
        let mut s = s.borrow_mut();
        let revocations = s
            .views
            .iter_mut()
            .map(|(id, record)| (*id, record.rpc.revoke()))
            .collect::<Vec<_>>();
        (
            s.windows
                .values()
                .filter_map(|r| r.window.clone())
                .collect::<Vec<_>>(),
            s.views
                .values()
                .filter_map(|r| r.browser.clone())
                .collect::<Vec<_>>(),
            revocations,
        )
    });
    for (id, revoked) in revocations {
        revoke_renderer(id, revoked);
    }
    for browser in browsers {
        if let Some(host) = browser.host() {
            host.close_browser(1);
        }
    }
    for window in windows {
        window.close();
    }
    if STATE.with(|s| s.borrow().windows.is_empty() && s.borrow().views.is_empty()) {
        finish_on_ui();
    }
}
fn finish_on_ui() {
    bound_shutdown();
    if FINALIZING.swap(true, Ordering::SeqCst) {
        return;
    }
    QUITTING.store(true, Ordering::SeqCst);
    // Release request contexts while the UI loop can still run CEF destruction tasks.
    // Enter the final task only after native close callbacks have unwound.
    let mut task = FinalizeTask::new();
    post_task(ThreadId::UI, Some(&mut task));
}
wrap_task! {
    struct FinalizeTask;
    impl Task {
        fn execute(&self) { finalize_sessions(); }
    }
}
fn finalize_sessions() {
    let sessions = STATE.with(|state| {
        let mut state = state.borrow_mut();
        if state.sessions.values().any(|record| record.busy) {
            return None;
        }
        Some(
            state
                .sessions
                .iter_mut()
                .filter_map(|(id, record)| {
                    if record.disposing.is_some() {
                        None
                    } else {
                        record.disposing = Some(0);
                        Some((*id, record.context.clone()))
                    }
                })
                .collect::<Vec<_>>(),
        )
    });
    let Some(sessions) = sessions else {
        return;
    };
    if sessions.is_empty() {
        if STATE.with(|state| state.borrow().sessions.is_empty()) {
            let mut done = FinishLoopTask::new();
            post_task(ThreadId::UI, Some(&mut done));
        }
        return;
    }
    for (id, context) in sessions {
        begin_dispose_flush(id, context);
    }
}
fn operation_finished(id: u64) {
    STATE.with(|state| {
        if let Some(record) = state.borrow_mut().sessions.get_mut(&id) {
            record.busy = false;
        }
    });
    if FINALIZING.load(Ordering::SeqCst) {
        finalize_sessions();
    }
}
pub(crate) fn session_initialized(id: u64, context: RequestContext) {
    // Even a synchronous CEF initialization callback is completed on a later UI
    // task, after CreateContext has returned and installed the native record.
    let mut task = SessionReadyTask::new(id, context);
    if post_task(ThreadId::UI, Some(&mut task)) == 0 {
        fail("Session initialization completion could not be scheduled");
    }
}
fn finish_session_initialization(id: u64, context: &RequestContext) {
    let candidate = STATE.with(|state| {
        state
            .borrow()
            .sessions
            .get(&id)
            .filter(|record| record.creating.is_some())
            .map(|record| record.context.clone())
    });
    let Some(mut candidate) = candidate else {
        return;
    };
    if context.is_same(Some(&mut candidate)) == 0 {
        fail("Session initialization identity mismatch");
        return;
    }
    scheme::attach(context);
    let request = STATE.with(|state| {
        state.borrow_mut().sessions.get_mut(&id).and_then(|record| {
            record.busy = false;
            record.creating.take()
        })
    });
    if let Some(request) = request {
        if QUITTING.load(Ordering::SeqCst) {
            error(request, "Host stopped during session initialization");
        } else {
            reply(request, json!({"id":id}));
        }
    }
    if FINALIZING.load(Ordering::SeqCst) {
        finalize_sessions();
    }
}
wrap_task! {
    struct SessionReadyTask { id: u64, context: RequestContext }
    impl Task { fn execute(&self) { finish_session_initialization(self.id, &self.context); } }
}

fn begin_dispose_flush(id: u64, context: RequestContext) {
    let Some(manager) = context.cookie_manager(None) else {
        dispose_failed(id, "Cookie store unavailable during session disposal");
        return;
    };
    let mut callback = SessionFlushedForDispose::new(id, context);
    if manager.flush_store(Some(&mut callback)) == 0 {
        dispose_failed(id, "Cookie store flush could not be scheduled");
    }
}
fn dispose_failed(id: u64, message: &str) {
    let request = STATE.with(|state| {
        state
            .borrow_mut()
            .sessions
            .get_mut(&id)
            .and_then(|record| record.disposing.take())
    });
    if let Some(request) = request.filter(|request| *request != 0) {
        error(request, message);
    } else {
        fail(message);
    }
}
wrap_completion_callback! {
    struct SessionFlushedForDispose { id: u64, context: RequestContext }
    impl CompletionCallback { fn on_complete(&self) {
        self.context.clear_scheme_handler_factories();
        let mut closed = ContextClosed::new(self.id);
        // Keep the context and profile lock in STATE until asynchronous CEF cleanup.
        self.context.close_all_connections(Some(&mut closed));
    } }
}
wrap_completion_callback! {
    struct ContextClosed { id: u64 }
    impl CompletionCallback { fn on_complete(&self) {
        let record = STATE.with(|s| s.borrow_mut().sessions.remove(&self.id));
        if let Some(mut record) = record {
            if let Some(request) = record.disposing.filter(|request| *request != 0) {
                reply(request, Value::Null);
            }
            drop(record.context);
            if let Some(profile) = record.profile.take() {
                session::retire(profile);
            }
        }
        if FINALIZING.load(Ordering::SeqCst) && STATE.with(|s| s.borrow().sessions.is_empty()) {
            let mut done = FinishLoopTask::new(); post_task(ThreadId::UI, Some(&mut done));
        }
    } }
}
// Request-context destruction may enqueue work on CEF's IO sequence. Cross
// that queue and return to UI before ending the loop, instead of entering
// CefShutdown's task-drain from inside an outstanding close callback.
wrap_task! { struct FinishLoopTask; impl Task { fn execute(&self) {
    let mut fence = ShutdownIoFence::new();
    if post_task(ThreadId::IO, Some(&mut fence)) == 0 { FAILED.store(true, Ordering::SeqCst); shutdown_acknowledged(); quit_message_loop(); }
} } }
wrap_task! { struct ShutdownIoFence; impl Task { fn execute(&self) {
    let mut fence = ShutdownUiFence::new();
    if post_task(ThreadId::UI, Some(&mut fence)) == 0 { FAILED.store(true, Ordering::SeqCst); }
} } }
wrap_task! { struct ShutdownUiFence; impl Task { fn execute(&self) {
    shutdown_acknowledged(); quit_message_loop();
} } }
pub fn release() {
    shutdown_acknowledged();
    if let Some(slot) = SHUTDOWN_THREAD.get() {
        if let Some(worker) = slot.lock().unwrap().take() {
            if worker.join().is_err() {
                FAILED.store(true, Ordering::SeqCst);
            }
        }
    }
    let retired = STATE.with(|s| std::mem::take(&mut *s.borrow_mut()));
    if !retired.windows.is_empty() || !retired.views.is_empty() || !retired.sessions.is_empty() {
        FAILED.store(true, Ordering::SeqCst);
    }
    // Drop CEF references outside the registry borrow during final teardown.
    drop(retired);
}
fn cancel_navigation(id: u64, message: &str) {
    let requests = STATE.with(|s| {
        s.borrow_mut()
            .views
            .get_mut(&id)
            .map(|r| r.navigate.cancel())
            .unwrap_or_default()
    });
    for request in requests {
        error(request, message);
    }
}
fn issue_navigation(id: u64, request: navigation::Request) {
    // Clone the native handle before entering CEF. Never retain a RefCell borrow
    // across native calls, which may synchronously call back into this host.
    let browser = STATE.with(|s| {
        s.borrow()
            .views
            .get(&id)
            .filter(|r| r.close.is_none())
            .and_then(|r| r.browser.clone())
    });
    let Some(browser) = browser else {
        cancel_navigation(id, "Browser unavailable during navigation");
        return;
    };
    let Some(frame) = browser.main_frame() else {
        cancel_navigation(id, "Missing main frame");
        return;
    };
    let current = CefString::from(&frame.url()).to_string();
    if current == request.url {
        browser.reload();
    } else {
        // Fragment-only loads do not have document-load callbacks in CEF. They
        // require their own completion contract; do not leave a pending promise.
        if let (Ok(mut old), Ok(mut new)) =
            (url::Url::parse(&current), url::Url::parse(&request.url))
        {
            old.set_fragment(None);
            new.set_fragment(None);
            if old == new {
                cancel_navigation(id, "UNSUPPORTED_CAPABILITY: same-document navigation");
                return;
            }
        }
        frame.load_url(Some(&CefString::from(request.url.as_str())));
    }
}
wrap_task! {
    struct CommandTask { value: Value }
    impl Task {
        fn execute(&self) {
            PENDING.fetch_sub(1, Ordering::SeqCst);
            let id = self.value.get("id").and_then(Value::as_u64).unwrap_or(0);
            if let Err(e) = dispatch(&self.value) { error(id, &e); }
        }
    }
}
wrap_task! { struct QuitTask; impl Task { fn execute(&self) { quit_on_ui(); } } }
wrap_app! {
    pub struct BunlyApp;
    impl App {
        fn on_register_custom_schemes(&self, registrar: Option<&mut SchemeRegistrar>) { scheme::register(registrar); }
        fn browser_process_handler(&self) -> Option<BrowserProcessHandler> { Some(BunlyProcess::new()) }
        fn render_process_handler(&self) -> Option<RenderProcessHandler> { Some(crate::renderer_rpc::handler()) }
    }
}
wrap_browser_process_handler! {
    struct BunlyProcess;
    impl BrowserProcessHandler {
        fn on_context_initialized(&self) { if currently_on(ThreadId::UI) == 0 { fail("CEF initialized on incorrect thread"); return; }
            if let Err(e) = process::start() { fail(&e); } }
        fn on_already_running_app_relaunch(&self, _command_line: Option<&mut CommandLine>, _current_directory: Option<&CefString>) -> i32 {
            eprintln!("{}", json!({"event":"bunly.profile-root-collision","handled":true}));
            1
        }
    }
}
fn checked_url(text: &str) -> Result<String, String> {
    policy::navigation(
        text,
        crate::PATHS.get().and_then(|p| p.dev_origin.as_deref()),
    )
}
fn checked_cookie_url(text: &str) -> Result<String, String> {
    let url = url::Url::parse(text).map_err(|_| "Invalid cookie URL")?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.host_str().is_none()
    {
        return Err("Cookie URL must be credential-free HTTP(S)".into());
    }
    Ok(url.into())
}
fn live_view(id: u64) -> bool {
    STATE.with(|s| s.borrow().views.get(&id).is_some_and(|r| r.close.is_none()))
}
fn begin_session_operation(id: u64, require_cookies: bool) -> Result<RequestContext, String> {
    STATE.with(|state| {
        let mut state = state.borrow_mut();
        let record = state
            .sessions
            .get_mut(&id)
            .ok_or("INVALID_HANDLE: session")?;
        if record.disposing.is_some() || record.busy {
            return Err("RESOURCE_IN_USE: session operation".into());
        }
        if require_cookies && !record.cookies_supported {
            return Err("UNSUPPORTED_CAPABILITY: persistent cookies require a qualified app-specific credential identity".into());
        }
        record.busy = true;
        Ok(record.context.clone())
    })
}
fn operation_schedule_failed(id: u64, message: &str) -> String {
    operation_finished(id);
    message.into()
}
fn optional_string<'a>(
    value: &'a Value,
    key: &str,
    maximum: usize,
) -> Result<Option<&'a str>, String> {
    match value.get(key) {
        None => Ok(None),
        Some(Value::String(text))
            if !text.is_empty() && text.len() <= maximum && !text.contains('\0') =>
        {
            Ok(Some(text))
        }
        _ => Err(format!("Invalid {key}")),
    }
}
fn boolean(value: &Value, key: &str) -> Result<bool, String> {
    value
        .get(key)
        .and_then(Value::as_bool)
        .ok_or_else(|| format!("Invalid {key}"))
}
const WINDOWS_EPOCH_MICROS: i64 = 11_644_473_600_000_000;
fn unix_millis_to_basetime(value: i64) -> Result<Basetime, String> {
    let micros = value
        .checked_mul(1000)
        .and_then(|value| value.checked_add(WINDOWS_EPOCH_MICROS))
        .ok_or("Cookie expiry is out of range")?;
    Ok(Basetime { val: micros })
}
fn basetime_to_unix_millis(value: i64) -> Option<i64> {
    value
        .checked_sub(WINDOWS_EPOCH_MICROS)
        .map(|value| value / 1000)
}
fn same_site_name(value: CookieSameSite) -> Result<&'static str, String> {
    match value.get_raw() {
        0 => Ok("unspecified"),
        1 => Ok("none"),
        2 => Ok("lax"),
        3 => Ok("strict"),
        _ => Err("CEF returned an unknown cookie sameSite value".into()),
    }
}
fn same_site_value(value: &str) -> Result<CookieSameSite, String> {
    match value {
        "unspecified" => Ok(CookieSameSite::UNSPECIFIED),
        "none" => Ok(CookieSameSite::NO_RESTRICTION),
        "lax" => Ok(CookieSameSite::LAX_MODE),
        "strict" => Ok(CookieSameSite::STRICT_MODE),
        _ => Err("Invalid cookie sameSite".into()),
    }
}
#[derive(Default)]
struct CookieReadState {
    values: Vec<Value>,
    encoded_bytes: usize,
    error: Option<String>,
}
wrap_cookie_visitor! {
    struct ReadCookies { state: Rc<RefCell<CookieReadState>> }
    impl CookieVisitor { fn visit(&self, cookie: Option<&Cookie>, count: i32, total: i32, _delete: Option<&mut i32>) -> i32 {
        let Some(cookie) = cookie else { self.state.borrow_mut().error = Some("CEF returned a missing cookie".into()); return 0; };
        if count < 0 || total < 1 || count >= total || total > 128 {
            self.state.borrow_mut().error = Some("Cookie result exceeds the bounded 128-cookie limit".into());
            return 0;
        }
        let name = cookie.name.to_string();
        let value = cookie.value.to_string();
        let domain = cookie.domain.to_string();
        let path = cookie.path.to_string();
        if name.is_empty() || name.len() > 256 || value.len() > 4096 || domain.len() > 255 || path.len() > 1024 {
            self.state.borrow_mut().error = Some("CEF returned an invalid or excessive cookie".into());
            return 0;
        }
        let same_site = match same_site_name(cookie.same_site) {
            Ok(value) => value,
            Err(error) => { self.state.borrow_mut().error = Some(error); return 0; }
        };
        let mut result = json!({
            "name":name,
            "value":value,
            "domain":domain,
            "path":path,
            "secure":cookie.secure != 0,
            "httpOnly":cookie.httponly != 0,
            "sameSite":same_site,
        });
        if cookie.has_expires != 0 {
            let Some(expires) = basetime_to_unix_millis(cookie.expires.val) else {
                self.state.borrow_mut().error = Some("CEF returned an invalid cookie expiry".into());
                return 0;
            };
            result["expires"] = json!(expires);
        }
        let encoded = serde_json::to_vec(&result).map_or(usize::MAX, |bytes| bytes.len());
        let mut state = self.state.borrow_mut();
        state.encoded_bytes = state.encoded_bytes.saturating_add(encoded);
        if state.encoded_bytes > 48 * 1024 {
            state.error = Some("Cookie result exceeds the bounded 48 KiB response limit".into());
            return 0;
        }
        state.values.push(result);
        1
    } }
}
wrap_completion_callback! {
    struct CookiesRead { id: u64, request: u64, state: Rc<RefCell<CookieReadState>> }
    impl CompletionCallback { fn on_complete(&self) {
        operation_finished(self.id);
        let mut state = self.state.borrow_mut();
        if let Some(message) = state.error.take() { error(self.request, &message); }
        else { reply(self.request, Value::Array(std::mem::take(&mut state.values))); }
    } }
}
wrap_set_cookie_callback! {
    struct CookieSet { id: u64, request: u64 }
    impl SetCookieCallback { fn on_complete(&self, success: i32) {
        operation_finished(self.id);
        if success != 0 { reply(self.request, Value::Null); }
        else { error(self.request, "CEF rejected the cookie attributes"); }
    } }
}
wrap_delete_cookies_callback! {
    struct CookiesDeleted { id: u64, request: u64 }
    impl DeleteCookiesCallback { fn on_complete(&self, deleted: i32) {
        operation_finished(self.id);
        if deleted >= 0 { reply(self.request, json!(deleted)); }
        else { error(self.request, "CEF cookie deletion failed"); }
    } }
}
wrap_completion_callback! {
    struct SessionFlushed { id: u64, request: u64 }
    impl CompletionCallback { fn on_complete(&self) {
        operation_finished(self.id);
        reply(self.request, Value::Null);
    } }
}
wrap_completion_callback! {
    struct CacheCleared { id: u64, request: u64, cookies_deleted: i32 }
    impl CompletionCallback { fn on_complete(&self) {
        operation_finished(self.id);
        reply(self.request, json!({"cookiesDeleted":self.cookies_deleted,"cacheCleared":true,"storageCleared":false}));
    } }
}
wrap_delete_cookies_callback! {
    struct CookiesCleared { id: u64, request: u64, context: RequestContext, clear_cache: bool }
    impl DeleteCookiesCallback { fn on_complete(&self, deleted: i32) {
        if deleted < 0 {
            operation_finished(self.id);
            error(self.request, "CEF cookie clearing failed");
        } else if self.clear_cache {
            let mut callback = CacheCleared::new(self.id, self.request, deleted);
            self.context.clear_http_cache(Some(&mut callback));
        } else {
            operation_finished(self.id);
            reply(self.request, json!({"cookiesDeleted":deleted,"cacheCleared":false,"storageCleared":false}));
        }
    } }
}
fn dispatch(command: &Value) -> Result<(), String> {
    if currently_on(ThreadId::UI) == 0 {
        return Err("Wrong native thread".into());
    }
    let request = number(command, "id")?;
    let operation = string(command, "op")?;
    let args = command.get("args").unwrap_or(&Value::Null);
    if QUITTING.load(Ordering::SeqCst) && operation != "quit" {
        return Err("Host is shutting down".into());
    }
    match operation {
        "session.create" => {
            let persistence = string(args, "persistence")?;
            let partition = string(args, "partition")?.to_owned();
            if !matches!(persistence, "ephemeral" | "persistent") {
                return Err("Invalid session persistence".into());
            }
            if partition.is_empty()
                || partition.len() > 64
                || !partition.bytes().enumerate().all(|(index, byte)| {
                    byte.is_ascii_alphanumeric() || (index > 0 && b"._-".contains(&byte))
                })
            {
                return Err("Invalid session partition".into());
            }
            if STATE.with(|s| s.borrow().sessions.len() >= 128) {
                return Err("Session capacity exceeded".into());
            }
            if STATE.with(|state| {
                state
                    .borrow()
                    .sessions
                    .values()
                    .any(|record| record.partition == partition)
            }) {
                return Err("Session partition already has a native owner".into());
            }
            let persistent = persistence == "persistent";
            if !persistent && args.get("persistentRoot").is_some() {
                return Err("Ephemeral sessions cannot specify a persistent root".into());
            }
            let profile = if persistent {
                let requested_root = string(args, "persistentRoot")?;
                let root = crate::PATHS
                    .get()
                    .and_then(|paths| paths.profile_root.as_ref())
                    .ok_or("Persistent sessions require BUNLY_PROFILE_ROOT at native startup")?;
                Some(root.acquire(requested_root, &partition)?)
            } else {
                None
            };
            let mut settings = RequestContextSettings::default();
            if let Some(profile) = profile.as_ref() {
                settings.cache_path = CefString::from(profile.path.to_string_lossy().as_ref());
                settings.persist_session_cookies = 0;
                // No platform credential provider is qualified for Bunly yet.
                // CEF 154 also lacks app-specific macOS Keychain settings.
                // Persist storage, but never silently persist credentials using
                // a shared identity, plaintext fallback, or unqualified provider.
                settings.cookieable_schemes_exclude_defaults = 1;
            }
            let id = next_id()?;
            let mut handler = scheme::context_handler(id);
            let context = request_context_create_context(Some(&settings), Some(&mut handler))
                .ok_or("Session creation failed")?;
            STATE.with(|s| {
                s.borrow_mut().sessions.insert(
                    id,
                    SessionRecord {
                        context,
                        profile,
                        partition,
                        persistent,
                        cookies_supported: !persistent,
                        creating: Some(request),
                        busy: true,
                        disposing: None,
                    },
                );
            });
            // Reply from the initialized callback, not before disk-backed
            // profile initialization is complete in Chromium.
        }
        "session.dispose" => {
            let id = number(args, "id")?;
            if STATE.with(|s| s.borrow().views.values().any(|v| v.session == id)) {
                return Err("RESOURCE_IN_USE: session".into());
            }
            let context = STATE.with(|state| {
                let mut state = state.borrow_mut();
                let record = state
                    .sessions
                    .get_mut(&id)
                    .ok_or("INVALID_HANDLE: session")?;
                if record.disposing.is_some() || record.busy {
                    return Err("RESOURCE_IN_USE: session operation".into());
                }
                record.disposing = Some(request);
                Ok::<RequestContext, String>(record.context.clone())
            })?;
            begin_dispose_flush(id, context);
        }
        "session.cookies" => {
            let id = number(args, "id")?;
            let url = optional_string(args, "url", 4096)?
                .map(checked_cookie_url)
                .transpose()?;
            let context = begin_session_operation(id, true)?;
            let manager = context
                .cookie_manager(None)
                .ok_or_else(|| operation_schedule_failed(id, "Cookie manager unavailable"))?;
            let state = Rc::new(RefCell::new(CookieReadState::default()));
            let mut visitor = ReadCookies::new(state.clone());
            let started = match url.as_ref() {
                Some(url) => manager.visit_url_cookies(
                    Some(&CefString::from(url.as_str())),
                    1,
                    Some(&mut visitor),
                ),
                None => manager.visit_all_cookies(Some(&mut visitor)),
            };
            if started == 0 {
                return Err(operation_schedule_failed(
                    id,
                    "Cookie enumeration could not be scheduled",
                ));
            }
            // The visitor is never invoked for an empty store. Flush is queued
            // behind enumeration on CEF's cookie sequence and supplies completion.
            let mut completed = CookiesRead::new(id, request, state);
            if manager.flush_store(Some(&mut completed)) == 0 {
                return Err(operation_schedule_failed(
                    id,
                    "Cookie enumeration completion could not be scheduled",
                ));
            }
        }
        "session.cookie.set" => {
            let id = number(args, "id")?;
            let url = checked_cookie_url(string(args, "url")?)?;
            let input = args
                .get("cookie")
                .filter(|value| value.is_object())
                .ok_or("Invalid cookie")?;
            let mut cookie = Cookie {
                name: CefString::from(string(input, "name")?),
                value: CefString::from(string(input, "value")?),
                domain: CefString::from(optional_string(input, "domain", 255)?.unwrap_or("")),
                path: CefString::from(optional_string(input, "path", 1024)?.unwrap_or("/")),
                secure: i32::from(boolean(input, "secure")?),
                httponly: i32::from(boolean(input, "httpOnly")?),
                same_site: same_site_value(string(input, "sameSite")?)?,
                ..Default::default()
            };
            if cookie.name.to_string().is_empty()
                || cookie.name.to_string().len() > 256
                || cookie.value.to_string().len() > 4096
            {
                return Err("Invalid or excessive cookie".into());
            }
            if let Some(expires) = input.get("expires") {
                let expires = expires
                    .as_i64()
                    .filter(|value| *value > 0)
                    .ok_or("Invalid cookie expiry")?;
                cookie.has_expires = 1;
                cookie.expires = unix_millis_to_basetime(expires)?;
            }
            let context = begin_session_operation(id, true)?;
            let manager = context
                .cookie_manager(None)
                .ok_or_else(|| operation_schedule_failed(id, "Cookie manager unavailable"))?;
            let mut completed = CookieSet::new(id, request);
            if manager.set_cookie(
                Some(&CefString::from(url.as_str())),
                Some(&cookie),
                Some(&mut completed),
            ) == 0
            {
                return Err(operation_schedule_failed(
                    id,
                    "Cookie write could not be scheduled",
                ));
            }
        }
        "session.cookies.delete" => {
            let id = number(args, "id")?;
            let url = optional_string(args, "url", 4096)?
                .map(checked_cookie_url)
                .transpose()?;
            let name = optional_string(args, "name", 256)?;
            let context = begin_session_operation(id, true)?;
            let manager = context
                .cookie_manager(None)
                .ok_or_else(|| operation_schedule_failed(id, "Cookie manager unavailable"))?;
            let url = url.as_deref().map(CefString::from);
            let name = name.map(CefString::from);
            let mut completed = CookiesDeleted::new(id, request);
            if manager.delete_cookies(url.as_ref(), name.as_ref(), Some(&mut completed)) == 0 {
                return Err(operation_schedule_failed(
                    id,
                    "Cookie deletion could not be scheduled",
                ));
            }
        }
        "session.clear" => {
            let id = number(args, "id")?;
            let clear_cookies = boolean(args, "cookies")?;
            let clear_cache = boolean(args, "cache")?;
            if !clear_cookies && !clear_cache {
                return Err("No supported session data kind selected".into());
            }
            let context = begin_session_operation(id, clear_cookies)?;
            if clear_cookies {
                let manager = context
                    .cookie_manager(None)
                    .ok_or_else(|| operation_schedule_failed(id, "Cookie manager unavailable"))?;
                let mut completed = CookiesCleared::new(id, request, context, clear_cache);
                if manager.delete_cookies(None, None, Some(&mut completed)) == 0 {
                    return Err(operation_schedule_failed(
                        id,
                        "Cookie clearing could not be scheduled",
                    ));
                }
            } else {
                let mut completed = CacheCleared::new(id, request, 0);
                context.clear_http_cache(Some(&mut completed));
            }
        }
        "session.flush" => {
            let id = number(args, "id")?;
            let context = begin_session_operation(id, false)?;
            let manager = context
                .cookie_manager(None)
                .ok_or_else(|| operation_schedule_failed(id, "Cookie manager unavailable"))?;
            let mut completed = SessionFlushed::new(id, request);
            if manager.flush_store(Some(&mut completed)) == 0 {
                return Err(operation_schedule_failed(
                    id,
                    "Session flush could not be scheduled",
                ));
            }
        }
        "window.create" => {
            if STATE.with(|s| s.borrow().windows.len() >= 32) {
                return Err("Window capacity exceeded".into());
            }
            let title = string(args, "title")?.to_owned();
            let width = number(args, "width")?;
            let height = number(args, "height")?;
            if width > 32768 || height > 32768 {
                return Err("Invalid window dimensions".into());
            }
            let x = policy::coordinate(args, "x")?;
            let y = policy::coordinate(args, "y")?;
            let id = next_id()?;
            STATE.with(|s| {
                s.borrow_mut().windows.insert(
                    id,
                    WindowRecord {
                        window: None,
                        request,
                        closing: None,
                    },
                );
            });
            let mut delegate = BunlyWindow::new(id, title, x, y, width as i32, height as i32);
            if window_create_top_level(Some(&mut delegate)).is_none() {
                STATE.with(|s| {
                    s.borrow_mut().windows.remove(&id);
                });
                return Err("Window creation failed".into());
            }
        }
        "view.create" => {
            if STATE.with(|s| s.borrow().views.len() >= 128) {
                return Err("View capacity exceeded".into());
            }
            let owner = number(args, "window")?;
            let session = number(args, "session")?;
            let url = checked_url(string(args, "url")?)?;
            let approved_origin = application_origin(args)?;
            if approved_origin
                .as_deref()
                .is_some_and(|origin| rpc_authority::exact_origin(&url).as_deref() != Some(origin))
            {
                return Err("Application origin must match the initial document".into());
            }
            let (window, mut context) = STATE.with(|s| {
                let s = s.borrow();
                let record = s.windows.get(&owner).ok_or("INVALID_HANDLE: window")?;
                if record.closing.is_some() {
                    return Err("Window is closing");
                }
                Ok::<_, &str>((
                    record.window.clone().ok_or("Window not ready")?,
                    s.sessions
                        .get(&session)
                        .filter(|record| record.disposing.is_none())
                        .map(|record| record.context.clone())
                        .ok_or("INVALID_HANDLE: session")?,
                ))
            })?;
            let id = next_id()?;
            STATE.with(|s| {
                s.borrow_mut().views.insert(
                    id,
                    ViewRecord {
                        view: None,
                        browser: None,
                        window: owner,
                        session,
                        create: request,
                        navigate: navigation::Navigation::default(),
                        close: None,
                        rpc: rpc_authority::Authority::new(id, url.clone(), approved_origin),
                        #[cfg(feature = "rpc-qualification")]
                        previous_rpc: None,
                    },
                );
            });
            let mut client = BunlyClient::new(id);
            let mut delegate = BunlyView::new(RuntimeStyle::ALLOY);
            let settings = BrowserSettings {
                javascript_close_windows: cef::State::DISABLED,
                ..Default::default()
            };
            let Some(view) = browser_view_create(
                Some(&mut client),
                Some(&CefString::from(url.as_str())),
                Some(&settings),
                None,
                Some(&mut context),
                Some(&mut delegate),
            ) else {
                STATE.with(|s| {
                    s.borrow_mut().views.remove(&id);
                });
                return Err("Browser view creation failed".into());
            };
            STATE.with(|s| {
                if let Some(r) = s.borrow_mut().views.get_mut(&id) {
                    r.view = Some(view.clone());
                }
            });
            let mut native = View::from(&view);
            window.add_child_view(Some(&mut native));
            if let Some(layout) = window.set_to_box_layout(Some(&BoxLayoutSettings {
                horizontal: 0,
                ..Default::default()
            })) {
                let views = STATE.with(|s| {
                    s.borrow()
                        .views
                        .values()
                        .filter(|v| v.window == owner)
                        .filter_map(|v| v.view.clone())
                        .collect::<Vec<_>>()
                });
                for child in views {
                    let mut native = View::from(&child);
                    layout.set_flex_for_view(Some(&mut native), 1);
                }
            }
            window.layout();
            native.request_focus();
        }
        "view.navigate" => {
            let id = number(args, "id")?;
            let url = checked_url(string(args, "url")?)?;
            let (start, revoked) = STATE.with(|s| {
                let mut s = s.borrow_mut();
                let r = s.views.get_mut(&id).ok_or("INVALID_HANDLE: view")?;
                if r.close.is_some() {
                    return Err("View is closing");
                }
                if r.browser.is_none() {
                    return Err("Browser not ready");
                }
                let revoked = r.rpc.explicit_navigation_start();
                Ok::<_, &'static str>((r.navigate.request(request, url)?, revoked))
            })?;
            revoke_renderer(id, revoked);
            if let Some(request) = start {
                issue_navigation(id, request);
            }
        }
        "view.dispose" => {
            let id = number(args, "id")?;
            let (browser, revoked) = STATE.with(|s| {
                let mut s = s.borrow_mut();
                let r = s.views.get_mut(&id).ok_or("INVALID_HANDLE: view")?;
                if r.close.is_some() {
                    return Err("Close already pending");
                }
                let browser = r.browser.clone().ok_or("Browser not ready")?;
                r.close = Some(request);
                Ok::<_, &str>((browser, r.rpc.revoke()))
            })?;
            revoke_renderer(id, revoked);
            browser
                .host()
                .ok_or("Browser host unavailable")?
                .close_browser(1);
        }
        "window.close" | "window.show" | "window.hide" | "window.resize" => {
            let id = number(args, "id")?;
            let window = STATE
                .with(|s| s.borrow().windows.get(&id).and_then(|r| r.window.clone()))
                .ok_or("INVALID_HANDLE: window")?;
            match operation {
                "window.close" => {
                    let revocations = STATE.with(|s| {
                        let mut s = s.borrow_mut();
                        let r = s.windows.get_mut(&id).ok_or("INVALID_HANDLE: window")?;
                        if r.closing.is_some() {
                            return Err("Window is closing");
                        }
                        r.closing = Some(request);
                        Ok::<_, &str>(
                            s.views
                                .iter_mut()
                                .filter(|(_, view)| view.window == id)
                                .map(|(view_id, view)| (*view_id, view.rpc.revoke()))
                                .collect::<Vec<_>>(),
                        )
                    })?;
                    for (view_id, revoked) in revocations {
                        revoke_renderer(view_id, revoked);
                    }
                    window.close();
                }
                "window.show" => {
                    window.show();
                    reply(request, Value::Null);
                }
                "window.hide" => {
                    window.hide();
                    reply(request, Value::Null);
                }
                _ => {
                    let width = number(args, "width")?;
                    let height = number(args, "height")?;
                    if width > 32768 || height > 32768 {
                        return Err("Invalid resize".into());
                    }
                    window.set_size(Some(&Size {
                        width: width as i32,
                        height: height as i32,
                    }));
                    window.layout();
                    reply(request, Value::Null);
                }
            }
        }
        "view.focus" => {
            let id = number(args, "id")?;
            let view = STATE
                .with(|s| {
                    s.borrow()
                        .views
                        .get(&id)
                        .filter(|r| r.close.is_none())
                        .and_then(|r| r.view.clone())
                })
                .ok_or("INVALID_HANDLE: view")?;
            view.request_focus();
            reply(request, Value::Null);
        }
        "rpc.ack" => {
            let (id, binding, frame, context) = rpc_target(args)?;
            let sequence = number(args, "sequence")?;
            let mut message = wire::message(wire::ACK, binding.identity(), sequence, None)
                .ok_or("RPC allocation failed")?;
            STATE.with(|s| {
                s.borrow_mut()
                    .views
                    .get_mut(&id)
                    .ok_or("Stale RPC connection")?
                    .rpc
                    .acknowledge_receive(&context, binding.identity(), sequence)
            })?;
            frame.send_process_message(ProcessId::RENDERER, Some(&mut message));
            reply(request, Value::Null);
        }
        "rpc.deliver" => {
            let (id, binding, frame, context) = rpc_target(args)?;
            let bytes = unhex(packet_string(args, "packet")?)?;
            let sequence = STATE.with(|s| {
                let mut state = s.borrow_mut();
                state
                    .views
                    .get_mut(&id)
                    .ok_or("Stale RPC connection")?
                    .rpc
                    .begin_delivery(&context, binding.identity(), bytes.len())
            })?;
            let Some(mut delivery) =
                wire::message(wire::DELIVER, binding.identity(), sequence, Some(&bytes))
            else {
                STATE.with(|s| {
                    if let Some(record) = s.borrow_mut().views.get_mut(&id) {
                        let _ = record.rpc.finish_delivery(binding.identity(), sequence);
                    }
                });
                return Err("RPC allocation failed".into());
            };
            let reserved = STATE.with(|s| {
                s.borrow_mut().rpc_deliveries.reserve(
                    binding.clone(),
                    sequence,
                    bytes.len(),
                    request,
                )
            });
            if let Err(reason) = reserved {
                STATE.with(|s| {
                    if let Some(record) = s.borrow_mut().views.get_mut(&id) {
                        let _ = record.rpc.finish_delivery(binding.identity(), sequence);
                    }
                });
                return Err(reason.into());
            }
            // Reserve before the CEF call; no callback can race an absent record.
            frame.send_process_message(ProcessId::RENDERER, Some(&mut delivery));
        }
        "rpc.disconnect" => {
            let connection = number(args, "connection")?;
            let identity = wire::Identity {
                connection,
                context: number(args, "context")?,
                generation: number(args, "generation")?,
            };
            let result = STATE.with(|s| {
                let mut state = s.borrow_mut();
                state
                    .views
                    .iter_mut()
                    .find(|(_, r)| {
                        r.rpc
                            .binding()
                            .is_some_and(|binding| binding.identity() == identity)
                    })
                    .map(|(id, record)| (*id, record.rpc.revoke()))
            });
            if let Some((id, revoked)) = result {
                revoke_renderer(id, revoked);
            }
            reply(request, Value::Null);
        }
        "diagnostics" => {
            let value = STATE.with(|s| { let s = s.borrow(); json!({"windows":s.windows.len(),"views":s.views.len(),"sessions":s.sessions.len(),"persistentSessions":s.sessions.values().filter(|record| record.persistent).count(),"pending":PENDING.load(Ordering::SeqCst),"deadlineProfile":crate::deadlines::current().name(),"rpcBindings":s.views.values().filter(|view| view.rpc.binding().is_some()).count(),"rpcIncomingBytes":s.views.values().map(|view| view.rpc.incoming_bytes()).sum::<usize>(),"rpcDeliveryPackets":s.rpc_deliveries.len(),"rpcDeliveryBytes":s.rpc_deliveries.bytes()}) });
            reply(request, value);
        }
        "quit" => {
            reply(request, Value::Null);
            quit_on_ui();
        }
        _ => return Err("UNSUPPORTED_CAPABILITY: unknown native operation".into()),
    }
    Ok(())
}
wrap_window_delegate! {
    struct BunlyWindow { id: u64, title: String, x: i32, y: i32, width: i32, height: i32 }
    impl ViewDelegate { fn preferred_size(&self, _view: Option<&mut View>) -> Size { Size { width: self.width, height: self.height } } }
    impl PanelDelegate {}
    impl WindowDelegate {
        fn window_runtime_style(&self) -> RuntimeStyle { RuntimeStyle::ALLOY }
        fn on_window_created(&self, window: Option<&mut Window>) {
            let Some(window) = window else {
                if let Some(record) = STATE.with(|s| s.borrow_mut().windows.remove(&self.id)) { error(record.request, "Window creation callback failed"); }
                return;
            };
            let request = STATE.with(|s| { let mut s = s.borrow_mut(); s.windows.get_mut(&self.id).map(|r| { r.window = Some(window.clone()); let request = r.request; r.request = 0; request }) });
            let Some(request) = request else { window.close(); return; };
            window.set_title(Some(&CefString::from(self.title.as_str())));
            window.set_bounds(Some(&Rect { x: self.x, y: self.y, width: self.width, height: self.height }));
            window.show(); if request != 0 { reply(request, json!({"id":self.id})); }
        }
        fn can_close(&self, _window: Option<&mut Window>) -> i32 {
            let (browsers, pending, revocations) = STATE.with(|s| { let mut s = s.borrow_mut();
                if let Some(r) = s.windows.get_mut(&self.id) { r.closing.get_or_insert(0); }
                let view_ids = s.views.iter().filter_map(|(id, view)| (view.window == self.id).then_some(*id)).collect::<Vec<_>>();
                let browsers = view_ids.iter().filter_map(|id| s.views.get(id)?.browser.clone()).collect::<Vec<_>>();
                let pending = view_ids.iter().any(|id| s.views.get(id).is_some_and(|view| view.browser.is_none()));
                let revocations = view_ids.into_iter().filter_map(|id| s.views.get_mut(&id).map(|view| (id, view.rpc.revoke()))).collect::<Vec<_>>();
                (browsers, pending, revocations)
            });
            for (id, revoked) in revocations { revoke_renderer(id, revoked); }
            let mut allowed = !pending;
            for browser in browsers { if let Some(host) = browser.host() { if host.try_close_browser() == 0 { allowed = false; } } }
            i32::from(allowed)
        }
        fn on_window_destroyed(&self, _window: Option<&mut Window>) { let removed = STATE.with(|s| s.borrow_mut().windows.remove(&self.id)); if let Some(record) = removed { if let Some(request) = record.closing.filter(|r| *r != 0) { reply(request, Value::Null); } } event("window.closed", self.id, Value::Null); if STATE.with(|s| s.borrow().windows.is_empty() && s.borrow().views.is_empty()) { QUITTING.store(true, Ordering::SeqCst); finish_on_ui(); } }
    }
}
wrap_browser_view_delegate! {
    struct BunlyView { style: RuntimeStyle }
    impl ViewDelegate {}
    impl BrowserViewDelegate { fn browser_runtime_style(&self) -> RuntimeStyle { self.style } }
}
wrap_client! {
    struct BunlyClient { id: u64 }
    impl Client {
        fn permission_handler(&self) -> Option<PermissionHandler> { Some(DenyPermissions::new()) }
        fn download_handler(&self) -> Option<DownloadHandler> { Some(DenyDownloads::new()) }
        fn life_span_handler(&self) -> Option<LifeSpanHandler> { Some(BunlyLife::new(self.id)) }
        fn load_handler(&self) -> Option<LoadHandler> { Some(BunlyLoad::new(self.id)) }
        fn display_handler(&self) -> Option<DisplayHandler> { Some(BunlyDisplay::new(self.id)) }
        fn request_handler(&self) -> Option<RequestHandler> { Some(BunlyRequest::new(self.id)) }
        fn frame_handler(&self) -> Option<FrameHandler> { Some(BunlyFrame::new(self.id)) }
        fn on_process_message_received(&self, browser: Option<&mut Browser>, frame: Option<&mut Frame>, source: ProcessId, message: Option<&mut ProcessMessage>) -> i32 {
            renderer_message(self.id, browser, frame, source, message)
        }
    }
}
fn revoke_frame(id: u64, frame: Option<&mut Frame>) {
    let Some(frame) = frame else {
        return;
    };
    let frame_id = CefString::from(&frame.identifier()).to_string();
    let revoked = STATE.with(|s| {
        s.borrow_mut()
            .views
            .get_mut(&id)
            .and_then(|r| r.rpc.revoke_frame(&frame_id))
    });
    revoke_renderer(id, revoked);
}
wrap_frame_handler! {
    struct BunlyFrame { id: u64 }
    impl FrameHandler {
        fn on_frame_detached(&self, _browser: Option<&mut Browser>, frame: Option<&mut Frame>) { revoke_frame(self.id, frame); }
        fn on_frame_destroyed(&self, _browser: Option<&mut Browser>, frame: Option<&mut Frame>) { revoke_frame(self.id, frame); }
        fn on_main_frame_changed(&self, _browser: Option<&mut Browser>, old_frame: Option<&mut Frame>, _new_frame: Option<&mut Frame>) { revoke_frame(self.id, old_frame); }
    }
}
wrap_life_span_handler! {
    struct BunlyLife { id: u64 }
    impl LifeSpanHandler {
        fn on_before_popup(&self, _browser: Option<&mut Browser>, _frame: Option<&mut Frame>, _popup_id: i32,
            _target_url: Option<&CefString>, _target_frame_name: Option<&CefString>, _disposition: WindowOpenDisposition,
            _gesture: i32, _features: Option<&PopupFeatures>, _window_info: Option<&mut WindowInfo>,
            _client: Option<&mut Option<Client>>, _settings: Option<&mut BrowserSettings>,
            _extra: Option<&mut Option<DictionaryValue>>, _no_access: Option<&mut i32>) -> i32 { 1 }
        fn on_after_created(&self, browser: Option<&mut Browser>) {
            let Some(browser) = browser else { return; };
            let action = STATE.with(|s| { let mut s = s.borrow_mut();
                let closing = QUITTING.load(Ordering::SeqCst) || s.views.get(&self.id).is_none_or(|r| {
                    r.close.is_some() || s.windows.get(&r.window).is_none_or(|w| w.closing.is_some())
                });
                s.views.get_mut(&self.id).map(|r| { r.browser = Some(browser.clone()); let request = r.create; r.create = 0; (request, closing) })
            });
            match action {
                Some((request, false)) => if request != 0 {
                    let document = STATE.with(|s| s.borrow().views.get(&self.id).map(|r| r.rpc.document().to_owned()));
                    if let Some(document) = document { reply(request, json!({"id":self.id,"documentId":document})); }
                },
                other => { if let Some((request, _)) = other { if request != 0 { error(request, "View owner closed during creation"); } }
                    if let Some(host) = browser.host() { host.close_browser(1); }
                }
            }
        }
        fn on_before_close(&self, _browser: Option<&mut Browser>) {
            let record = STATE.with(|s| s.borrow_mut().views.remove(&self.id));
            if let Some(mut record) = record {
                revoke_renderer(self.id, record.rpc.revoke());
                if record.create != 0 { error(record.create, "View closed before creation completed"); }
                for request in record.navigate.cancel() { error(request, "Navigation cancelled by close"); }
                if let Some(request) = record.close { reply(request, Value::Null); }
                event("view.closed", self.id, Value::Null);
                let window = STATE.with(|s| s.borrow().windows.get(&record.window).and_then(|r| r.window.clone()));
                if let Some(window) = window {
                    if let Some(view) = record.view { let mut view = View::from(&view); window.remove_child_view(Some(&mut view)); }
                    let closing = STATE.with(|s| s.borrow().windows.get(&record.window).is_some_and(|r| r.closing.is_some()));
                    if closing || QUITTING.load(Ordering::SeqCst) { window.close(); }
                }
            }
            if STATE.with(|s| s.borrow().windows.is_empty() && s.borrow().views.is_empty()) { QUITTING.store(true, Ordering::SeqCst); finish_on_ui(); }
        }
    }
}
wrap_load_handler! {
    struct BunlyLoad { id: u64 }
    impl LoadHandler {
        fn on_loading_state_change(&self, _browser: Option<&mut Browser>, loading: i32, _back: i32, _forward: i32) {
            let closing = STATE.with(|s| s.borrow().views.get(&self.id).is_none_or(|r| r.close.is_some()));
            if closing || QUITTING.load(Ordering::SeqCst) { cancel_navigation(self.id, "Navigation cancelled by close"); return; }
            let transition = STATE.with(|s| s.borrow_mut().views.get_mut(&self.id).map(|r| r.navigate.loading(loading != 0)));
            if let Some(transition) = transition {
                if let Some((request, result)) = transition.completed {
                    match result { Ok(value) => reply(request, json!({"url":value.url,"status":value.status})), Err(message) => error(request, &message) }
                }
                if let Some(request) = transition.start { issue_navigation(self.id, request); }
            }
        }
        fn on_load_end(&self, _browser: Option<&mut Browser>, frame: Option<&mut Frame>, status: i32) {
            if let Some(frame) = frame { if frame.is_main() != 0 && live_view(self.id) {
                let url = CefString::from(&frame.url()).to_string();
                STATE.with(|s| { if let Some(r) = s.borrow_mut().views.get_mut(&self.id) { r.navigate.loaded(&url, status); } });
                let document = STATE.with(|s| s.borrow().views.get(&self.id).map(|r| r.rpc.document().to_owned()));
                if let Some(document) = document { event("view.loaded", self.id, json!({"url":url,"status":status,"documentId":document})); }
            } }
        }
        fn on_load_error(&self, _browser: Option<&mut Browser>, frame: Option<&mut Frame>, code: Errorcode, text: Option<&CefString>, url: Option<&CefString>) {
            if frame.is_some_and(|f| f.is_main() != 0) && live_view(self.id) {
                let message = text.map(|v| v.to_string()).unwrap_or_default();
                let url = url.map(|v| v.to_string()).unwrap_or_default();
                let revoked = STATE.with(|s| s.borrow_mut().views.get_mut(&self.id).and_then(|r| r.rpc.revoke()));
                revoke_renderer(self.id, revoked);
                STATE.with(|s| { if let Some(r) = s.borrow_mut().views.get_mut(&self.id) { r.navigate.failed(&url, message.clone()); } });
                event("view.load-error", self.id, json!({"code":code.get_raw(),"message":message,"url":url}));
            }
        }
    }
}
wrap_display_handler! {
    struct BunlyDisplay { id: u64 }
    impl DisplayHandler {
        fn on_title_change(&self, _browser: Option<&mut Browser>, title: Option<&CefString>) { let title = title.map(|t| t.to_string()).unwrap_or_default(); if title.len() <= 4096 && live_view(self.id) { event("view.title", self.id, json!({"title":title})); } }
        fn on_console_message(&self, _browser: Option<&mut Browser>, _level: LogSeverity, message: Option<&CefString>, _source: Option<&CefString>, _line: i32) -> i32 { if let Some(message) = message { let text = message.to_string(); if text.len() <= 4096 && live_view(self.id) { event("view.console", self.id, json!({"message":text})); } } 1 }
    }
}
wrap_request_handler! {
    struct BunlyRequest { id: u64 }
    impl RequestHandler {
        // IO-thread callback: request policy is separate from UI-only host state.
        fn resource_request_handler(&self, _browser: Option<&mut Browser>, _frame: Option<&mut Frame>,
            _request: Option<&mut Request>, _navigation: i32, _download: i32, _initiator: Option<&CefString>,
            _disable_default: Option<&mut i32>) -> Option<ResourceRequestHandler> { Some(scheme::local_resources()) }
        fn on_render_process_terminated(&self, _browser: Option<&mut Browser>, status: TerminationStatus, code: i32, _message: Option<&CefString>) {
            if !live_view(self.id) || QUITTING.load(Ordering::SeqCst) { return; }
            let revoked = STATE.with(|s| s.borrow_mut().views.get_mut(&self.id).and_then(|r| r.rpc.revoke()));
            revoke_renderer(self.id, revoked);
            cancel_navigation(self.id, "Renderer process terminated");
            event("view.renderer-exit", self.id, json!({"status":status.get_raw(),"code":code}));
            // M3 fails closed. M4/M7 may later add explicit, authorized recovery.
            fail("Renderer process terminated before native shutdown");
        }
        // Do not cancel CEF-owned closing navigations solely because the view
        // is closing: Chromium needs them for teardown. URL policy still applies,
        // while only live application views receive navigation events.
        fn on_before_browse(&self, _browser: Option<&mut Browser>, frame: Option<&mut Frame>, request: Option<&mut Request>, _gesture: i32, redirect: i32) -> i32 {
            let Some(request) = request else { return 1 }; let url = CefString::from(&request.url()).to_string(); let denied = checked_url(&url).is_err();
            if denied && frame.as_ref().is_some_and(|frame| frame.is_main() != 0) {
                let revoked = STATE.with(|s| s.borrow_mut().views.get_mut(&self.id).and_then(|record| record.rpc.revoke()));
                revoke_renderer(self.id, revoked);
            }
            if !denied && live_view(self.id) && frame.is_some_and(|f| f.is_main() != 0) {
                let (revoked, document, application_trust) = STATE.with(|s| { let mut s = s.borrow_mut(); s.views.get_mut(&self.id).map(|r| {
                    if redirect != 0 { r.navigate.redirect(&url); }
                    let revoked = r.rpc.navigation_start(&url, redirect != 0);
                    (revoked, r.rpc.document().to_owned(), r.rpc.application_trust())
                }) }).unwrap_or((None, String::new(), false));
                revoke_renderer(self.id, revoked);
                event("view.navigating", self.id, json!({"url":url,"documentId":document,"applicationTrust":application_trust}));
            } i32::from(denied)
        }
    }
}
// Until user-authorized permission/download APIs are implemented, deny them natively.
wrap_permission_handler! {
    struct DenyPermissions;
    impl PermissionHandler {
        fn on_request_media_access_permission(&self, _browser: Option<&mut Browser>, _frame: Option<&mut Frame>,
            _origin: Option<&CefString>, _permissions: u32, callback: Option<&mut MediaAccessCallback>) -> i32 {
            if let Some(callback) = callback { callback.cont(0); } 1
        }
        fn on_show_permission_prompt(&self, _browser: Option<&mut Browser>, _id: u64,
            _origin: Option<&CefString>, _permissions: u32, callback: Option<&mut PermissionPromptCallback>) -> i32 {
            if let Some(callback) = callback { callback.cont(PermissionRequestResult::DENY); } 1
        }
    }
}
wrap_download_handler! {
    struct DenyDownloads;
    impl DownloadHandler { fn can_download(&self, _browser: Option<&mut Browser>, _url: Option<&CefString>, _method: Option<&CefString>) -> i32 { 0 } }
}
