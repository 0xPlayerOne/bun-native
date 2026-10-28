//! IO-thread download request admission. A secret fragment distinguishes the
//! exact backend operation without adding headers or changing HTTP path/query.
//! The UI owner revokes this permit before navigation, close, or quit enters CEF.
use crate::network_policy::NetworkPolicy;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};

#[derive(Default)]
pub(crate) struct Access(Mutex<Option<Arc<Permit>>>);
pub(crate) enum RequestPolicy {
    Ordinary,
    Denied,
    Owned(Arc<Permit>),
}
pub(crate) struct Permit {
    request_url: String,
    active: AtomicBool,
    denied: AtomicBool,
    request: Mutex<Option<u64>>,
    current: Mutex<String>,
}
impl Access {
    pub fn route(&self, url: Option<&str>, identifier: u64, is_download: bool) -> RequestPolicy {
        let known = self
            .0
            .lock()
            .unwrap()
            .as_ref()
            .is_some_and(|permit| url == Some(permit.request_url()));
        if known {
            return url
                .and_then(|url| self.claim(url, identifier))
                .map_or(RequestPolicy::Denied, RequestPolicy::Owned);
        }
        if is_download {
            RequestPolicy::Denied
        } else {
            RequestPolicy::Ordinary
        }
    }
    pub fn install(&self, permit: Arc<Permit>) -> Result<(), &'static str> {
        let mut current = self.0.lock().unwrap();
        if current.is_some() {
            return Err("RESOURCE_IN_USE: view has an outstanding download");
        }
        *current = Some(permit);
        Ok(())
    }
    pub fn clear(&self, permit: &Arc<Permit>) {
        let mut current = self.0.lock().unwrap();
        if current
            .as_ref()
            .is_some_and(|active| Arc::ptr_eq(active, permit))
        {
            current.take();
        }
    }
    pub fn claim(&self, url: &str, identifier: u64) -> Option<Arc<Permit>> {
        let permit = self.0.lock().unwrap().clone()?;
        if identifier == 0 || !permit.active() || url != permit.request_url {
            return None;
        }
        let accepted = {
            let mut previous = permit.request.lock().unwrap();
            if previous.is_none() {
                *previous = Some(identifier);
            }
            *previous == Some(identifier)
        };
        accepted.then_some(permit)
    }
}
impl Permit {
    pub fn new(url: &str) -> Result<Arc<Self>, String> {
        let mut secret = [0u8; 32];
        #[cfg(unix)]
        if unsafe { libc::getentropy(secret.as_mut_ptr().cast(), secret.len()) } != 0 {
            return Err("Native download entropy unavailable".into());
        }
        #[cfg(windows)]
        {
            use windows_sys::Win32::Security::Cryptography::{
                BCryptGenRandom, BCRYPT_USE_SYSTEM_PREFERRED_RNG,
            };
            if unsafe {
                BCryptGenRandom(
                    std::ptr::null_mut(),
                    secret.as_mut_ptr(),
                    secret.len() as u32,
                    BCRYPT_USE_SYSTEM_PREFERRED_RNG,
                )
            } < 0
            {
                return Err("Native download entropy unavailable".into());
            }
        }
        let fragment: String = secret.iter().map(|byte| format!("{byte:02x}")).collect();
        let request_url = format!("{url}#bunly-download={fragment}");
        Ok(Arc::new(Self {
            current: Mutex::new(request_url.clone()),
            request_url,
            active: AtomicBool::new(true),
            denied: AtomicBool::new(false),
            request: Mutex::new(None),
        }))
    }
    pub fn request_url(&self) -> &str {
        &self.request_url
    }
    pub fn active(&self) -> bool {
        self.active.load(Ordering::Acquire)
    }
    pub fn admitted(&self) -> bool {
        self.request.lock().unwrap().is_some()
    }
    pub fn revoke(&self) {
        self.active.store(false, Ordering::Release);
    }
    pub fn denied(&self) -> bool {
        self.denied.load(Ordering::Acquire)
    }
    pub fn allows(&self, url: &str, network: &NetworkPolicy) -> bool {
        self.active()
            && self.request.lock().unwrap().is_some()
            && *self.current.lock().unwrap() == url
            && network.navigation(url).is_ok()
            && url::Url::parse(url)
                .ok()
                .is_some_and(|url| matches!(url.scheme(), "https" | "http"))
    }
    pub fn redirect(&self, url: &str, network: &NetworkPolicy) -> bool {
        if !self.active()
            || network.navigation(url).is_err()
            || !url::Url::parse(url)
                .ok()
                .is_some_and(|url| matches!(url.scheme(), "https" | "http"))
        {
            self.denied.store(true, Ordering::Release);
            self.revoke();
            return false;
        }
        *self.current.lock().unwrap() = url.to_owned();
        true
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn exact_native_download_identity_does_not_depend_on_cefs_advisory_download_flag() {
        let access = Access::default();
        let permit = Permit::new("https://download.test/file").unwrap();
        access.install(permit.clone()).unwrap();
        assert!(matches!(
            access.route(Some("https://download.test/file"), 1, false),
            RequestPolicy::Ordinary
        ));
        assert!(matches!(
            access.route(Some("https://download.test/file"), 1, true),
            RequestPolicy::Denied
        ));
        let RequestPolicy::Owned(admitted) = access.route(Some(permit.request_url()), 2, false)
        else {
            panic!("Exact native admission must not depend on is_download");
        };
        assert!(Arc::ptr_eq(&admitted, &permit));
        assert!(matches!(
            access.route(Some(permit.request_url()), 2, true),
            RequestPolicy::Owned(_)
        ));
        for identifier in [0, 3] {
            assert!(matches!(
                access.route(Some(permit.request_url()), identifier, false),
                RequestPolicy::Denied
            ));
        }
        permit.revoke();
        assert!(matches!(
            access.route(Some(permit.request_url()), 2, false),
            RequestPolicy::Denied
        ));
        assert!(matches!(access.route(None, 2, true), RequestPolicy::Denied));
    }
    #[test]
    fn admission_is_secret_exact_single_request_and_revocable() {
        let access = Access::default();
        let permit = Permit::new("https://download.test/file").unwrap();
        access.install(permit.clone()).unwrap();
        assert!(access.claim("https://download.test/file", 1).is_none());
        assert!(access.claim(permit.request_url(), 0).is_none());
        assert!(access.claim(permit.request_url(), 1).is_some());
        assert!(access.claim(permit.request_url(), 2).is_none());
        assert!(access.claim(permit.request_url(), 1).is_some());
        permit.revoke();
        assert!(access.claim(permit.request_url(), 1).is_none());
        assert!(access
            .install(Permit::new("https://download.test/file").unwrap())
            .is_err());
        access.clear(&permit);
        access
            .install(Permit::new("https://download.test/file").unwrap())
            .unwrap();
    }
    #[test]
    fn every_redirect_needs_live_session_policy_and_never_reactivates_a_permit() {
        let network = NetworkPolicy::new(
            Some(&json!({"allowedOrigins":["https://download.test","https://cdn.test"]})),
            None,
        )
        .unwrap();
        let access = Access::default();
        let permit = Permit::new("https://download.test/file").unwrap();
        access.install(permit.clone()).unwrap();
        access.claim(permit.request_url(), 5).unwrap();
        assert!(permit.allows(permit.request_url(), &network));
        assert!(permit.redirect("https://cdn.test/final", &network));
        assert!(!permit.allows(permit.request_url(), &network));
        assert!(permit.allows("https://cdn.test/final", &network));
        assert!(!permit.redirect("file:///tmp/secret", &network));
        assert!(permit.denied());
        assert!(!permit.redirect("https://cdn.test/final", &network));
        assert!(!permit.allows("https://cdn.test/final", &network));
    }
}
