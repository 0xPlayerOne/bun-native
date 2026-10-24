//! Immutable per-context navigation and HTTP resource policy. This is not a
//! complete network firewall: channels outside CEF resource callbacks are outside
//! this API. It never grants RPC authority or certificate exceptions.
use serde_json::Value;
use std::{
    collections::BTreeSet,
    sync::atomic::{AtomicBool, Ordering},
};

pub struct NetworkPolicy {
    origins: BTreeSet<String>,
    development: Option<String>,
    retired: AtomicBool,
}
impl NetworkPolicy {
    pub fn new(value: Option<&Value>, development: Option<&str>) -> Result<Self, String> {
        let mut origins = BTreeSet::new();
        if let Some(value) = value {
            let object = value.as_object().ok_or("Invalid session network policy")?;
            let list = object
                .get("allowedOrigins")
                .and_then(Value::as_array)
                .filter(|list| list.len() <= 32)
                .ok_or("Invalid session origin list")?;
            if object.len() != 1 {
                return Err("Unknown session network policy field".into());
            }
            for origin in list {
                let origin = origin.as_str().ok_or("Invalid session origin")?;
                if !valid_origin(origin) || !origins.insert(origin.to_owned()) {
                    return Err(
                        "Expected unique exact HTTPS or numeric-loopback HTTP origins".into(),
                    );
                }
            }
        }
        let development = development
            .map(crate::policy::development_origin)
            .transpose()?;
        Ok(Self {
            origins,
            development,
            retired: AtomicBool::new(false),
        })
    }
    pub fn navigation(&self, text: &str) -> Result<String, String> {
        if self.retired.load(Ordering::Acquire) {
            return Err("Session network policy is retired".into());
        }
        if let Ok(local) = crate::policy::navigation(text, self.development.as_deref()) {
            return Ok(local);
        }
        if text.is_empty() || text.len() > 4096 || text.chars().any(char::is_control) {
            return Err("Invalid URL".into());
        }
        let url = url::Url::parse(text).map_err(|_| "Invalid URL")?;
        if !matches!(url.scheme(), "https" | "http")
            || !url.username().is_empty()
            || url.password().is_some()
            || !self.origins.contains(&url.origin().ascii_serialization())
        {
            return Err("PERMISSION_DENIED: session origin is not allowed".into());
        }
        Ok(url.to_string())
    }
    #[cfg(feature = "rpc-qualification")]
    pub fn is_local_only_fixture(&self) -> bool {
        self.origins.is_empty()
            && self.development.is_none()
            && !self.retired.load(Ordering::Acquire)
    }
    pub fn retire(&self) {
        self.retired.store(true, Ordering::Release);
    }
}
fn valid_origin(value: &str) -> bool {
    if value.is_empty() || value.len() > 256 {
        return false;
    }
    let Ok(url) = url::Url::parse(value) else {
        return false;
    };
    url.origin().ascii_serialization() == value
        && url.username().is_empty()
        && url.password().is_none()
        && url.path() == "/"
        && url.query().is_none()
        && url.fragment().is_none()
        && url
            .host_str()
            .is_some_and(|host| !host.is_empty() && !host.contains('*'))
        && url.port() != Some(0)
        && (url.scheme() == "https"
            || (url.scheme() == "http"
                && url.host_str() == Some("127.0.0.1")
                && url.port().is_some()))
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[cfg(feature = "rpc-qualification")]
    #[test]
    fn loopback_fixture_cannot_use_remote_development_or_retired_contexts() {
        let local = NetworkPolicy::new(None, None).unwrap();
        assert!(local.is_local_only_fixture());
        local.retire();
        assert!(!local.is_local_only_fixture());
        assert!(!NetworkPolicy::new(None, Some("http://127.0.0.1:43111"))
            .unwrap()
            .is_local_only_fixture());
        assert!(!NetworkPolicy::new(
            Some(&json!({"allowedOrigins":["https://remote.invalid"]})),
            None
        )
        .unwrap()
        .is_local_only_fixture());
    }
    #[test]
    fn exact_origins_are_bounded_and_not_urls_aliases_or_prefixes() {
        for origin in [
            "https://example.test",
            "https://example.test:8443",
            "https://127.0.0.1:8443",
            "http://127.0.0.1:43111",
        ] {
            assert!(valid_origin(origin), "{origin}");
        }
        for origin in [
            "https://example.test/",
            "https://EXAMPLE.test",
            "https://example.test:443",
            "https://example.test:0",
            "https://u:p@example.test",
            "https://*.example.test",
            "https://example.test/path",
            "https://example.test?x",
            "https://example.test#x",
            "http://example.test",
            "http://localhost:43111",
            "http://127.0.0.1",
            "http://127.0.0.1:0",
            "http://127.1:43111",
            "file:///",
            "app://ui",
            "null",
        ] {
            assert!(!valid_origin(origin), "{origin}");
        }
        for value in [
            json!(null),
            json!([]),
            json!({}),
            json!({"allowedOrigins":null}),
            json!({"allowedOrigins":[42]}),
            json!({"allowedOrigins":[],"unexpected":true}),
            json!({"allowedOrigins":["https://a.test","https://a.test"]}),
            json!({"allowedOrigins":["x".repeat(257)]}),
            json!({"allowedOrigins":(0..33).map(|i|format!("https://a{i}.test")).collect::<Vec<_>>()}),
        ] {
            assert!(NetworkPolicy::new(Some(&value), None).is_err());
        }
    }
    #[test]
    fn session_policy_isolated_default_denial_and_retirement_are_fail_closed() {
        let restricted = NetworkPolicy::new(None, None).unwrap();
        let first = NetworkPolicy::new(
            Some(&json!({"allowedOrigins":["https://one.test","http://127.0.0.1:43111"]})),
            None,
        )
        .unwrap();
        let second =
            NetworkPolicy::new(Some(&json!({"allowedOrigins":["https://two.test"]})), None)
                .unwrap();
        assert!(restricted.navigation("app://ui/index.html").is_ok());
        assert!(restricted.navigation("https://one.test/").is_err());
        assert!(first.navigation("https://one.test/path?q=1").is_ok());
        assert!(first.navigation("http://127.0.0.1:43111/path").is_ok());
        for value in [
            "https://one.test.evil/",
            "https://one.test:444/",
            "http://one.test/",
            "https://u:p@one.test/",
            "https://two.test/",
            "http://localhost:43111/",
            "http://127.0.0.1:43112/",
            "data:text/html,hello",
            "javascript:alert(1)",
            "file:///tmp/test",
            "https://one.test/\n",
        ] {
            assert!(first.navigation(value).is_err(), "{value}");
        }
        assert!(second.navigation("https://one.test/").is_err());
        first.retire();
        assert!(first.navigation("https://one.test/").is_err());
        assert!(first.navigation("app://ui/index.html").is_err());
        assert!(second.navigation("https://two.test/").is_ok());
    }
    #[test]
    fn development_origin_does_not_expand_other_contexts() {
        let dev = NetworkPolicy::new(None, Some("http://127.0.0.1:3333")).unwrap();
        assert!(dev.navigation("http://127.0.0.1:3333/index.html").is_ok());
        assert!(dev.navigation("http://127.0.0.1:3334/index.html").is_err());
        assert!(NetworkPolicy::new(None, None)
            .unwrap()
            .navigation("http://127.0.0.1:3333/")
            .is_err());
    }
}
