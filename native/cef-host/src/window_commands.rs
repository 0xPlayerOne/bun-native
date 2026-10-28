//! Application-owned popup menus and window-local accelerators. No Chromium command IDs,
//! renderer commands, global shortcuts, system menubar, or implicit file/URL actions.
use super::native_modal::{self, Owner as ModalOwner};
use super::{captured_ready_scope, event, policy_scope, reply, STATE};
use crate::capability_policy::{
    self, AdapterAvailability, DocumentScope, GateDecision, NativeRequest,
};
use cef::*;
use serde::Deserialize;
use serde_json::{json, Value};
use std::cell::RefCell;
use std::collections::{BTreeMap, BTreeSet};
use std::sync::{atomic::Ordering, Arc};

#[cfg(all(target_os = "macos", feature = "rpc-qualification"))]
#[path = "window_commands_macos.rs"]
mod macos;

const MAX_REGISTRATIONS: usize = 64;
const MAX_PER_WINDOW: usize = 8;
const MAX_COMMANDS: usize = 32;
const MAX_MENU_ITEMS: usize = 64;
const MAX_DEPTH: usize = 3;
const FIRST_COMMAND_ID: i32 = 1_000_000;
fn invalid() -> String {
    "INVALID_ARGUMENT: invalid bounded window command definition".into()
}
fn busy() -> String {
    "RESOURCE_IN_USE: window command capacity or shortcut already in use".into()
}
fn yes() -> bool {
    true
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(deny_unknown_fields)]
struct Shortcut {
    key: String,
    #[serde(default)]
    control: bool,
    #[serde(default)]
    alt: bool,
    #[serde(default)]
    shift: bool,
}
impl Shortcut {
    fn key_code(&self) -> Result<i32, String> {
        let key = self.key.as_bytes();
        if key.len() == 1 && (key[0].is_ascii_uppercase() || key[0].is_ascii_digit()) {
            if !self.control && !self.alt {
                return Err(invalid());
            }
            return Ok(i32::from(key[0]));
        }
        match self.key.as_str() {
            "F1" => Ok(112),
            "F2" => Ok(113),
            "F3" => Ok(114),
            "F4" => Ok(115),
            "F5" => Ok(116),
            "F6" => Ok(117),
            "F7" => Ok(118),
            "F8" => Ok(119),
            "F9" => Ok(120),
            "F10" => Ok(121),
            "F11" => Ok(122),
            "F12" => Ok(123),
            _ => Err(invalid()),
        }
    }
}
fn optional_shortcut<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<Shortcut>, D::Error> {
    Shortcut::deserialize(deserializer).map(Some)
}
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Command {
    id: String,
    label: String,
    #[serde(default = "yes")]
    enabled: bool,
    #[serde(default, deserialize_with = "optional_shortcut")]
    shortcut: Option<Shortcut>,
}
#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase", deny_unknown_fields)]
enum Item {
    Command { command: String },
    Separator,
    Submenu { label: String, items: Vec<Item> },
}
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Definition {
    commands: Vec<Command>,
    menu: Vec<Item>,
}
fn valid_label(label: &str) -> bool {
    !label.trim().is_empty()
        && label.len() <= 128
        && !label
            .chars()
            .any(|c| c <= '\u{1f}' || c == '\u{7f}' || c == '&')
}
fn valid_id(id: &str) -> bool {
    let bytes = id.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 32
        && bytes[0].is_ascii_lowercase()
        && bytes
            .iter()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'.' || *b == b'-')
}
impl Definition {
    fn parse(value: &Value) -> Result<Self, String> {
        let definition: Self = serde_json::from_value(value.clone()).map_err(|_| invalid())?;
        if definition.commands.is_empty() || definition.commands.len() > MAX_COMMANDS {
            return Err(invalid());
        }
        let mut ids = BTreeSet::new();
        let mut shortcuts = BTreeSet::new();
        for command in &definition.commands {
            if !valid_id(&command.id)
                || !valid_label(&command.label)
                || !ids.insert(command.id.clone())
            {
                return Err(invalid());
            }
            if let Some(shortcut) = &command.shortcut {
                shortcut.key_code()?;
                if !shortcuts.insert(shortcut.clone()) {
                    return Err(invalid());
                }
            }
        }
        fn validate_items(
            items: &[Item],
            depth: usize,
            count: &mut usize,
            ids: &BTreeSet<String>,
            used: &mut BTreeSet<String>,
        ) -> Result<(), String> {
            if depth > MAX_DEPTH || items.len() > MAX_MENU_ITEMS {
                return Err(invalid());
            }
            let mut separator = true;
            for item in items {
                *count += 1;
                if *count > MAX_MENU_ITEMS {
                    return Err(invalid());
                }
                match item {
                    Item::Separator if separator => return Err(invalid()),
                    Item::Separator => separator = true,
                    Item::Command { command } => {
                        separator = false;
                        if !ids.contains(command) || !used.insert(command.clone()) {
                            return Err(invalid());
                        }
                    }
                    Item::Submenu {
                        label,
                        items: children,
                    } => {
                        separator = false;
                        if !valid_label(label) || children.is_empty() {
                            return Err(invalid());
                        }
                        validate_items(children, depth + 1, count, ids, used)?;
                    }
                }
            }
            if !items.is_empty() && separator {
                return Err(invalid());
            }
            Ok(())
        }
        validate_items(&definition.menu, 1, &mut 0, &ids, &mut BTreeSet::new())?;
        if definition.menu.is_empty() && shortcuts.is_empty() {
            return Err(invalid());
        }
        Ok(definition)
    }
}
#[derive(Clone)]
struct Registration {
    token: String,
    scope: DocumentScope,
    window: u64,
    definition: Arc<Definition>,
    ids: Vec<i32>,
    sequence: u64,
    last_popup: u64,
    retired: bool,
    accelerators_removed: bool,
    dispose_requests: Vec<u64>,
    #[cfg(feature = "rpc-qualification")]
    select_first: bool,
}
impl Registration {
    fn birth(&self) -> i32 {
        self.ids[0]
    }
}
#[derive(Clone)]
struct Popup {
    birth: i32,
    id: u64,
    modal_lease: u64,
    shown: bool,
    cancelled: bool,
}
struct Registry {
    registrations: BTreeMap<String, Registration>,
    popup: Option<Popup>,
    next_id: i32,
    cleanup_queued: bool,
    #[cfg(any(target_os = "macos", test))]
    tracking: Option<(i32, u64)>,
}
impl Default for Registry {
    fn default() -> Self {
        Self {
            registrations: BTreeMap::new(),
            popup: None,
            next_id: FIRST_COMMAND_ID,
            cleanup_queued: false,
            #[cfg(any(target_os = "macos", test))]
            tracking: None,
        }
    }
}
impl Registry {
    #[cfg(any(target_os = "macos", test))]
    fn cancel_tracking(&mut self, command: Option<&Value>, quitting: bool) -> Option<u64> {
        let tracking = self.tracking?;
        let popup = self.popup.as_ref()?;
        if tracking != (popup.birth, popup.id) || !popup.shown || popup.cancelled {
            return None;
        }
        let record = self
            .registrations
            .values()
            .find(|record| record.birth() == popup.birth)?;
        let authorized = match command {
            Some(command) => pending_cleanup_matches(record, popup, command),
            None => quitting || record.retired,
        };
        if !authorized {
            return None;
        }
        let window = record.window;
        // Cancellation fences command callbacks immediately. It does not
        // release the popup, modal lease, registration or accelerator owners.
        self.popup.as_mut().unwrap().cancelled = true;
        Some(window)
    }
    fn begin_popup(&mut self, record: &Registration, popup: u64) -> Result<(), String> {
        if self.popup.is_some() {
            return Err(busy());
        }
        let current = self
            .registrations
            .get_mut(&record.token)
            .filter(|r| r.birth() == record.birth() && !r.retired && r.scope == record.scope)
            .ok_or_else(busy)?;
        if popup <= current.last_popup || popup > crate::rpc_protocol::MAX_ID {
            return Err(invalid());
        }
        let modal_lease = native_modal::reserve(ModalOwner::WindowMenu)?;
        current.last_popup = popup;
        self.popup = Some(Popup {
            birth: record.birth(),
            id: popup,
            modal_lease,
            shown: false,
            cancelled: false,
        });
        Ok(())
    }
    fn close_popup(&mut self, birth: i32, popup: u64) -> bool {
        if self
            .popup
            .as_ref()
            .is_some_and(|p| p.birth == birth && p.id == popup)
        {
            if !native_modal::release(
                ModalOwner::WindowMenu,
                self.popup.as_ref().unwrap().modal_lease,
            ) {
                super::fail("Native popup modal ownership changed");
                return false;
            }
            self.popup = None;
            true
        } else {
            false
        }
    }
    fn finish_release(&mut self, record: &Registration) -> Vec<u64> {
        if self
            .popup
            .as_ref()
            .is_some_and(|popup| popup.birth == record.birth())
        {
            return Vec::new();
        }
        if self
            .registrations
            .get(&record.token)
            .is_some_and(|r| r.birth() == record.birth() && r.retired && r.accelerators_removed)
        {
            return self
                .registrations
                .remove(&record.token)
                .unwrap()
                .dispose_requests;
        }
        Vec::new()
    }
    fn reserve_ids(&mut self, count: usize) -> Result<Vec<i32>, String> {
        let end = self
            .next_id
            .checked_add(i32::try_from(count).map_err(|_| busy())?)
            .ok_or_else(busy)?;
        let ids = (self.next_id..end).collect();
        self.next_id = end;
        Ok(ids)
    }
    fn admit(
        &mut self,
        token: String,
        scope: DocumentScope,
        window: u64,
        definition: Definition,
    ) -> Result<Registration, String> {
        if self.registrations.len() >= MAX_REGISTRATIONS || self.registrations.contains_key(&token)
        {
            return Err(busy());
        }
        let siblings: Vec<_> = self
            .registrations
            .values()
            .filter(|r| r.window == window)
            .collect();
        if siblings.len() >= MAX_PER_WINDOW {
            return Err(busy());
        }
        for command in &definition.commands {
            if let Some(shortcut) = &command.shortcut {
                if siblings.iter().any(|r| {
                    r.definition
                        .commands
                        .iter()
                        .any(|c| c.shortcut.as_ref() == Some(shortcut))
                }) {
                    return Err(busy());
                }
            }
        }
        let ids = self.reserve_ids(definition.commands.len())?;
        let record = Registration {
            token: token.clone(),
            scope,
            window,
            definition: Arc::new(definition),
            ids,
            sequence: 0,
            last_popup: 0,
            retired: false,
            accelerators_removed: false,
            dispose_requests: Vec::new(),
            #[cfg(feature = "rpc-qualification")]
            select_first: false,
        };
        self.registrations.insert(token, record.clone());
        Ok(record)
    }
}
thread_local! { static COMMANDS: RefCell<Registry> = RefCell::new(Registry::default()); }

/// This is only a cancellation preflight. The original CEF task remains the
/// sole dispatcher/acknowledger. Match its exact cleanup field validation before
/// requesting any effect; stale scopes may release only their own registration.
#[cfg(any(target_os = "macos", test))]
fn pending_cleanup_matches(record: &Registration, popup: &Popup, command: &Value) -> bool {
    if super::number(command, "id").is_err() {
        return false;
    }
    let Some(operation) = command.get("op").and_then(Value::as_str) else {
        return false;
    };
    if operation == "quit" {
        // Quit is application-owned on the private pipe. It has no scoped
        // arguments in ordinary dispatch and still runs only after ShowMenu.
        return true;
    }
    let args = command.get("args").unwrap_or(&Value::Null);
    let expected: &[&str] = match operation {
        "commands.cancel" => &["registration", "scope", "popup"],
        "commands.dispose" => &["registration", "scope"],
        _ => return false,
    };
    fields(args, expected).is_ok()
        && token(args).is_ok_and(|token| token == record.token)
        && pending_scope_matches(&record.scope, &args["scope"])
        && record.birth() == popup.birth
        && (operation == "commands.dispose"
            || super::number(args, "popup").is_ok_and(|id| id == popup.id))
}

#[cfg(any(target_os = "macos", test))]
fn pending_scope_matches(scope: &DocumentScope, value: &Value) -> bool {
    // This scope was validated at native registration. Compare its entire exact
    // wire shape by borrowing the already-admitted Value, without cloning even
    // a malformed/oversized scope while inspecting the cleanup queue.
    value.as_object().is_some_and(|value| {
        value.len() == 6
            && value.get("view").and_then(Value::as_u64) == Some(scope.view)
            && value.get("session").and_then(Value::as_u64) == Some(scope.session)
            && value.get("generation").and_then(Value::as_u64) == Some(scope.generation)
            && value.get("mainFrame").and_then(Value::as_str) == Some(scope.main_frame.as_str())
            && value.get("document").and_then(Value::as_str) == Some(scope.document.as_str())
            && value.get("origin").and_then(Value::as_str) == Some(scope.origin.as_str())
    })
}

#[cfg(target_os = "macos")]
struct TrackingGuard(i32, u64);
#[cfg(target_os = "macos")]
impl TrackingGuard {
    fn begin(birth: i32, popup: u64) -> Result<Self, String> {
        COMMANDS.with(|registry| {
            let mut registry = registry.borrow_mut();
            if registry.tracking.is_some()
                || !registry
                    .popup
                    .as_ref()
                    .is_some_and(|p| p.birth == birth && p.id == popup)
            {
                return Err(busy());
            }
            registry.tracking = Some((birth, popup));
            Ok(Self(birth, popup))
        })
    }
}
#[cfg(target_os = "macos")]
impl Drop for TrackingGuard {
    fn drop(&mut self) {
        COMMANDS.with(|registry| {
            let mut registry = registry.borrow_mut();
            if registry.tracking == Some((self.0, self.1)) {
                registry.tracking = None;
            }
        });
    }
}

#[cfg(target_os = "macos")]
fn cancel_tracking(command: Option<&Value>, quitting: bool) {
    let owner = COMMANDS.with(|registry| registry.borrow_mut().cancel_tracking(command, quitting));
    let window = owner.and_then(|owner| {
        STATE.with(|state| {
            state
                .borrow()
                .windows
                .get(&owner)
                .and_then(|record| record.window.clone())
        })
    });
    // No registry borrow crosses AppKit/CEF reentrancy. Only this exact current
    // popup is cancelled; actual MenuClosed and normal FIFO dispatch settle it.
    if let Some(window) = window {
        window.cancel_menu();
    }
}
#[cfg(target_os = "macos")]
pub(super) fn cancel_retired_tracking(quitting: bool) {
    cancel_tracking(None, quitting);
}
#[cfg(target_os = "macos")]
pub(super) fn cancel_tracking_for_command(command: &Value) {
    cancel_tracking(Some(command), false);
}

fn authorize(scope: &DocumentScope) -> Result<(), String> {
    if super::RPC_STOPPED.load(Ordering::SeqCst) || super::QUITTING.load(Ordering::SeqCst) {
        return Err("PERMISSION_DENIED: native application is shutting down".into());
    }
    let grants = STATE.with(|state| {
        let state = state.borrow();
        captured_ready_scope(&state, scope.view, scope)
            .map_err(|_| "PERMISSION_DENIED: window command document authority changed")?;
        state
            .policy
            .native_grants(scope)
            .ok_or("PERMISSION_DENIED: missing window command authority")
    })?;
    match capability_policy::authorize_native_grants(
        &grants,
        &NativeRequest::WindowCommands,
        AdapterAvailability::Available,
    ) {
        GateDecision::Authorized => Ok(()),
        _ => Err("PERMISSION_DENIED: missing window-commands document grant".into()),
    }
}
fn window(id: u64) -> Result<Window, String> {
    STATE.with(|state| {
        let state = state.borrow();
        let owner = state
            .windows
            .get(&id)
            .ok_or("DISPOSED: command owner window closed")?;
        if owner.closing.is_some() {
            return Err("DISPOSED: command owner window closing".into());
        }
        owner
            .window
            .clone()
            .ok_or_else(|| "DISPOSED: command owner window unavailable".into())
    })
}
fn same(record: &Registration) -> Result<(), String> {
    let current = COMMANDS.with(|registry| {
        registry
            .borrow()
            .registrations
            .get(&record.token)
            .is_some_and(|r| !r.retired && r.birth() == record.birth() && r.scope == record.scope)
    });
    if !current {
        return Err("DISPOSED: window command registration retired".into());
    }
    authorize(&record.scope)
}
fn emit(record: &Registration, mut data: Value) {
    let sequence = COMMANDS.with(|registry| {
        let mut registry = registry.borrow_mut();
        let current = registry.registrations.get_mut(&record.token)?;
        if current.birth() != record.birth() {
            return None;
        }
        current.sequence = crate::rpc_protocol::next(current.sequence)?;
        Some(current.sequence)
    });
    let Some(sequence) = sequence else {
        super::fail("Window command event identity exhausted");
        return;
    };
    data["registration"] = json!(record.token);
    data["sequence"] = json!(sequence);
    event("window.commands", record.scope.view, data);
}

/// May run under STATE's borrow. Only plain registry data is retired here; CEF
/// cleanup is posted and cannot synchronously reenter that borrow.
pub(super) fn retire_view(view: u64) {
    let (retired, schedule) = COMMANDS.with(|registry| {
        let mut registry = registry.borrow_mut();
        let mut retired = Vec::new();
        for record in registry.registrations.values_mut() {
            if record.scope.view == view && !record.retired {
                record.retired = true;
                retired.push(record.clone());
            }
        }
        let schedule = !retired.is_empty() && !registry.cleanup_queued;
        registry.cleanup_queued |= schedule;
        (retired, schedule)
    });
    for record in retired {
        emit(&record, json!({"type":"revoked"}));
    }
    if schedule {
        let mut task = Cleanup::new();
        if post_task(ThreadId::UI, Some(&mut task)) == 0 {
            super::fail("Window command cleanup unavailable");
        }
        #[cfg(target_os = "macos")]
        super::native_menu_wake::wake();
    }
}
wrap_task! { struct Cleanup; impl Task { fn execute(&self) { drain_retired(); } } }
fn drain_retired() {
    let records = COMMANDS.with(|registry| {
        let mut registry = registry.borrow_mut();
        registry.cleanup_queued = false;
        registry
            .registrations
            .values()
            .filter(|r| r.retired)
            .cloned()
            .collect::<Vec<_>>()
    });
    for record in records {
        release(&record);
    }
}
pub(super) fn verify_shutdown() {
    let released = COMMANDS.with(|registry| {
        let registry = registry.borrow();
        registry.registrations.is_empty() && registry.popup.is_none()
    });
    if !released {
        // The private process-stop receipt follows this final UI fence. Mark
        // failure before it is sent; fallback release is not completed disposal.
        super::FAILED.store(true, Ordering::SeqCst);
        eprintln!(
            "{}",
            json!({"event":"bunly.host.failure","error":"Native window commands remain owned at shutdown"})
        );
    }
}
pub(super) fn release_all() {
    let records = COMMANDS.with(|registry| {
        registry
            .borrow()
            .registrations
            .values()
            .cloned()
            .collect::<Vec<_>>()
    });
    for record in records {
        release(&record);
    }
    if COMMANDS.with(|registry| !registry.borrow().registrations.is_empty()) {
        // This is a final failure fallback after the native loop, not evidence of
        // successful menu disposal. Orderly closure uses MenuClosed/WindowDestroyed.
        super::FAILED.store(true, Ordering::SeqCst);
    }
}
fn finish_release(record: &Registration) {
    let requests = COMMANDS.with(|registry| registry.borrow_mut().finish_release(record));
    for request in requests {
        reply(request, Value::Null);
    }
}
fn release(record: &Registration) {
    let (remove, cancel) = COMMANDS.with(|registry| {
        let mut registry = registry.borrow_mut();
        let Some(current) = registry
            .registrations
            .get_mut(&record.token)
            .filter(|r| r.birth() == record.birth())
        else {
            return (false, false);
        };
        current.retired = true;
        let remove = !current.accelerators_removed;
        let cancel = registry.popup.as_mut().is_some_and(|popup| {
            if popup.birth != record.birth() {
                return false;
            }
            popup.cancelled = true;
            true
        });
        (remove, cancel)
    });
    // Cleanup must still reach a closing Window. No policy grant is needed to
    // release exactly the resource already owned by this registration.
    let owner = STATE.with(|state| {
        state
            .borrow()
            .windows
            .get(&record.window)
            .and_then(|w| w.window.clone())
    });
    if let Some(owner) = owner {
        if remove {
            for (command, id) in record.definition.commands.iter().zip(&record.ids) {
                if command.shortcut.is_some() {
                    owner.remove_accelerator(*id);
                }
            }
        }
        COMMANDS.with(|registry| {
            if let Some(current) = registry
                .borrow_mut()
                .registrations
                .get_mut(&record.token)
                .filter(|r| r.birth() == record.birth())
            {
                current.accelerators_removed = true;
            }
        });
        if cancel {
            owner.cancel_menu();
        }
    } else {
        // The WindowDestroyed callback already removed its native owner.
        COMMANDS.with(|registry| {
            let mut registry = registry.borrow_mut();
            if let Some(current) = registry
                .registrations
                .get_mut(&record.token)
                .filter(|r| r.birth() == record.birth())
            {
                current.accelerators_removed = true;
            }
            if let Some(popup) = registry.popup.clone().filter(|p| p.birth == record.birth()) {
                registry.close_popup(popup.birth, popup.id);
            }
        });
    }
    finish_release(record);
}
pub(super) fn window_destroyed(window: u64) {
    let records = COMMANDS.with(|registry| {
        registry
            .borrow()
            .registrations
            .values()
            .filter(|r| r.window == window)
            .cloned()
            .collect::<Vec<_>>()
    });
    for record in records {
        release(&record);
    }
}

fn command(record: &Registration, command_id: i32, popup: Option<u64>) {
    if same(record).is_err() {
        return;
    }
    let Some(index) = record.ids.iter().position(|id| *id == command_id) else {
        return;
    };
    let selected = &record.definition.commands[index];
    if !selected.enabled || (popup.is_none() && selected.shortcut.is_none()) {
        return;
    }
    if let Some(popup) = popup {
        let matches = COMMANDS.with(|registry| {
            registry.borrow().popup.as_ref().is_some_and(|p| {
                p.birth == record.birth() && p.id == popup && p.shown && !p.cancelled
            })
        });
        if !matches {
            return;
        }
        emit(
            record,
            json!({"type":"command","command":selected.id,"source":"menu","popup":popup}),
        );
    } else {
        emit(
            record,
            json!({"type":"command","command":selected.id,"source":"shortcut"}),
        );
    }
}
pub(super) fn accelerator(owner: u64, command_id: i32) -> i32 {
    let record = COMMANDS.with(|registry| {
        registry
            .borrow()
            .registrations
            .values()
            .find(|record| record.window == owner && record.ids.contains(&command_id))
            .cloned()
    });
    let Some(record) = record else {
        return 0;
    };
    // Consume even disabled/revoked commands during removal. Never dispatch an
    // application command ID through Chromium's built-in command machinery.
    command(&record, command_id, None);
    1
}
wrap_menu_model_delegate! {
    struct Menu { token: String, birth: i32, popup: u64 }
    impl MenuModelDelegate {
        fn execute_command(&self, _model: Option<&mut MenuModel>, command_id: i32, _flags: EventFlags) {
            if let Some(record) = callback_record(&self.token, self.birth) { command(&record, command_id, Some(self.popup)); }
        }
        fn menu_will_show(&self, model: Option<&mut MenuModel>) {
            if model.is_some_and(|model| model.is_sub_menu() == 0) { menu_shown(&self.token, self.birth, self.popup); }
        }
        fn menu_closed(&self, model: Option<&mut MenuModel>) {
            if model.is_some_and(|model| model.is_sub_menu() == 0) { menu_closed(&self.token, self.birth, self.popup); }
        }
    }
}
fn callback_record(token: &str, birth: i32) -> Option<Registration> {
    COMMANDS.with(|registry| {
        registry
            .borrow()
            .registrations
            .get(token)
            .filter(|r| r.birth() == birth && !r.retired)
            .cloned()
    })
}
fn menu_shown(token: &str, birth: i32, popup: u64) {
    let first = COMMANDS.with(|registry| {
        let mut registry = registry.borrow_mut();
        let Some(current) = registry
            .popup
            .as_mut()
            .filter(|p| p.birth == birth && p.id == popup)
        else {
            return false;
        };
        if current.shown {
            return false;
        }
        current.shown = true;
        true
    });
    if !first {
        return;
    }
    // An earlier cleanup wake may have run before this popup started. It must
    // remain inspectable now that Cocoa is about to enter its tracking loop.
    #[cfg(target_os = "macos")]
    super::native_menu_wake::wake();
    let Some(record) = callback_record(token, birth) else {
        return;
    };
    if same(&record).is_err() {
        retire_view(record.scope.view);
        return;
    }
    emit(&record, json!({"type":"menu-shown","popup":popup}));
    #[cfg(feature = "rpc-qualification")]
    if record.select_first {
        COMMANDS.with(|registry| {
            if let Some(r) = registry
                .borrow_mut()
                .registrations
                .get_mut(token)
                .filter(|r| r.birth() == birth && r.scope == record.scope)
            {
                r.select_first = false;
            }
        });
        #[cfg(target_os = "macos")]
        if let Some(owner) = selection_owner(token, birth, popup) {
            // Cocoa's native menu tracking disables nested application tasks.
            // Enqueue now, before returning from the real MenuWillShow callback;
            // posting a CEF task here cannot feed that tracking loop.
            if let Err(reason) = macos::queue_first_selection(&owner) {
                super::fail(reason);
            }
        }
        #[cfg(not(target_os = "macos"))]
        {
            let mut task = SelectFirst::new(token.to_owned(), birth, popup);
            if post_task(ThreadId::UI, Some(&mut task)) == 0 {
                super::fail("Menu qualification input unavailable");
            }
        }
    }
}
fn menu_closed(token: &str, birth: i32, popup: u64) {
    let closed = COMMANDS.with(|registry| registry.borrow_mut().close_popup(birth, popup));
    if closed {
        let record = COMMANDS.with(|registry| {
            registry
                .borrow()
                .registrations
                .get(token)
                .filter(|r| r.birth() == birth)
                .cloned()
        });
        if let Some(record) = record {
            if record.retired {
                finish_release(&record);
            } else if same(&record).is_ok() {
                emit(&record, json!({"type":"menu-closed","popup":popup}));
            } else {
                retire_view(record.scope.view);
            }
        }
    }
}
fn build_menu(record: &Registration, popup: u64) -> Result<MenuModel, String> {
    let mut delegate = Menu::new(record.token.clone(), record.birth(), popup);
    let model = menu_model_create(Some(&mut delegate)).ok_or("Native menu creation failed")?;
    fn append(model: &MenuModel, items: &[Item], record: &Registration) -> Result<(), String> {
        for item in items {
            let added = match item {
                Item::Separator => model.add_separator(),
                Item::Command { command } => {
                    let index = record
                        .definition
                        .commands
                        .iter()
                        .position(|c| c.id == *command)
                        .ok_or_else(invalid)?;
                    let command = &record.definition.commands[index];
                    let id = record.ids[index];
                    if model.add_item(id, Some(&CefString::from(command.label.as_str()))) == 0 {
                        return Err("Native menu item rejected".into());
                    }
                    if let Some(shortcut) = &command.shortcut {
                        if model.set_accelerator(
                            id,
                            shortcut.key_code()?,
                            i32::from(shortcut.shift),
                            i32::from(shortcut.control),
                            i32::from(shortcut.alt),
                        ) == 0
                        {
                            return Err("Native menu shortcut rejected".into());
                        }
                    }
                    model.set_enabled(id, i32::from(command.enabled))
                }
                Item::Submenu { label, items } => {
                    let id = COMMANDS.with(|registry| registry.borrow_mut().reserve_ids(1))?[0];
                    let child = model
                        .add_sub_menu(id, Some(&CefString::from(label.as_str())))
                        .ok_or("Native submenu rejected")?;
                    append(&child, items, record)?;
                    1
                }
            };
            if added == 0 {
                return Err("Native menu item rejected".into());
            }
        }
        Ok(())
    }
    append(&model, &record.definition.menu, record)?;
    Ok(model)
}
fn fields(args: &Value, allowed: &[&str]) -> Result<(), String> {
    let object = args.as_object().ok_or_else(invalid)?;
    if object.len() != allowed.len() || object.keys().any(|key| !allowed.contains(&key.as_str())) {
        return Err(invalid());
    }
    Ok(())
}
fn token(args: &Value) -> Result<&str, String> {
    args.get("registration")
        .and_then(Value::as_str)
        .filter(|token| {
            token.len() == 32
                && token
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        })
        .ok_or_else(invalid)
}
fn lookup(args: &Value, scope: &DocumentScope) -> Result<Option<Registration>, String> {
    let token = token(args)?;
    let record = COMMANDS.with(|registry| registry.borrow().registrations.get(token).cloned());
    if record.as_ref().is_some_and(|record| record.scope != *scope) {
        return Err("PERMISSION_DENIED: foreign window command scope".into());
    }
    Ok(record)
}
pub(super) fn dispatch(request: u64, operation: &str, args: &Value) -> Result<(), String> {
    #[cfg(feature = "rpc-qualification")]
    if operation == "commands.qualification.snapshot" {
        fields(args, &[])?;
        drain_retired();
        let snapshot = COMMANDS.with(|registry| {
            let registry = registry.borrow();
            json!({"registrations":registry.registrations.len(),"shortcuts":registry.registrations.values().map(|r|r.definition.commands.iter().filter(|c|c.shortcut.is_some()).count()).sum::<usize>(),"popups":usize::from(registry.popup.is_some())})
        });
        reply(request, snapshot);
        return Ok(());
    }
    let scope = policy_scope(args)?;
    if operation == "commands.create" {
        fields(args, &["registration", "scope", "definition"])?;
        let token = token(args)?.to_owned();
        let definition = Definition::parse(&args["definition"])?;
        authorize(&scope)?;
        drain_retired();
        let owner = STATE
            .with(|state| state.borrow().views.get(&scope.view).map(|v| v.window))
            .ok_or("PERMISSION_DENIED: command view closed")?;
        let window = window(owner)?;
        let record = COMMANDS
            .with(|registry| registry.borrow_mut().admit(token, scope, owner, definition))?;
        let result = (|| {
            for (command, id) in record.definition.commands.iter().zip(&record.ids) {
                if let Some(shortcut) = &command.shortcut {
                    same(&record)?;
                    window.set_accelerator(
                        *id,
                        shortcut.key_code()?,
                        i32::from(shortcut.shift),
                        i32::from(shortcut.control),
                        i32::from(shortcut.alt),
                        1,
                    );
                }
            }
            same(&record)
        })();
        if let Err(error) = result {
            release(&record);
            return Err(error);
        }
        reply(request, Value::Null);
        return Ok(());
    }
    let record = lookup(args, &scope)?;
    if operation == "commands.dispose" {
        fields(args, &["registration", "scope"])?;
        if let Some(record) = record {
            COMMANDS.with(|registry| {
                let mut registry = registry.borrow_mut();
                let current = registry
                    .registrations
                    .get_mut(&record.token)
                    .ok_or_else(busy)?;
                if current.dispose_requests.len() >= 4 {
                    return Err(busy());
                }
                current.dispose_requests.push(request);
                Ok(())
            })?;
            release(&record);
        } else {
            reply(request, Value::Null);
        }
        return Ok(());
    }
    if operation == "commands.cancel" {
        fields(args, &["registration", "scope", "popup"])?;
        let popup = super::number(args, "popup")?;
        if let Some(record) = record {
            let matches = COMMANDS.with(|registry| {
                registry.borrow_mut().popup.as_mut().is_some_and(|p| {
                    if p.birth != record.birth() || p.id != popup {
                        return false;
                    }
                    p.cancelled = true;
                    true
                })
            });
            if matches {
                // Retired scope may cancel only its exact owned popup; it never
                // acquires new authority or cancels a replacement registration.
                let owner = STATE.with(|state| {
                    state
                        .borrow()
                        .windows
                        .get(&record.window)
                        .and_then(|w| w.window.clone())
                });
                if let Some(owner) = owner {
                    owner.cancel_menu();
                }
            }
        }
        let pending = COMMANDS.with(|registry| {
            registry.borrow().popup.as_ref().is_some_and(|p| {
                p.id == popup
                    && registry
                        .borrow()
                        .registrations
                        .get(token(args).unwrap())
                        .is_some_and(|r| r.birth() == p.birth)
            })
        });
        reply(request, json!({"pending":pending}));
        return Ok(());
    }
    let record = record
        .filter(|r| !r.retired)
        .ok_or("DISPOSED: window command registration retired")?;
    same(&record)?;
    #[cfg(feature = "rpc-qualification")]
    if operation == "commands.qualification" {
        return qualify(request, args, &record);
    }
    if operation != "commands.show" {
        return Err("UNSUPPORTED_CAPABILITY: window command operation".into());
    }
    fields(args, &["registration", "scope", "popup", "point"])?;
    let popup = super::number(args, "popup")?;
    if record.definition.menu.is_empty() {
        return Err(invalid());
    }
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct ClientPoint {
        x: i32,
        y: i32,
    }
    let point: ClientPoint =
        serde_json::from_value(args["point"].clone()).map_err(|_| invalid())?;
    if !(0..=16383).contains(&point.x) || !(0..=16383).contains(&point.y) {
        return Err(invalid());
    }
    let owner = window(record.window)?;
    let client = owner.client_area_bounds_in_screen();
    if point.x >= client.width
        || point.y >= client.height
        || owner.is_drawn() == 0
        || owner.is_minimized() != 0
    {
        return Err("INVALID_ARGUMENT: menu point is outside the visible client area".into());
    }
    let screen = Point {
        x: client.x.checked_add(point.x).ok_or_else(invalid)?,
        y: client.y.checked_add(point.y).ok_or_else(invalid)?,
    };
    let mut model = build_menu(&record, popup)?;
    same(&record)?;
    COMMANDS.with(|registry| registry.borrow_mut().begin_popup(&record, popup))?;
    #[cfg(target_os = "macos")]
    let tracking = match TrackingGuard::begin(record.birth(), popup) {
        Ok(tracking) => tracking,
        Err(error) => {
            COMMANDS.with(|registry| registry.borrow_mut().close_popup(record.birth(), popup));
            return Err(error);
        }
    };
    // ShowMenu can enter a native nested loop. The admission reply is distinct
    // from MenuWillShow/MenuClosed and does not wait for human interaction.
    reply(request, Value::Null);
    owner.show_menu(Some(&mut model), Some(&screen), MenuAnchorPosition::TOPLEFT);
    #[cfg(target_os = "macos")]
    drop(tracking);
    // The pinned CEF implementations invoke MenuWillShow synchronously when a
    // menu starts. A void ShowMenu return without that callback is not proof of
    // visibility. Retire the failed popup and report that distinct outcome.
    let not_shown = COMMANDS.with(|registry| {
        let mut registry = registry.borrow_mut();
        if registry
            .popup
            .as_ref()
            .is_some_and(|p| p.birth == record.birth() && p.id == popup && !p.shown)
        {
            if !registry.close_popup(record.birth(), popup) {
                return false;
            }
            #[cfg(feature = "rpc-qualification")]
            if let Some(current) = registry.registrations.get_mut(&record.token) {
                current.select_first = false;
            }
            true
        } else {
            false
        }
    });
    if not_shown {
        if same(&record).is_ok() {
            emit(&record, json!({"type":"menu-failed","popup":popup}));
        }
        finish_release(&record);
    }
    Ok(())
}

#[cfg(feature = "rpc-qualification")]
fn qualify(request: u64, args: &Value, record: &Registration) -> Result<(), String> {
    let action = args
        .get("action")
        .and_then(Value::as_str)
        .ok_or_else(invalid)?;
    let owner = window(record.window)?;
    if owner.is_active() == 0 || owner.is_drawn() == 0 {
        return Err("RESOURCE_IN_USE: qualification requires the active owner window".into());
    }
    if action == "select-first" {
        fields(args, &["registration", "scope", "action"])?;
        let Some(Item::Command { command }) = record.definition.menu.first() else {
            return Err(invalid());
        };
        if !record
            .definition
            .commands
            .iter()
            .any(|c| &c.id == command && c.enabled)
        {
            return Err(invalid());
        }
        COMMANDS.with(|registry| {
            let mut registry = registry.borrow_mut();
            if registry.popup.is_some() {
                return Err(busy());
            }
            registry
                .registrations
                .get_mut(&record.token)
                .ok_or_else(busy)?
                .select_first = true;
            Ok(())
        })?;
    } else if action == "shortcut" {
        fields(args, &["registration", "scope", "action", "command"])?;
        let selected = record
            .definition
            .commands
            .iter()
            .find(|c| {
                args.get("command").and_then(Value::as_str) == Some(c.id.as_str()) && c.enabled
            })
            .ok_or_else(invalid)?;
        let shortcut = selected.shortcut.as_ref().ok_or_else(invalid)?;
        same(record)?;
        // This testing-only CEF API feeds actual native accelerator dispatch. It
        // never calls the application delegate directly or fabricates receipts.
        let flags = (if shortcut.shift { 1 << 1 } else { 0 })
            | (if shortcut.control { 1 << 2 } else { 0 })
            | (if shortcut.alt { 1 << 3 } else { 0 });
        owner.send_key_press(shortcut.key_code()?, flags);
    } else {
        return Err(invalid());
    }
    same(record)?;
    reply(request, Value::Null);
    Ok(())
}
#[cfg(all(feature = "rpc-qualification", target_os = "macos"))]
fn selection_owner(token: &str, birth: i32, popup: u64) -> Option<Window> {
    let record = callback_record(token, birth)?;
    same(&record).ok()?;
    let current = COMMANDS.with(|registry| {
        registry
            .borrow()
            .popup
            .as_ref()
            .is_some_and(|p| p.birth == birth && p.id == popup && p.shown && !p.cancelled)
    });
    if !current {
        return None;
    }
    let owner = window(record.window).ok()?;
    (owner.is_active() != 0 && owner.is_drawn() != 0 && owner.is_minimized() == 0).then_some(owner)
}
#[cfg(all(feature = "rpc-qualification", not(target_os = "macos")))]
wrap_task! {
    struct SelectFirst { token: String, birth: i32, popup: u64 }
    impl Task { fn execute(&self) {
        let Some(record) = callback_record(&self.token, self.birth) else { return; };
        if same(&record).is_err() { return; }
        let current = COMMANDS.with(|registry| registry.borrow().popup.as_ref().is_some_and(|p| p.birth == self.birth && p.id == self.popup && p.shown && !p.cancelled));
        if !current { return; }
        let Ok(owner) = window(record.window) else { return; };
        owner.send_key_press(40, 0); // VKEY_DOWN
        if same(&record).is_ok() { owner.send_key_press(13, 0); } // VKEY_RETURN
    } }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn definition() -> Definition {
        Definition::parse(&json!({"commands":[{"id":"open","label":"Open","shortcut":{"key":"K","control":true}}],"menu":[{"type":"command","command":"open"}]})).unwrap()
    }
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
    fn bounded_and_exact_definitions() {
        let valid = json!({"commands":[{"id":"open","label":"Open"}],"menu":[{"type":"command","command":"open"}]});
        assert!(Definition::parse(&valid).is_ok());
        for bad in [
            json!(null),
            json!({"commands":[],"menu":[]}),
            json!({"commands":[{"id":"open","label":"Open","shortcut":null}],"menu":[]}),
        ] {
            assert!(Definition::parse(&bad).is_err());
        }
        for field in ["role", "execute", "url"] {
            let mut bad = valid.clone();
            bad["commands"][0][field] = json!("anything");
            assert!(Definition::parse(&bad).is_err());
        }
        for label in ["", "&Open", "Open\n", "\0", &"😀".repeat(33)] {
            let mut bad = valid.clone();
            bad["commands"][0]["label"] = json!(label);
            assert!(Definition::parse(&bad).is_err());
        }
        let mut deep = json!({"type":"command","command":"open"});
        for _ in 0..3 {
            deep = json!({"type":"submenu","label":"Sub","items":[deep]});
        }
        let mut bad = valid;
        bad["menu"] = json!([deep]);
        assert!(Definition::parse(&bad).is_err());
    }
    #[test]
    fn shortcut_keys_and_duplicates_are_exact() {
        for key in ["A", "0", "F1", "F12"] {
            assert!(Shortcut {
                key: key.into(),
                control: true,
                alt: false,
                shift: false
            }
            .key_code()
            .is_ok());
        }
        for key in ["a", "F13", "Enter", "Meta+K"] {
            assert!(Shortcut {
                key: key.into(),
                control: true,
                alt: false,
                shift: false
            }
            .key_code()
            .is_err());
        }
        assert!(Shortcut {
            key: "A".into(),
            control: false,
            alt: false,
            shift: true
        }
        .key_code()
        .is_err());
        let bad = json!({"commands":[{"id":"a","label":"A","shortcut":{"key":"K","control":true}},{"id":"b","label":"B","shortcut":{"key":"K","control":true,"alt":false}}],"menu":[]});
        assert!(Definition::parse(&bad).is_err());
    }
    #[test]
    fn window_ownership_bounds_and_monotonic_callback_identity() {
        let mut registry = Registry::default();
        let first = registry
            .admit("a".into(), scope(1), 1, definition())
            .unwrap();
        assert!(registry
            .admit("b".into(), scope(2), 1, definition())
            .is_err());
        assert!(registry
            .admit("b".into(), scope(2), 2, definition())
            .is_ok());
        registry.registrations.remove("a");
        let next = registry
            .admit("a".into(), scope(1), 1, definition())
            .unwrap();
        assert!(next.birth() > first.birth());
        registry.next_id = i32::MAX;
        assert!(registry.reserve_ids(1).is_err());
    }
    #[test]
    fn native_release_waits_for_both_accelerator_removal_and_exact_popup_closure() {
        let mut registry = Registry::default();
        let record = registry
            .admit("a".into(), scope(1), 1, definition())
            .unwrap();
        registry.begin_popup(&record, 1).unwrap();
        let current = registry.registrations.get_mut("a").unwrap();
        current.retired = true;
        current.dispose_requests.push(42);
        assert!(registry.finish_release(&record).is_empty());
        registry
            .registrations
            .get_mut("a")
            .unwrap()
            .accelerators_removed = true;
        assert!(registry.finish_release(&record).is_empty());
        assert_eq!(registry.registrations.len(), 1);
        assert!(!registry.close_popup(record.birth(), 2));
        assert!(!registry.close_popup(record.birth() + 1, 1));
        assert!(registry.close_popup(record.birth(), 1));
        assert_eq!(registry.finish_release(&record), vec![42]);
        assert!(registry.registrations.is_empty());
        assert!(registry.finish_release(&record).is_empty());
    }
    #[test]
    fn popup_reservation_excludes_other_native_modal_ui_until_actual_closure() {
        let dialog = native_modal::reserve(ModalOwner::FileDialog).unwrap();
        let mut registry = Registry::default();
        let record = registry
            .admit("a".into(), scope(1), 1, definition())
            .unwrap();
        assert!(registry.begin_popup(&record, 1).is_err());
        assert_eq!(registry.registrations["a"].last_popup, 0);
        assert!(native_modal::release(ModalOwner::FileDialog, dialog));
        registry.begin_popup(&record, 1).unwrap();
        registry.registrations.get_mut("a").unwrap().retired = true;
        registry
            .registrations
            .get_mut("a")
            .unwrap()
            .accelerators_removed = true;
        assert!(registry.finish_release(&record).is_empty());
        assert!(native_modal::reserve(ModalOwner::FileDialog).is_err());
        assert!(!registry.close_popup(record.birth(), 2));
        assert!(native_modal::reserve(ModalOwner::FileDialog).is_err());
        assert!(registry.close_popup(record.birth(), 1));
        let next = native_modal::reserve(ModalOwner::FileDialog).unwrap();
        assert!(!native_modal::release(ModalOwner::FileDialog, dialog));
        assert!(native_modal::release(ModalOwner::FileDialog, next));
        registry.finish_release(&record);
        assert!(registry.registrations.is_empty());
    }
    #[test]
    fn popup_identity_does_not_reuse_or_cross_registration_incarnations() {
        let mut registry = Registry::default();
        let old = registry
            .admit("a".into(), scope(1), 1, definition())
            .unwrap();
        registry.begin_popup(&old, 1).unwrap();
        assert!(registry.begin_popup(&old, 2).is_err());
        assert!(registry.close_popup(old.birth(), 1));
        assert!(registry.begin_popup(&old, 1).is_err());
        registry.begin_popup(&old, 2).unwrap();
        assert!(registry.close_popup(old.birth(), 2));
        registry.registrations.remove("a");
        let fresh = registry
            .admit("a".into(), scope(1), 1, definition())
            .unwrap();
        assert!(registry.begin_popup(&old, 3).is_err());
        registry.begin_popup(&fresh, 1).unwrap();
        assert!(!registry.close_popup(old.birth(), 1));
        assert!(registry.popup.is_some());
        assert!(registry.close_popup(fresh.birth(), 1));
    }
    #[test]
    fn retired_registrations_remain_charged_until_observed_release() {
        let mut registry = Registry::default();
        let first = registry
            .admit("first".into(), scope(1), 1, definition())
            .unwrap();
        registry.registrations.get_mut("first").unwrap().retired = true;
        assert!(registry
            .admit("other".into(), scope(1), 1, definition())
            .is_err());
        assert!(registry.finish_release(&first).is_empty());
        assert_eq!(registry.registrations.len(), 1);
        registry
            .registrations
            .get_mut("first")
            .unwrap()
            .accelerators_removed = true;
        registry.finish_release(&first);
        assert!(registry
            .admit("other".into(), scope(1), 1, definition())
            .is_ok());
    }
    #[test]
    fn pending_cleanup_waits_for_actual_tracking_and_keeps_all_native_owners() {
        let mut registry = Registry::default();
        let token = "a".repeat(32);
        let record = registry
            .admit(token.clone(), scope(1), 1, definition())
            .unwrap();
        registry.begin_popup(&record, 1).unwrap();
        let cancel = json!({"v":1,"id":4,"op":"commands.cancel","args":{
            "registration":token,"scope":record.scope,"popup":1}});
        assert_eq!(registry.cancel_tracking(Some(&cancel), false), None);
        registry.tracking = Some((record.birth(), 1));
        // The tracking marker precedes the admission reply. Only the actual
        // MenuWillShow makes cancellation eligible; its wake covers early abort.
        assert_eq!(registry.cancel_tracking(Some(&cancel), false), None);
        registry.popup.as_mut().unwrap().shown = true;
        assert_eq!(registry.cancel_tracking(Some(&cancel), false), Some(1));
        assert_eq!(registry.cancel_tracking(Some(&cancel), false), None);
        assert!(registry.popup.as_ref().unwrap().cancelled);
        assert_eq!(registry.registrations.len(), 1);
        assert!(!registry.registrations[&token].accelerators_removed);
        assert!(!registry.registrations[&token].retired);
        assert!(native_modal::reserve(ModalOwner::FileDialog).is_err());
        assert!(registry.close_popup(record.birth(), 1));
    }
    #[test]
    fn pending_cleanup_rejects_foreign_stale_and_malformed_commands_before_cancelling() {
        let mut registry = Registry::default();
        let token = "a".repeat(32);
        let record = registry
            .admit(token.clone(), scope(1), 1, definition())
            .unwrap();
        registry.begin_popup(&record, 2).unwrap();
        registry.tracking = Some((record.birth(), 2));
        registry.popup.as_mut().unwrap().shown = true;
        let valid = json!({"v":1,"id":4,"op":"commands.cancel","args":{
            "registration":token,"scope":record.scope,"popup":2}});
        let mut rejected = vec![
            json!({"v":1,"id":4,"op":"window.close","args":{"id":1}}),
            json!({"v":1,"id":0,"op":"quit"}),
        ];
        for (field, value) in [
            ("view", json!(2)),
            ("session", json!(2)),
            ("generation", json!(2)),
            ("document", json!("replacement")),
            ("mainFrame", json!("other")),
            ("origin", json!("app://other")),
            ("extra", json!(true)),
        ] {
            let mut changed = valid.clone();
            changed["args"]["scope"][field] = value;
            rejected.push(changed);
        }
        for (field, value) in [
            ("registration", json!("b".repeat(32))),
            ("popup", json!(1)),
            ("popup", json!("2")),
            ("extra", json!(true)),
        ] {
            let mut changed = valid.clone();
            changed["args"][field] = value;
            rejected.push(changed);
        }
        let mut invalid_dispose = valid.clone();
        invalid_dispose["op"] = json!("commands.dispose"); // unexpected popup field
        rejected.push(invalid_dispose);
        for command in rejected {
            assert_eq!(registry.cancel_tracking(Some(&command), false), None);
            assert!(!registry.popup.as_ref().unwrap().cancelled);
        }
        // A stale tracking guard cannot operate on a replacement incarnation.
        registry.tracking = Some((record.birth() + 1, 2));
        assert_eq!(registry.cancel_tracking(Some(&valid), false), None);
        registry.tracking = Some((record.birth(), 2));
        let dispose = json!({"v":1,"id":5,"op":"commands.dispose","args":{
            "registration":token,"scope":record.scope}});
        assert_eq!(registry.cancel_tracking(Some(&dispose), false), Some(1));
        assert!(registry.close_popup(record.birth(), 2));
    }
    #[test]
    fn only_owned_quit_or_native_retirement_can_cancel_without_a_scoped_cleanup_command() {
        let mut registry = Registry::default();
        let token = "a".repeat(32);
        let record = registry
            .admit(token.clone(), scope(1), 1, definition())
            .unwrap();
        for (popup, quitting, retired, command) in [
            (1, false, false, Some(json!({"v":1,"id":7,"op":"quit"}))),
            (2, true, false, None),
            (3, false, true, None),
        ] {
            registry.registrations.get_mut(&token).unwrap().retired = false;
            registry.begin_popup(&record, popup).unwrap();
            registry.tracking = Some((record.birth(), popup));
            registry.popup.as_mut().unwrap().shown = true;
            assert_eq!(registry.cancel_tracking(None, false), None);
            registry.registrations.get_mut(&token).unwrap().retired = retired;
            assert_eq!(
                registry.cancel_tracking(command.as_ref(), quitting),
                Some(1)
            );
            assert!(registry.close_popup(record.birth(), popup));
        }
    }
    #[test]
    fn grant_is_distinct_and_exact() {
        use capability_policy::{authorize_native_grants, NativeCapability};
        let request = NativeRequest::WindowCommands;
        assert_eq!(
            authorize_native_grants(&[], &request, AdapterAvailability::Available),
            GateDecision::Denied
        );
        assert_eq!(
            authorize_native_grants(
                &[NativeCapability::ClipboardRead],
                &request,
                AdapterAvailability::Available
            ),
            GateDecision::Denied
        );
        assert_eq!(
            authorize_native_grants(
                &[NativeCapability::WindowCommands],
                &request,
                AdapterAvailability::Available
            ),
            GateDecision::Authorized
        );
        assert!(capability_policy::decode_native_capability(
            json!({"name":"window-commands","global":true})
        )
        .is_err());
        assert!(
            capability_policy::decode_native_capability(json!({"name":"window-commands"})).is_ok()
        );
    }
}
