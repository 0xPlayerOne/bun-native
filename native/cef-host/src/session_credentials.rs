//! Explicit OS-cookie policy and private proof-profile metadata. No OS secret is
//! read here. Actual protection is verified from a native-written canary and a
//! trusted Bun readonly SQLite check before any protected application context.
use super::*;

pub const PROBE_PARTITION: &str = "bunly-internal-credential-proof";
pub const PROBE_ORIGIN: &str = "https://bunly-credential-proof.invalid/";
pub const PROBE_HOST: &str = "bunly-credential-proof.invalid";
pub const PROBE_COOKIE: &str = "__Host-bunly-credential-proof";
const OWNER_MARKER: &str = ".bunly-credential-owner.json";
const PROOF_MARKER: &str = ".bunly-credential-proof.json";
const PROTECTED_MARKER: &str = ".bunly-protected-cookies.json";

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum Provider {
    MacosKeychain,
    WindowsDpapi,
    LinuxSecretService,
}
impl Provider {
    pub fn name(&self) -> &'static str {
        match self {
            Self::MacosKeychain => "macos-keychain",
            Self::WindowsDpapi => "windows-dpapi",
            Self::LinuxSecretService => "linux-secret-service",
        }
    }
    pub fn tag(&self) -> &'static str {
        if matches!(self, Self::LinuxSecretService) {
            "v11"
        } else {
            "v10"
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Policy {
    pub application_id: String,
    pub provider: Provider,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shared_key_scope: Option<String>,
}
impl Policy {
    pub fn validate(&self) -> Result<(), String> {
        self.validate_for(std::env::consts::OS)
    }
    fn validate_for(&self, platform: &str) -> Result<(), String> {
        let id = self.application_id.as_str();
        if id.len() > 128
            || id.split('.').count() < 2
            || id.split('.').any(|part| {
                part.is_empty()
                    || !part.as_bytes()[0].is_ascii_lowercase()
                    || !part.as_bytes()[part.len() - 1].is_ascii_alphanumeric()
                    || !part
                        .bytes()
                        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
            })
        {
            return Err(
                "Credential policy requires a bounded explicit application identity".into(),
            );
        }
        match (&self.provider, platform, self.shared_key_scope.as_deref()) {
            (Provider::MacosKeychain, "macos", None)
            | (Provider::WindowsDpapi, "windows", None)
            | (Provider::LinuxSecretService, "linux", Some("chromium-user-shared")) => Ok(()),
            _ => Err("Credential provider/platform or explicit key-scope policy mismatch".into()),
        }
    }
    pub fn configure(&self, settings: &mut cef::Settings) {
        #[cfg(target_os = "macos")]
        {
            settings.keychain_service_name = cef::CefString::from(
                format!("Bunly {} Safe Storage", self.application_id).as_str(),
            );
            settings.keychain_account_name = cef::CefString::from(self.application_id.as_str());
        }
        #[cfg(not(target_os = "macos"))]
        let _ = settings;
    }
}

#[derive(Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Owner {
    schema: u32,
    policy: Policy,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Seal {
    schema: u32,
    policy: Policy,
    nonce: String,
    ready: bool,
}

#[derive(Clone, Debug)]
pub struct Probe {
    pub path: PathBuf,
    pub policy: Policy,
    pub nonce: String,
    pub was_ready: bool,
    pub native_verified: bool,
}

fn owned_json<T: serde::de::DeserializeOwned>(path: &Path) -> Result<T, String> {
    reject_existing_symlink_components(path)?;
    let info = path.symlink_metadata().map_err(|error| error.to_string())?;
    if !info.is_file() || info.len() > 4096 {
        return Err("Invalid bounded credential metadata".into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if info.uid() != unsafe { libc::geteuid() } || info.mode() & 0o077 != 0 {
            return Err("Credential metadata must be private and owned".into());
        }
    }
    let mut file = OpenOptions::new()
        .read(true)
        .open(path)
        .map_err(|error| error.to_string())?;
    let mut bytes = Vec::new();
    std::io::Read::by_ref(&mut file)
        .take(4097)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    if bytes.len() > 4096 {
        return Err("Credential metadata bound exceeded".into());
    }
    serde_json::from_slice(&bytes).map_err(|_| "Corrupt credential metadata".into())
}
fn exists(path: &Path) -> Result<bool, String> {
    match path.symlink_metadata() {
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => Err(error.to_string()),
    }
}
fn write_new<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    let bytes = serde_json::to_vec(value).map_err(|error| error.to_string())?;
    if bytes.len() > 4096 {
        return Err("Credential metadata bound exceeded".into());
    }
    let mut file = options.open(path).map_err(|error| error.to_string())?;
    file.write_all(&bytes)
        .and_then(|_| file.sync_all())
        .map_err(|error| error.to_string())?;
    #[cfg(unix)]
    File::open(path.parent().ok_or("Credential metadata owner missing")?)
        .and_then(|file| file.sync_all())
        .map_err(|error| error.to_string())?;
    Ok(())
}
fn fresh_profile(path: &Path) -> Result<(), String> {
    for entry in fs::read_dir(path)
        .map_err(|error| error.to_string())?
        .take(3)
    {
        let name = entry.map_err(|error| error.to_string())?.file_name();
        if name != PROFILE_MARKER && name != PROFILE_LOCK {
            return Err("Existing unqualified cookie profile requires an explicit offline reset or migration".into());
        }
    }
    Ok(())
}

/// Call only while the root's native ownership lease is held, before CefInitialize.
pub fn bind_root(root: &ProfileRoot, policy: Option<&Policy>) -> Result<(), String> {
    let path = root.path().join(OWNER_MARKER);
    if exists(&path)? {
        let expected =
            policy.ok_or("Protected profile root requires its explicit credential policy")?;
        let owner: Owner = owned_json(&path)?;
        if owner.schema != 1 || owner.policy != *expected {
            return Err("Persistent root credential identity/provider changed".into());
        }
    } else if let Some(policy) = policy {
        policy.validate()?;
        write_new(
            &path,
            &Owner {
                schema: 1,
                policy: policy.clone(),
            },
        )?;
    }
    Ok(())
}

pub fn application_profile(path: &Path, policy: Option<&Policy>) -> Result<(), String> {
    let marker = path.join(PROTECTED_MARKER);
    if exists(&marker)? {
        let expected = policy
            .ok_or("Protected cookie profile cannot be opened without protected-cookie intent")?;
        let owner: Owner = owned_json(&marker)?;
        if owner.schema != 1 || owner.policy != *expected {
            return Err("Cookie profile credential identity/provider changed".into());
        }
    } else if let Some(policy) = policy {
        fresh_profile(path)?;
        write_new(
            &marker,
            &Owner {
                schema: 1,
                policy: policy.clone(),
            },
        )?;
    }
    Ok(())
}

pub fn prepare_probe(path: &Path, policy: &Policy, proposed_nonce: &str) -> Result<Probe, String> {
    if proposed_nonce.len() != 64
        || !proposed_nonce
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err("Invalid bounded credential probe nonce".into());
    }
    let marker = path.join(PROOF_MARKER);
    let seal = if exists(&marker)? {
        let seal: Seal = owned_json(&marker)?;
        if seal.schema != 1
            || seal.policy != *policy
            || seal.nonce.len() != 64
            || !seal
                .nonce
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err("Credential proof identity or metadata changed".into());
        }
        seal
    } else {
        fresh_profile(path)?;
        let seal = Seal {
            schema: 1,
            policy: policy.clone(),
            nonce: proposed_nonce.into(),
            ready: false,
        };
        write_new(&marker, &seal)?;
        seal
    };
    Ok(Probe {
        path: path.into(),
        policy: seal.policy,
        nonce: seal.nonce,
        was_ready: seal.ready,
        native_verified: false,
    })
}

pub fn seal_verified(probe: &Probe) -> Result<(), String> {
    if !probe.native_verified {
        return Err("Native cookie proof was not verified".into());
    }
    let path = probe.path.join(PROOF_MARKER);
    let mut current: Seal = owned_json(&path)?;
    if current.schema != 1
        || current.policy != probe.policy
        || current.nonce != probe.nonce
        || current.ready != probe.was_ready
    {
        return Err("Credential proof changed during verification".into());
    }
    if current.ready {
        return Ok(());
    }
    current.ready = true;
    let next = probe.path.join(".bunly-credential-proof.next");
    if exists(&next)? {
        let pending: Seal = owned_json(&next)?;
        if pending != current {
            return Err("Unowned credential proof replacement".into());
        }
    } else {
        write_new(&next, &current)?;
    }
    fs::rename(next, path).map_err(|error| error.to_string())?;
    #[cfg(unix)]
    File::open(&probe.path)
        .and_then(|file| file.sync_all())
        .map_err(|error| error.to_string())?;
    Ok(())
}

pub fn forbidden_override(args: impl IntoIterator<Item = String>) -> Result<(), String> {
    for argument in args {
        let key = argument.split('=').next().unwrap_or("");
        if [
            "--password-store",
            "--use-mock-keychain",
            "--disable-features",
            "--enable-features",
        ]
        .contains(&key)
        {
            return Err(
                "Credential-enabled runtime rejects encryption/provider feature overrides".into(),
            );
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn policy() -> Policy {
        Policy {
            application_id: "dev.bunly.credential-test".into(),
            provider: Provider::MacosKeychain,
            shared_key_scope: None,
        }
    }
    fn directory() -> PathBuf {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let value = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let path = normalized_canonical(&std::env::temp_dir())
            .unwrap()
            .join(format!(
                "bunly-credential-metadata-{}-{value}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
        fs::create_dir(&path).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
        }
        path
    }
    #[test]
    fn platform_provider_and_shared_scope_are_explicit() {
        let mac = policy();
        assert!(mac.validate_for("macos").is_ok());
        assert!(mac.validate_for("linux").is_err());
        let mut linux = Policy {
            provider: Provider::LinuxSecretService,
            ..mac.clone()
        };
        assert!(linux.validate_for("linux").is_err());
        linux.shared_key_scope = Some("chromium-user-shared".into());
        assert!(linux.validate_for("linux").is_ok());
        assert!(linux.validate_for("windows").is_err());
        for app in [
            "",
            "single",
            "dev..app",
            "dev.App",
            "dev.user/app",
            "dev.-bad",
            "dev.bad-",
            "dev.a\0b",
        ] {
            assert!(Policy {
                application_id: app.into(),
                ..mac.clone()
            }
            .validate_for("macos")
            .is_err());
        }
        assert!(Policy {
            provider: Provider::WindowsDpapi,
            ..mac
        }
        .validate_for("windows")
        .is_ok());
    }
    #[test]
    fn proof_is_bound_and_cannot_overwrite_unknown_or_unreadable_profiles() {
        let path = directory();
        let p = policy();
        let mut probe = prepare_probe(&path, &p, &"a".repeat(64)).unwrap();
        assert!(!probe.was_ready);
        assert!(seal_verified(&probe).is_err());
        probe.native_verified = true;
        seal_verified(&probe).unwrap();
        let again = prepare_probe(&path, &p, &"b".repeat(64)).unwrap();
        assert!(again.was_ready);
        assert_eq!(again.nonce, probe.nonce);
        assert!(prepare_probe(
            &path,
            &Policy {
                application_id: "other.application".into(),
                ..p.clone()
            },
            &"b".repeat(64)
        )
        .is_err());
        fs::write(path.join(PROOF_MARKER), b"{}").unwrap();
        assert!(prepare_probe(&path, &p, &"b".repeat(64)).is_err());
        fs::remove_dir_all(path).unwrap();
        let path = directory();
        fs::write(path.join("unknown-cookies"), b"unowned").unwrap();
        assert!(prepare_probe(&path, &p, &"a".repeat(64)).is_err());
        assert!(application_profile(&path, Some(&p)).is_err());
        fs::remove_dir_all(path).unwrap();
    }
    #[test]
    fn protected_application_profile_cannot_downgrade_to_disabled_or_other_identity() {
        let path = directory();
        let p = policy();
        application_profile(&path, Some(&p)).unwrap();
        assert!(application_profile(&path, None).is_err());
        assert!(application_profile(
            &path,
            Some(&Policy {
                application_id: "other.application".into(),
                ..p.clone()
            })
        )
        .is_err());
        application_profile(&path, Some(&p)).unwrap();
        fs::remove_dir_all(path).unwrap();
    }
    #[test]
    fn provider_switches_cannot_enable_known_fallbacks() {
        for arg in [
            "--use-mock-keychain",
            "--password-store=basic",
            "--disable-features=UseKeychainKeyProvider",
            "--enable-features=UnknownEncryption",
        ] {
            assert!(forbidden_override([arg.into()]).is_err());
        }
        assert!(forbidden_override(["app-path".into()]).is_ok());
    }
}
