use crate::{Error, Phase, Result};
use std::ffi::CString;
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::os::unix::{fs::OpenOptionsExt, process::CommandExt};
use std::path::{Path, PathBuf};
use std::process::Command;

const ENABLE: &str = "BUN_NATIVE_ALLOCATIONS";
const REEXEC: &str = "BUN_NATIVE_ALLOCATION_REEXEC";
const SOURCES: [&str; 2] = [
    "6ea507b58d0249b752ff62691ebc1879f3fcf6da",
    "4549e75ca5463f136898a2f5fb49d22b58dffa11",
];

pub(crate) struct Config {
    pub(crate) phase: Phase,
    pub(crate) nonce: String,
    pub(crate) source: String,
    pub(crate) build: String,
    pub(crate) directory: PathBuf,
    pub(crate) library: PathBuf,
    reexec: Option<String>,
}

impl Config {
    pub(crate) fn parse(
        get: impl Fn(&str) -> Option<String>,
        compiled_build: &str,
    ) -> Result<Option<Self>> {
        match get(ENABLE).as_deref() {
            None => return Ok(None),
            Some("1") => {}
            _ => return Err(Error("diagnostic enable flag must be exactly 1")),
        }
        let required =
            |name| get(name).ok_or(Error("incomplete allocation diagnostic configuration"));
        let nonce = required("BUN_NATIVE_ALLOCATION_NONCE")?;
        let source = required("BUN_NATIVE_ALLOCATION_SOURCE")?;
        let build = required("BUN_NATIVE_ALLOCATION_BUILD_ID")?;
        if !hex(&nonce, 32) || !SOURCES.contains(&source.as_str()) {
            return Err(Error("allocation diagnostic identity is invalid"));
        }
        if !hex(compiled_build, 64) || build != compiled_build {
            return Err(Error("diagnostic rlib build identity does not match"));
        }
        let directory = PathBuf::from(required("BUN_NATIVE_ALLOCATION_OUTPUT")?);
        let library = PathBuf::from(required("BUN_NATIVE_ALLOCATION_PRELOAD")?);
        if !directory.is_absolute() || !library.is_absolute() {
            return Err(Error("diagnostic paths must be absolute"));
        }
        Ok(Some(Self {
            phase: Phase::parse(&required("BUN_NATIVE_ALLOCATION_PHASE")?)?,
            nonce,
            source,
            build,
            directory,
            library,
            reexec: get(REEXEC),
        }))
    }

    pub(crate) fn prepare(&mut self) -> Result<CString> {
        use std::os::unix::fs::PermissionsExt;
        let directory = std::fs::symlink_metadata(&self.directory)
            .map_err(|_| Error("diagnostic directory is unavailable"))?;
        if !directory.is_dir() || directory.permissions().mode() & 0o077 != 0 {
            return Err(Error("diagnostic directory must be private and real"));
        }
        self.directory = self
            .directory
            .canonicalize()
            .map_err(|_| Error("diagnostic directory identity is unavailable"))?;
        let library = std::fs::symlink_metadata(&self.library)
            .map_err(|_| Error("profiler library is unavailable"))?;
        if !library.is_file() {
            return Err(Error("profiler library must be a regular file"));
        }
        self.library = self
            .library
            .canonicalize()
            .map_err(|_| Error("profiler library identity is unavailable"))?;
        let guard = format!("{}:{}", self.nonce, self.build);
        match self.reexec.as_deref() {
            None => {
                if std::env::var_os("LD_PRELOAD").is_some()
                    || std::env::var_os("DUMP_HEAPTRACK_OUTPUT").is_some()
                {
                    return Err(Error("unexpected inherited profiler injection"));
                }
                let initial = self.directory.join("preload.raw");
                reserve(&initial)?;
                // Only our existing executable is replaced, before native/GPUI
                // threads. The unchanged Bun client sees the same path/hash/PID;
                // Bun itself never inherits LD_PRELOAD from this command.
                let executable = std::env::current_exe()
                    .map_err(|_| Error("owned executable identity is unavailable"))?;
                let _error = Command::new(executable)
                    .args(std::env::args_os().skip(1))
                    .env(REEXEC, guard)
                    .env("LD_PRELOAD", &self.library)
                    .env("DUMP_HEAPTRACK_OUTPUT", initial)
                    .exec();
                Err(Error("owned profiler preload exec failed"))
            }
            Some(actual) if actual == guard => {
                let raw = self.directory.join("allocation.raw");
                reserve(&raw)?;
                CString::new(raw.as_os_str().as_encoded_bytes())
                    .map_err(|_| Error("diagnostic output path contains NUL"))
            }
            Some(_) => Err(Error("diagnostic exec guard does not match")),
        }
    }

    pub(crate) fn report(&self, name: &str, fields: &str) -> Result<()> {
        // Variable strings are validated hex/enums. fields is private, numeric
        // or fixed source text; application payloads never enter this record.
        let encoded = format!(
            "{{\"schemaVersion\":1,\"nonce\":\"{}\",\"source\":\"{}\",\"buildId\":\"{}\",\"phase\":\"{}\",\"pid\":{},{} }}\n",
            self.nonce,
            self.source,
            self.build,
            self.phase.name(),
            std::process::id(),
            fields
        );
        if encoded.len() > 4096 {
            return Err(Error("diagnostic report exceeds its bound"));
        }
        reserve(&self.directory.join(name))?
            .write_all(encoded.as_bytes())
            .map_err(|_| Error("diagnostic report write failed"))
    }
}

fn hex(value: &str, length: usize) -> bool {
    value.len() == length
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}
fn reserve(path: &Path) -> Result<File> {
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)
        .map_err(|_| Error("diagnostic output must be new and writable"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;
    fn environment() -> BTreeMap<&'static str, String> {
        [
            (ENABLE, "1".into()),
            ("BUN_NATIVE_ALLOCATION_NONCE", "a".repeat(32)),
            ("BUN_NATIVE_ALLOCATION_BUILD_ID", "b".repeat(64)),
            ("BUN_NATIVE_ALLOCATION_SOURCE", SOURCES[0].into()),
            ("BUN_NATIVE_ALLOCATION_OUTPUT", "/owned/output".into()),
            ("BUN_NATIVE_ALLOCATION_PRELOAD", "/owned/profiler.so".into()),
            ("BUN_NATIVE_ALLOCATION_PHASE", "individual".into()),
        ]
        .into_iter()
        .collect()
    }
    #[test]
    fn disabled_does_not_read_other_configuration() {
        assert!(
            Config::parse(
                |name| {
                    assert_eq!(name, ENABLE);
                    None
                },
                ""
            )
            .unwrap()
            .is_none()
        );
    }
    #[test]
    fn malformed_or_mismatched_configuration_fails_closed() {
        for (name, value) in [
            (ENABLE, "true"),
            ("BUN_NATIVE_ALLOCATION_NONCE", "../output"),
            ("BUN_NATIVE_ALLOCATION_BUILD_ID", "wrong"),
            ("BUN_NATIVE_ALLOCATION_SOURCE", "main"),
            ("BUN_NATIVE_ALLOCATION_OUTPUT", "relative"),
            ("BUN_NATIVE_ALLOCATION_PRELOAD", "relative"),
            ("BUN_NATIVE_ALLOCATION_PHASE", "all"),
        ] {
            let mut values = environment();
            values.insert(name, value.into());
            assert!(Config::parse(|key| values.get(key).cloned(), &"b".repeat(64)).is_err());
        }
        let values = environment();
        assert!(Config::parse(|key| values.get(key).cloned(), "").is_err());
        assert!(
            Config::parse(|key| values.get(key).cloned(), &"b".repeat(64))
                .unwrap()
                .is_some()
        );
    }
}
