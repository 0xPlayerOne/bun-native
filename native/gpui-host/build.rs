// Reproducible Windows links (#223). Without `/Brepro`, MSVC's link.exe writes
// the link time into the COFF header and the debug directory and gives the
// CodeView record a fresh GUID, so two clean builds of one commit differed in
// exactly those 20 bytes (hosted windows-2022, run 42363522092). `/Brepro`
// derives all of them from a hash of the output instead. A link argument
// survives the workflows' `CARGO_ENCODED_RUSTFLAGS`, which replaces any
// `rustflags` in `.cargo/config.toml`.
//
// Linux GNU hosts pack their relative relocations (DT_RELR): about 43,500
// `R_X86_64_RELATIVE` entries took 1 MB of `.rela.dyn`, all applied by the
// loader at every start. The host already requires glibc 2.39 and DT_RELR
// needs 2.36, so this costs no compatibility. See docs/reproducible-builds.md.
fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let target_env = std::env::var("CARGO_CFG_TARGET_ENV").unwrap_or_default();
    if target_env == "msvc" {
        println!("cargo:rustc-link-arg=/Brepro");
    }
    if target_os == "linux" && target_env == "gnu" {
        println!("cargo:rustc-link-arg-bins=-Wl,-z,pack-relative-relocs");
    }
}
