//! Windows task dialogs live in Common Controls 6, which a process gets only
//! from a side-by-side manifest dependency. The host has no manifest of its
//! own, so the MSVC linker embeds one that asks for it. The dialog code
//! resolves `TaskDialogIndirect` at run time, so a host built without this
//! reports the service unavailable instead of failing to start.

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    let target = |name: &str| std::env::var(name).unwrap_or_default();
    if target("CARGO_CFG_TARGET_OS") == "windows" && target("CARGO_CFG_TARGET_ENV") == "msvc" {
        println!("cargo:rustc-link-arg-bins=/MANIFEST:EMBED");
        println!(
            "cargo:rustc-link-arg-bins=/MANIFESTDEPENDENCY:type='win32' name='Microsoft.Windows.Common-Controls' version='6.0.0.0' processorArchitecture='*' publicKeyToken='6595b64144ccf1df' language='*'"
        );
    }
}
