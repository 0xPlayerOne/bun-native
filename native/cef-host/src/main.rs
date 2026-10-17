fn main() {
    #[cfg(target_os = "windows")]
    {
        eprintln!("Bunly requires the packaged CEF sandbox bootstrap executable on Windows.");
        std::process::exit(78);
    }
    #[cfg(not(target_os = "windows"))]
    std::process::exit(bunly_host::run(std::ptr::null_mut(), None));
}
