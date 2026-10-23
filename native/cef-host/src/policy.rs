//! Fail-closed local-content baseline; optional origins are owned by each session.
use serde_json::Value;

pub fn development_origin(value: &str) -> Result<String, String> {
    let url = url::Url::parse(value).map_err(|_| "Invalid development origin")?;
    if url.scheme() != "http"
        || url.host_str() != Some("127.0.0.1")
        || url.port().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
        || value != url.origin().ascii_serialization()
    {
        return Err("Development requires an exact explicit loopback HTTP origin".into());
    }
    Ok(value.to_owned())
}
pub fn navigation(text: &str, dev: Option<&str>) -> Result<String, String> {
    if text.len() > 4096 || text.chars().any(char::is_control) {
        return Err("Invalid URL".into());
    }
    let url = url::Url::parse(text).map_err(|_| "Invalid URL")?;
    if !url.username().is_empty() || url.password().is_some() {
        return Err("URL credentials denied".into());
    }
    match url.scheme() {
        "app" if url.host_str() == Some("ui") && url.port().is_none() => {}
        "about" if text == "about:blank" => {}
        "http" if dev.is_some_and(|origin| url.origin().ascii_serialization() == origin) => {}
        _ => {
            return Err(
                "UNSUPPORTED_CAPABILITY: remote navigation awaits browser security qualification"
                    .into(),
            )
        }
    }
    Ok(url.to_string())
}
pub fn safe_switches(args: impl IntoIterator<Item = String>) -> Result<(), String> {
    const DENIED: &[&str] = &[
        "--no-sandbox",
        "--disable-web-security",
        "--disable-gpu-sandbox",
        "--disable-setuid-sandbox",
        "--disable-seccomp-filter-sandbox",
        "--single-process",
        "--in-process-gpu",
        "--remote-debugging-port",
        "--remote-debugging-pipe",
        "--renderer-cmd-prefix",
        "--browser-subprocess-path",
    ];
    if args
        .into_iter()
        .any(|a| DENIED.contains(&a.split('=').next().unwrap_or("")))
    {
        return Err("Unsafe command-line override denied".into());
    }
    Ok(())
}
pub fn coordinate(args: &Value, key: &str) -> Result<i32, String> {
    args.get(key)
        .and_then(Value::as_i64)
        .filter(|v| (-32768..=32768).contains(v))
        .map(|v| v as i32)
        .ok_or_else(|| format!("Invalid {key} coordinate"))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn packaged_mode_has_no_localhost_or_remote_fallback() {
        assert!(navigation("app://ui/index.html", None).is_ok());
        for u in [
            "http://127.0.0.1:8080/",
            "https://example.com/",
            "file:///etc/passwd",
            "app://other/",
            "app://user:pass@ui/",
            "javascript:alert(1)",
        ] {
            assert!(navigation(u, None).is_err(), "{u}");
        }
    }
    #[test]
    fn dev_requires_exact_declared_origin_for_every_frame_and_redirect() {
        let origin = development_origin("http://127.0.0.1:8080").unwrap();
        assert!(navigation("http://127.0.0.1:8080/page", Some(&origin)).is_ok());
        for u in [
            "http://localhost:8080",
            "http://127.0.0.1:8081/",
            "https://127.0.0.1:8080/",
            "http://u:p@127.0.0.1:8080/",
        ] {
            assert!(navigation(u, Some(&origin)).is_err());
        }
        for u in [
            "http://127.0.0.1",
            "http://127.0.0.1:8080/",
            "http://0.0.0.0:8080",
            "http://127.0.0.1:8080/?a=1",
        ] {
            assert!(development_origin(u).is_err());
        }
    }
    #[test]
    fn sandbox_overrides_are_rejected_even_with_values() {
        for a in [
            "--no-sandbox",
            "--no-sandbox=1",
            "--disable-gpu-sandbox",
            "--remote-debugging-port=9222",
            "--single-process",
        ] {
            assert!(safe_switches([a.to_owned()]).is_err());
        }
        assert!(safe_switches(["--type=renderer".to_owned()]).is_ok());
    }
    #[test]
    fn native_coordinates_are_checked_without_unsigned_conversion() {
        assert_eq!(
            coordinate(&serde_json::json!({"x":-100}), "x").unwrap(),
            -100
        );
        for v in [
            serde_json::json!(1.5),
            serde_json::json!(32769),
            serde_json::json!("0"),
        ] {
            assert!(coordinate(&serde_json::json!({"x":v}), "x").is_err());
        }
    }
}
