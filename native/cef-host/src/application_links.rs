//! Exact application routes and a bounded, acknowledged inbox. Startup arguments
//! are untrusted input; this module never installs an OS protocol registration.
use super::{captured_ready_scope, policy_scope, reply, STATE};
use crate::capability_policy::{
    self, AdapterAvailability, DocumentScope, GateDecision, NativeRequest,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{cell::RefCell, collections::VecDeque, sync::atomic::Ordering};

#[cfg(target_os = "macos")]
#[path = "application_links_macos.rs"]
mod macos;
#[cfg(target_os = "windows")]
#[path = "application_links_windows.rs"]
mod windows;

const MAX_URL: usize = 2048;
const MAX_ENTRIES: usize = 16;
const MAX_BYTES: usize = 16384;
const MAX_COUNTER: u64 = crate::rpc_protocol::MAX_ID;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub(crate) struct Route {
    scheme: String,
    host: String,
    path: String,
}
impl Route {
    fn valid(&self) -> bool {
        let scheme = self.scheme.as_bytes();
        let host = self.host.as_bytes();
        scheme.len() >= 2
            && scheme.len() <= 32
            && scheme[0].is_ascii_lowercase()
            && scheme
                .iter()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"+.-".contains(b))
            && ![
                "http",
                "https",
                "file",
                "data",
                "javascript",
                "about",
                "bunly",
                "ws",
                "wss",
                "ftp",
            ]
            .contains(&self.scheme.as_str())
            && !host.is_empty()
            && host.len() <= 64
            && self.host.split(['.', '-']).all(|part| {
                !part.is_empty()
                    && part
                        .bytes()
                        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
            })
            && self.path.starts_with('/')
            && self.path.len() <= 128
            && self
                .path
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"/._~-".contains(&b))
            && !self.path.contains("//")
            && !self.path.split('/').any(|part| part == "." || part == "..")
    }
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Manifest {
    schema: u32,
    routes: Vec<Route>,
}
impl Manifest {
    fn validate(&self) -> Result<(), String> {
        if self.schema != 1
            || self.routes.is_empty()
            || self.routes.len() > 8
            || serde_json::to_vec(self).map_err(|_| invalid())?.len() > 2048
            || self
                .routes
                .iter()
                .enumerate()
                .any(|(index, route)| !route.valid() || self.routes[..index].contains(route))
        {
            return Err(invalid());
        }
        Ok(())
    }
    fn accepts(&self, input: &str) -> bool {
        let Ok(url) = canonical_url(input) else {
            return false;
        };
        url.port().is_none()
            && self.routes.iter().any(|route| {
                route.scheme == url.scheme()
                    && Some(route.host.as_str()) == url.host_str()
                    && route.path == url.path()
            })
    }
}
fn canonical_url(input: &str) -> Result<url::Url, String> {
    let bytes = input.as_bytes();
    if bytes.is_empty()
        || bytes.len() > MAX_URL
        || bytes
            .iter()
            .any(|b| !(0x21..=0x7e).contains(b) || *b == b'\\' || *b == b'#')
        || bytes.iter().enumerate().any(|(index, b)| {
            *b == b'%'
                && (bytes.get(index + 1).is_none_or(|b| !b.is_ascii_hexdigit())
                    || bytes.get(index + 2).is_none_or(|b| !b.is_ascii_hexdigit()))
        })
    {
        return Err(invalid());
    }
    let url = url::Url::parse(input).map_err(|_| invalid())?;
    if url.as_str() != input || !url.username().is_empty() || url.password().is_some() {
        return Err(invalid());
    }
    Ok(url)
}
fn external_url(input: &str) -> Result<url::Url, String> {
    let url = canonical_url(input)?;
    if url.scheme() != "https" || url.host_str().is_none() {
        return Err(invalid());
    }
    Ok(url)
}
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
struct Link {
    sequence: u64,
    url: String,
    source: &'static str,
}
#[derive(Clone, Debug)]
struct ReadReceipt {
    id: u64,
    through: u64,
    overflow: u64,
}
#[derive(Clone, Debug)]
struct Reader {
    token: String,
    birth: u64,
    scope: DocumentScope,
    read: Option<ReadReceipt>,
}
#[derive(Default)]
struct Registry {
    manifest: Option<Manifest>,
    queue: VecDeque<Link>,
    bytes: usize,
    overflow: u64,
    next_link: u64,
    next_reader: u64,
    next_receipt: u64,
    reader: Option<Reader>,
    stopped: bool,
    startup: u64,
    macos: u64,
    rejected: u64,
    acknowledged: u64,
    shutdown_emitted: bool,
}
fn count(value: &mut u64) {
    *value = value.saturating_add(1).min(MAX_COUNTER);
}
impl Registry {
    fn receive(&mut self, url: &str, source: &'static str) {
        if self.stopped
            || !self
                .manifest
                .as_ref()
                .is_some_and(|manifest| manifest.accepts(url))
        {
            count(&mut self.rejected);
            return;
        }
        if self.queue.len() >= MAX_ENTRIES
            || self.bytes + url.len() > MAX_BYTES
            || self.next_link == MAX_COUNTER
        {
            count(&mut self.overflow);
            return;
        }
        self.next_link += 1;
        self.bytes += url.len();
        self.queue.push_back(Link {
            sequence: self.next_link,
            url: url.to_owned(),
            source,
        });
        count(if source == "startup" {
            &mut self.startup
        } else {
            &mut self.macos
        });
    }
    fn create(&mut self, token: String, scope: DocumentScope) -> Result<Reader, String> {
        if self.manifest.is_none() {
            return Err(
                "UNSUPPORTED_CAPABILITY: application link routes are not configured".into(),
            );
        }
        if self.stopped || self.reader.is_some() {
            return Err("RESOURCE_IN_USE: application link reader capacity exceeded".into());
        }
        self.next_reader = crate::rpc_protocol::next(self.next_reader)
            .ok_or("RESOURCE_IN_USE: application link identity exhausted")?;
        let reader = Reader {
            token,
            birth: self.next_reader,
            scope,
            read: None,
        };
        self.reader = Some(reader.clone());
        Ok(reader)
    }
    fn current(&self, expected: &Reader) -> bool {
        self.reader.as_ref().is_some_and(|current| {
            current.token == expected.token
                && current.birth == expected.birth
                && current.scope == expected.scope
        }) && !self.stopped
    }
    fn read(&mut self, expected: &Reader) -> Result<Value, String> {
        if !self.current(expected) {
            return Err(disposed());
        }
        self.next_receipt = crate::rpc_protocol::next(self.next_receipt)
            .ok_or("RESOURCE_IN_USE: application link receipt exhausted")?;
        let receipt = ReadReceipt {
            id: self.next_receipt,
            through: self.queue.back().map_or(0, |link| link.sequence),
            overflow: self.overflow,
        };
        let result = json!({"receipt":receipt.id,"links":self.queue,"overflow":receipt.overflow});
        self.reader.as_mut().unwrap().read = Some(receipt);
        Ok(result)
    }
    fn acknowledge(&mut self, expected: &Reader, receipt: u64) -> Result<(), String> {
        if !self.current(expected) {
            return Err(disposed());
        }
        let read = self
            .reader
            .as_ref()
            .and_then(|reader| reader.read.as_ref())
            .filter(|read| read.id == receipt)
            .cloned()
            .ok_or("INVALID_ARGUMENT: application link receipt is not current")?;
        while self
            .queue
            .front()
            .is_some_and(|link| link.sequence <= read.through)
        {
            self.bytes -= self.queue.pop_front().unwrap().url.len();
            count(&mut self.acknowledged);
        }
        self.overflow -= read.overflow;
        self.reader.as_mut().unwrap().read = None;
        Ok(())
    }
}
thread_local! { static LINKS: RefCell<Registry> = RefCell::new(Registry::default()); }
fn invalid() -> String {
    "INVALID_ARGUMENT: invalid application link".into()
}
fn disposed() -> String {
    "DISPOSED: application link reader retired".into()
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
fn authorize(scope: &DocumentScope, request: &NativeRequest) -> Result<(), String> {
    if super::RPC_STOPPED.load(Ordering::SeqCst) || super::QUITTING.load(Ordering::SeqCst) {
        return Err("PERMISSION_DENIED: native application is shutting down".into());
    }
    let grants = STATE.with(|state| {
        let state = state.borrow();
        captured_ready_scope(&state, scope.view, scope)
            .map_err(|_| "PERMISSION_DENIED: application link document authority changed")?;
        state
            .policy
            .native_grants(scope)
            .ok_or("PERMISSION_DENIED: missing application link authority")
    })?;
    match capability_policy::authorize_native_grants(
        &grants,
        request,
        AdapterAvailability::Available,
    ) {
        GateDecision::Authorized => Ok(()),
        _ => Err("PERMISSION_DENIED: missing application link document grant".into()),
    }
}
pub(crate) fn configure(
    manifest: Option<Manifest>,
    arguments: impl IntoIterator<Item = String>,
) -> Result<(), String> {
    if let Some(manifest) = &manifest {
        manifest.validate()?;
    }
    LINKS.with(|links| {
        let mut links = links.borrow_mut();
        links.manifest = manifest;
        for argument in arguments {
            if let Some(value) = argument.strip_prefix("--bunly-link=") {
                links.receive(value, "startup");
            }
        }
    });
    Ok(())
}
#[cfg(target_os = "macos")]
pub(crate) struct DelegateLease;
#[cfg(target_os = "macos")]
impl Drop for DelegateLease {
    fn drop(&mut self) {
        if macos::remove().is_err() {
            super::FAILED.store(true, Ordering::SeqCst);
        }
    }
}
#[cfg(target_os = "macos")]
pub(crate) fn install_delegate() -> Result<DelegateLease, String> {
    if LINKS.with(|links| links.borrow().manifest.is_some()) {
        macos::install()?;
    }
    Ok(DelegateLease)
}
#[cfg(target_os = "macos")]
fn receive_macos(url: &str) {
    LINKS.with(|links| links.borrow_mut().receive(url, "macos"));
}
#[cfg(target_os = "macos")]
fn reject_macos(count_rejected: usize) {
    LINKS.with(|links| {
        let mut links = links.borrow_mut();
        links.rejected = links
            .rejected
            .saturating_add(count_rejected as u64)
            .min(MAX_COUNTER);
    });
}
#[cfg(target_os = "macos")]
fn overflow_macos(count_rejected: usize) {
    LINKS.with(|links| {
        let mut links = links.borrow_mut();
        links.overflow = links
            .overflow
            .saturating_add(count_rejected as u64)
            .min(MAX_COUNTER);
    });
}
pub(super) fn retire_view(view: u64) {
    LINKS.with(|links| {
        let mut links = links.borrow_mut();
        if links
            .reader
            .as_ref()
            .is_some_and(|reader| reader.scope.view == view)
        {
            links.reader = None;
        }
    });
}
fn outbound(url: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        macos::open(url)
    }
    #[cfg(target_os = "windows")]
    {
        windows::open(url)
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = url;
        Err("UNSUPPORTED_CAPABILITY: external URL adapter unavailable".into())
    }
}
pub(super) fn dispatch(request: u64, operation: &str, args: &Value) -> Result<(), String> {
    if operation == "app.open.url" {
        fields(args, &["scope", "url"])?;
        let scope = policy_scope(args)?;
        let url = external_url(
            args.get("url")
                .and_then(Value::as_str)
                .ok_or_else(invalid)?,
        )?;
        authorize(
            &scope,
            &NativeRequest::ExternalUrl {
                url: url.as_str().to_owned(),
            },
        )?;
        outbound(url.as_str())?;
        reply(request, Value::Null);
        return Ok(());
    }
    #[cfg(feature = "rpc-qualification")]
    if operation == "links.qualification.snapshot" {
        fields(args, &[])?;
        reply(request, snapshot());
        return Ok(());
    }
    let expected = match operation {
        "links.create" => &["registration", "scope"][..],
        "links.ack" => &["registration", "scope", "incarnation", "receipt"][..],
        _ => &["registration", "scope", "incarnation"][..],
    };
    fields(args, expected)?;
    let token = token(args)?;
    let scope = policy_scope(args)?;
    if operation == "links.dispose" {
        let birth = super::number(args, "incarnation")?;
        LINKS.with(|links| {
            let mut links = links.borrow_mut();
            // Disposal is cleanup authority for the exact original identity only.
            if links.reader.as_ref().is_some_and(|reader| {
                reader.token == token && reader.scope == scope && reader.birth == birth
            }) {
                links.reader = None;
            }
        });
        reply(request, Value::Null);
        return Ok(());
    }
    authorize(&scope, &NativeRequest::ApplicationLinks)?;
    if operation == "links.create" {
        let reader = LINKS.with(|links| links.borrow_mut().create(token.to_owned(), scope))?;
        reply(request, json!({"incarnation":reader.birth}));
        return Ok(());
    }
    let birth = super::number(args, "incarnation")?;
    let reader = LINKS
        .with(|links| {
            links
                .borrow()
                .reader
                .as_ref()
                .filter(|reader| {
                    reader.token == token && reader.scope == scope && reader.birth == birth
                })
                .cloned()
        })
        .ok_or_else(disposed)?;
    let result = match operation {
        "links.read" => LINKS.with(|links| links.borrow_mut().read(&reader))?,
        "links.ack" => {
            let receipt = super::number(args, "receipt")?;
            LINKS.with(|links| links.borrow_mut().acknowledge(&reader, receipt))?;
            Value::Null
        }
        _ => return Err(invalid()),
    };
    reply(request, result);
    Ok(())
}
fn snapshot() -> Value {
    #[cfg(target_os = "macos")]
    let delegates = macos::owners();
    #[cfg(not(target_os = "macos"))]
    let delegates = 0;
    LINKS.with(|links| {
        let links = links.borrow();
        json!({"readers":usize::from(links.reader.is_some()),"queued":links.queue.len(),"bytes":links.bytes,"overflow":links.overflow,"startup":links.startup,"macos":links.macos,"rejected":links.rejected,"acknowledged":links.acknowledged,"delegates":delegates})
    })
}
fn shutdown_event(data: Value) -> Value {
    json!({"v":1,"event":"links.shutdown","data":data})
}
pub(super) fn shutdown() {
    LINKS.with(|links| {
        let mut links = links.borrow_mut();
        links.stopped = true;
        links.reader = None;
        links.queue.clear();
        links.bytes = 0;
    });
    #[cfg(target_os = "macos")]
    if macos::remove().is_err() {
        super::fail("Application link delegate removal failed");
        return;
    }
    let emit = LINKS.with(|links| !links.borrow_mut().shutdown_emitted);
    if emit {
        LINKS.with(|links| links.borrow_mut().shutdown_emitted = true);
        let data = snapshot();
        eprintln!(
            "{}",
            json!({"event":"bunly.host.links-shutdown","state":data})
        );
        crate::process::emit(shutdown_event(data));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn shutdown_receipt_is_an_untargeted_global_protocol_event() {
        let state = json!({"readers": 0, "queued": 0});
        let frame = shutdown_event(state.clone());
        assert_eq!(frame, json!({"v":1,"event":"links.shutdown","data":state}));
        assert!(frame.get("target").is_none());
    }
    fn manifest() -> Manifest {
        serde_json::from_value(
            json!({"schema":1,"routes":[{"scheme":"bunly-test","host":"open","path":"/item"}]}),
        )
        .unwrap()
    }
    fn scope() -> DocumentScope {
        DocumentScope {
            view: 1,
            session: 1,
            generation: 1,
            main_frame: "frame".into(),
            document: "document".into(),
            origin: "app://local".into(),
        }
    }
    fn registry() -> Registry {
        Registry {
            manifest: Some(manifest()),
            ..Default::default()
        }
    }
    #[test]
    fn exact_routes_reject_normalized_aliases_and_untrusted_authority() {
        let manifest = manifest();
        manifest.validate().unwrap();
        assert!(manifest.accepts("bunly-test://open/item?q=untrusted%20text"));
        for bad in [
            "BUNLY-TEST://open/item",
            "bunly-test://Open/item",
            "bunly-test://open/item/",
            "bunly-test://open/%69tem",
            "bunly-test://open/x/../item",
            "bunly-test://open:80/item",
            "bunly-test://user@open/item",
            "bunly-test://open/item#",
            "bunly-test://open/item\n",
            "bunly-test://open/item?q=%Q0",
            "https://open/item",
        ] {
            assert!(!manifest.accepts(bad), "{bad}");
        }
    }
    #[test]
    fn manifests_are_bounded_unique_and_exact() {
        let mut value = manifest();
        value.routes.push(value.routes[0].clone());
        assert!(value.validate().is_err());
        for field in ["http", "javascript", "a", "bunly-test\n"] {
            let mut value = manifest();
            value.routes[0].scheme = field.into();
            assert!(value.validate().is_err());
        }
        let mut value = manifest();
        value.routes[0].host = "-open".into();
        assert!(value.validate().is_err());
        let mut value = manifest();
        value.routes[0].path = "/../item".into();
        assert!(value.validate().is_err());
    }
    #[test]
    fn queue_preserves_accepted_entries_and_acknowledges_only_the_read_snapshot() {
        let mut registry = registry();
        for index in 0..MAX_ENTRIES + 1 {
            registry.receive(&format!("bunly-test://open/item?i={index}"), "startup");
        }
        assert_eq!(registry.queue.len(), MAX_ENTRIES);
        assert_eq!(registry.overflow, 1);
        let reader = registry.create("first".into(), scope()).unwrap();
        let read = registry.read(&reader).unwrap();
        registry.receive("bunly-test://open/item?later", "macos");
        registry
            .acknowledge(&reader, read["receipt"].as_u64().unwrap())
            .unwrap();
        assert_eq!(registry.overflow, 1);
        assert_eq!(registry.bytes, 0);
        assert_eq!(registry.acknowledged, 16);
        assert!(registry
            .acknowledge(&reader, read["receipt"].as_u64().unwrap())
            .is_err());
    }
    #[test]
    fn stale_read_and_replaced_reader_cannot_discard_pending_links() {
        let mut registry = registry();
        registry.receive("bunly-test://open/item", "startup");
        let reader = registry.create("same-token".into(), scope()).unwrap();
        assert!(registry.create("second".into(), scope()).is_err());
        let old = registry.read(&reader).unwrap();
        let current = registry.read(&reader).unwrap();
        assert!(registry
            .acknowledge(&reader, old["receipt"].as_u64().unwrap())
            .is_err());
        registry.reader = None;
        let replacement = registry.create("same-token".into(), scope()).unwrap();
        assert!(registry
            .acknowledge(&reader, current["receipt"].as_u64().unwrap())
            .is_err());
        assert!(registry
            .acknowledge(&replacement, current["receipt"].as_u64().unwrap())
            .is_err());
        assert_eq!(registry.queue.len(), 1);
    }
    #[test]
    fn byte_limit_and_late_arrivals_are_bounded_without_eviction() {
        let mut registry = registry();
        let input = format!("bunly-test://open/item?{}", "a".repeat(1800));
        for _ in 0..10 {
            registry.receive(&input, "startup");
        }
        assert_eq!(registry.queue.len(), 8);
        assert_eq!(registry.overflow, 2);
        assert!(registry.bytes <= MAX_BYTES);
        let reader = registry.create("first".into(), scope()).unwrap();
        let read = registry.read(&reader).unwrap();
        registry.receive("bunly-test://open/item?late", "macos");
        registry
            .acknowledge(&reader, read["receipt"].as_u64().unwrap())
            .unwrap();
        assert_eq!(registry.queue.len(), 1);
        assert_eq!(registry.queue[0].source, "macos");
    }
    #[test]
    fn external_submission_accepts_only_canonical_https() {
        assert!(external_url("https://example.com/path?q=one").is_ok());
        for bad in [
            "http://example.com/",
            "https://u:p@example.com/",
            "file:///tmp/example",
            "https://example.com",
            "https://example.com/#fragment",
            "https://example.com/\n",
            "https://example.com/%xx",
        ] {
            assert!(external_url(bad).is_err());
        }
    }
}
