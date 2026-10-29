//! Native capability policy. This module authorizes operations; it does not
//! implement OS adapters or accept renderer-supplied identity.
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Component, Path, PathBuf},
};

pub const MAX_GRANTS_PER_VIEW: usize = 64;
pub const MAX_ARGUMENTS: usize = 128;
pub const MAX_ARGUMENT_BYTES: usize = 16 * 1024;
const MAX_EXACT_JSON_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DocumentScope {
    pub view: u64,
    pub session: u64,
    pub generation: u64,
    pub main_frame: String,
    pub document: String,
    pub origin: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PreparedDocumentScope(DocumentScope);

impl PreparedDocumentScope {
    pub fn matches(&self, view: u64, generation: u64) -> bool {
        self.0.view == view && self.0.generation == generation
    }
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(tag = "name", rename_all = "kebab-case", deny_unknown_fields)]
pub enum NativeCapability {
    BrowserSnapshot,
    BrowserObserveDom,
    BrowserObserveAccessibility,
    BrowserInput,
    BrowserEvaluate {
        expression: String,
    },

    FileRead {
        root: PathBuf,
    },
    FileWrite {
        root: PathBuf,
    },
    #[serde(rename = "process-execute")]
    Execute {
        executable: PathBuf,
        arguments: Vec<String>,
    },
    ClipboardRead,
    ClipboardWrite,
    WindowCommands,
    StatusItem,
    ApplicationLinks,
    DialogOpen,
    DialogSave,
    ExternalUrl {
        origins: BTreeSet<String>,
    },
    Download {
        root: PathBuf,
    },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PreparedNativeCapability(NativeCapability);

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum BrowserCapability {
    Camera,
    Microphone,
    DisplayCapture,
    Geolocation,
    Notifications,
    Clipboard,
    MultipleDownloads,
    PointerLock,
}

impl BrowserCapability {
    pub fn from_name(value: &str) -> Option<Self> {
        match value {
            "camera" => Some(Self::Camera),
            "microphone" => Some(Self::Microphone),
            "display-capture" => Some(Self::DisplayCapture),
            "geolocation" => Some(Self::Geolocation),
            "notifications" => Some(Self::Notifications),
            "clipboard" => Some(Self::Clipboard),
            "multiple-downloads" => Some(Self::MultipleDownloads),
            "pointer-lock" => Some(Self::PointerLock),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BrowserGrantSource {
    ApplicationPolicy,
    UserDecision,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct NativeGrant {
    scope: DocumentScope,
    capability: NativeCapability,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct BrowserGrant {
    scope: DocumentScope,
    capability: BrowserCapability,
    source: BrowserGrantSource,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Eq)]
#[serde(tag = "name", rename_all = "kebab-case", deny_unknown_fields)]
pub enum NativeRequest {
    BrowserSnapshot,
    BrowserObserveDom,
    BrowserObserveAccessibility,
    BrowserInput,
    BrowserEvaluate {
        expression: String,
    },

    FileRead {
        path: PathBuf,
    },
    FileWrite {
        path: PathBuf,
    },
    #[serde(rename = "process-execute")]
    Execute {
        executable: PathBuf,
        arguments: Vec<String>,
    },
    ClipboardRead,
    ClipboardWrite,
    WindowCommands,
    StatusItem,
    ApplicationLinks,
    DialogOpen,
    DialogSave,
    ExternalUrl {
        url: String,
    },
    Download {
        path: PathBuf,
    },
    #[serde(skip)]
    Unknown {
        name: String,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AdapterAvailability {
    Available,
    Unavailable,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GateDecision {
    Authorized,
    Denied,
    Unavailable,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PromptToken {
    id: u64,
    scope: DocumentScope,
    capability: BrowserCapability,
}

#[derive(Default)]
pub struct Policy {
    current: BTreeMap<u64, DocumentScope>,
    native: Vec<NativeGrant>,
    browser: Vec<BrowserGrant>,
    prompts: BTreeMap<u64, PromptToken>,
    next_prompt: u64,
}

impl Policy {
    pub fn current_scope(&self, view: u64) -> Option<DocumentScope> {
        self.current.get(&view).cloned()
    }

    pub fn install_document(&mut self, scope: DocumentScope) -> Result<(), &'static str> {
        self.install_prepared_document(prepare_document_scope(scope)?)
    }

    pub fn install_prepared_document(
        &mut self,
        scope: PreparedDocumentScope,
    ) -> Result<(), &'static str> {
        let scope = scope.0;
        self.revoke_view(scope.view);
        self.current.insert(scope.view, scope);
        Ok(())
    }

    /// Must run at navigation start, before CEF can dispatch the replacement
    /// document or a redirect. The replacement scope is installed only after
    /// native frame/document provenance is known.
    pub fn navigation_started(&mut self, view: u64) {
        self.revoke_view(view);
        self.current.remove(&view);
    }

    pub fn close_view(&mut self, view: u64) {
        self.navigation_started(view);
    }

    pub fn grant_native(
        &mut self,
        scope: &DocumentScope,
        capability: NativeCapability,
    ) -> Result<(), &'static str> {
        let capability = prepare_native_capability(capability)?;
        self.grant_prepared_native(scope, capability)
    }

    /// Commit a capability which was validated without a host-state borrow.
    pub fn grant_prepared_native(
        &mut self,
        scope: &DocumentScope,
        capability: PreparedNativeCapability,
    ) -> Result<(), &'static str> {
        self.require_current(scope)?;
        if self.grant_count(scope.view) >= MAX_GRANTS_PER_VIEW {
            return Err("capability grant capacity exceeded");
        }
        self.native.push(NativeGrant {
            scope: scope.clone(),
            capability: capability.0,
        });
        Ok(())
    }

    pub fn grant_browser(
        &mut self,
        scope: &DocumentScope,
        capability: BrowserCapability,
        source: BrowserGrantSource,
    ) -> Result<(), &'static str> {
        self.require_current(scope)?;
        if self.grant_count(scope.view) >= MAX_GRANTS_PER_VIEW {
            return Err("capability grant capacity exceeded");
        }
        self.browser.push(BrowserGrant {
            scope: scope.clone(),
            capability,
            source,
        });
        Ok(())
    }

    pub fn set_browser_decision(
        &mut self,
        scope: &DocumentScope,
        capability: BrowserCapability,
        source: BrowserGrantSource,
        allow: bool,
    ) -> Result<(), &'static str> {
        self.require_current(scope)?;
        self.browser
            .retain(|grant| !(grant.scope == *scope && grant.capability == capability));
        if allow {
            self.grant_browser(scope, capability, source)?;
        }
        Ok(())
    }

    pub fn authorize_native(
        &self,
        scope: &DocumentScope,
        request: &NativeRequest,
        adapter: AdapterAvailability,
    ) -> GateDecision {
        let Some(grants) = self.native_grants(scope) else {
            return GateDecision::Denied;
        };
        authorize_native_grants(&grants, request, adapter)
    }

    /// Snapshot grants while state is borrowed. Filesystem work occurs later.
    pub fn native_grants(&self, scope: &DocumentScope) -> Option<Vec<NativeCapability>> {
        self.require_current(scope).ok()?;
        Some(
            self.native
                .iter()
                .filter(|grant| grant.scope == *scope)
                .map(|grant| grant.capability.clone())
                .collect(),
        )
    }

    pub fn authorize_browser(
        &self,
        scope: &DocumentScope,
        capability: BrowserCapability,
    ) -> Option<BrowserGrantSource> {
        self.require_current(scope).ok()?;
        self.browser
            .iter()
            .find(|grant| grant.scope == *scope && grant.capability == capability)
            .map(|grant| grant.source)
    }

    pub fn begin_prompt(
        &mut self,
        scope: &DocumentScope,
        capability: BrowserCapability,
    ) -> Result<PromptToken, &'static str> {
        self.require_current(scope)?;
        if self.prompts.len() >= MAX_GRANTS_PER_VIEW * self.current.len().max(1) {
            return Err("permission prompt capacity exceeded");
        }
        self.next_prompt = self
            .next_prompt
            .checked_add(1)
            .ok_or("prompt id exhausted")?;
        let token = PromptToken {
            id: self.next_prompt,
            scope: scope.clone(),
            capability,
        };
        self.prompts.insert(token.id, token.clone());
        Ok(token)
    }

    pub fn complete_prompt(
        &mut self,
        token: PromptToken,
        allow: bool,
    ) -> Result<bool, &'static str> {
        let Some(pending) = self.prompts.remove(&token.id) else {
            return Err("permission prompt is stale");
        };
        if pending != token || self.require_current(&token.scope).is_err() {
            return Err("permission prompt authority changed");
        }
        if allow {
            self.grant_browser(
                &token.scope,
                token.capability,
                BrowserGrantSource::UserDecision,
            )?;
        }
        Ok(allow)
    }

    fn require_current(&self, scope: &DocumentScope) -> Result<(), &'static str> {
        if self.current.get(&scope.view) != Some(scope) {
            return Err("document authority is stale or unknown");
        }
        Ok(())
    }

    fn grant_count(&self, view: u64) -> usize {
        self.native.iter().filter(|g| g.scope.view == view).count()
            + self.browser.iter().filter(|g| g.scope.view == view).count()
    }

    fn revoke_view(&mut self, view: u64) {
        self.native.retain(|grant| grant.scope.view != view);
        self.browser.retain(|grant| grant.scope.view != view);
        self.prompts.retain(|_, prompt| prompt.scope.view != view);
    }
}

pub fn prepare_document_scope(scope: DocumentScope) -> Result<PreparedDocumentScope, &'static str> {
    validate_scope(&scope)?;
    Ok(PreparedDocumentScope(scope))
}

fn validate_scope(scope: &DocumentScope) -> Result<(), &'static str> {
    if scope.view == 0
        || scope.session == 0
        || scope.generation == 0
        || scope.view > MAX_EXACT_JSON_INTEGER
        || scope.session > MAX_EXACT_JSON_INTEGER
        || scope.generation > MAX_EXACT_JSON_INTEGER
        || scope.main_frame.is_empty()
        || scope.document.is_empty()
        || scope.origin.is_empty()
        || scope.main_frame.len() > 256
        || scope.document.len() > 256
        || scope.origin.len() > 4096
    {
        return Err("incomplete native document authority");
    }
    exact_origin(&scope.origin).map(|_| ())
}

pub fn decode_document_scope(value: serde_json::Value) -> Result<DocumentScope, &'static str> {
    let scope: DocumentScope = serde_json::from_value(value).map_err(|_| "invalid policy scope")?;
    validate_scope(&scope)?;
    Ok(scope)
}

pub fn prepare_native_capability(
    capability: NativeCapability,
) -> Result<PreparedNativeCapability, &'static str> {
    let capability = match capability {
        NativeCapability::BrowserEvaluate { expression } => {
            if expression.is_empty() || expression.len() > 4096 || expression.contains('\0') {
                return Err("browser evaluation source is empty or oversized");
            }
            NativeCapability::BrowserEvaluate { expression }
        }
        NativeCapability::FileRead { root } => NativeCapability::FileRead {
            root: canonical_root(&root)?,
        },
        NativeCapability::FileWrite { root } => NativeCapability::FileWrite {
            root: canonical_root(&root)?,
        },
        NativeCapability::Download { root } => NativeCapability::Download {
            root: canonical_root(&root)?,
        },
        NativeCapability::Execute {
            executable,
            arguments,
        } => {
            validate_arguments(&arguments)?;
            NativeCapability::Execute {
                executable: canonical_executable(&executable)?,
                arguments,
            }
        }
        NativeCapability::ExternalUrl { origins } => {
            if origins.is_empty() || origins.len() > 32 {
                return Err("external URL origin scope is empty or oversized");
            }
            for origin in &origins {
                let parsed = exact_origin(origin)?;
                if parsed.scheme() != "https" {
                    return Err("external URLs require exact HTTPS origins");
                }
            }
            NativeCapability::ExternalUrl { origins }
        }
        capability => capability,
    };
    Ok(PreparedNativeCapability(capability))
}

pub fn decode_native_capability(
    value: serde_json::Value,
) -> Result<NativeCapability, &'static str> {
    validate_wire_shape(
        &value,
        &[
            ("file-read", &["root"]),
            ("file-write", &["root"]),
            ("process-execute", &["executable", "arguments"]),
            ("browser-snapshot", &[]),
            ("browser-observe-dom", &[]),
            ("browser-observe-accessibility", &[]),
            ("browser-input", &[]),
            ("browser-evaluate", &["expression"]),
            ("clipboard-read", &[]),
            ("clipboard-write", &[]),
            ("window-commands", &[]),
            ("status-item", &[]),
            ("dialog-open", &[]),
            ("dialog-save", &[]),
            ("external-url", &["origins"]),
            ("download", &["root"]),
        ],
    )?;
    serde_json::from_value(value).map_err(|_| "invalid native capability")
}

pub fn decode_native_request(value: serde_json::Value) -> Result<NativeRequest, &'static str> {
    validate_wire_shape(
        &value,
        &[
            ("file-read", &["path"]),
            ("file-write", &["path"]),
            ("process-execute", &["executable", "arguments"]),
            ("browser-snapshot", &[]),
            ("browser-observe-dom", &[]),
            ("browser-observe-accessibility", &[]),
            ("browser-input", &[]),
            ("browser-evaluate", &["expression"]),
            ("clipboard-read", &[]),
            ("clipboard-write", &[]),
            ("window-commands", &[]),
            ("status-item", &[]),
            ("dialog-open", &[]),
            ("dialog-save", &[]),
            ("external-url", &["url"]),
            ("download", &["path"]),
        ],
    )?;
    serde_json::from_value(value).map_err(|_| "invalid native request")
}

fn validate_wire_shape(
    value: &serde_json::Value,
    variants: &[(&str, &[&str])],
) -> Result<(), &'static str> {
    let object = value.as_object().ok_or("policy input must be an object")?;
    let name = object
        .get("name")
        .and_then(serde_json::Value::as_str)
        .ok_or("policy input requires a capability name")?;
    let fields = variants
        .iter()
        .find_map(|(variant, fields)| (*variant == name).then_some(*fields))
        .ok_or("unknown policy capability")?;
    if object.len() != fields.len() + 1
        || object
            .keys()
            .any(|key| key != "name" && !fields.contains(&key.as_str()))
    {
        return Err("unknown policy capability field");
    }
    Ok(())
}

pub fn authorize_native_grants(
    grants: &[NativeCapability],
    request: &NativeRequest,
    adapter: AdapterAvailability,
) -> GateDecision {
    if !grants.iter().any(|grant| native_matches(grant, request)) {
        GateDecision::Denied
    } else if adapter == AdapterAvailability::Unavailable {
        GateDecision::Unavailable
    } else {
        GateDecision::Authorized
    }
}

/// Resolve one explicit download root after the ordinary policy gate. Selection
/// is never inferred from the first grant or from a renderer-suggested filename.
pub(crate) fn download_root(
    grants: &[NativeCapability],
    root: &Path,
    name: &str,
) -> Result<PathBuf, &'static str> {
    let root = canonical_root(root)?;
    if !grants.iter().any(|grant| {
        matches!(grant, NativeCapability::Download { root: granted } if granted == &root)
            && native_matches(grant, &NativeRequest::Download { path: name.into() })
    }) {
        return Err("PERMISSION_DENIED: download destination is outside its native grant");
    }
    Ok(root)
}

fn native_matches(grant: &NativeCapability, request: &NativeRequest) -> bool {
    match (grant, request) {
        (NativeCapability::BrowserSnapshot, NativeRequest::BrowserSnapshot)
        | (NativeCapability::BrowserObserveDom, NativeRequest::BrowserObserveDom)
        | (
            NativeCapability::BrowserObserveAccessibility,
            NativeRequest::BrowserObserveAccessibility,
        )
        | (NativeCapability::BrowserInput, NativeRequest::BrowserInput) => true,
        (
            NativeCapability::BrowserEvaluate {
                expression: granted,
            },
            NativeRequest::BrowserEvaluate { expression },
        ) => granted == expression,
        (NativeCapability::FileRead { root }, NativeRequest::FileRead { path }) => {
            contained_path(root, path, true).is_ok()
        }
        (NativeCapability::FileWrite { root }, NativeRequest::FileWrite { path })
        | (NativeCapability::Download { root }, NativeRequest::Download { path }) => {
            contained_path(root, path, false).is_ok()
        }
        (
            NativeCapability::Execute {
                executable,
                arguments,
            },
            NativeRequest::Execute {
                executable: requested,
                arguments: requested_arguments,
            },
        ) => {
            let exact_executable = match (
                canonical_executable(executable),
                canonical_executable(requested),
            ) {
                (Ok(granted), Ok(requested)) => granted == requested,
                _ => false,
            };
            validate_arguments(requested_arguments).is_ok()
                && exact_executable
                && arguments == requested_arguments
        }
        (NativeCapability::ClipboardRead, NativeRequest::ClipboardRead)
        | (NativeCapability::ClipboardWrite, NativeRequest::ClipboardWrite)
        | (NativeCapability::WindowCommands, NativeRequest::WindowCommands)
        | (NativeCapability::StatusItem, NativeRequest::StatusItem)
        | (NativeCapability::ApplicationLinks, NativeRequest::ApplicationLinks)
        | (NativeCapability::DialogOpen, NativeRequest::DialogOpen)
        | (NativeCapability::DialogSave, NativeRequest::DialogSave) => true,
        (NativeCapability::ExternalUrl { origins }, NativeRequest::ExternalUrl { url }) => {
            url::Url::parse(url).ok().is_some_and(|parsed| {
                parsed.scheme() == "https"
                    && parsed.username().is_empty()
                    && parsed.password().is_none()
                    && origins.contains(&parsed.origin().ascii_serialization())
            })
        }
        _ => false,
    }
}

fn exact_origin(value: &str) -> Result<url::Url, &'static str> {
    let parsed = url::Url::parse(value).map_err(|_| "invalid exact origin")?;
    if parsed.scheme() == "app" {
        if parsed.host_str().is_some()
            && parsed.port().is_none()
            && parsed.username().is_empty()
            && parsed.password().is_none()
            && parsed.path().is_empty()
            && parsed.query().is_none()
            && parsed.fragment().is_none()
            && value == format!("app://{}", parsed.host_str().unwrap_or_default())
        {
            return Ok(parsed);
        }
        return Err("invalid exact origin");
    }
    if !parsed.username().is_empty()
        || parsed.password().is_some()
        || parsed.path() != "/"
        || parsed.query().is_some()
        || parsed.fragment().is_some()
        || parsed.origin().ascii_serialization() != value
        || !matches!(parsed.scheme(), "app" | "https" | "http")
    {
        return Err("invalid exact origin");
    }
    if parsed.scheme() == "http"
        && !(parsed.host_str() == Some("127.0.0.1") && parsed.port().is_some())
    {
        return Err("HTTP is restricted to an exact loopback fixture origin");
    }
    Ok(parsed)
}

fn canonical_root(root: &Path) -> Result<PathBuf, &'static str> {
    reject_unsafe_path(root)?;
    if !root.is_absolute() {
        return Err("capability root must be absolute");
    }
    if contains_symlink(root) {
        return Err("capability root must not contain symlinks");
    }
    let canonical = canonical_path(root).map_err(|_| "capability root is unavailable")?;
    if !canonical.is_dir() {
        return Err("capability root is not a directory");
    }
    Ok(canonical)
}

fn canonical_executable(path: &Path) -> Result<PathBuf, &'static str> {
    reject_unsafe_path(path)?;
    if !path.is_absolute() {
        return Err("executable scope must be absolute");
    }
    let canonical = canonical_path(path).map_err(|_| "executable is unavailable")?;
    if !canonical.is_file() || contains_symlink(path) {
        return Err("executable must be an existing non-symlink file");
    }
    Ok(canonical)
}

fn validate_arguments(arguments: &[String]) -> Result<(), &'static str> {
    if arguments.len() > MAX_ARGUMENTS
        || arguments.iter().map(String::len).sum::<usize>() > MAX_ARGUMENT_BYTES
        || arguments
            .iter()
            .any(|argument| argument.contains('\0') || argument.chars().any(char::is_control))
    {
        return Err("invalid executable argument vector");
    }
    Ok(())
}

// Validate the portable request spelling before Path::components can normalize
// Windows separators, repeated separators or dot components. Absolute trusted
// grant roots keep their platform-native syntax; only relative requests use this
// forward-slash grammar on every target.
fn validate_relative_path_text(value: &str) -> Result<(), &'static str> {
    if value.len() > 4096
        || !value.is_ascii()
        || value.chars().any(char::is_control)
        || value.split('/').count() > 128
    {
        return Err("relative path input bound exceeded");
    }
    for component in value.split('/') {
        if component.is_empty()
            || matches!(component, "." | "..")
            || component.ends_with(['.', ' '])
            || component.contains(':')
            || component.contains('\\')
            || reserved_name(component)
        {
            return Err("unsafe platform path alias denied");
        }
    }
    Ok(())
}

/// Requests are relative to a canonical grant root. Rejecting symlinked path
/// components prevents straightforward escapes and aliasing. The returned path
/// must still be opened by a platform adapter using handle-relative/no-follow
/// primitives; this check does not claim to defeat an arbitrary same-user race.
fn contained_path(
    root: &Path,
    requested: &Path,
    must_exist: bool,
) -> Result<PathBuf, &'static str> {
    let root = canonical_root(root)?;
    reject_unsafe_path(requested)?;
    if requested.is_absolute() {
        return Err("capability paths must be relative");
    }
    let text = requested.to_str().ok_or("path must be valid Unicode")?;
    validate_relative_path_text(text)?;
    let mut joined = root.clone();
    for text in text.split('/') {
        if joined.is_dir() {
            for (index, entry) in fs::read_dir(&joined)
                .map_err(|_| "path directory unavailable")?
                .enumerate()
            {
                if index >= 4096 {
                    return Err("path directory inspection bound exceeded");
                }
                let name = entry.map_err(|_| "path entry unavailable")?.file_name();
                if let Some(name) = name.to_str() {
                    if name.eq_ignore_ascii_case(text) && name != text {
                        return Err("case-colliding path alias denied");
                    }
                }
            }
        }
        joined.push(text);
        if joined
            .symlink_metadata()
            .is_ok_and(|metadata| linked_metadata(&metadata))
        {
            return Err("symlink path component denied");
        }
    }
    if must_exist {
        let canonical = canonical_path(&joined).map_err(|_| "requested path is unavailable")?;
        if !canonical.starts_with(&root) {
            return Err("path escaped capability root");
        }
        return Ok(canonical);
    }
    let mut existing = joined.as_path();
    while !existing.exists() {
        existing = existing
            .parent()
            .ok_or("requested path has no existing parent")?;
    }
    let canonical_parent = canonical_path(existing).map_err(|_| "path parent unavailable")?;
    if !canonical_parent.starts_with(&root) {
        return Err("path escaped capability root");
    }
    Ok(joined)
}

fn reject_unsafe_path(path: &Path) -> Result<(), &'static str> {
    let text = path.to_str().ok_or("path must be valid Unicode")?;
    let lower = text.to_ascii_lowercase();
    if text.is_empty()
        || text.len() > 4096
        || text.chars().any(char::is_control)
        || path.components().count() > 128
        || path
            .components()
            .any(|part| matches!(part, Component::ParentDir))
        || text.starts_with("\\\\")
        || text.starts_with("//")
        || lower.starts_with(r"\\?\")
        || lower.starts_with(r"\\.\")
        || lower.starts_with(r"\\?\globalroot")
    {
        return Err("device or UNC path denied");
    }
    Ok(())
}

// Windows canonicalization uses an extended-length drive prefix. Keep the
// public capability form normalized without permitting UNC/device namespaces.
fn canonical_path(path: &Path) -> Result<PathBuf, std::io::Error> {
    let path = fs::canonicalize(path)?;
    #[cfg(windows)]
    {
        if let Some(Component::Prefix(prefix)) = path.components().next() {
            if let std::path::Prefix::VerbatimDisk(drive) = prefix.kind() {
                let mut result = PathBuf::from(format!("{}:\\", char::from(drive)));
                for part in path.components().skip(1) {
                    if !matches!(part, Component::RootDir) {
                        result.push(part.as_os_str());
                    }
                }
                return Ok(result);
            }
        }
    }
    Ok(path)
}
fn linked_metadata(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    metadata.file_type().is_symlink()
}
fn reserved_name(value: &str) -> bool {
    let stem = value
        .split('.')
        .next()
        .unwrap_or_default()
        .to_ascii_uppercase();
    matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (stem.len() == 4
            && (stem.starts_with("COM") || stem.starts_with("LPT"))
            && matches!(stem.as_bytes()[3], b'1'..=b'9'))
}

fn contains_symlink(path: &Path) -> bool {
    let mut current = PathBuf::new();
    for component in path.components() {
        current.push(component);
        if current
            .symlink_metadata()
            .is_ok_and(|metadata| linked_metadata(&metadata))
        {
            return true;
        }
    }
    false
}

pub fn origin_for_url(value: &str) -> Option<String> {
    let parsed = url::Url::parse(value).ok()?;
    match parsed.scheme() {
        "app" if parsed.host_str().is_some() => Some(format!("app://{}", parsed.host_str()?)),
        "https" => Some(parsed.origin().ascii_serialization()),
        "http" if parsed.host_str() == Some("127.0.0.1") && parsed.port().is_some() => {
            Some(parsed.origin().ascii_serialization())
        }
        _ => None,
    }
}

pub fn permission_callback_scope(
    current: &DocumentScope,
    requester: Option<(&str, bool)>,
    requesting_origin: &str,
) -> Option<DocumentScope> {
    let (frame, is_main) = requester?;
    let origin = origin_for_url(requesting_origin)?;
    (is_main && frame == current.main_frame && origin == current.origin).then(|| current.clone())
}

pub const fn allow_popup() -> bool {
    false
}

pub const fn allow_external_protocol(_scheme: &str) -> bool {
    false
}

pub const fn allow_certificate_error(_error: i32) -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn scope(view: u64, session: u64, generation: u64, origin: &str) -> DocumentScope {
        DocumentScope {
            view,
            session,
            generation,
            main_frame: format!("frame-{view}"),
            document: format!("document-{generation}"),
            origin: origin.into(),
        }
    }
    #[test]
    fn browser_actions_require_the_exact_native_document_session_and_expression() {
        let mut policy = Policy::default();
        let live = scope(1, 2, 3, "https://remote.invalid");
        policy.install_document(live.clone()).unwrap();
        policy
            .grant_native(
                &live,
                NativeCapability::BrowserEvaluate {
                    expression: "document.title".into(),
                },
            )
            .unwrap();
        let request = NativeRequest::BrowserEvaluate {
            expression: "document.title".into(),
        };
        assert_eq!(
            policy.authorize_native(&live, &request, AdapterAvailability::Available),
            GateDecision::Authorized
        );
        assert_eq!(
            policy.authorize_native(
                &scope(1, 9, 3, "https://remote.invalid"),
                &request,
                AdapterAvailability::Available
            ),
            GateDecision::Denied
        );
        assert_eq!(
            policy.authorize_native(
                &live,
                &NativeRequest::BrowserEvaluate {
                    expression: "document.cookie".into()
                },
                AdapterAvailability::Available
            ),
            GateDecision::Denied
        );
        assert_eq!(
            policy.authorize_native(
                &live,
                &NativeRequest::ClipboardRead,
                AdapterAvailability::Available
            ),
            GateDecision::Denied
        );
        policy.navigation_started(1);
        assert_eq!(
            policy.authorize_native(&live, &request, AdapterAvailability::Available),
            GateDecision::Denied
        );
        let replacement = scope(1, 2, 4, "https://remote.invalid");
        policy.install_document(replacement.clone()).unwrap();
        assert_eq!(
            policy.authorize_native(&replacement, &request, AdapterAvailability::Available),
            GateDecision::Denied
        );
    }
    #[test]
    fn browser_grants_are_byte_bounded_and_reject_unknown_fields() {
        assert!(
            prepare_native_capability(NativeCapability::BrowserEvaluate {
                expression: "é".repeat(2049)
            })
            .is_err()
        );
        assert!(
            prepare_native_capability(NativeCapability::BrowserEvaluate {
                expression: String::new()
            })
            .is_err()
        );
        for name in [
            "browser-snapshot",
            "browser-observe-dom",
            "browser-observe-accessibility",
            "browser-input",
        ] {
            assert!(decode_native_capability(serde_json::json!({"name":name})).is_ok());
            assert!(
                decode_native_capability(serde_json::json!({"name":name,"frame":"child"})).is_err()
            );
        }
        assert!(decode_native_capability(serde_json::json!({"name":"browser-evaluate","expression":"document.title","frame":"child"})).is_err());
    }
    fn fixture() -> PathBuf {
        let base = std::env::temp_dir().join(format!(
            "bunly-capability-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        for attempt in 0..32 {
            let path = base.with_extension(attempt.to_string());
            match fs::create_dir(&path) {
                Ok(()) => {
                    fs::write(path.join("read.txt"), b"fixture").unwrap();
                    return canonical_path(&path).unwrap();
                }
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => panic!("cannot create capability fixture: {error}"),
            }
        }
        panic!("capability fixture collision limit exceeded")
    }

    #[test]
    fn link_reading_has_a_distinct_document_grant_from_external_submission() {
        let mut policy = Policy::default();
        let live = scope(4, 8, 2, "app://ui");
        policy.install_document(live.clone()).unwrap();
        policy
            .grant_native(
                &live,
                NativeCapability::ExternalUrl {
                    origins: ["https://example.com".into()].into_iter().collect(),
                },
            )
            .unwrap();
        assert_eq!(
            policy.authorize_native(
                &live,
                &NativeRequest::ApplicationLinks,
                AdapterAvailability::Available
            ),
            GateDecision::Denied
        );
        policy
            .grant_native(&live, NativeCapability::ApplicationLinks)
            .unwrap();
        assert_eq!(
            policy.authorize_native(
                &live,
                &NativeRequest::ApplicationLinks,
                AdapterAvailability::Available
            ),
            GateDecision::Authorized
        );
        for foreign in [
            scope(5, 8, 2, "app://ui"),
            scope(4, 9, 2, "app://ui"),
            scope(4, 8, 1, "app://ui"),
        ] {
            assert_eq!(
                policy.authorize_native(
                    &foreign,
                    &NativeRequest::ApplicationLinks,
                    AdapterAvailability::Available
                ),
                GateDecision::Denied
            );
        }
        policy.navigation_started(live.view);
        assert_eq!(
            policy.authorize_native(
                &live,
                &NativeRequest::ApplicationLinks,
                AdapterAvailability::Available
            ),
            GateDecision::Denied
        );
        assert!(decode_native_capability(
            serde_json::json!({"name":"application-links","route":"untrusted"})
        )
        .is_err());
    }

    #[test]
    fn status_item_grant_is_distinct_and_revokes_with_its_exact_document() {
        let mut policy = Policy::default();
        let live = scope(4, 8, 2, "app://ui");
        policy.install_document(live.clone()).unwrap();
        policy
            .grant_native(&live, NativeCapability::WindowCommands)
            .unwrap();
        assert_eq!(
            policy.authorize_native(
                &live,
                &NativeRequest::StatusItem,
                AdapterAvailability::Available
            ),
            GateDecision::Denied
        );
        policy
            .grant_native(&live, NativeCapability::StatusItem)
            .unwrap();
        assert_eq!(
            policy.authorize_native(
                &live,
                &NativeRequest::StatusItem,
                AdapterAvailability::Available
            ),
            GateDecision::Authorized
        );
        assert_eq!(
            policy.authorize_native(
                &live,
                &NativeRequest::StatusItem,
                AdapterAvailability::Unavailable
            ),
            GateDecision::Unavailable
        );
        policy.navigation_started(live.view);
        assert_eq!(
            policy.authorize_native(
                &live,
                &NativeRequest::StatusItem,
                AdapterAvailability::Available
            ),
            GateDecision::Denied
        );
        assert!(decode_native_capability(
            serde_json::json!({"name":"status-item","title":"not-a-grant"})
        )
        .is_err());
        assert!(decode_native_request(serde_json::json!({"name":"status-item","view":4})).is_err());
    }

    #[test]
    fn stale_forged_and_cross_session_scopes_are_denied() {
        let mut policy = Policy::default();
        let live = scope(4, 8, 2, "app://ui");
        policy.install_document(live.clone()).unwrap();
        policy
            .grant_native(&live, NativeCapability::ClipboardRead)
            .unwrap();
        for forged in [
            scope(5, 8, 2, "app://ui"),
            scope(4, 9, 2, "app://ui"),
            scope(4, 8, 1, "app://ui"),
            scope(4, 8, 2, "https://evil.invalid"),
        ] {
            assert_eq!(
                policy.authorize_native(
                    &forged,
                    &NativeRequest::ClipboardRead,
                    AdapterAvailability::Available
                ),
                GateDecision::Denied
            );
        }
    }

    #[test]
    fn captured_scope_wire_format_is_exact_and_bounded() {
        let live = scope(4, 8, 2, "app://ui");
        let encoded = serde_json::to_value(&live).unwrap();
        assert_eq!(decode_document_scope(encoded), Ok(live));
        assert!(decode_document_scope(serde_json::json!({
            "view": 4,
            "session": 8,
            "generation": 2,
            "mainFrame": "frame-4",
            "document": "document-2",
            "origin": "app://ui",
            "pageClaim": "forged"
        }))
        .is_err());
        assert!(decode_document_scope(serde_json::json!({
            "view": 4,
            "session": 8,
            "generation": 2,
            "mainFrame": "frame-4",
            "document": "document-2",
            "origin": "x".repeat(4097)
        }))
        .is_err());
    }

    #[test]
    fn navigation_reload_replacement_and_close_revoke_every_grant() {
        let mut policy = Policy::default();
        let old = scope(1, 2, 3, "app://ui");
        policy.install_document(old.clone()).unwrap();
        policy
            .grant_native(&old, NativeCapability::ClipboardRead)
            .unwrap();
        policy
            .grant_browser(
                &old,
                BrowserCapability::Camera,
                BrowserGrantSource::ApplicationPolicy,
            )
            .unwrap();
        policy.navigation_started(old.view);
        assert_eq!(
            policy.authorize_browser(&old, BrowserCapability::Camera),
            None
        );
        assert_eq!(
            policy.authorize_native(
                &old,
                &NativeRequest::ClipboardRead,
                AdapterAvailability::Available
            ),
            GateDecision::Denied
        );
        let replacement = scope(1, 2, 4, "app://ui");
        policy.install_document(replacement.clone()).unwrap();
        assert_eq!(
            policy.authorize_browser(&replacement, BrowserCapability::Camera),
            None
        );
        policy.close_view(replacement.view);
        assert!(policy
            .grant_native(&replacement, NativeCapability::ClipboardRead)
            .is_err());
    }

    #[test]
    fn prompt_completion_racing_navigation_or_close_is_stale_and_single_use() {
        let mut policy = Policy::default();
        let live = scope(1, 2, 3, "https://trusted.invalid");
        policy.install_document(live.clone()).unwrap();
        let token = policy
            .begin_prompt(&live, BrowserCapability::Microphone)
            .unwrap();
        policy.navigation_started(live.view);
        assert!(policy.complete_prompt(token, true).is_err());
        policy.install_document(live.clone()).unwrap();
        let token = policy
            .begin_prompt(&live, BrowserCapability::Camera)
            .unwrap();
        assert_eq!(policy.complete_prompt(token.clone(), true), Ok(true));
        assert!(policy.complete_prompt(token, true).is_err());
        assert_eq!(
            policy.authorize_browser(&live, BrowserCapability::Camera),
            Some(BrowserGrantSource::UserDecision)
        );
    }

    #[test]
    fn prepared_grant_and_authorization_snapshots_cannot_cross_navigation() {
        let mut policy = Policy::default();
        let live = scope(1, 2, 3, "app://ui");
        policy.install_document(live.clone()).unwrap();
        let prepared = prepare_native_capability(NativeCapability::ClipboardRead).unwrap();
        policy.navigation_started(live.view);
        assert!(policy.grant_prepared_native(&live, prepared).is_err());
        assert!(policy
            .set_browser_decision(
                &live,
                BrowserCapability::Camera,
                BrowserGrantSource::ApplicationPolicy,
                true,
            )
            .is_err());

        policy.install_document(live.clone()).unwrap();
        policy
            .grant_native(&live, NativeCapability::ClipboardRead)
            .unwrap();
        let grants = policy.native_grants(&live).unwrap();
        policy.close_view(live.view);
        assert_eq!(
            authorize_native_grants(
                &grants,
                &NativeRequest::ClipboardRead,
                AdapterAvailability::Unavailable,
            ),
            GateDecision::Unavailable
        );
        assert!(policy.current_scope(live.view).is_none());
    }

    #[test]
    fn unavailable_adapter_is_not_reported_as_permission_denial_or_success() {
        let mut policy = Policy::default();
        let live = scope(1, 2, 3, "app://ui");
        policy.install_document(live.clone()).unwrap();
        policy
            .grant_native(&live, NativeCapability::DialogOpen)
            .unwrap();
        assert_eq!(
            policy.authorize_native(
                &live,
                &NativeRequest::DialogOpen,
                AdapterAvailability::Unavailable
            ),
            GateDecision::Unavailable
        );
        assert_eq!(
            policy.authorize_native(
                &live,
                &NativeRequest::DialogSave,
                AdapterAvailability::Unavailable
            ),
            GateDecision::Denied
        );
        assert_eq!(
            policy.authorize_native(
                &live,
                &NativeRequest::Unknown {
                    name: "future".into()
                },
                AdapterAvailability::Available
            ),
            GateDecision::Denied
        );
    }

    #[test]
    fn control_pipe_rejects_unknown_and_malformed_capability_shapes() {
        let capability = decode_native_capability(serde_json::json!({
            "name": "process-execute",
            "executable": "/fixture/tool",
            "arguments": ["--literal"]
        }))
        .unwrap();
        assert!(matches!(capability, NativeCapability::Execute { .. }));
        for value in [
            serde_json::json!({"name":"unknown"}),
            serde_json::json!({"name":"clipboard-read","extra":true}),
            serde_json::json!({"name":"process-execute","executable":"/bin/tool","arguments":"shell string"}),
        ] {
            assert!(decode_native_capability(value).is_err());
        }
        assert!(BrowserCapability::from_name("future-permission").is_none());
    }

    #[test]
    fn relative_request_spelling_is_validated_before_platform_normalization() {
        for value in ["read.txt", "new/file.txt", "Nested/Exact-name_1.bin"] {
            assert!(validate_relative_path_text(value).is_ok(), "{value}");
        }
        for value in [
            r"sub\read.txt",
            r"sub\..\read.txt",
            "sub//read.txt",
            "./read.txt",
            "sub/./read.txt",
            "read.txt/",
            "/read.txt",
            "../read.txt",
            "",
            "C:read.txt",
            "C:/read.txt",
            "sub/NUL.txt",
            "sub/file:stream",
            "sub/read.txt.",
            "sub/read.txt ",
            "sub/é",
            "sub/\nread.txt",
        ] {
            assert!(validate_relative_path_text(value).is_err(), "{value:?}");
        }
        assert!(validate_relative_path_text(&vec!["a"; 128].join("/")).is_ok());
        assert!(validate_relative_path_text(&vec!["a"; 129].join("/")).is_err());
        assert!(validate_relative_path_text(&"a".repeat(4097)).is_err());
    }

    #[test]
    fn paths_reject_escape_prefix_confusion_symlinks_and_platform_aliases() {
        let root = fixture();
        assert!(contained_path(&root, Path::new("read.txt"), true).is_ok());
        for path in [
            "../read.txt",
            "sub/../../read.txt",
            "read.txt.",
            "C:read.txt",
            r"sub\read.txt",
            "sub//read.txt",
            "./read.txt",
            "sub/./read.txt",
            "read.txt/",
            "CON",
            "nul.txt",
            "COM1.log",
            "aux",
            "LPT9.txt",
            "",
            "sub/file:stream",
        ] {
            assert!(
                contained_path(&root, Path::new(path), false).is_err(),
                "{path}"
            );
        }
        assert!(contained_path(&root, Path::new("new/file.txt"), false).is_ok());
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink("read.txt", root.join("alias")).unwrap();
            assert!(contained_path(&root, Path::new("alias"), true).is_err());
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn process_grants_require_exact_executable_and_argument_vector() {
        let root = fixture();
        let executable = root.join("read.txt");
        let mut policy = Policy::default();
        let live = scope(1, 2, 3, "app://ui");
        policy.install_document(live.clone()).unwrap();
        policy
            .grant_native(
                &live,
                NativeCapability::Execute {
                    executable: executable.clone(),
                    arguments: vec!["--literal".into(), "a;b".into()],
                },
            )
            .unwrap();
        let exact = NativeRequest::Execute {
            executable: executable.clone(),
            arguments: vec!["--literal".into(), "a;b".into()],
        };
        assert_eq!(
            policy.authorize_native(&live, &exact, AdapterAvailability::Available),
            GateDecision::Authorized
        );
        for arguments in [
            vec!["--literal".into(), "a;b && injected".into()],
            vec!["--literal".into()],
            vec!["bad\0arg".into()],
        ] {
            assert_eq!(
                policy.authorize_native(
                    &live,
                    &NativeRequest::Execute {
                        executable: executable.clone(),
                        arguments
                    },
                    AdapterAvailability::Available
                ),
                GateDecision::Denied
            );
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn popup_external_protocol_and_certificate_fail_closed() {
        assert!(!allow_popup());
        for scheme in ["mailto", "custom", "javascript", "file"] {
            assert!(!allow_external_protocol(scheme));
        }
        for certificate_error in [-200, -201, -202] {
            assert!(!allow_certificate_error(certificate_error));
        }
    }

    #[test]
    fn frameless_and_same_origin_child_callbacks_cannot_reuse_main_grant() {
        let mut policy = Policy::default();
        let main = scope(1, 2, 3, "https://trusted.invalid");
        policy.install_document(main.clone()).unwrap();
        policy
            .grant_browser(
                &main,
                BrowserCapability::Geolocation,
                BrowserGrantSource::UserDecision,
            )
            .unwrap();
        assert!(permission_callback_scope(&main, None, "https://trusted.invalid").is_none());
        assert!(permission_callback_scope(
            &main,
            Some(("same-origin-child", false)),
            "https://trusted.invalid"
        )
        .is_none());
        assert_eq!(
            permission_callback_scope(
                &main,
                Some((main.main_frame.as_str(), true)),
                "https://trusted.invalid"
            ),
            Some(main)
        );
    }
}
