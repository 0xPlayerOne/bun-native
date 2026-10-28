#[allow(dead_code)]
mod terminal_runtime;
// Contributor-only assembly. This binary is never included in an application.
use std::path::{Path, PathBuf};
fn artifacts(executable: &Path, required: &[&str]) -> Result<PathBuf, Box<dyn std::error::Error>> {
    let target = executable
        .parent()
        .ok_or("Bundler executable directory is unavailable")?;
    if !target.is_absolute() {
        return Err("Bundler executable directory must be absolute".into());
    }
    for name in required {
        let info = target.join(name).symlink_metadata()?;
        if !info.is_file() || info.len() == 0 {
            return Err(format!("Missing regular native sibling artifact: {name}").into());
        }
    }
    Ok(target.to_path_buf())
}
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let output = PathBuf::from(
        std::env::args()
            .nth(1)
            .ok_or("Expected an absolute output directory")?,
    );
    if !output.is_absolute() {
        return Err("Bundle destination must be absolute".into());
    }
    #[cfg(target_os = "macos")]
    let required = &["bunly_host", "bunly_helper", "bunly-terminal-owner"][..];
    #[cfg(target_os = "linux")]
    let required = &["bunly_host", "bunly-terminal-owner"][..];
    #[cfg(all(windows, feature = "sandbox"))]
    let required = &[
        "bunly_host.dll",
        "bunly_host.pdb",
        "bunly-terminal-owner.exe",
    ][..];
    #[cfg(all(windows, not(feature = "sandbox")))]
    let required = &["bunly_host.exe", "bunly-terminal-owner.exe"][..];
    // Cargo target overrides and separate feature builds must select their own
    // actual artifacts. Never silently assemble a different target/release host.
    let target = artifacts(&std::env::current_exe()?, required)?;
    #[cfg(target_os = "macos")]
    let path = cef::build_util::mac::bundle(
        &output,
        &target,
        "bunly_host",
        "bunly_helper",
        None,
        cef::build_util::mac::BundleInfo::new(
            "Bunly",
            "dev.bunly.fixture",
            "Bunly",
            "en",
            semver::Version::new(0, 1, 0),
        ),
    )?;
    #[cfg(target_os = "linux")]
    let path = cef::build_util::linux::bundle(&output, &target, "bunly_host")?;
    #[cfg(target_os = "windows")]
    let path = cef::build_util::win::bundle(&output, &target, "bunly_host")?;
    #[cfg(target_os = "macos")]
    let executables = path.join("Contents/MacOS");
    #[cfg(not(target_os = "macos"))]
    let executables = path
        .parent()
        .ok_or("Missing executable parent")?
        .to_path_buf();
    let owner = executables.join(terminal_runtime::name());
    std::fs::copy(target.join(terminal_runtime::name()), &owner)?;
    #[cfg(target_os = "macos")]
    if !std::process::Command::new("/usr/bin/codesign")
        .args(["--force", "--sign", "-"])
        .arg(&owner)
        .status()?
        .success()
    {
        return Err("Terminal owner contributor signing failed".into());
    }
    let manifest = terminal_runtime::fingerprint(&owner)?;
    std::fs::write(
        terminal_runtime::manifest_path(&executables),
        serde_json::to_vec(&manifest)?,
    )?;
    independent_files(if path.is_dir() {
        &path
    } else {
        path.parent().ok_or_else(|| {
            std::io::Error::new(std::io::ErrorKind::InvalidInput, "Missing bundle parent")
        })?
    })?;
    let data = serde_json::json!({"event":"bunly.runtime.assembled", "path":path});
    std::fs::write(
        output.join("bundle.json"),
        serde_json::to_vec_pretty(&data)?,
    )?;
    println!("{data}");
    Ok(())
}

// CEF's contributor assembler may hard-link native executables. Signing or
// rebuilding one output must not mutate Cargo's artifacts or another bundle.
fn independent_files(root: &std::path::Path) -> std::io::Result<()> {
    for entry in std::fs::read_dir(root)? {
        let path = entry?.path();
        let info = std::fs::symlink_metadata(&path)?;
        if info.is_dir() {
            independent_files(&path)?;
        } else if info.is_file() {
            #[cfg(unix)]
            let linked = {
                use std::os::unix::fs::MetadataExt;
                info.nlink() > 1
            };
            #[cfg(not(unix))]
            let linked = true;
            if linked {
                let temporary = path.with_extension(format!("bunly-copy-{}", std::process::id()));
                let mut source = std::fs::File::open(&path)?;
                let mut output = std::fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(&temporary)?;
                std::io::copy(&mut source, &mut output)?;
                output.sync_all()?;
                std::fs::set_permissions(&temporary, info.permissions())?;
                drop(output);
                std::fs::rename(temporary, path)?;
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn selection_uses_only_actual_siblings_and_never_falls_back() {
        let root =
            std::env::temp_dir().join(format!("bunly-bundle-artifacts-{}", std::process::id()));
        std::fs::create_dir(&root).unwrap();
        let result = (|| -> Result<(), Box<dyn std::error::Error>> {
            let chosen = root.join("chosen");
            let stale = root.join("target/release");
            std::fs::create_dir(&chosen)?;
            std::fs::create_dir_all(&stale)?;
            std::fs::write(stale.join("host"), b"wrong-host")?;
            assert!(artifacts(&chosen.join("bundler"), &["host"]).is_err());
            std::fs::write(chosen.join("host"), b"")?;
            assert!(artifacts(&chosen.join("bundler"), &["host"]).is_err());
            std::fs::remove_file(chosen.join("host"))?;
            std::fs::create_dir(chosen.join("host"))?;
            assert!(artifacts(&chosen.join("bundler"), &["host"]).is_err());
            std::fs::remove_dir(chosen.join("host"))?;
            std::fs::write(chosen.join("host"), b"chosen-host")?;
            assert_eq!(artifacts(&chosen.join("bundler"), &["host"])?, chosen);
            assert!(artifacts(&chosen.join("bundler"), &["host", "helper"]).is_err());
            #[cfg(unix)]
            {
                std::os::unix::fs::symlink(stale.join("host"), chosen.join("helper"))?;
                assert!(artifacts(&chosen.join("bundler"), &["host", "helper"]).is_err());
            }
            Ok(())
        })();
        std::fs::remove_dir_all(root).unwrap();
        result.unwrap();
    }
}
