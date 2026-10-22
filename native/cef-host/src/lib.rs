//! First CEF host: one native GUI owner and one supervised Bun application.
use cef::*;
use serde::Deserialize;
use std::{path::PathBuf, sync::OnceLock};
mod asset_service;
mod deadlines;
mod handshake;
pub mod host;
#[cfg(target_os = "macos")]
mod keychain;
#[cfg(target_os = "macos")]
mod mac;
mod policy;
mod process;
pub mod resources;
mod scheme;
#[cfg(not(feature = "sandbox"))]
compile_error!("Bunly requires compiled sandbox support");
#[derive(Clone)]
pub struct Paths {
    pub resources: PathBuf,
    pub cache: PathBuf,
    pub bun: PathBuf,
    pub entry: PathBuf,
    pub dev_origin: Option<String>,
    pub(crate) deadlines: deadlines::DeadlineProfile,
}
pub static PATHS: OnceLock<Paths> = OnceLock::new();
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Config {
    schema: u32,
    protocol: u32,
    bun_version: String,
    cef_version: String,
    #[serde(default)]
    development_origin: Option<String>,
    #[serde(default)]
    qualification_profile: deadlines::DeadlineProfile,
}
pub fn browser_app() -> App {
    host::BunlyApp::new()
}
pub fn run(sandbox: *mut u8, main_args: Option<MainArgs>) -> i32 {
    match run_inner(sandbox, main_args) {
        Ok(code) => code,
        Err(error) => {
            eprintln!(
                "{}",
                serde_json::json!({"event":"bunly.host.error","error":error})
            );
            78
        }
    }
}
fn run_inner(sandbox: *mut u8, _main_args: Option<MainArgs>) -> Result<i32, String> {
    #[cfg(target_os = "macos")]
    let _loader = {
        let loader = library_loader::LibraryLoader::new(
            &std::env::current_exe().map_err(|e| e.to_string())?,
            false,
        );
        if !loader.load() {
            return Err("CEF framework missing or incompatible".into());
        }
        loader
    };
    let _ = api_hash(sys::CEF_API_VERSION_LAST, 0);
    #[cfg(target_os = "windows")]
    let args = args::Args::from(_main_args.ok_or("Windows requires sandbox bootstrap")?);
    #[cfg(not(target_os = "windows"))]
    let args = args::Args::new();
    let mut app = browser_app();
    let code = execute_process(Some(args.as_main_args()), Some(&mut app), sandbox);
    if code >= 0 {
        return Ok(code);
    }
    #[cfg(target_os = "windows")]
    if sandbox.is_null() {
        return Err("Missing Windows sandbox state".into());
    }
    policy::safe_switches(std::env::args())?;
    #[cfg(target_os = "linux")]
    {
        if unsafe { libc::geteuid() } == 0 {
            return Err("Linux CEF requires an unprivileged user with sandbox support; root/no-sandbox is not supported".into());
        }
        if std::env::var_os("DISPLAY").is_none() {
            return Err("M3 Linux requires an X11 DISPLAY (including Xwayland); native Wayland is not qualified".into());
        }
    }
    let executable = std::env::current_exe().map_err(|e| e.to_string())?;
    let directory = executable.parent().ok_or("missing executable parent")?;
    #[cfg(target_os = "macos")]
    let resources = directory
        .parent()
        .ok_or("missing Contents")?
        .join("Resources");
    #[cfg(not(target_os = "macos"))]
    let resources = directory.join("resources");
    let raw = std::fs::read(resources.join("runtime.json"))
        .map_err(|e| format!("Missing installed runtime configuration: {e}"))?;
    if raw.len() > 4096 {
        return Err("Runtime config too large".into());
    }
    let config: Config = serde_json::from_slice(&raw).map_err(|e| e.to_string())?;
    if config.schema != 1
        || config.protocol != 1
        || config.bun_version != "1.4.3"
        || config.cef_version != "154.0.34"
    {
        return Err("Runtime/ABI manifest mismatch".into());
    }
    let dev_origin = config
        .development_origin
        .as_deref()
        .map(policy::development_origin)
        .transpose()?;
    let asset_service = scheme::load(resources.join("public"))?;
    #[cfg(target_os = "macos")]
    for suffix in ["", " (GPU)", " (Renderer)", " (Plugin)", " (Alerts)"] {
        let name = format!(
            "{} Helper{}",
            executable
                .file_name()
                .and_then(|s| s.to_str())
                .ok_or("Invalid executable name")?,
            suffix
        );
        let helper = directory
            .parent()
            .ok_or("Missing Contents")?
            .join("Frameworks")
            .join(format!("{name}.app/Contents/MacOS/{name}"));
        if !helper.is_file() {
            return Err(format!(
                "Missing packaged CEF helper: {name}; no runtime fallback"
            ));
        }
    }
    let (cache, owned_cache) = match std::env::var_os("BUNLY_CACHE_DIR") {
        Some(path) => (PathBuf::from(path), false),
        None => {
            let mut chosen = None;
            for attempt in 0..32 {
                let stamp = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map_err(|e| e.to_string())?
                    .as_nanos();
                let path = std::env::temp_dir()
                    .join(format!("bunly-{}-{stamp}-{attempt}", std::process::id()));
                let builder = std::fs::DirBuilder::new();
                #[cfg(unix)]
                let builder = {
                    use std::os::unix::fs::DirBuilderExt;
                    let mut builder = builder;
                    builder.mode(0o700);
                    builder
                };
                match builder.create(&path) {
                    Ok(()) => {
                        chosen = Some(path);
                        break;
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
                    Err(e) => return Err(e.to_string()),
                }
            }
            (
                chosen.ok_or("Unable to allocate private runtime cache")?,
                true,
            )
        }
    };
    if !cache.is_absolute() {
        return Err("Cache directory must be absolute".into());
    }
    let _cleanup = OwnedCache(owned_cache.then(|| cache.clone()));
    if cache
        .symlink_metadata()
        .is_ok_and(|m| m.file_type().is_symlink())
    {
        return Err("Refusing symlink cache directory".into());
    }
    std::fs::create_dir_all(&cache).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let metadata = cache.metadata().map_err(|e| e.to_string())?;
        if metadata.uid() != unsafe { libc::geteuid() } || metadata.mode() & 0o022 != 0 {
            return Err("Cache must be owned and not writable by other users".into());
        }
    }
    let cache = std::fs::canonicalize(cache).map_err(|e| e.to_string())?;
    let bun = resources.join(if cfg!(windows) { "bun.exe" } else { "bun" });
    let entry = resources.join("backend/main.js");
    if !bun.is_file() || !entry.is_file() {
        return Err("Installed Bun or backend missing; runtime never downloads or compiles".into());
    }
    PATHS
        .set(Paths {
            resources: resources.clone(),
            cache: cache.clone(),
            bun,
            entry,
            dev_origin,
            deadlines: config.qualification_profile,
        })
        .map_err(|_| "Host cannot be initialized twice")?;
    eprintln!(
        "{}",
        serde_json::json!({"event":"bunly.runtime.profile", "profile":config.qualification_profile.name(), "startupTimeoutMs":config.qualification_profile.startup().as_millis(), "requestTimeoutMs":config.qualification_profile.requests_ms()})
    );
    #[cfg(target_os = "macos")]
    let _keychain_policy = keychain::NonInteractiveKeychain::enter()?;
    #[cfg(target_os = "macos")]
    eprintln!(
        "{}",
        serde_json::json!({"event":"bunly.credential-policy","mode":"non-interactive-existing-authorization-only","persistentSessions":false})
    );
    #[cfg(target_os = "macos")]
    let _application = mac::setup();
    let settings = Settings {
        no_sandbox: 0,
        command_line_args_disabled: 1,
        root_cache_path: CefString::from(cache.to_string_lossy().as_ref()),
        log_file: CefString::from(cache.join("cef.log").to_string_lossy().as_ref()),
        ..Default::default()
    };
    if initialize(
        Some(args.as_main_args()),
        Some(&settings),
        Some(&mut app),
        sandbox,
    ) != 1
    {
        return Err("CEF initialization failed".into());
    }
    run_message_loop();
    shutdown_phase("process-stop", process::stop);
    shutdown_phase("host-release", host::release);
    // Stop work and fence continuations before the CEF runtime is disposed.
    shutdown_phase("asset-service-stop", || drop(asset_service));
    shutdown_phase("cef-shutdown", shutdown);
    eprintln!(
        "{}",
        serde_json::json!({"event":"bunly.host.shutdown","clean":!host::FAILED.load(std::sync::atomic::Ordering::SeqCst)})
    );
    Ok(if host::FAILED.load(std::sync::atomic::Ordering::SeqCst) {
        1
    } else {
        0
    })
}

fn shutdown_phase(phase: &'static str, operation: impl FnOnce()) {
    eprintln!(
        "{}",
        serde_json::json!({"event":"bunly.host.shutdown-phase","phase":phase,"state":"start"})
    );
    let started = std::time::Instant::now();
    operation();
    eprintln!(
        "{}",
        serde_json::json!({"event":"bunly.host.shutdown-phase","phase":phase,"state":"complete","durationMs":started.elapsed().as_millis()})
    );
}

#[cfg(target_os = "windows")]
/// Entry called only by the matching CEF sandbox bootstrap executable.
///
/// # Safety
/// `instance` and `sandbox` must be the live values supplied by that bootstrap,
/// with their native lifetime retained until this function returns. This entry
/// must run on the process main thread and must not be called concurrently.
#[no_mangle]
pub unsafe extern "C" fn RunWinMain(
    instance: sys::HINSTANCE,
    _command_line: *const u8,
    _show: i32,
    sandbox: *mut u8,
) -> i32 {
    std::panic::catch_unwind(|| run(sandbox, Some(MainArgs { instance }))).unwrap_or(1)
}

struct OwnedCache(Option<PathBuf>);
impl Drop for OwnedCache {
    fn drop(&mut self) {
        if let Some(path) = self.0.take() {
            let _ = std::fs::remove_dir_all(path);
        }
    }
}
