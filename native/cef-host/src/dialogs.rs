//! Trusted-host file selection. This never enables CEF renderer file pickers.
use super::{captured_ready_scope, event, number, policy_scope, reply, STATE};
use crate::capability_policy::{
    self, AdapterAvailability, DocumentScope, GateDecision, NativeRequest,
};
use cef::*;
use serde_json::{json, Value};
use std::cell::RefCell;
use std::sync::atomic::Ordering;
static STOPPED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

#[path = "dialogs_macos.rs"]
#[cfg(target_os = "macos")]
mod platform;
#[cfg(not(target_os = "macos"))]
mod platform {
    use super::*;
    #[derive(Clone)]
    pub(super) struct Panel;
    pub(super) fn prepare(_options: &Options, _window: &Window) -> Result<Panel, String> {
        Err("UNSUPPORTED_CAPABILITY: native file dialogs unavailable on this platform".into())
    }
    impl Panel {
        pub(super) fn show(&self, _token: u64) {}
        pub(super) fn cancel(&self) {}
        pub(super) fn close(&self) -> bool {
            true
        }
        #[cfg(feature = "rpc-qualification")]
        pub(super) fn visible(&self) -> bool {
            false
        }
        pub(super) fn selected_path(&self) -> Result<String, String> {
            Err("UNSUPPORTED_CAPABILITY: native file dialogs unavailable on this platform".into())
        }
    }
}

pub(super) const SUPPORTED: bool = cfg!(target_os = "macos");

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Kind {
    Open,
    Save,
}
// These presentation fields are consumed only by the implemented AppKit adapter.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
struct Options {
    kind: Kind,
    title: String,
    suggested_name: String,
    directory: String,
}
fn valid_text(text: &str, limit: usize) -> bool {
    text.len() <= limit && !text.chars().any(char::is_control)
}
fn valid_path(path: &str) -> bool {
    valid_text(path, 4096)
        && path.starts_with('/')
        && !path.split('/').any(|part| matches!(part, "." | ".."))
}
fn options(args: &Value) -> Result<Options, String> {
    let object = args
        .as_object()
        .ok_or("INVALID_ARGUMENT: file dialog arguments")?;
    if object.len() != 6
        || object.keys().any(|key| {
            !matches!(
                key.as_str(),
                "id" | "scope" | "kind" | "title" | "suggestedName" | "directory"
            )
        })
    {
        return Err("INVALID_ARGUMENT: unexpected file dialog argument".into());
    }
    let kind = match args.get("kind").and_then(Value::as_str) {
        Some("open") => Kind::Open,
        Some("save") => Kind::Save,
        _ => return Err("INVALID_ARGUMENT: file dialog kind".into()),
    };
    let title = args
        .get("title")
        .and_then(Value::as_str)
        .filter(|value| valid_text(value, 256))
        .ok_or("INVALID_ARGUMENT: file dialog title")?
        .to_owned();
    let suggested_name = args
        .get("suggestedName")
        .and_then(Value::as_str)
        .filter(|value| valid_text(value, 255))
        .ok_or("INVALID_ARGUMENT: file dialog name")?
        .to_owned();
    let directory = args
        .get("directory")
        .and_then(Value::as_str)
        .filter(|value| valid_path(value))
        .ok_or("INVALID_ARGUMENT: file dialog directory")?
        .to_owned();
    if (kind == Kind::Open && !suggested_name.is_empty())
        || (kind == Kind::Save
            && (suggested_name.is_empty()
                || matches!(suggested_name.as_str(), "." | "..")
                || suggested_name.contains(['/', '\\', ':'])))
    {
        return Err("INVALID_ARGUMENT: file dialog basename".into());
    }
    Ok(Options {
        kind,
        title,
        suggested_name,
        directory,
    })
}
fn authorize(scope: &DocumentScope, kind: Kind) -> Result<(), String> {
    if super::RPC_STOPPED.load(Ordering::SeqCst) || super::QUITTING.load(Ordering::SeqCst) {
        return Err("PERMISSION_DENIED: native application is shutting down".into());
    }
    let grants = STATE.with(|state| {
        let state = state.borrow();
        captured_ready_scope(&state, scope.view, scope)
            .map_err(|_| "PERMISSION_DENIED: file dialog document changed")?;
        state
            .policy
            .native_grants(scope)
            .ok_or("PERMISSION_DENIED: file dialog document changed")
    })?;
    let request = if kind == Kind::Open {
        NativeRequest::DialogOpen
    } else {
        NativeRequest::DialogSave
    };
    let availability = if SUPPORTED {
        AdapterAvailability::Available
    } else {
        AdapterAvailability::Unavailable
    };
    match capability_policy::authorize_native_grants(&grants, &request, availability) {
        GateDecision::Authorized => Ok(()),
        GateDecision::Denied => Err("PERMISSION_DENIED: file dialog grant missing".into()),
        GateDecision::Unavailable => {
            Err("UNSUPPORTED_CAPABILITY: native file dialogs unavailable on this platform".into())
        }
    }
}
struct Active {
    token: u64,
    scope: DocumentScope,
    kind: Kind,
    panel: platform::Panel,
    cancel_requested: bool,
    revoked: bool,
    shown: bool,
    completing: bool,
}
thread_local! { static ACTIVE: RefCell<Option<Active>> = const { RefCell::new(None) }; }
#[cfg(feature = "rpc-qualification")]
#[derive(Default)]
struct Counters {
    admissions: u64,
    callbacks: u64,
    selected: u64,
    cancelled: u64,
    failed: u64,
}
#[cfg(feature = "rpc-qualification")]
thread_local! { static COUNTERS: RefCell<Counters> = RefCell::new(Counters::default()); }
pub(super) fn contains(view: u64) -> bool {
    ACTIVE.with(|active| {
        active
            .borrow()
            .as_ref()
            .is_some_and(|record| record.scope.view == view)
    })
}
pub(super) fn is_empty() -> bool {
    ACTIVE.with(|active| active.borrow().is_none())
}

pub(super) fn start(request: u64, args: &Value) -> Result<(), String> {
    let settings = options(args)?;
    let id = number(args, "id")?;
    let scope = policy_scope(args)?;
    if scope.view != id {
        return Err("PERMISSION_DENIED: file dialog scope mismatch".into());
    }
    authorize(&scope, settings.kind)?;
    let window = STATE.with(|state| {
        let state = state.borrow();
        let view = state
            .views
            .get(&id)
            .ok_or("PERMISSION_DENIED: file dialog view closed")?;
        state
            .windows
            .get(&view.window)
            .filter(|owner| owner.closing.is_none())
            .and_then(|owner| owner.window.clone())
            .ok_or("PERMISSION_DENIED: file dialog window closed")
    })?;
    if !is_empty() {
        return Err("RESOURCE_IN_USE: native file dialog is still owned".into());
    }
    let token = super::native_modal::reserve(super::native_modal::Owner::FileDialog)?;
    let prepared = platform::prepare(&settings, &window).and_then(|panel| {
        authorize(&scope, settings.kind)?;
        Ok(panel)
    });
    let panel = match prepared {
        Ok(panel) => panel,
        Err(message) => {
            super::native_modal::release(super::native_modal::Owner::FileDialog, token);
            return Err(message);
        }
    };
    ACTIVE.with(|active| {
        *active.borrow_mut() = Some(Active {
            token,
            scope,
            kind: settings.kind,
            panel,
            cancel_requested: false,
            revoked: false,
            shown: false,
            completing: false,
        });
    });
    #[cfg(feature = "rpc-qualification")]
    COUNTERS.with(|counts| counts.borrow_mut().admissions += 1);
    reply(request, json!({"id":token}));
    // Publish admission before any possible native completion callback.
    let mut task = ShowDialog::new(token);
    if post_task(ThreadId::UI, Some(&mut task)) == 0 {
        finish(token, false, Some("NATIVE_FAILURE"));
        super::fail("Native file dialog presentation could not be scheduled");
    }
    Ok(())
}
wrap_task! { struct ShowDialog { token: u64 } impl Task { fn execute(&self) { show(self.token); } } }
fn show(token: u64) {
    if STOPPED.load(Ordering::SeqCst) {
        return;
    }
    let captured = ACTIVE.with(|active| {
        active
            .borrow()
            .as_ref()
            .filter(|record| record.token == token)
            .map(|record| (record.scope.clone(), record.kind, record.cancel_requested))
    });
    let Some((scope, kind, cancelled)) = captured else {
        return;
    };
    if cancelled {
        finish(token, false, None);
        return;
    }
    if authorize(&scope, kind).is_err() {
        finish(token, false, Some("PERMISSION_DENIED"));
        return;
    }
    let panel = ACTIVE.with(|active| {
        let mut active = active.borrow_mut();
        let record = active.as_mut().filter(|record| record.token == token)?;
        record.shown = true;
        Some(record.panel.clone())
    });
    if let Some(panel) = panel {
        panel.show(token);
    }
}
pub(super) fn cancel(request: u64, args: &Value) -> Result<(), String> {
    if args.as_object().is_none_or(|object| {
        object.len() != 2
            || object
                .keys()
                .any(|key| !matches!(key.as_str(), "id" | "dialog"))
    }) {
        return Err("INVALID_ARGUMENT: file dialog cancellation arguments".into());
    }
    let view = number(args, "id")?;
    let token = number(args, "dialog")?;
    let valid = ACTIVE.with(|active| {
        let mut active = active.borrow_mut();
        let Some(record) = active
            .as_mut()
            .filter(|record| record.token == token && record.scope.view == view)
        else {
            return false;
        };
        record.cancel_requested = true;
        true
    });
    // A completion may have reached the pipe before this queued cancellation.
    // A stale token never affects any current panel.
    reply(request, Value::Null);
    if valid {
        cancel_on_ui(token);
    }
    Ok(())
}
/// Called under the host registry borrow: only mark and post; AppKit can reenter.
pub(super) fn revoke(view: u64) {
    let token = ACTIVE.with(|active| {
        let mut active = active.borrow_mut();
        let record = active.as_mut().filter(|record| record.scope.view == view)?;
        if record.revoked {
            return None;
        }
        record.revoked = true;
        record.cancel_requested = true;
        Some(record.token)
    });
    if let Some(token) = token {
        let mut task = CancelDialog::new(token);
        if post_task(ThreadId::UI, Some(&mut task)) == 0 {
            // Preserve the owner for the shutdown deadline; never report clean release.
            super::fail("Native file dialog cancellation could not be scheduled");
        }
    }
}
wrap_task! { struct CancelDialog { token: u64 } impl Task { fn execute(&self) { cancel_on_ui(self.token); } } }
fn cancel_on_ui(token: u64) {
    if STOPPED.load(Ordering::SeqCst) {
        return;
    }
    let current = ACTIVE.with(|active| {
        active
            .borrow()
            .as_ref()
            .filter(|record| record.token == token && !record.completing)
            .map(|record| (record.panel.clone(), record.shown))
    });
    if let Some((panel, shown)) = current {
        if shown {
            panel.cancel();
        } else {
            finish(token, false, None);
        }
    }
}
pub(super) fn finish(token: u64, selected: bool, failure: Option<&'static str>) {
    // AppKit can finish an outstanding block during failed CEF teardown. It must
    // not publish pipe work or post CEF tasks after the owner loop has stopped.
    if STOPPED.load(Ordering::SeqCst) {
        return;
    }
    let captured = ACTIVE.with(|active| {
        let mut active = active.borrow_mut();
        let record = active
            .as_mut()
            .filter(|record| record.token == token && !record.completing)?;
        record.completing = true;
        Some((
            record.panel.clone(),
            record.scope.clone(),
            record.kind,
            record.cancel_requested,
            record.revoked,
        ))
    });
    let Some((panel, scope, kind, cancelled, revoked)) = captured else {
        return;
    };
    if !panel.close() {
        // The slot and retained owner remain charged after an unproven close.
        super::fail("Native file dialog remained visible after completion");
        return;
    }
    let mut failure = failure;
    let mut path = None;
    if revoked || authorize(&scope, kind).is_err() {
        failure = Some("PERMISSION_DENIED");
    } else if selected && !cancelled && failure.is_none() {
        match panel.selected_path() {
            Ok(value) if valid_path(&value) => {
                path = Some(value);
            }
            _ => failure = Some("INVALID_ARGUMENT"),
        }
        // Reading panel results may reenter AppKit; revalidate before delivery.
        if authorize(&scope, kind).is_err() {
            path = None;
            failure = Some("PERMISSION_DENIED");
        }
    }
    ACTIVE.with(|active| {
        active.borrow_mut().take();
    });
    if !super::native_modal::release(super::native_modal::Owner::FileDialog, token) {
        super::fail("Native file dialog modal identity mismatch");
        return;
    }
    #[cfg(feature = "rpc-qualification")]
    COUNTERS.with(|counts| {
        let mut counts = counts.borrow_mut();
        if failure.is_some() {
            counts.failed += 1;
        } else if path.is_some() {
            counts.selected += 1;
        } else {
            counts.cancelled += 1;
        }
    });
    event(
        "dialog.finished",
        scope.view,
        json!({"id":token,"status":if failure.is_some() {"failed"} else if path.is_some() {"selected"} else {"cancelled"},"path":path,"error":failure}),
    );
    // Unwind the AppKit callback before closing a window or its CEF browser.
    let mut task = ResumeAfterDialog::new(scope.view);
    if post_task(ThreadId::UI, Some(&mut task)) == 0 {
        super::fail("Native dialog close continuation could not be scheduled");
    }
}
#[cfg(target_os = "macos")]
pub(super) fn dismissed(token: u64, selected: bool, failure: Option<&'static str>) {
    #[cfg(feature = "rpc-qualification")]
    COUNTERS.with(|counts| counts.borrow_mut().callbacks += 1);
    finish(token, selected, failure);
}
wrap_task! { struct ResumeAfterDialog { view: u64 } impl Task { fn execute(&self) { super::resume_after_owned_operation(self.view); } } }

pub(super) fn stop() {
    STOPPED.store(true, Ordering::SeqCst);
    let panel = ACTIVE.with(|active| active.borrow().as_ref().map(|record| record.panel.clone()));
    if let Some(panel) = panel {
        super::FAILED.store(true, Ordering::SeqCst);
        eprintln!(
            "{}",
            json!({"event":"bunly.host.failure","error":"Native file dialog did not complete before host release"})
        );
        panel.cancel();
        panel.close();
        // Retain the bounded AppKit-only owner after failed shutdown. Its late
        // completion is inert and never masquerades as a clean terminal event.
        // There are no CEF references in Active or the completion block.
    }
}

#[cfg(feature = "rpc-qualification")]
fn snapshot() -> Value {
    let (active, panel) = ACTIVE.with(|active| {
        let active = active.borrow();
        (
            usize::from(active.is_some()),
            active.as_ref().map(|record| record.panel.clone()),
        )
    });
    let visible = panel.is_some_and(|panel| panel.visible());
    COUNTERS.with(|counts| { let counts = counts.borrow(); json!({"supported":SUPPORTED,"active":active,"visible":visible,"admissions":counts.admissions,"callbacks":counts.callbacks,"selected":counts.selected,"cancelled":counts.cancelled,"failed":counts.failed}) })
}
#[cfg(feature = "rpc-qualification")]
pub(super) fn qualification(request: u64, args: &Value) -> Result<(), String> {
    if args.as_object().is_none_or(|object| !object.is_empty()) {
        return Err("INVALID_ARGUMENT: dialog qualification takes no arguments".into());
    }
    reply(request, snapshot());
    Ok(())
}
pub(super) fn shutdown_receipt() {
    #[cfg(feature = "rpc-qualification")]
    {
        let data = snapshot();
        eprintln!(
            "{}",
            json!({"event":"bunly.host.dialog-shutdown","state":data})
        );
        crate::process::emit(json!({"v":1,"event":"dialog.shutdown","data":data}));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn request(kind: &str, name: &str) -> Value {
        json!({"id":1,"scope":{},"kind":kind,"title":"Choose","suggestedName":name,"directory":"/owned-fixture"})
    }
    #[test]
    fn arguments_do_not_smuggle_paths_modes_or_unbounded_strings() {
        assert!(options(&request("open", "")).is_ok());
        assert!(options(&request("save", "report.txt")).is_ok());
        for (kind, name) in [
            ("open", "secret"),
            ("save", ""),
            ("save", "../secret"),
            ("save", "a\\b"),
            ("save", "a:b"),
            ("folder", ""),
        ] {
            assert!(options(&request(kind, name)).is_err());
        }
        let mut value = request("open", "");
        value["title"] = json!("é".repeat(129));
        assert!(options(&value).is_err());
        let mut value = request("open", "");
        value["extra"] = json!(true);
        assert!(options(&value).is_err());
        for path in [
            "relative",
            "/root/../private",
            "/root/./private",
            "/bad\npath",
            "/bad\0path",
        ] {
            assert!(!valid_path(path));
        }
        assert!(valid_path("/owned/é.txt"));
        assert!(!valid_path(&format!("/{}", "x".repeat(4096))));
    }
    #[test]
    fn native_dialog_grants_are_distinct_and_stale_documents_fail_before_platform_access() {
        let (mut state, scope) = super::super::tests::state_with_view(7, 11);
        state
            .policy
            .grant_native(&scope, capability_policy::NativeCapability::DialogOpen)
            .unwrap();
        STATE.with(|slot| *slot.borrow_mut() = state);
        let open = authorize(&scope, Kind::Open);
        if SUPPORTED {
            assert!(open.is_ok());
        } else {
            assert!(open.unwrap_err().starts_with("UNSUPPORTED_CAPABILITY:"));
        }
        assert!(authorize(&scope, Kind::Save)
            .unwrap_err()
            .starts_with("PERMISSION_DENIED:"));
        let mut stale = scope.clone();
        stale.generation += 1;
        assert!(authorize(&stale, Kind::Open)
            .unwrap_err()
            .starts_with("PERMISSION_DENIED:"));
        STATE.with(|slot| slot.borrow_mut().policy.close_view(scope.view));
        assert!(authorize(&scope, Kind::Open)
            .unwrap_err()
            .starts_with("PERMISSION_DENIED:"));
        STATE.with(|slot| *slot.borrow_mut() = Default::default());
    }
}
