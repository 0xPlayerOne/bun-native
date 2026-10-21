//! Contributor-only assembly. This binary is never included in an application.
use std::path::PathBuf;
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let output = PathBuf::from(
        std::env::args()
            .nth(1)
            .ok_or("Expected an absolute output directory")?,
    );
    if !output.is_absolute() {
        return Err("Bundle destination must be absolute".into());
    }
    let target = root.join("target/release");
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
