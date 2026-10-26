//! Installed terminal-owner identity and the native GUI's generation lifetime.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    io::Read,
    path::{Path, PathBuf},
};

pub const PROTOCOL: u32 = 2;
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Manifest {
    pub version: String,
    pub protocol: u32,
    pub platform: String,
    pub arch: String,
    pub bytes: u64,
    pub sha256: String,
}
pub fn platform() -> &'static str {
    if cfg!(target_os = "macos") {
        "darwin"
    } else if cfg!(windows) {
        "win32"
    } else {
        "linux"
    }
}
pub fn arch() -> &'static str {
    if cfg!(target_arch = "aarch64") {
        "arm64"
    } else {
        "x64"
    }
}
pub fn name() -> &'static str {
    if cfg!(windows) {
        "bunly-terminal-owner.exe"
    } else {
        "bunly-terminal-owner"
    }
}
pub fn fingerprint(path: &Path) -> Result<Manifest, String> {
    let info = path
        .symlink_metadata()
        .map_err(|_| "Terminal owner missing; no fallback")?;
    if !info.is_file() || info.len() == 0 || info.len() > 128 * 1024 * 1024 {
        return Err("Invalid terminal owner artifact".into());
    }
    let mut file = std::fs::File::open(path).map_err(|_| "Cannot open terminal owner")?;
    let mut hash = Sha256::new();
    let mut bytes = 0;
    let mut buffer = [0; 65536];
    loop {
        let count = file
            .read(&mut buffer)
            .map_err(|_| "Cannot read terminal owner")?;
        if count == 0 {
            break;
        }
        bytes += count as u64;
        if bytes > info.len() {
            return Err("Terminal owner changed".into());
        }
        hash.update(&buffer[..count]);
    }
    if bytes != info.len() {
        return Err("Terminal owner changed".into());
    }
    Ok(Manifest {
        version: env!("CARGO_PKG_VERSION").into(),
        protocol: PROTOCOL,
        platform: platform().into(),
        arch: arch().into(),
        bytes,
        sha256: format!("{:x}", hash.finalize()),
    })
}
pub fn discover(directory: &Path) -> Result<(PathBuf, Manifest), String> {
    let path = directory.join(name());
    let raw = std::fs::read(directory.join("terminal-owner.json"))
        .map_err(|_| "Terminal owner manifest missing; no fallback")?;
    if raw.len() > 4096 {
        return Err("Terminal owner manifest too large".into());
    }
    let expected: Manifest =
        serde_json::from_slice(&raw).map_err(|_| "Terminal owner manifest invalid")?;
    let actual = fingerprint(&path)?;
    if expected.version != actual.version
        || expected.protocol != PROTOCOL
        || expected.platform != actual.platform
        || expected.arch != actual.arch
        || expected.bytes != actual.bytes
        || expected.sha256 != actual.sha256
    {
        return Err("Terminal owner identity/integrity mismatch".into());
    }
    Ok((path, actual))
}

#[cfg(unix)]
pub mod lifetime {
    use std::{
        io,
        os::{
            fd::AsRawFd,
            unix::{net::UnixStream, process::CommandExt},
        },
        process::Command,
        sync::{Mutex, OnceLock},
    };
    // Only the GUI retains this endpoint. Both original endpoints are CLOEXEC;
    // only the read peer is explicitly inherited into the supervised Bun child.
    static WRITER: OnceLock<Mutex<Option<UnixStream>>> = OnceLock::new();
    pub fn attach(command: &mut Command) -> io::Result<UnixStream> {
        let (writer, reader) = UnixStream::pair()?;
        let fd = reader.as_raw_fd();
        WRITER
            .set(Mutex::new(Some(writer)))
            .map_err(|_| io::ErrorKind::AlreadyExists)?;
        unsafe {
            command.pre_exec(move || {
                if libc::fcntl(fd, libc::F_SETFD, 0) != 0 {
                    return Err(io::Error::last_os_error());
                }
                Ok(())
            });
        }
        Ok(reader)
    }
    pub fn revoke() {
        if let Some(writer) = WRITER.get() {
            if let Ok(mut writer) = writer.lock() {
                writer.take();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn discovery_rejects_missing_wrong_version_platform_and_modified_bytes() {
        let root = std::env::temp_dir().join(format!(
            "bunly-owner-manifest-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&root).unwrap();
        struct Cleanup(PathBuf);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
        let _cleanup = Cleanup(root.clone());
        assert!(discover(&root).is_err());
        let path = root.join(name());
        std::fs::write(&path, b"fixed binary fixture").unwrap();
        let mut manifest = fingerprint(&path).unwrap();
        let write = |manifest: &Manifest| {
            std::fs::write(
                root.join("terminal-owner.json"),
                serde_json::to_vec(manifest).unwrap(),
            )
            .unwrap()
        };
        write(&manifest);
        assert!(discover(&root).is_ok());
        manifest.protocol = 1;
        write(&manifest);
        assert!(discover(&root).is_err());
        manifest.protocol = PROTOCOL;
        manifest.platform = "other".into();
        write(&manifest);
        assert!(discover(&root).is_err());
        manifest.platform = platform().into();
        write(&manifest);
        std::fs::write(path, b"changed binary data!").unwrap();
        assert!(discover(&root).is_err());
    }
}
