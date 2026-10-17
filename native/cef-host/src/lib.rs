//! First CEF host: one native GUI owner and one supervised Bun application.
use cef::*;
use serde::Deserialize;
use std::{path::PathBuf,sync::OnceLock};
pub mod resources;
mod scheme;
mod process;
pub mod host;
#[cfg(target_os="macos")] mod mac;
#[cfg(not(feature="sandbox"))] compile_error!("Bunly requires compiled sandbox support");
#[derive(Clone)]pub struct Paths{pub resources:PathBuf,pub cache:PathBuf,pub bun:PathBuf,pub entry:PathBuf}
pub static PATHS:OnceLock<Paths>=OnceLock::new();
#[derive(Deserialize)]#[serde(deny_unknown_fields)]struct Config{schema:u32,protocol:u32,bun_version:String,cef_version:String}
pub fn browser_app()->App{host::BunlyApp::new()}
pub fn run(sandbox:*mut u8,main_args:Option<MainArgs>)->i32{match run_inner(sandbox,main_args){Ok(code)=>code,Err(error)=>{eprintln!("{}",serde_json::json!({"event":"bunly.host.error","error":error}));78}}}
fn run_inner(sandbox:*mut u8,_main_args:Option<MainArgs>)->Result<i32,String>{
    #[cfg(target_os="macos")]
    let _loader={let loader=library_loader::LibraryLoader::new(&std::env::current_exe().map_err(|e|e.to_string())?,false);if !loader.load(){return Err("CEF framework missing or incompatible".into());}loader};
    let _=api_hash(sys::CEF_API_VERSION_LAST,0);
    #[cfg(target_os="windows")]let args=args::Args::from(_main_args.ok_or("Windows requires sandbox bootstrap")?);
    #[cfg(not(target_os="windows"))]let args=args::Args::new();
    let mut app=browser_app();
    let code=execute_process(Some(args.as_main_args()),Some(&mut app),sandbox);
    if code>=0{return Ok(code);}
    #[cfg(target_os="windows")]if sandbox.is_null(){return Err("Missing Windows sandbox state".into());}
    if std::env::args().any(|a|a=="--no-sandbox"||a=="--disable-web-security"||a.starts_with("--remote-debugging")){return Err("Unsafe command-line override denied".into());}
    let executable=std::env::current_exe().map_err(|e|e.to_string())?;
    let directory=executable.parent().ok_or("missing executable parent")?;
    #[cfg(target_os="macos")]let resources=directory.parent().ok_or("missing Contents")?.join("Resources");
    #[cfg(not(target_os="macos"))]let resources=directory.join("resources");
    let raw=std::fs::read(resources.join("runtime.json")).map_err(|e|format!("Missing installed runtime configuration: {e}"))?;
    if raw.len()>4096{return Err("Runtime config too large".into());}
    let config:Config=serde_json::from_slice(&raw).map_err(|e|e.to_string())?;
    if config.schema!=1||config.protocol!=1||config.bun_version!="1.4.3"||config.cef_version!="154.0.34"{return Err("Runtime/ABI manifest mismatch".into());}
    scheme::load(resources.join("public"))?;
    let cache=std::env::var_os("BUNLY_CACHE_DIR").map(PathBuf::from).unwrap_or_else(||std::env::temp_dir().join(format!("bunly-{}",std::process::id())));
    if !cache.is_absolute(){return Err("Cache directory must be absolute".into());}
    std::fs::create_dir_all(&cache).map_err(|e|e.to_string())?;
    if std::fs::symlink_metadata(&cache).map_err(|e|e.to_string())?.file_type().is_symlink(){return Err("Cache root cannot be a link".into());}
    let cache=std::fs::canonicalize(cache).map_err(|e|e.to_string())?;
    let bun=resources.join(if cfg!(windows){"bun.exe"}else{"bun"});let entry=resources.join("backend/main.js");
    if !bun.is_file()||!entry.is_file(){return Err("Installed Bun or backend missing; runtime never downloads or compiles".into());}
    PATHS.set(Paths{resources:resources.clone(),cache:cache.clone(),bun,entry}).map_err(|_|"Host cannot be initialized twice")?;
    #[cfg(target_os="macos")]let _application=mac::setup();
    let settings=Settings{no_sandbox:0,command_line_args_disabled:1,root_cache_path:CefString::from(cache.to_string_lossy().as_ref()),..Default::default()};
    if initialize(Some(args.as_main_args()),Some(&settings),Some(&mut app),sandbox)!=1{return Err("CEF initialization failed".into());}
    run_message_loop();process::stop();host::release();shutdown();
    Ok(if host::FAILED.load(std::sync::atomic::Ordering::SeqCst){1}else{0})
}
#[cfg(target_os="windows")]
#[no_mangle]
pub unsafe extern "C" fn RunWinMain(instance:sys::HINSTANCE,_command_line:*const u8,_show:i32,sandbox:*mut u8)->i32{std::panic::catch_unwind(||run(sandbox,Some(MainArgs{instance}))).unwrap_or(1)}
