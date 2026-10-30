//! Contributor-only startup capture for the synthetic Windows download fixture.
//! Raw data and clock anchors stay in the launcher's private temporary directory.
//! No page API, arbitrary categories, runtime warmup, or download deadline changes.
use cef::{CefString, CommandLine, ImplCommandLine};
use serde_json::{json, Value};
use std::{
    fs::OpenOptions,
    io::Write,
    path::{Component, Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicI64, Ordering},
        OnceLock,
    },
};

const DIRECTORY_ENV: &str = "BUNLY_DOWNLOAD_READINESS_TRACE_DIR";
const CATEGORIES: [&str; 6] = [
    "browser",
    "startup",
    "sql",
    "leveldb",
    "toplevel",
    "toplevel.flow",
];
struct Capture {
    directory: PathBuf,
    switches_applied: AtomicBool,
    before_initialize: i64,
    context_initialized: AtomicI64,
    first_download: AtomicI64,
    first_callback: AtomicI64,
}
static CAPTURE: OnceLock<Capture> = OnceLock::new();

fn permitted(windows: bool, hosted: bool, sandbox: bool, ephemeral: bool) -> bool {
    windows && hosted && sandbox && ephemeral
}

fn configuration(directory: &Path, process: u32) -> Value {
    json!({
        "trace_config": {
            "record_mode": "record-until-full",
            "trace_buffer_size_in_kb": 8192,
            "included_categories": CATEGORIES,
            "excluded_categories": ["*"],
            "included_process_ids": [process],
            "enable_systrace": false,
        },
        "startup_duration": 15,
        "result_file": directory.join("trace.json"),
    })
}

fn write_private(path: &Path, value: &Value) -> Result<(), String> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(path)
        .map_err(|_| "Cannot create private download trace sidecar")?;
    let bytes = serde_json::to_vec(value).map_err(|_| "Cannot encode download trace sidecar")?;
    file.write_all(&bytes)
        .map_err(|_| "Cannot write private download trace sidecar".into())
}

pub(crate) fn prepare(ephemeral: bool) -> Result<(), String> {
    let Some(directory) = std::env::var_os(DIRECTORY_ENV) else {
        return Ok(());
    };
    let hosted = std::env::var("GITHUB_ACTIONS").as_deref() == Ok("true")
        && std::env::var("RUNNER_ENVIRONMENT").as_deref() == Ok("github-hosted")
        && std::env::var("RUNNER_OS").as_deref() == Ok("Windows");
    if !permitted(
        cfg!(target_os = "windows"),
        hosted,
        std::env::var("BUNLY_BENCH_SANDBOX").as_deref() == Ok("1"),
        ephemeral,
    ) {
        return Err("Download tracing requires an isolated hosted Windows fixture".into());
    }
    let directory = PathBuf::from(directory);
    if !directory.is_absolute()
        || directory.as_os_str().len() > 4096
        || directory.components().any(|part| {
            !matches!(
                part,
                Component::Prefix(_) | Component::RootDir | Component::Normal(_)
            )
        })
    {
        return Err("Invalid private download trace directory".into());
    }
    let metadata = directory
        .symlink_metadata()
        .map_err(|_| "Missing private download trace directory")?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err("Invalid private download trace directory".into());
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT;
        if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err("Refusing reparse download trace directory".into());
        }
    }
    if std::fs::read_dir(&directory)
        .map_err(|_| "Cannot inspect private download trace directory")?
        .next()
        .is_some()
    {
        return Err("Download trace directory must be newly allocated and empty".into());
    }
    write_private(
        &directory.join("config.json"),
        &configuration(&directory, std::process::id()),
    )?;
    CAPTURE
        .set(Capture {
            directory,
            switches_applied: AtomicBool::new(false),
            before_initialize: cef::now_from_system_trace_time(),
            context_initialized: AtomicI64::new(0),
            first_download: AtomicI64::new(0),
            first_callback: AtomicI64::new(0),
        })
        .map_err(|_| "Download tracing cannot initialize twice".into())
}

pub(crate) fn configure(process_type: Option<&CefString>, line: Option<&CommandLine>) {
    let Some(capture) = CAPTURE.get() else {
        return;
    };
    if process_type.is_some_and(|value| !value.to_string().is_empty()) {
        return;
    }
    let Some(line) = line else { return };
    line.append_switch_with_value(
        Some(&CefString::from("trace-config-file")),
        Some(&CefString::from(
            capture
                .directory
                .join("config.json")
                .to_string_lossy()
                .as_ref(),
        )),
    );
    line.append_switch_with_value(
        Some(&CefString::from("trace-startup-format")),
        Some(&CefString::from("json")),
    );
    capture.switches_applied.store(true, Ordering::Relaxed);
}

fn first(slot: &AtomicI64) {
    if slot.load(Ordering::Relaxed) == 0 {
        let _ = slot.compare_exchange(
            0,
            cef::now_from_system_trace_time(),
            Ordering::Relaxed,
            Ordering::Relaxed,
        );
    }
}
pub(crate) fn context_initialized() {
    if let Some(capture) = CAPTURE.get() {
        first(&capture.context_initialized);
    }
}
pub(crate) fn download_started() {
    if let Some(capture) = CAPTURE.get() {
        first(&capture.first_download);
    }
}
pub(crate) fn download_callback() {
    if let Some(capture) = CAPTURE.get() {
        if capture.first_download.load(Ordering::Relaxed) > 0 {
            first(&capture.first_callback);
        }
    }
}

/// Called after CEF has stopped its startup trace; no CEF calls during teardown.
pub(crate) fn finish() -> Result<(), String> {
    let Some(capture) = CAPTURE.get() else {
        return Ok(());
    };
    let observed = |value: i64| (value > 0).then_some(value);
    write_private(
        &capture.directory.join("clocks.json"),
        &json!({
            "schema": 1,
            "switchesApplied": capture.switches_applied.load(Ordering::Relaxed),
            "process": std::process::id(),
            "beforeInitializeUs": observed(capture.before_initialize),
            "contextInitializedUs": observed(capture.context_initialized.load(Ordering::Relaxed)),
            "firstDownloadUs": observed(capture.first_download.load(Ordering::Relaxed)),
            "firstCallbackUs": observed(capture.first_callback.load(Ordering::Relaxed)),
        }),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capture_requires_all_contributor_guards() {
        for bits in 0..16 {
            assert_eq!(
                permitted(bits & 1 != 0, bits & 2 != 0, bits & 4 != 0, bits & 8 != 0),
                bits == 15
            );
        }
    }

    #[test]
    fn configuration_bounds_duration_memory_process_and_categories() {
        let config = configuration(Path::new("private"), 42);
        assert_eq!(config["startup_duration"], 15);
        let trace = &config["trace_config"];
        assert_eq!(trace["record_mode"], "record-until-full");
        assert_eq!(trace["trace_buffer_size_in_kb"], 8192);
        assert_eq!(trace["included_process_ids"], json!([42]));
        assert_eq!(trace["included_categories"], json!(CATEGORIES));
        assert_eq!(trace["excluded_categories"], json!(["*"]));
        assert_eq!(trace["enable_systrace"], false);
        assert!(trace.get("enable_argument_filter").is_none());
    }
}
