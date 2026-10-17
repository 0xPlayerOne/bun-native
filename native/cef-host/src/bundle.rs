//! Contributor-only assembly. This binary is never included in an application.
use std::path::PathBuf;
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let output = PathBuf::from(std::env::args().nth(1).ok_or("Expected an absolute output directory")?);
    if !output.is_absolute() { return Err("Bundle destination must be absolute".into()); }
    let target = root.join("target/release");
    #[cfg(target_os = "macos")]
    let path = cef::build_util::mac::bundle(&output, &target, "bunly_host", "bunly_helper", None,
        cef::build_util::mac::BundleInfo::new("Bunly", "dev.bunly.fixture", "Bunly", "en", semver::Version::new(0,1,0)))?;
    #[cfg(target_os = "linux")]
    let path = cef::build_util::linux::bundle(&output, &target, "bunly_host")?;
    #[cfg(target_os = "windows")]
    let path = cef::build_util::win::bundle(&output, &target, "bunly_host")?;
    let data = serde_json::json!({"event":"bunly.runtime.assembled", "path":path});
    std::fs::write(output.join("bundle.json"), serde_json::to_vec_pretty(&data)?)?;
    println!("{data}");
    Ok(())
}
