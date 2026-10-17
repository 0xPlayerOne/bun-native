//! Strict public-asset allowlist. No fallback to the application/backend directory.
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, fs, io::Read, path::{Component, Path, PathBuf}};
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Asset { pub bytes: u64, pub sha256: String }
#[derive(Clone)]
pub struct Assets { root: PathBuf, files: BTreeMap<String, Asset> }
#[derive(Debug, Clone)]
pub struct AssetResponse { pub status: i32, pub body: Vec<u8>, pub mime: String, pub headers: Vec<(String,String)> }
fn failure(status: i32) -> AssetResponse { AssetResponse { status, body: Vec::new(), mime: "text/plain".into(), headers: vec![("Cache-Control".into(), "no-store".into())] } }
fn read_bounded(path: &Path, limit: u64) -> Result<Vec<u8>, String> {
    let file = fs::File::open(path).map_err(|e|e.to_string())?;
    if file.metadata().map_err(|e|e.to_string())?.len() > limit { return Err("Asset exceeds byte limit".into()); }
    let mut data = Vec::new();
    file.take(limit + 1).read_to_end(&mut data).map_err(|e|e.to_string())?;
    if data.len() as u64 > limit { return Err("Asset grew beyond byte limit".into()); }
    Ok(data)
}
pub fn safe_relative(value: &str) -> Result<PathBuf, String> {
    if value.is_empty() || value.len() > 4096 || value.contains(['\\', ':', '\0', '?', '#']) { return Err("unsafe asset path".into()); }
    if value.split('/').any(|p| p.is_empty() || p == "." || p == ".." || p.ends_with([' ', '.'])) { return Err("non-canonical path".into()); }
    for segment in value.split('/') {
        let stem = segment.split('.').next().unwrap_or("").to_ascii_uppercase();
        if ["CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$"].contains(&stem.as_str())
            || ((stem.starts_with("COM") || stem.starts_with("LPT")) && stem.len()==4 && stem.as_bytes()[3].is_ascii_digit()) {
            return Err("Windows device alias denied".into());
        }
    }
    let path = PathBuf::from(value);
    if path.components().any(|p| !matches!(p, Component::Normal(_))) { return Err("absolute or parent path".into()); }
    Ok(path)
}
fn checked_file(root: &Path, path: &Path) -> Result<PathBuf, String> {
    let mut current = root.to_owned();
    for part in path.components() {
        current.push(part);
        if fs::symlink_metadata(&current).map_err(|e| e.to_string())?.file_type().is_symlink() { return Err("asset symlink denied".into()); }
    }
    let full = fs::canonicalize(&current).map_err(|e| e.to_string())?;
    if !full.starts_with(root) || !full.is_file() { return Err("asset escaped public root".into()); }
    Ok(full)
}
impl Assets {
    pub fn load(root: &Path) -> Result<Self, String> {
        if fs::symlink_metadata(root).map_err(|e| e.to_string())?.file_type().is_symlink() { return Err("public root is a link".into()); }
        let root = fs::canonicalize(root).map_err(|e| e.to_string())?;
        let manifest = checked_file(&root, Path::new("assets.json"))?;
        let raw = read_bounded(&manifest, 1024*1024)?;
        let files: BTreeMap<String, Asset> = serde_json::from_slice(&raw).map_err(|e| e.to_string())?;
        if files.is_empty() || files.len() > 10000 { return Err("invalid asset inventory".into()); }
        for (name, asset) in &files {
            let path = safe_relative(name)?;
            if name == "assets.json" || name.ends_with(".ts") || name.ends_with(".map") || name.starts_with('.') || asset.bytes > 32*1024*1024 || asset.sha256.len()!=64 || !asset.sha256.bytes().all(|b| b.is_ascii_hexdigit()) { return Err("invalid public asset".into()); }
            let full = checked_file(&root, &path)?;
            if fs::metadata(full).map_err(|e|e.to_string())?.len() != asset.bytes { return Err("asset size mismatch".into()); }
        }
        Ok(Self { root, files })
    }
    pub fn response(&self, raw: &str, method: &str, range: &str) -> AssetResponse {
        if method != "GET" && method != "HEAD" { return failure(405); }
        let Some(tail) = raw.strip_prefix("app://ui/") else { return failure(403); };
        let encoded = tail.split(['?', '#']).next().unwrap_or("");
        let decoded = match percent_encoding::percent_decode_str(encoded).decode_utf8() { Ok(s)=>s, Err(_)=>return failure(400) };
        let name = if decoded.is_empty() { "index.html" } else { decoded.as_ref() };
        let path = match safe_relative(name) { Ok(p)=>p, Err(_)=>return failure(403) };
        let Some(asset) = self.files.get(name) else { return failure(404); };
        let full = match checked_file(&self.root, &path) { Ok(p)=>p, Err(_)=>return failure(403) };
        let bytes = match read_bounded(&full, asset.bytes) { Ok(b) if b.len() as u64 == asset.bytes=>b, _=>return failure(500) };
        if format!("{:x}",Sha256::digest(&bytes)) != asset.sha256 { return failure(500); }
        let mime = match path.extension().and_then(|s|s.to_str()).unwrap_or("") {
            "html"=>"text/html", "js"|"mjs"=>"text/javascript", "css"=>"text/css", "json"=>"application/json", "wasm"=>"application/wasm", "svg"=>"image/svg+xml", "png"=>"image/png", "jpg"|"jpeg"=>"image/jpeg", "woff2"=>"font/woff2", _=>"application/octet-stream"
        };
        let mut headers = vec![("Content-Security-Policy".into(), "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'".into()), ("X-Content-Type-Options".into(),"nosniff".into()), ("Cache-Control".into(),"no-cache".into()), ("ETag".into(),format!("\"{}\"",asset.sha256)), ("Accept-Ranges".into(),"bytes".into())];
        let (status, start, end) = if range.is_empty() { (200,0,bytes.len()) } else {
            match parse_range(range,bytes.len()) { Some((a,b))=>{ headers.push(("Content-Range".into(),format!("bytes {}-{}/{}",a,b-1,bytes.len()))); (206,a,b) }, None=>{ let mut r=failure(416); r.headers.push(("Content-Range".into(),format!("bytes */{}",bytes.len()))); return r; } }
        };
        headers.push(("Content-Length".into(),(end-start).to_string()));
        AssetResponse { status, body: if method=="HEAD" {Vec::new()} else {bytes[start..end].to_vec()}, mime:mime.into(), headers }
    }
}
pub fn parse_range(range: &str, length: usize) -> Option<(usize,usize)> {
    if length==0 {return None;}
    let (left,right) = range.strip_prefix("bytes=")?.split_once('-')?;
    if left.is_empty() { let suffix=right.parse::<usize>().ok()?; return (suffix>0).then_some((length.saturating_sub(suffix),length)); }
    let start=left.parse::<usize>().ok()?;
    let end=if right.is_empty(){length}else{right.parse::<usize>().ok()?.checked_add(1)?.min(length)};
    (start<end && start<length).then_some((start,end))
}
#[cfg(test)] mod tests {
    use super::*;
    #[test] fn paths_reject_escape_and_windows_aliases() { for p in ["../secret","/root","a/../b","a//b","a\\b","C:secret","a.","a ","./foo",""] { assert!(safe_relative(p).is_err(),"{p}"); } assert!(safe_relative("assets/é.js").is_ok()); }
    #[test] fn ranges_are_bounded() { assert_eq!(parse_range("bytes=1-3",5),Some((1,4))); assert_eq!(parse_range("bytes=-2",5),Some((3,5))); assert_eq!(parse_range("bytes=2-",5),Some((2,5))); for r in ["bytes=5-7","bytes=3-1","bytes=0-1,3-4","bytes=-0","items=0-1"]{assert_eq!(parse_range(r,5),None);} }
}
#[cfg(test)] mod file_tests {
    use super::*;
    use std::{sync::atomic::{AtomicU64,Ordering}, time::{SystemTime,UNIX_EPOCH}};
    static NEXT:AtomicU64=AtomicU64::new(0);
    struct Fixture(PathBuf);
    impl Fixture {
        fn new()->Self {
            let directory=std::env::temp_dir().join(format!("bunly-resource-test-{}-{}-{}",std::process::id(),SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos(),NEXT.fetch_add(1,Ordering::SeqCst)));
            fs::create_dir(&directory).unwrap();
            fs::write(directory.join("index.html"),b"0123456789").unwrap();
            let manifest=serde_json::json!({"index.html":{"bytes":10,"sha256":format!("{:x}",Sha256::digest(b"0123456789"))}});
            fs::write(directory.join("assets.json"),manifest.to_string()).unwrap(); Self(directory)
        }
    }
    impl Drop for Fixture { fn drop(&mut self){let _=fs::remove_dir_all(&self.0);} }
    #[test]fn serves_only_hashed_manifest_members(){
        let fixture=Fixture::new();let assets=Assets::load(&fixture.0).unwrap();
        assert_eq!(assets.response("app://ui/index.html","GET","").body,b"0123456789");
        for url in ["app://ui/assets.json","app://ui/backend/main.js","app://ui/not-found"]{assert_eq!(assets.response(url,"GET","").status,404);}
        for url in ["app://other/index.html","app://ui/%2e%2e/secret","app://ui/a%5cb","app://ui/%FF"]{assert!(assets.response(url,"GET","").status>=400);}
        assert_eq!(assets.response("app://ui/index.html","POST","").status,405);
        assert_eq!(assets.response("app://ui/index.html","GET","bytes=2-5").body,b"2345");
        assert!(assets.response("app://ui/index.html","HEAD","").body.is_empty());
    }
    #[test]fn modified_or_oversized_assets_fail_closed(){
        let fixture=Fixture::new();let assets=Assets::load(&fixture.0).unwrap();
        fs::write(fixture.0.join("index.html"),b"abcdefghij").unwrap();
        assert_eq!(assets.response("app://ui/index.html","GET","").status,500);
        fs::write(fixture.0.join("index.html"),b"0123456789overflow").unwrap();
        assert!(Assets::load(&fixture.0).is_err());
        assert_eq!(assets.response("app://ui/index.html","GET","").status,500);
    }
    #[test]fn device_aliases_are_not_public_files(){for name in ["nul.txt","AUX","con.js","a/COM1","lpt9.json"]{assert!(safe_relative(name).is_err());}}
    #[cfg(unix)]
    #[test]fn symlinked_assets_and_manifests_are_rejected(){
        let fixture=Fixture::new();let assets=Assets::load(&fixture.0).unwrap();
        fs::rename(fixture.0.join("index.html"),fixture.0.join("real.html")).unwrap();
        std::os::unix::fs::symlink("real.html",fixture.0.join("index.html")).unwrap();
        assert_eq!(assets.response("app://ui/index.html","GET","").status,403);
        fs::rename(fixture.0.join("assets.json"),fixture.0.join("real.json")).unwrap();
        std::os::unix::fs::symlink("real.json",fixture.0.join("assets.json")).unwrap();
        assert!(Assets::load(&fixture.0).is_err());
    }
}
