//! Scoped text status items. Registry retirement never enters AppKit while
//! HostState is borrowed; the owning UI task performs real platform removal.
use super::{captured_ready_scope, event, policy_scope, reply, STATE};
use crate::capability_policy::{
    self, AdapterAvailability, DocumentScope, GateDecision, NativeRequest,
};
use cef::*;
use serde::Deserialize;
use serde_json::{json, Value};
#[cfg(target_os = "macos")]
use std::rc::Rc;
use std::{cell::RefCell, collections::BTreeMap, sync::atomic::Ordering};

#[cfg(target_os = "macos")]
#[path = "status_items_macos.rs"]
mod macos;

pub(super) const SUPPORTED: bool = cfg!(target_os = "macos");
const MAX_ITEMS: usize = 4;

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct Definition {
    title: String,
    #[serde(default)]
    tooltip: String,
}
impl Definition {
    fn parse(value: &Value) -> Result<Self, String> {
        let definition: Self = serde_json::from_value(value.clone()).map_err(|_| invalid())?;
        let text = |value: &str, maximum: usize| {
            value.len() <= maximum && !value.chars().any(char::is_control)
        };
        if definition.title.trim().is_empty()
            || !text(&definition.title, 64)
            || !text(&definition.tooltip, 256)
        {
            return Err(invalid());
        }
        Ok(definition)
    }
}
#[derive(Clone)]
struct Registration {
    token: String,
    birth: u64,
    scope: DocumentScope,
    sequence: u64,
    retired: bool,
    phase: Phase,
    #[cfg(target_os = "macos")]
    native: Option<Rc<macos::Item>>,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Phase {
    Creating,
    Ready,
    Removing,
}
#[derive(Default)]
struct Registry {
    records: BTreeMap<String, Registration>,
    next: u64,
    cleanup_queued: bool,
    created: u64,
    removed: u64,
    clicks: u64,
    shutdown_emitted: bool,
}
impl Registry {
    fn admit(&mut self, token: String, scope: DocumentScope) -> Result<Registration, String> {
        if self.records.len() >= MAX_ITEMS
            || self.records.contains_key(&token)
            || self
                .records
                .values()
                .any(|record| record.scope.view == scope.view)
        {
            return Err("RESOURCE_IN_USE: status item capacity exceeded".into());
        }
        self.next = crate::rpc_protocol::next(self.next)
            .ok_or("RESOURCE_IN_USE: status item identity exhausted")?;
        let record = Registration {
            token: token.clone(),
            birth: self.next,
            scope,
            sequence: 0,
            retired: false,
            phase: Phase::Creating,
            #[cfg(target_os = "macos")]
            native: None,
        };
        self.records.insert(token, record.clone());
        Ok(record)
    }
    fn begin_removal(&mut self, expected: &Registration) -> Option<Registration> {
        let current = self
            .records
            .get_mut(&expected.token)
            .filter(|current| current.birth == expected.birth && current.scope == expected.scope)?;
        current.retired = true;
        if current.phase != Phase::Ready {
            return None;
        }
        current.phase = Phase::Removing;
        Some(current.clone())
    }
    fn finish_removal(&mut self, expected: &Registration, removed: bool) -> Option<Registration> {
        if !self.records.get(&expected.token).is_some_and(|current| {
            current.birth == expected.birth
                && current.scope == expected.scope
                && current.phase == Phase::Removing
        }) {
            return None;
        }
        if removed {
            self.removed += 1;
        }
        self.records.remove(&expected.token)
    }
}
thread_local! { static ITEMS: RefCell<Registry> = RefCell::new(Registry::default()); }
fn invalid() -> String {
    "INVALID_ARGUMENT: invalid text status item".into()
}
fn fields(args: &Value, expected: &[&str]) -> Result<(), String> {
    let object = args.as_object().ok_or_else(invalid)?;
    if object.len() != expected.len() || expected.iter().any(|key| !object.contains_key(*key)) {
        return Err(invalid());
    }
    Ok(())
}
fn token(args: &Value) -> Result<&str, String> {
    args.get("registration")
        .and_then(Value::as_str)
        .filter(|value| {
            value.len() == 32
                && value
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        })
        .ok_or_else(invalid)
}
fn authorize(scope: &DocumentScope) -> Result<(), String> {
    if super::RPC_STOPPED.load(Ordering::SeqCst) || super::QUITTING.load(Ordering::SeqCst) {
        return Err("PERMISSION_DENIED: native application is shutting down".into());
    }
    let grants = STATE.with(|state| {
        let state = state.borrow();
        captured_ready_scope(&state, scope.view, scope)
            .map_err(|_| "PERMISSION_DENIED: status item document authority changed")?;
        state
            .policy
            .native_grants(scope)
            .ok_or("PERMISSION_DENIED: missing status item authority")
    })?;
    match capability_policy::authorize_native_grants(
        &grants,
        &NativeRequest::StatusItem,
        AdapterAvailability::Available,
    ) {
        GateDecision::Authorized => Ok(()),
        _ => Err("PERMISSION_DENIED: missing status-item document grant".into()),
    }
}
fn same(record: &Registration) -> Result<(), String> {
    let current = ITEMS.with(|items| {
        items
            .borrow()
            .records
            .get(&record.token)
            .is_some_and(|value| {
                value.birth == record.birth
                    && value.scope == record.scope
                    && value.phase == Phase::Ready
                    && !value.retired
            })
    });
    if !current {
        return Err("DISPOSED: status item retired".into());
    }
    authorize(&record.scope)
}
fn emit(record: &Registration, kind: &str) {
    let sequence = ITEMS.with(|items| {
        let mut items = items.borrow_mut();
        let current = items
            .records
            .get_mut(&record.token)
            .filter(|value| value.birth == record.birth)?;
        current.sequence = crate::rpc_protocol::next(current.sequence)?;
        Some(current.sequence)
    });
    let Some(sequence) = sequence else {
        super::fail("Status item event identity exhausted");
        return;
    };
    event(
        "status.item",
        record.scope.view,
        json!({"registration":record.token,"sequence":sequence,"type":kind}),
    );
}
#[cfg(target_os = "macos")]
fn clicked(token: &str, birth: u64) {
    let record = ITEMS.with(|items| {
        items
            .borrow()
            .records
            .get(token)
            .filter(|record| {
                record.birth == birth && record.phase == Phase::Ready && !record.retired
            })
            .cloned()
    });
    let Some(record) = record else {
        return;
    };
    if same(&record).is_err() {
        retire_view(record.scope.view);
        return;
    }
    let counted = ITEMS.with(|items| {
        let mut items = items.borrow_mut();
        let Some(next) = crate::rpc_protocol::next(items.clicks) else {
            return false;
        };
        items.clicks = next;
        true
    });
    if !counted {
        super::fail("Status item callback count exhausted");
        return;
    }
    emit(&record, "click");
}
/// Called during native document revocation. Only plain data changes before the queued task.
pub(super) fn retire_view(view: u64) {
    let (records, schedule) = ITEMS.with(|items| {
        let mut items = items.borrow_mut();
        let mut records = Vec::new();
        for record in items.records.values_mut() {
            if record.scope.view == view && !record.retired {
                record.retired = true;
                records.push(record.clone());
            }
        }
        let schedule = !records.is_empty() && !items.cleanup_queued;
        items.cleanup_queued |= schedule;
        (records, schedule)
    });
    for record in records {
        emit(&record, "revoked");
    }
    if schedule {
        let mut task = Cleanup::new();
        if post_task(ThreadId::UI, Some(&mut task)) == 0 {
            super::fail("Status item cleanup unavailable");
        }
    }
}
wrap_task! { struct Cleanup; impl Task { fn execute(&self) { drain_retired(); } } }
fn drain_retired() {
    let records = ITEMS.with(|items| {
        let mut items = items.borrow_mut();
        items.cleanup_queued = false;
        items
            .records
            .values()
            .filter(|record| record.retired)
            .cloned()
            .collect::<Vec<_>>()
    });
    for record in records {
        release(&record);
    }
}
fn release(record: &Registration) {
    // A nested close may retire a pending creation or removal, but cannot release
    // its reservation while the outer AppKit call still owns native work.
    let current = ITEMS.with(|items| items.borrow_mut().begin_removal(record));
    let Some(current) = current else {
        return;
    };
    #[cfg(target_os = "macos")]
    let removed = match current
        .native
        .as_ref()
        .map(|item| item.remove())
        .transpose()
    {
        Ok(value) => value.unwrap_or(false),
        Err(_) => {
            ITEMS.with(|items| {
                if let Some(value) =
                    items
                        .borrow_mut()
                        .records
                        .get_mut(&current.token)
                        .filter(|value| {
                            value.birth == current.birth
                                && value.scope == current.scope
                                && value.phase == Phase::Removing
                        })
                {
                    value.phase = Phase::Ready;
                }
            });
            super::fail("Status item native removal failed");
            return;
        }
    };
    #[cfg(not(target_os = "macos"))]
    let removed = false;
    // The item, delegate and callback owner remain retained through actual removal.
    let retired = ITEMS.with(|items| items.borrow_mut().finish_removal(&current, removed));
    drop(retired);
}
pub(super) fn release_all() {
    let records = ITEMS.with(|items| items.borrow().records.values().cloned().collect::<Vec<_>>());
    for record in records {
        release(&record);
    }
}
fn snapshot() -> Value {
    ITEMS.with(|items| {
        let items = items.borrow();
        let owned = items.records.len();
        json!({"supported":SUPPORTED,"items":owned,"delegates":owned,"weakOwners":owned,"created":items.created,"removed":items.removed,"clicks":items.clicks})
    })
}
pub(super) fn shutdown_receipt() {
    let first = ITEMS.with(|items| {
        let mut items = items.borrow_mut();
        !std::mem::replace(&mut items.shutdown_emitted, true)
    });
    if !first {
        return;
    }
    let state = snapshot();
    if state["items"] != 0 || state["created"] != state["removed"] {
        super::FAILED.store(true, Ordering::SeqCst);
        eprintln!(
            "{}",
            json!({"event":"bunly.host.failure","error":"Native status items remain owned at shutdown"})
        );
    }
    eprintln!(
        "{}",
        json!({"event":"bunly.host.status-shutdown","state":state})
    );
    crate::process::emit(json!({"v":1,"event":"status.shutdown","data":state}));
}
pub(super) fn dispatch(request: u64, operation: &str, args: &Value) -> Result<(), String> {
    #[cfg(feature = "rpc-qualification")]
    if operation == "status.qualification.snapshot" {
        fields(args, &[])?;
        drain_retired();
        reply(request, snapshot());
        return Ok(());
    }
    if !SUPPORTED {
        return Err("UNSUPPORTED_CAPABILITY: native status items unavailable".into());
    }
    let scope = policy_scope(args)?;
    let token = token(args)?.to_owned();
    if operation == "status.create" {
        fields(args, &["registration", "scope", "definition"])?;
        let definition = Definition::parse(&args["definition"])?;
        authorize(&scope)?;
        drain_retired();
        let record = ITEMS.with(|items| items.borrow_mut().admit(token, scope))?;
        #[cfg(target_os = "macos")]
        let created = (|| {
            let item = Rc::new(macos::Item::create(
                record.token.clone(),
                record.birth,
                &definition,
            )?);
            ITEMS.with(|items| {
                let mut items = items.borrow_mut();
                let next = crate::rpc_protocol::next(items.created)
                    .ok_or("Status item creation count exhausted")?;
                let current = items
                    .records
                    .get_mut(&record.token)
                    .filter(|value| {
                        value.birth == record.birth
                            && value.scope == record.scope
                            && value.phase == Phase::Creating
                    })
                    .ok_or("Status item creation owner changed")?;
                // The outer Rc remains live while this borrow is held, including
                // the error path. No native item may be dropped under ITEMS.
                current.native = Some(Rc::clone(&item));
                current.phase = Phase::Ready;
                items.created = next;
                Ok::<_, String>(())
            })?;
            same(&record)
        })();
        #[cfg(not(target_os = "macos"))]
        let created: Result<(), String> = {
            let _ = definition;
            Err("UNSUPPORTED_CAPABILITY: native status items unavailable".into())
        };
        if let Err(error) = created {
            ITEMS.with(|items| {
                if let Some(current) =
                    items
                        .borrow_mut()
                        .records
                        .get_mut(&record.token)
                        .filter(|current| {
                            current.birth == record.birth
                                && current.scope == record.scope
                                && current.phase == Phase::Creating
                        })
                {
                    current.phase = Phase::Ready;
                }
            });
            release(&record);
            return Err(error);
        }
        reply(request, Value::Null);
        return Ok(());
    }
    let record = ITEMS.with(|items| items.borrow().records.get(&token).cloned());
    if record.as_ref().is_some_and(|record| record.scope != scope) {
        return Err("PERMISSION_DENIED: foreign status item scope".into());
    }
    if operation == "status.dispose" {
        fields(args, &["registration", "scope"])?;
        if let Some(record) = record {
            release(&record);
        }
        if ITEMS.with(|items| items.borrow().records.contains_key(&token)) {
            return Err("RESOURCE_IN_USE: status item native removal remains pending".into());
        }
        reply(request, Value::Null);
        return Ok(());
    }
    let record = record.ok_or("DISPOSED: status item retired")?;
    same(&record)?;
    if operation == "status.update" {
        fields(args, &["registration", "scope", "definition"])?;
        let definition = Definition::parse(&args["definition"])?;
        #[cfg(target_os = "macos")]
        record
            .native
            .as_ref()
            .ok_or("DISPOSED: native status item unavailable")?
            .update(&definition)?;
        #[cfg(not(target_os = "macos"))]
        let _ = definition;
    } else {
        #[cfg(all(target_os = "macos", feature = "rpc-qualification"))]
        if operation == "status.qualification.click" {
            fields(args, &["registration", "scope"])?;
            record
                .native
                .as_ref()
                .ok_or("DISPOSED: native status item unavailable")?
                .click()?;
        } else {
            return Err("UNSUPPORTED_CAPABILITY: status item operation".into());
        }
        #[cfg(not(all(target_os = "macos", feature = "rpc-qualification")))]
        return Err("UNSUPPORTED_CAPABILITY: status item operation".into());
    }
    same(&record)?;
    reply(request, Value::Null);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn scope(view: u64) -> DocumentScope {
        DocumentScope {
            view,
            session: 1,
            generation: 1,
            main_frame: "main".into(),
            document: "document".into(),
            origin: "app://ui".into(),
        }
    }
    #[test]
    fn text_only_definition_is_bounded_and_exact() {
        assert!(Definition::parse(&json!({"title":"Bunly Ω","tooltip":"Ready"})).is_ok());
        assert!(
            Definition::parse(&json!({"title":"a".repeat(64),"tooltip":"b".repeat(256)})).is_ok()
        );
        for value in [
            json!({"title":""}),
            json!({"title":"a".repeat(65)}),
            json!({"title":"Ω".repeat(33)}),
            json!({"title":"Title","tooltip":"b".repeat(257)}),
            json!({"title":"line\nbreak"}),
            json!({"title":"Title\u{85}"}),
            json!({"title":"Title","icon":"path"}),
            json!({"title":"Title","tooltip":null}),
        ] {
            assert!(Definition::parse(&value).is_err());
        }
    }
    #[test]
    fn pending_and_retired_items_stay_charged_until_removed() {
        let mut registry = Registry::default();
        let first = registry.admit("first".into(), scope(1)).unwrap();
        assert!(registry.admit("duplicate-view".into(), scope(1)).is_err());
        registry.records.get_mut("first").unwrap().retired = true;
        assert!(registry.admit("replacement".into(), scope(1)).is_err());
        for view in 2..=4 {
            registry.admit(view.to_string(), scope(view)).unwrap();
        }
        assert!(registry.admit("fifth".into(), scope(5)).is_err());
        registry.records.remove("first");
        let replacement = registry.admit("first".into(), scope(1)).unwrap();
        assert!(replacement.birth > first.birth);
    }
    #[test]
    fn nested_removal_keeps_capacity_until_the_outer_native_call_returns() {
        let mut registry = Registry::default();
        let first = registry.admit("token".into(), scope(1)).unwrap();
        registry.records.get_mut("token").unwrap().phase = Phase::Ready;
        registry.created = 1;
        let removing = registry.begin_removal(&first).unwrap();
        assert!(registry.begin_removal(&first).is_none());
        assert!(registry.admit("replacement".into(), scope(1)).is_err());
        assert_eq!(registry.records.len(), 1);
        assert_eq!(registry.removed, 0);
        drop(registry.finish_removal(&removing, true).unwrap());
        assert_eq!(registry.removed, 1);
        let replacement = registry.admit("token".into(), scope(1)).unwrap();
        assert!(registry.finish_removal(&removing, true).is_none());
        assert_eq!(registry.records["token"].birth, replacement.birth);
        assert_eq!(registry.removed, 1);
    }
    #[test]
    fn reentrant_retirement_during_creation_waits_for_native_creation_to_settle() {
        let mut registry = Registry::default();
        let creating = registry.admit("token".into(), scope(1)).unwrap();
        assert!(registry.begin_removal(&creating).is_none());
        assert!(registry.records["token"].retired);
        assert_eq!(registry.records["token"].phase, Phase::Creating);
        assert!(registry.admit("replacement".into(), scope(1)).is_err());
        // The creator later publishes its retained owner, then immediately
        // removes the retired item; no nested release can steal its slot.
        registry.records.get_mut("token").unwrap().phase = Phase::Ready;
        registry.created = 1;
        let removing = registry.begin_removal(&creating).unwrap();
        assert!(registry.finish_removal(&removing, true).is_some());
        assert_eq!(registry.created, registry.removed);
        assert!(registry.records.is_empty());
    }
}
