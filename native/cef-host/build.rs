fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("linux") {
        // The installed CEF distribution sits beside the host executable.
        // Resolve from the executable's directory, never the launch cwd or a
        // developer's browser cache. Cargo passes $ORIGIN literally to ld.
        println!("cargo:rustc-link-arg=-Wl,-rpath,$ORIGIN");
    }
}
