// Reproducible Windows links (#223). Without `/Brepro`, MSVC's link.exe writes
// the link time into the COFF header and the debug directory and gives the
// CodeView record a fresh GUID, so two clean builds of one commit differed in
// exactly those 20 bytes (hosted windows-2022, run 42363522092). `/Brepro`
// derives all of them from a hash of the output instead. A link argument
// survives the workflows' `CARGO_ENCODED_RUSTFLAGS`, which replaces any
// `rustflags` in `.cargo/config.toml`.
fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    let target_env = std::env::var("CARGO_CFG_TARGET_ENV").unwrap_or_default();
    if target_env == "msvc" {
        println!("cargo:rustc-link-arg=/Brepro");
    }
}
