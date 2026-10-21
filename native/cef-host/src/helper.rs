use cef::*;
fn main() {
    let args = args::Args::new();
    #[cfg(target_os = "macos")]
    let _sandbox = {
        let mut sandbox = cef::sandbox::Sandbox::new();
        sandbox.initialize(args.as_main_args());
        sandbox
    };
    #[cfg(target_os = "macos")]
    let _loader = {
        let loader =
            library_loader::LibraryLoader::new(&std::env::current_exe().expect("executable"), true);
        if !loader.load() {
            std::process::exit(78);
        }
        loader
    };
    let _ = api_hash(sys::CEF_API_VERSION_LAST, 0);
    let mut app = bunly_host::browser_app();
    let code = execute_process(
        Some(args.as_main_args()),
        Some(&mut app),
        std::ptr::null_mut(),
    );
    std::process::exit(code.max(0));
}
