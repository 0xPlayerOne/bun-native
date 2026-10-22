//! Strict public-asset allowlist. No fallback to backend code or the launch cwd.
use serde::{
    de::{self, MapAccess, Visitor},
    Deserialize, Deserializer,
};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fmt, fs,
    io::Read,
    path::{Component, Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
};

pub const MAX_ASSET_BYTES: u64 = 32 * 1024 * 1024;
pub(crate) const VERIFY_BUFFER_BYTES: usize = 64 * 1024;
pub(crate) type VerificationBuffer = [u8; VERIFY_BUFFER_BYTES];
pub const APP_CSP: &str = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; media-src 'self'; connect-src 'self'; frame-src 'self'; frame-ancestors 'self'; worker-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'";

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Asset {
    pub bytes: u64,
    pub sha256: String,
}
#[derive(Clone)]
pub struct Assets {
    root: PathBuf,
    files: BTreeMap<String, Asset>,
}
#[derive(Debug, Clone)]
pub struct AssetResponse {
    pub status: i32,
    pub body: Vec<u8>,
    pub mime: String,
    pub headers: Vec<(String, String)>,
}

// serde's ordinary map deserializer keeps the last duplicate. A public inventory
// is an allowlist, so ambiguous keys must instead invalidate the entire manifest.
struct Inventory(BTreeMap<String, Asset>);
impl<'de> Deserialize<'de> for Inventory {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Unique;
        impl<'de> Visitor<'de> for Unique {
            type Value = Inventory;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("a unique public asset inventory")
            }
            fn visit_map<M: MapAccess<'de>>(self, mut map: M) -> Result<Inventory, M::Error> {
                let mut files = BTreeMap::new();
                let mut folded = BTreeSet::new();
                while let Some((name, asset)) = map.next_entry::<String, Asset>()? {
                    if files.len() >= 10_000
                        || !folded.insert(name.to_lowercase())
                        || files.insert(name, asset).is_some()
                    {
                        return Err(de::Error::custom(
                            "duplicate, case-colliding, or oversized asset inventory",
                        ));
                    }
                }
                Ok(Inventory(files))
            }
        }
        deserializer.deserialize_map(Unique)
    }
}

fn security_headers() -> Vec<(String, String)> {
    [
        ("Content-Security-Policy", APP_CSP),
        ("X-Content-Type-Options", "nosniff"),
        ("Cross-Origin-Resource-Policy", "same-origin"),
        ("Referrer-Policy", "no-referrer"),
        (
            "Permissions-Policy",
            "camera=(), microphone=(), geolocation=(), display-capture=(), usb=(), serial=()",
        ),
    ]
    .into_iter()
    .map(|(k, v)| (k.into(), v.into()))
    .collect()
}
pub(crate) fn failure(status: i32) -> AssetResponse {
    let mut headers = security_headers();
    headers.push(("Cache-Control".into(), "no-store".into()));
    headers.push(("Content-Length".into(), "0".into()));
    if status == 405 {
        headers.push(("Allow".into(), "GET, HEAD".into()));
    }
    AssetResponse {
        status,
        body: Vec::new(),
        mime: "text/plain".into(),
        headers,
    }
}
fn read_bounded(path: &Path, limit: u64) -> Result<Vec<u8>, String> {
    let file = fs::File::open(path).map_err(|e| e.to_string())?;
    let metadata = file.metadata().map_err(|e| e.to_string())?;
    if !metadata.is_file() || metadata.len() > limit {
        return Err("Asset exceeds byte limit or is not a file".into());
    }
    let mut data = Vec::new();
    file.take(limit + 1)
        .read_to_end(&mut data)
        .map_err(|e| e.to_string())?;
    if data.len() as u64 > limit {
        return Err("Asset grew beyond byte limit".into());
    }
    Ok(data)
}

pub fn safe_relative(value: &str) -> Result<PathBuf, String> {
    if value.is_empty()
        || value.len() > 4096
        || value
            .chars()
            .any(|c| c.is_control() || "\\:?#<>\"|*".contains(c))
    {
        return Err("unsafe asset path".into());
    }
    for segment in value.split('/') {
        if segment.is_empty() || segment.starts_with('.') || segment.ends_with([' ', '.']) {
            return Err("non-canonical or hidden asset path".into());
        }
        let stem = segment
            .split('.')
            .next()
            .unwrap_or("")
            .trim_end_matches(' ')
            .to_ascii_uppercase();
        let device = ["CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$"].contains(&stem.as_str());
        let serial = stem
            .strip_prefix("COM")
            .or_else(|| stem.strip_prefix("LPT"));
        if device
            || serial.is_some_and(|s| {
                s.chars().count() == 1 && s.chars().all(|c| c.is_ascii_digit() || "¹²³".contains(c))
            })
        {
            return Err("Windows device alias denied".into());
        }
    }
    let path = PathBuf::from(value);
    if path
        .components()
        .any(|p| !matches!(p, Component::Normal(_)))
    {
        return Err("absolute or parent path".into());
    }
    Ok(path)
}
fn public_name(path: &Path) -> bool {
    let name = path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let extension = path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    !["ts", "tsx", "jsx", "map", "rs", "py", "pyc", "pem", "key"].contains(&extension.as_str())
        && ![
            "assets.json",
            "runtime.json",
            "package.json",
            "package-lock.json",
            "bun.lock",
            "bun.lockb",
            "cargo.toml",
            "cargo.lock",
            "tsconfig.json",
        ]
        .contains(&name.as_str())
}
fn checked_file(root: &Path, path: &Path) -> Result<PathBuf, String> {
    let mut current = root.to_owned();
    for part in path.components() {
        current.push(part);
        if fs::symlink_metadata(&current)
            .map_err(|e| e.to_string())?
            .file_type()
            .is_symlink()
        {
            return Err("asset symlink denied".into());
        }
    }
    let full = fs::canonicalize(&current).map_err(|e| e.to_string())?;
    if !full.starts_with(root) || !full.is_file() {
        return Err("asset escaped public root".into());
    }
    Ok(full)
}
fn valid_escapes(path: &str) -> bool {
    let bytes = path.as_bytes();
    let mut offset = 0;
    while offset < bytes.len() {
        if bytes[offset] == b'%' {
            if offset + 2 >= bytes.len()
                || !bytes[offset + 1].is_ascii_hexdigit()
                || !bytes[offset + 2].is_ascii_hexdigit()
            {
                return false;
            }
            // Slash/backslash separators must be literal and canonical, never encoded.
            if path[offset + 1..offset + 3].eq_ignore_ascii_case("2f")
                || path[offset + 1..offset + 3].eq_ignore_ascii_case("5c")
            {
                return false;
            }
            offset += 3;
        } else {
            offset += 1;
        }
    }
    true
}
fn mime(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "html" | "htm" => "text/html",
        "js" | "mjs" => "text/javascript",
        "css" => "text/css",
        "json" => "application/json",
        "webmanifest" => "application/manifest+json",
        "wasm" => "application/wasm",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "txt" => "text/plain",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "mp3" => "audio/mpeg",
        "ogg" => "audio/ogg",
        "wav" => "audio/wav",
        _ => "application/octet-stream",
    }
}
fn matches_etag(condition: &str, etag: &str) -> bool {
    if condition.trim() == "*" {
        return true;
    }
    condition
        .split(',')
        .take(32)
        .any(|part| part.trim().strip_prefix("W/").unwrap_or(part.trim()) == etag)
}

impl Assets {
    pub fn load(root: &Path) -> Result<Self, String> {
        if fs::symlink_metadata(root)
            .map_err(|e| e.to_string())?
            .file_type()
            .is_symlink()
        {
            return Err("public root is a link".into());
        }
        let root = fs::canonicalize(root).map_err(|e| e.to_string())?;
        let manifest = checked_file(&root, Path::new("assets.json"))?;
        let raw = read_bounded(&manifest, 1024 * 1024)?;
        let Inventory(files) = serde_json::from_slice(&raw).map_err(|e| e.to_string())?;
        if files.is_empty() {
            return Err("invalid asset inventory".into());
        }
        for (name, asset) in &files {
            let path = safe_relative(name)?;
            if !public_name(&path)
                || asset.bytes > MAX_ASSET_BYTES
                || asset.sha256.len() != 64
                || !asset
                    .sha256
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            {
                return Err("invalid public asset".into());
            }
            let full = checked_file(&root, &path)?;
            if fs::metadata(full).map_err(|e| e.to_string())?.len() != asset.bytes {
                return Err("asset size mismatch".into());
            }
        }
        Ok(Self { root, files })
    }
    pub fn response(&self, raw: &str, method: &str, range: &str) -> AssetResponse {
        self.conditional_response(raw, method, range, "", "")
    }
    /// Synchronous contributor/test entrypoint. The browser schedules the same plan off-thread.
    pub fn conditional_response(
        &self,
        raw: &str,
        method: &str,
        range: &str,
        if_none_match: &str,
        if_range: &str,
    ) -> AssetResponse {
        self.plan(raw, method, range, if_none_match, if_range)
            .execute(&AtomicBool::new(false))
    }

    /// Pure, bounded request planning. No stat, canonicalization, open, read or hash on CEF IO.
    pub(crate) fn plan(
        &self,
        raw: &str,
        method: &str,
        range: &str,
        if_none_match: &str,
        if_range: &str,
    ) -> AssetPlan {
        let reject = |status| AssetPlan::Immediate(failure(status));
        if raw.len() > 8192
            || method.len() > 16
            || range.len() > 128
            || if_none_match.len() > 4096
            || if_range.len() > 256
        {
            return reject(400);
        }
        if method != "GET" && method != "HEAD" {
            return reject(405);
        }
        let Some(tail) = raw.strip_prefix("app://ui/") else {
            return reject(403);
        };
        let encoded = tail.split(['?', '#']).next().unwrap_or("");
        if !valid_escapes(encoded) {
            return reject(400);
        }
        let decoded = match percent_encoding::percent_decode_str(encoded).decode_utf8() {
            Ok(value) => value,
            Err(_) => return reject(400),
        };
        let name = if decoded.is_empty() {
            "index.html"
        } else {
            decoded.as_ref()
        };
        let path = match safe_relative(name) {
            Ok(path) => path,
            Err(_) => return reject(403),
        };
        let Some(asset) = self.files.get(name) else {
            return reject(404);
        };
        let length = asset.bytes as usize;
        let etag = format!("\"{}\"", asset.sha256);
        let mut headers = security_headers();
        headers.extend([
            ("Cache-Control".into(), "no-cache".into()),
            ("ETag".into(), etag.clone()),
            ("Accept-Ranges".into(), "bytes".into()),
        ]);
        let not_modified = !if_none_match.is_empty() && matches_etag(if_none_match, &etag);
        let partial = !not_modified
            && method == "GET"
            && range
                .split_once('=')
                .is_some_and(|(unit, _)| unit.eq_ignore_ascii_case("bytes"))
            && !range.contains(',')
            && (if_range.is_empty() || if_range == etag);
        let mut response = AssetResponse {
            status: 200,
            body: Vec::new(),
            mime: mime(&path).into(),
            headers,
        };
        let retain = if not_modified {
            response.status = 304;
            0..0
        } else {
            let selected = if partial {
                parse_range(range, length)
            } else {
                Some((0, length))
            };
            match selected {
                Some((start, end)) => {
                    if partial {
                        response.status = 206;
                        response.headers.push((
                            "Content-Range".into(),
                            format!("bytes {}-{}/{}", start, end - 1, length),
                        ));
                    }
                    response
                        .headers
                        .push(("Content-Length".into(), (end - start).to_string()));
                    if method == "HEAD" {
                        0..0
                    } else {
                        start..end
                    }
                }
                None => {
                    response = failure(416);
                    response
                        .headers
                        .push(("Content-Range".into(), format!("bytes */{length}")));
                    0..0
                }
            }
        };
        // Even HEAD/304/416 still verify every byte before returning the planned status.
        AssetPlan::File {
            root: self.root.clone(),
            path,
            asset: asset.clone(),
            retain,
            response,
        }
    }
}

pub(crate) enum AssetPlan {
    Immediate(AssetResponse),
    File {
        root: PathBuf,
        path: PathBuf,
        asset: Asset,
        retain: std::ops::Range<usize>,
        response: AssetResponse,
    },
}
impl AssetPlan {
    pub(crate) fn retained_bytes(&self) -> usize {
        match self {
            Self::Immediate(_) => 0,
            Self::File { retain, .. } => retain.len(),
        }
    }
    pub(crate) fn execute(self, cancelled: &AtomicBool) -> AssetResponse {
        self.execute_with_buffer(cancelled, &mut [0; VERIFY_BUFFER_BYTES])
    }
    pub(crate) fn execute_with_buffer(
        self,
        cancelled: &AtomicBool,
        buffer: &mut VerificationBuffer,
    ) -> AssetResponse {
        if cancelled.load(Ordering::Acquire) {
            return failure(499);
        }
        let Self::File {
            root,
            path,
            asset,
            retain,
            mut response,
        } = self
        else {
            let Self::Immediate(response) = self else {
                unreachable!()
            };
            return response;
        };
        let full = match checked_file(&root, &path) {
            Ok(path) => path,
            Err(_) => return failure(403),
        };
        let Ok(file) = fs::File::open(&full) else {
            return failure(500);
        };
        let Ok(metadata) = file.metadata() else {
            return failure(500);
        };
        if !metadata.is_file() || metadata.len() != asset.bytes {
            return failure(500);
        }
        match verified_body_with_buffer(file, &asset, retain, cancelled, buffer) {
            Ok(body) => {
                response.body = body;
                response
            }
            Err(_) if cancelled.load(Ordering::Acquire) => failure(499),
            Err(_) => failure(500),
        }
    }
}

/// Retain only the requested body while verifying the entire representation.
/// No seek/re-read window: response bytes and hash are derived from the same read.
#[cfg(test)]
fn verified_body(
    reader: impl Read,
    asset: &Asset,
    retain: std::ops::Range<usize>,
    cancelled: &AtomicBool,
) -> Result<Vec<u8>, String> {
    verified_body_with_buffer(
        reader,
        asset,
        retain,
        cancelled,
        &mut [0; VERIFY_BUFFER_BYTES],
    )
}
fn verified_body_with_buffer(
    reader: impl Read,
    asset: &Asset,
    retain: std::ops::Range<usize>,
    cancelled: &AtomicBool,
    buffer: &mut VerificationBuffer,
) -> Result<Vec<u8>, String> {
    if asset.bytes > MAX_ASSET_BYTES || retain.start > retain.end || retain.end as u64 > asset.bytes
    {
        return Err("Invalid retained asset bounds".into());
    }
    let mut source = reader.take(asset.bytes + 1);
    let mut body = Vec::new();
    body.try_reserve_exact(retain.len())
        .map_err(|_| "Asset body allocation failed")?;
    let mut digest = Sha256::new();
    let mut offset = 0usize;
    loop {
        if cancelled.load(Ordering::Acquire) {
            return Err("Asset request cancelled".into());
        }
        let count = source.read(buffer).map_err(|e| e.to_string())?;
        if count == 0 {
            break;
        }
        let end = offset + count;
        if end as u64 > asset.bytes {
            return Err("Asset grew beyond inventory".into());
        }
        digest.update(&buffer[..count]);
        let start_copy = offset.max(retain.start);
        let end_copy = end.min(retain.end);
        if start_copy < end_copy {
            body.extend_from_slice(&buffer[start_copy - offset..end_copy - offset]);
        }
        offset = end;
    }
    if offset as u64 != asset.bytes
        || format!("{:x}", digest.finalize()) != asset.sha256
        || body.len() != retain.len()
    {
        return Err("Asset integrity mismatch".into());
    }
    Ok(body)
}

pub fn parse_range(range: &str, length: usize) -> Option<(usize, usize)> {
    if length == 0 || range.len() > 128 {
        return None;
    }
    let (unit, positions) = range.split_once('=')?;
    if !unit.eq_ignore_ascii_case("bytes") {
        return None;
    }
    let (left, right) = positions.split_once('-')?;
    if !left
        .bytes()
        .chain(right.bytes())
        .all(|b| b.is_ascii_digit())
    {
        return None;
    }
    if left.is_empty() {
        let suffix = right.parse::<usize>().ok()?;
        return (suffix > 0).then_some((length.saturating_sub(suffix), length));
    }
    let start = left.parse::<usize>().ok()?;
    let end = if right.is_empty() {
        length
    } else {
        right.parse::<usize>().ok()?.min(length - 1) + 1
    };
    (start < end && start < length).then_some((start, end))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn paths_reject_escape_and_windows_aliases() {
        for p in [
            "../secret",
            "/root",
            "a/../b",
            "a//b",
            "a\\b",
            "C:secret",
            "a.",
            "a ",
            "./foo",
            "",
        ] {
            assert!(safe_relative(p).is_err(), "{p}");
        }
        assert!(safe_relative("assets/é.js").is_ok());
    }
    #[test]
    fn ranges_are_bounded() {
        assert_eq!(parse_range("bytes=1-3", 5), Some((1, 4)));
        assert_eq!(parse_range("bytes=-2", 5), Some((3, 5)));
        assert_eq!(parse_range("bytes=2-", 5), Some((2, 5)));
        for r in [
            "bytes=5-7",
            "bytes=3-1",
            "bytes=0-1,3-4",
            "bytes=-0",
            "items=0-1",
        ] {
            assert_eq!(parse_range(r, 5), None);
        }
    }
}
#[cfg(test)]
mod file_tests {
    use super::*;
    use std::{
        sync::atomic::{AtomicU64, Ordering},
        time::{SystemTime, UNIX_EPOCH},
    };
    static NEXT: AtomicU64 = AtomicU64::new(0);
    struct Fixture(PathBuf);
    fn fixture_directory() -> PathBuf {
        let namespace = format!(
            "bunly-resource-test-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        for _ in 0..64 {
            let directory = std::env::temp_dir().join(format!(
                "{namespace}-{}",
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            match fs::create_dir(&directory) {
                Ok(()) => return directory,
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => panic!("cannot create resource fixture: {error}"),
            }
        }
        panic!("resource fixture directory collision limit exceeded");
    }
    impl Fixture {
        fn new() -> Self {
            let directory = fixture_directory();
            fs::write(directory.join("index.html"), b"0123456789").unwrap();
            let manifest = serde_json::json!({"index.html":{"bytes":10,"sha256":format!("{:x}",Sha256::digest(b"0123456789"))}});
            fs::write(directory.join("assets.json"), manifest.to_string()).unwrap();
            Self(directory)
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    #[test]
    fn serves_only_hashed_manifest_members() {
        let fixture = Fixture::new();
        let assets = Assets::load(&fixture.0).unwrap();
        assert_eq!(
            assets.response("app://ui/index.html", "GET", "").body,
            b"0123456789"
        );
        for url in [
            "app://ui/assets.json",
            "app://ui/backend/main.js",
            "app://ui/not-found",
        ] {
            assert_eq!(assets.response(url, "GET", "").status, 404);
        }
        for url in [
            "app://other/index.html",
            "app://ui/%2e%2e/secret",
            "app://ui/a%5cb",
            "app://ui/%FF",
        ] {
            assert!(assets.response(url, "GET", "").status >= 400);
        }
        assert_eq!(
            assets.response("app://ui/index.html", "POST", "").status,
            405
        );
        assert_eq!(
            assets
                .response("app://ui/index.html", "GET", "bytes=2-5")
                .body,
            b"2345"
        );
        assert!(assets
            .response("app://ui/index.html", "HEAD", "")
            .body
            .is_empty());
    }
    #[test]
    fn modified_or_oversized_assets_fail_closed() {
        let fixture = Fixture::new();
        let assets = Assets::load(&fixture.0).unwrap();
        fs::write(fixture.0.join("index.html"), b"abcdefghij").unwrap();
        assert_eq!(
            assets.response("app://ui/index.html", "GET", "").status,
            500
        );
        fs::write(fixture.0.join("index.html"), b"0123456789overflow").unwrap();
        assert!(Assets::load(&fixture.0).is_err());
        assert_eq!(
            assets.response("app://ui/index.html", "GET", "").status,
            500
        );
    }
    #[test]
    fn device_aliases_are_not_public_files() {
        for name in ["nul.txt", "AUX", "con.js", "a/COM1", "lpt9.json"] {
            assert!(safe_relative(name).is_err());
        }
    }
    #[cfg(unix)]
    #[test]
    fn symlinked_assets_and_manifests_are_rejected() {
        let fixture = Fixture::new();
        let assets = Assets::load(&fixture.0).unwrap();
        fs::rename(fixture.0.join("index.html"), fixture.0.join("real.html")).unwrap();
        std::os::unix::fs::symlink("real.html", fixture.0.join("index.html")).unwrap();
        assert_eq!(
            assets.response("app://ui/index.html", "GET", "").status,
            403
        );
        fs::rename(fixture.0.join("assets.json"), fixture.0.join("real.json")).unwrap();
        std::os::unix::fs::symlink("real.json", fixture.0.join("assets.json")).unwrap();
        assert!(Assets::load(&fixture.0).is_err());
    }

    fn header<'a>(response: &'a AssetResponse, name: &str) -> Option<&'a str> {
        response
            .headers
            .iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.as_str())
    }
    #[test]
    fn head_ignores_ranges_but_retains_representation_length() {
        let fixture = Fixture::new();
        let assets = Assets::load(&fixture.0).unwrap();
        for range in ["", "bytes=2-5", "bytes=500-900", "not-a-range"] {
            let response = assets.response("app://ui/index.html", "HEAD", range);
            assert_eq!(response.status, 200);
            assert!(response.body.is_empty());
            assert_eq!(header(&response, "Content-Length"), Some("10"));
            assert_eq!(header(&response, "Content-Range"), None);
        }
    }
    #[test]
    fn conditional_requests_revalidate_both_get_and_head() {
        let fixture = Fixture::new();
        let assets = Assets::load(&fixture.0).unwrap();
        let first = assets.response("app://ui/index.html", "GET", "");
        let tag = header(&first, "ETag").unwrap();
        for method in ["GET", "HEAD"] {
            for validator in [
                tag.to_owned(),
                format!("W/{tag}"),
                format!("\"other\", {tag}"),
                "*".into(),
            ] {
                let result = assets.conditional_response(
                    "app://ui/index.html",
                    method,
                    "bytes=2-5",
                    &validator,
                    "",
                );
                assert_eq!(result.status, 304);
                assert!(result.body.is_empty());
                assert_eq!(header(&result, "ETag"), Some(tag));
                assert_eq!(header(&result, "Content-Length"), None);
            }
        }
        fs::write(fixture.0.join("index.html"), b"abcdefghij").unwrap();
        for method in ["GET", "HEAD"] {
            let result = assets.conditional_response("app://ui/index.html", method, "", tag, "");
            assert_eq!(result.status, 500);
            assert!(result.body.is_empty());
        }
    }
    #[test]
    fn if_range_requires_an_exact_strong_validator() {
        let fixture = Fixture::new();
        let assets = Assets::load(&fixture.0).unwrap();
        let first = assets.response("app://ui/index.html", "GET", "");
        let tag = header(&first, "ETag").unwrap();
        for validator in [
            "\"other\"".to_owned(),
            format!("W/{tag}"),
            "Wed, 21 Oct 2015 07:28:00 GMT".into(),
        ] {
            let result = assets.conditional_response(
                "app://ui/index.html",
                "GET",
                "bytes=2-5",
                "",
                &validator,
            );
            assert_eq!(result.status, 200);
            assert_eq!(result.body, b"0123456789");
        }
        assert_eq!(
            assets
                .conditional_response("app://ui/index.html", "GET", "bytes=2-5", "", tag)
                .body,
            b"2345"
        );
    }
    #[test]
    fn all_failure_paths_retain_security_headers_and_no_store() {
        let fixture = Fixture::new();
        let assets = Assets::load(&fixture.0).unwrap();
        for (url, method, range) in [
            ("app://ui/missing", "GET", ""),
            ("app://evil/index.html", "GET", ""),
            ("app://ui/index.html", "POST", ""),
            ("app://ui/%FF", "GET", ""),
            ("app://ui/index.html", "GET", "bytes=99-100"),
        ] {
            let result = assets.response(url, method, range);
            assert!(result.status >= 400);
            assert!(result.body.is_empty());
            assert_eq!(header(&result, "Content-Security-Policy"), Some(APP_CSP));
            assert_eq!(header(&result, "X-Content-Type-Options"), Some("nosniff"));
            assert_eq!(
                header(&result, "Cross-Origin-Resource-Policy"),
                Some("same-origin")
            );
            assert_eq!(header(&result, "Cache-Control"), Some("no-store"));
            assert_eq!(header(&result, "Content-Length"), Some("0"));
        }
        assert_eq!(
            header(&assets.response("app://ui/index.html", "PUT", ""), "Allow"),
            Some("GET, HEAD")
        );
    }
    #[test]
    fn nested_hidden_files_source_maps_and_private_configs_are_not_public() {
        let fixture = Fixture::new();
        for name in [
            "nested/.env",
            "nested/.git/config",
            "application.TS",
            "source.tsx",
            "source.MAP",
            "keys/private.pem",
            "keys/private.key",
            "nested/package.json",
            "runtime.json",
        ] {
            let record = serde_json::json!({name:{"bytes":10,"sha256":format!("{:x}",Sha256::digest(b"0123456789"))}});
            fs::write(fixture.0.join("assets.json"), record.to_string()).unwrap();
            assert!(Assets::load(&fixture.0).is_err(), "{name}");
        }
    }
    #[test]
    fn duplicate_and_case_colliding_manifests_fail_without_selecting_a_winner() {
        let fixture = Fixture::new();
        let hash = format!("{:x}", Sha256::digest(b"0123456789"));
        for key in ["index.html", "INDEX.HTML"] {
            fs::write(fixture.0.join("assets.json"),format!(r#"{{"index.html":{{"bytes":10,"sha256":"{hash}"}},"{key}":{{"bytes":10,"sha256":"{hash}"}}}}"#)).unwrap();
            assert!(Assets::load(&fixture.0).is_err());
        }
    }
    #[test]
    fn malformed_and_encoded_path_separators_are_rejected() {
        let fixture = Fixture::new();
        let assets = Assets::load(&fixture.0).unwrap();
        for path in [
            "%",
            "%2",
            "%zz",
            "a%2fb",
            "a%2Fb",
            "a%5Cb",
            "%00",
            "%0A",
            "%2eenv",
            "a/%2e%2e/b",
            "a//b",
            "a%3Ab",
            "%C0%AF",
            "%ED%A0%80",
        ] {
            assert!(
                assets
                    .response(&format!("app://ui/{path}"), "GET", "")
                    .status
                    >= 400,
                "{path}"
            );
        }
    }
    #[test]
    fn authority_and_protocol_variations_never_fall_back_to_disk() {
        let fixture = Fixture::new();
        let assets = Assets::load(&fixture.0).unwrap();
        for url in [
            "app://ui.evil/index.html",
            "app://ui@evil/index.html",
            "app://evil@ui/index.html",
            "app://ui:80/index.html",
            "file:///index.html",
            "https://ui/index.html",
            "app://ui\\evil/index.html",
            "//ui/index.html",
        ] {
            assert_eq!(assets.response(url, "GET", "").status, 403, "{url}");
        }
        fs::write(fixture.0.join("secret.txt"), b"not public").unwrap();
        assert_eq!(
            assets.response("app://ui/secret.txt", "GET", "").status,
            404
        );
    }
    #[test]
    fn root_queries_and_fragments_use_only_the_manifest_member() {
        let fixture = Fixture::new();
        let assets = Assets::load(&fixture.0).unwrap();
        for url in [
            "app://ui/",
            "app://ui/?secret=../backend/main.js",
            "app://ui/index.html#../../secret",
        ] {
            assert_eq!(assets.response(url, "GET", "").body, b"0123456789");
        }
    }
    #[test]
    fn range_grammar_is_unsigned_bounded_and_single_part() {
        for value in [
            "bytes=+0-4",
            "bytes=0-+4",
            "bytes= 0-4",
            "bytes=0-4 ",
            "bytes=-",
            "bytes=1--2",
            "bytes=1-2,3-4",
            "bytes=1.0-2",
            "bytes=1e1-2",
        ] {
            assert_eq!(parse_range(value, 10), None, "{value}");
        }
        assert_eq!(
            parse_range(&format!("bytes=0-{}", usize::MAX), 10),
            Some((0, 10))
        );
        assert_eq!(parse_range("bytes=-100", 10), Some((0, 10)));
    }
    #[test]
    fn range_and_metadata_limits_precede_allocating_an_asset() {
        let fixture = Fixture::new();
        let assets = Assets::load(&fixture.0).unwrap();
        assert_eq!(
            assets
                .response(&format!("app://ui/{}", "a".repeat(8192)), "GET", "")
                .status,
            400
        );
        assert_eq!(
            assets
                .response("app://ui/index.html", "GET", &"x".repeat(129))
                .status,
            400
        );
        assert_eq!(
            assets
                .conditional_response("app://ui/index.html", "GET", "", &"x".repeat(4097), "")
                .status,
            400
        );
        assert_eq!(
            assets
                .conditional_response("app://ui/index.html", "GET", "", "", &"x".repeat(257))
                .status,
            400
        );
    }
    #[test]
    fn portable_names_reject_extra_windows_aliases_and_controls() {
        for path in [
            "CON .txt",
            "COM¹.txt",
            "LPT².json",
            "sub/PRN .js",
            "x\ny",
            "x\ry",
            "a\u{7f}",
            "a<b",
            "a>b",
            "a|b",
            "a*b",
            "a\"b",
        ] {
            assert!(safe_relative(path).is_err(), "{path:?}");
        }
    }
    #[test]
    fn multimedia_and_font_mimes_are_explicit() {
        for (path, expected) in [
            ("module.MJS", "text/javascript"),
            ("font.woff", "font/woff"),
            ("font.woff2", "font/woff2"),
            ("font.ttf", "font/ttf"),
            ("image.avif", "image/avif"),
            ("image.webp", "image/webp"),
            ("sound.mp3", "audio/mpeg"),
            ("movie.mp4", "video/mp4"),
            ("data.wasm", "application/wasm"),
            ("app.webmanifest", "application/manifest+json"),
            ("data.unknown", "application/octet-stream"),
        ] {
            assert_eq!(mime(Path::new(path)), expected);
        }
    }
    #[test]
    fn empty_assets_work_except_for_byte_ranges() {
        let fixture = Fixture::new();
        fs::write(fixture.0.join("index.html"), b"").unwrap();
        fs::write(fixture.0.join("assets.json"),serde_json::json!({"index.html":{"bytes":0,"sha256":format!("{:x}",Sha256::digest(b""))}}).to_string()).unwrap();
        let assets = Assets::load(&fixture.0).unwrap();
        let result = assets.response("app://ui/index.html", "GET", "");
        assert_eq!(result.status, 200);
        assert_eq!(header(&result, "Content-Length"), Some("0"));
        let result = assets.response("app://ui/index.html", "GET", "bytes=0-");
        assert_eq!(result.status, 416);
        assert_eq!(header(&result, "Content-Range"), Some("bytes */0"));
    }
    #[cfg(unix)]
    #[test]
    fn replaced_parent_directories_cannot_redirect_reads() {
        let fixture = Fixture::new();
        fs::create_dir(fixture.0.join("scripts")).unwrap();
        fs::write(fixture.0.join("scripts/main.js"), b"0123456789").unwrap();
        fs::write(fixture.0.join("assets.json"),serde_json::json!({"scripts/main.js":{"bytes":10,"sha256":format!("{:x}",Sha256::digest(b"0123456789"))}}).to_string()).unwrap();
        let assets = Assets::load(&fixture.0).unwrap();
        fs::rename(fixture.0.join("scripts"), fixture.0.join("other")).unwrap();
        std::os::unix::fs::symlink("other", fixture.0.join("scripts")).unwrap();
        assert_eq!(
            assets
                .response("app://ui/scripts/main.js", "GET", "")
                .status,
            403
        );
    }
    #[test]
    fn unknown_range_units_and_unsupported_multipart_fall_back_to_the_full_asset() {
        let fixture = Fixture::new();
        let assets = Assets::load(&fixture.0).unwrap();
        for range in ["items=0-1", "bytes=0-1,4-5"] {
            let response = assets.response("app://ui/index.html", "GET", range);
            assert_eq!(response.status, 200);
            assert_eq!(response.body, b"0123456789");
        }
        assert_eq!(
            assets
                .response("app://ui/index.html", "GET", "BYTES=2-5")
                .body,
            b"2345"
        );
    }
}

#[cfg(test)]
mod streaming_tests {
    use super::*;
    use std::io::{self, Cursor};

    #[test]
    fn sha256_standard_vectors_use_independent_expected_digests() {
        // RFC 6234 section 8.5 supplies the abc, long-message and million-a
        // SHA-256 vectors; the empty digest is also fixed independently.
        // Never derive these expected values with the backend under test.
        let million = vec![b'a'; 1_000_000];
        for (bytes, expected) in [
            (
                b"".as_slice(),
                "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
            ),
            (
                b"abc".as_slice(),
                "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
            ),
            (
                b"abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq".as_slice(),
                "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
            ),
            (
                million.as_slice(),
                "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0",
            ),
        ] {
            let asset = Asset {
                bytes: bytes.len() as u64,
                sha256: expected.into(),
            };
            let body = verified_body(
                Cursor::new(bytes),
                &asset,
                0..bytes.len(),
                &AtomicBool::new(false),
            )
            .unwrap();
            assert_eq!(body, bytes);
        }
    }

    #[test]
    fn sha256_known_digests_survive_padding_block_and_worker_chunk_boundaries() {
        struct ShortReads<'a> {
            input: Cursor<&'a [u8]>,
            maximum: usize,
        }
        impl Read for ShortReads<'_> {
            fn read(&mut self, output: &mut [u8]) -> io::Result<usize> {
                let count = output.len().min(self.maximum);
                self.input.read(&mut output[..count])
            }
        }
        // Independent Python hashlib SHA-256 values for
        // bytes(offset % 251 for offset in range(length)); no test-time digest
        // computation by sha2. Cover SHA padding/blocks and the 64 KiB worker.
        for (length, expected) in [
            (
                55,
                "463eb28e72f82e0a96c0a4cc53690c571281131f672aa229e0d45ae59b598b59",
            ),
            (
                56,
                "da2ae4d6b36748f2a318f23e7ab1dfdf45acdc9d049bd80e59de82a60895f562",
            ),
            (
                63,
                "29af2686fd53374a36b0846694cc342177e428d1647515f078784d69cdb9e488",
            ),
            (
                64,
                "fdeab9acf3710362bd2658cdc9a29e8f9c757fcf9811603a8c447cd1d9151108",
            ),
            (
                65,
                "4bfd2c8b6f1eec7a2afeb48b934ee4b2694182027e6d0fc075074f2fabb31781",
            ),
            (
                65535,
                "dda402a2c028f0cbbdbc5c6ebae965eed9c75f71236e7022b0386d3455d5ae2f",
            ),
            (
                65536,
                "4b640d85ab3ba30fd02c9fc9db4a8928f416322ad27022ea58a65aaee68a4df2",
            ),
            (
                65537,
                "237356e18b503616912abb8ffaed3a72591e397d4ac294c4637917d48a3f529d",
            ),
            (
                131073,
                "dd84db969f4ff2abb79c8c2fbc06e8d8e02c46d6481c958e057f7ad7a24c58a7",
            ),
        ] {
            let bytes: Vec<u8> = (0..length).map(|offset| (offset % 251) as u8).collect();
            let asset = Asset {
                bytes: length as u64,
                sha256: expected.into(),
            };
            let retain = length - 17..length;
            for maximum in [1, 63, 64, 65, 65535, 65536] {
                let reader = ShortReads {
                    input: Cursor::new(bytes.as_slice()),
                    maximum,
                };
                let body =
                    verified_body(reader, &asset, retain.clone(), &AtomicBool::new(false)).unwrap();
                assert_eq!(
                    body,
                    bytes[retain.clone()],
                    "length={length}, read={maximum}"
                );
            }
        }
    }

    #[test]
    fn metadata_and_ranges_do_not_retain_the_full_file() {
        let bytes = vec![0x5a; 4 * 1024 * 1024];
        let asset = Asset {
            bytes: bytes.len() as u64,
            sha256: format!("{:x}", Sha256::digest(&bytes)),
        };
        for retain in [
            0..0,
            32765..32772,
            bytes.len() - 7..bytes.len(),
            0..bytes.len(),
        ] {
            let expected = bytes[retain.clone()].to_vec();
            let body = verified_body(
                Cursor::new(&bytes),
                &asset,
                retain.clone(),
                &AtomicBool::new(false),
            )
            .unwrap();
            assert_eq!(body, expected);
            assert_eq!(body.capacity(), retain.len());
        }
    }

    #[test]
    fn corrupt_unretained_bytes_invalidate_head_and_range() {
        let mut bytes = vec![7u8; 200000];
        let asset = Asset {
            bytes: bytes.len() as u64,
            sha256: format!("{:x}", Sha256::digest(&bytes)),
        };
        bytes[170000] ^= 1;
        for retain in [0..0, 4..12] {
            assert!(
                verified_body(Cursor::new(&bytes), &asset, retain, &AtomicBool::new(false))
                    .is_err()
            );
        }
    }

    #[test]
    fn streaming_detects_short_and_growing_files() {
        let asset = Asset {
            bytes: 3,
            sha256: format!("{:x}", Sha256::digest(b"abc")),
        };
        for bytes in [b"ab".as_slice(), b"abcd".as_slice()] {
            assert!(
                verified_body(Cursor::new(bytes), &asset, 0..0, &AtomicBool::new(false)).is_err()
            );
        }
    }

    #[test]
    fn cancellation_is_checked_between_bounded_reads() {
        struct CancelReader<'a> {
            cancelled: &'a AtomicBool,
            reads: usize,
        }
        impl Read for CancelReader<'_> {
            fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
                self.reads += 1;
                assert_eq!(self.reads, 1);
                assert!(buffer.len() <= 65536);
                buffer.fill(7);
                self.cancelled.store(true, Ordering::Release);
                Ok(buffer.len())
            }
        }
        let cancelled = AtomicBool::new(false);
        let asset = Asset {
            bytes: 200000,
            sha256: "0".repeat(64),
        };
        assert!(verified_body(
            CancelReader {
                cancelled: &cancelled,
                reads: 0
            },
            &asset,
            0..0,
            &cancelled
        )
        .is_err());
    }
}
