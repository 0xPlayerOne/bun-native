use crate::{policy, process, scheme};
use cef::*;
use serde_json::{json, Value};
use std::{
    cell::RefCell,
    collections::BTreeMap,
    sync::atomic::{AtomicBool, AtomicUsize, Ordering},
};
#[path = "navigation.rs"]
mod navigation;
pub static FAILED: AtomicBool = AtomicBool::new(false);
pub static QUITTING: AtomicBool = AtomicBool::new(false);
static PENDING: AtomicUsize = AtomicUsize::new(0);
static FINALIZING: AtomicBool = AtomicBool::new(false);
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
}
#[derive(Default)]
struct HostState {
    next: u64,
    windows: BTreeMap<u64, WindowRecord>,
    views: BTreeMap<u64, ViewRecord>,
    sessions: BTreeMap<u64, RequestContext>,
}
thread_local! { static STATE: RefCell<HostState> = RefCell::new(HostState::default()); }
fn number(value: &Value, key: &str) -> Result<u64, String> {
    value
        .get(key)
        .and_then(Value::as_u64)
        .filter(|n| *n > 0)
        .ok_or_else(|| format!("Invalid {key}"))
}
fn string<'a>(value: &'a Value, key: &str) -> Result<&'a str, String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|s| s.len() <= 4096 && !s.contains('\0'))
        .ok_or_else(|| format!("Invalid {key}"))
}
fn reply(id: u64, value: Value) {
    process::emit(json!({"v":1,"id":id,"ok":true,"value":value}));
}
fn error(id: u64, message: &str) {
    process::emit(json!({"v":1,"id":id,"ok":false,"error":message}));
}
fn next_id() -> u64 {
    STATE.with(|s| {
        let mut s = s.borrow_mut();
        s.next += 1;
        s.next
    })
}
fn event(kind: &str, target: u64, data: Value) {
    process::emit(json!({"v":1,"event":kind,"target":target,"data":data}));
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
    if QUITTING.swap(true, Ordering::SeqCst) {
        return;
    }
    bound_shutdown();
    let (windows, browsers) = STATE.with(|s| {
        let s = s.borrow();
        (
            s.windows
                .values()
                .filter_map(|r| r.window.clone())
                .collect::<Vec<_>>(),
            s.views
                .values()
                .filter_map(|r| r.browser.clone())
                .collect::<Vec<_>>(),
        )
    });
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
        fn execute(&self) {
            let contexts = STATE.with(|s| s.borrow().sessions.iter().map(|(id, context)| (*id, context.clone())).collect::<Vec<_>>());
            if contexts.is_empty() { let mut done = FinishLoopTask::new(); post_task(ThreadId::UI, Some(&mut done)); return; }
            for (id, context) in contexts {
                context.clear_scheme_handler_factories();
                let mut closed = ContextClosed::new(id);
                // Keep the context in STATE until its asynchronous completion.
                context.close_all_connections(Some(&mut closed));
            }
        }
    }
}
wrap_completion_callback! {
    struct ContextClosed { id: u64 }
    impl CompletionCallback { fn on_complete(&self) {
        let context = STATE.with(|s| s.borrow_mut().sessions.remove(&self.id));
        drop(context);
        if STATE.with(|s| s.borrow().sessions.is_empty()) {
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
    STATE.with(|s| {
        let mut s = s.borrow_mut();
        if !s.windows.is_empty() || !s.views.is_empty() {
            FAILED.store(true, Ordering::SeqCst);
        }
        s.windows.clear();
        s.views.clear();
        s.sessions.clear();
    });
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
    }
}
wrap_browser_process_handler! {
    struct BunlyProcess;
    impl BrowserProcessHandler { fn on_context_initialized(&self) { if currently_on(ThreadId::UI) == 0 { fail("CEF initialized on incorrect thread"); return; }
        if let Err(e) = process::start() { fail(&e); } } }
}
fn checked_url(text: &str) -> Result<String, String> {
    policy::navigation(
        text,
        crate::PATHS.get().and_then(|p| p.dev_origin.as_deref()),
    )
}
fn live_view(id: u64) -> bool {
    STATE.with(|s| s.borrow().views.get(&id).is_some_and(|r| r.close.is_none()))
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
            if string(args, "persistence")? != "ephemeral" {
                return Err("UNSUPPORTED_CAPABILITY: session.persistent".into());
            }
            if STATE.with(|s| s.borrow().sessions.len() >= 128) {
                return Err("Session capacity exceeded".into());
            }
            let mut handler = scheme::context_handler();
            let context = request_context_create_context(
                Some(&RequestContextSettings::default()),
                Some(&mut handler),
            )
            .ok_or("Session creation failed")?;
            scheme::attach(&context);
            let id = next_id();
            STATE.with(|s| {
                s.borrow_mut().sessions.insert(id, context);
            });
            reply(request, json!({"id":id}));
        }
        "session.dispose" => {
            let id = number(args, "id")?;
            if STATE.with(|s| s.borrow().views.values().any(|v| v.session == id)) {
                return Err("RESOURCE_IN_USE: session".into());
            }
            if STATE
                .with(|s| s.borrow_mut().sessions.remove(&id))
                .is_none()
            {
                return Err("INVALID_HANDLE: session".into());
            }
            reply(request, Value::Null);
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
            let id = next_id();
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
                        .cloned()
                        .ok_or("INVALID_HANDLE: session")?,
                ))
            })?;
            let id = next_id();
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
            let start = STATE.with(|s| {
                let mut s = s.borrow_mut();
                let r = s.views.get_mut(&id).ok_or("INVALID_HANDLE: view")?;
                if r.close.is_some() {
                    return Err("View is closing");
                }
                if r.browser.is_none() {
                    return Err("Browser not ready");
                }
                r.navigate.request(request, url)
            })?;
            if let Some(request) = start {
                issue_navigation(id, request);
            }
        }
        "view.dispose" => {
            let id = number(args, "id")?;
            let browser = STATE.with(|s| {
                let mut s = s.borrow_mut();
                let r = s.views.get_mut(&id).ok_or("INVALID_HANDLE: view")?;
                if r.close.is_some() {
                    return Err("Close already pending");
                }
                let browser = r.browser.clone().ok_or("Browser not ready")?;
                r.close = Some(request);
                Ok(browser)
            })?;
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
                    STATE.with(|s| {
                        let mut s = s.borrow_mut();
                        let r = s.windows.get_mut(&id).ok_or("INVALID_HANDLE: window")?;
                        if r.closing.is_some() {
                            return Err("Window is closing");
                        }
                        r.closing = Some(request);
                        Ok::<_, &str>(())
                    })?;
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
        "diagnostics" => {
            let value = STATE.with(|s| { let s = s.borrow(); json!({"windows":s.windows.len(),"views":s.views.len(),"sessions":s.sessions.len(),"pending":PENDING.load(Ordering::SeqCst),"deadlineProfile":crate::deadlines::current().name()}) });
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
            let (browsers, pending) = STATE.with(|s| { let mut s = s.borrow_mut();
                if let Some(r) = s.windows.get_mut(&self.id) { r.closing.get_or_insert(0); }
                let views = s.views.values().filter(|v| v.window == self.id).collect::<Vec<_>>();
                (views.iter().filter_map(|v| v.browser.clone()).collect::<Vec<_>>(), views.iter().any(|v| v.browser.is_none()))
            });
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
                Some((request, false)) => if request != 0 { reply(request, json!({"id":self.id})); },
                other => { if let Some((request, _)) = other { if request != 0 { error(request, "View owner closed during creation"); } }
                    if let Some(host) = browser.host() { host.close_browser(1); }
                }
            }
        }
        fn on_before_close(&self, _browser: Option<&mut Browser>) {
            let record = STATE.with(|s| s.borrow_mut().views.remove(&self.id));
            if let Some(mut record) = record {
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
                event("view.loaded", self.id, json!({"url":url,"status":status}));
            } }
        }
        fn on_load_error(&self, _browser: Option<&mut Browser>, frame: Option<&mut Frame>, code: Errorcode, text: Option<&CefString>, url: Option<&CefString>) {
            if frame.is_some_and(|f| f.is_main() != 0) && live_view(self.id) {
                let message = text.map(|v| v.to_string()).unwrap_or_default();
                let url = url.map(|v| v.to_string()).unwrap_or_default();
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
            if !denied && live_view(self.id) && frame.is_some_and(|f| f.is_main() != 0) {
                if redirect != 0 { STATE.with(|s| { if let Some(r) = s.borrow_mut().views.get_mut(&self.id) { r.navigate.redirect(&url); } }); }
                event("view.navigating", self.id, json!({"url":url}));
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
