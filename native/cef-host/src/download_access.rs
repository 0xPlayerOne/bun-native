//! IO-thread download admission. A native-only secret fragment binds one
//! operation; an epoch and one-shot expected hop bind each request handler.
//! Chromium's ResourceDownloader uses request ID 0. It is an opaque value, not
//! authority or an unclaimed sentinel. UI revocation remains independent.
use crate::network_policy::NetworkPolicy;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};

const MAX_URL: usize = 4096;
#[derive(Default)]
pub(crate) struct Access(Mutex<Option<Arc<Permit>>>);
pub(crate) enum RequestPolicy {
    Ordinary,
    Denied,
    Owned(RequestLease),
}
struct Hop {
    epoch: u64,
    url: String,
    claimed: bool,
}
struct RequestState {
    request: Option<u64>,
    // Exactly one current or pending hop. A redirect retires the old epoch
    // before publishing its expected continuation under this same mutex.
    hop: Hop,
}
pub(crate) struct Permit {
    request_url: String,
    fragment: String,
    active: AtomicBool,
    denied: AtomicBool,
    state: Mutex<RequestState>,
}
#[derive(Clone)]
pub(crate) struct RequestLease {
    permit: Arc<Permit>,
    request: u64,
    epoch: u64,
}
impl Access {
    pub fn route(&self, url: Option<&str>, identifier: u64, is_download: bool) -> RequestPolicy {
        let permit = self.0.lock().unwrap().clone();
        if let Some((permit, url)) = permit.zip(url) {
            // Recognize the immutable operation secret even on a stale or wrong
            // target. Such input must be denied, never routed as ordinary HTTP.
            if permit.recognizes(url) {
                return permit
                    .claim(url, identifier)
                    .map_or(RequestPolicy::Denied, RequestPolicy::Owned);
            }
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
}
impl Permit {
    pub fn new(url: &str) -> Result<Arc<Self>, String> {
        if http_url(url).is_none_or(|url| url.fragment().is_some()) {
            return Err("Invalid untagged download URL".into());
        }
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
        let secret: String = secret.iter().map(|byte| format!("{byte:02x}")).collect();
        let fragment = format!("bunly-download={secret}");
        let request_url = tagged_url(url, &fragment).ok_or("Invalid bounded download URL")?;
        Ok(Arc::new(Self {
            state: Mutex::new(RequestState {
                request: None,
                hop: Hop {
                    epoch: 1,
                    url: request_url.clone(),
                    claimed: false,
                },
            }),
            request_url,
            fragment,
            active: AtomicBool::new(true),
            denied: AtomicBool::new(false),
        }))
    }
    pub fn request_url(&self) -> &str {
        &self.request_url
    }
    pub fn active(&self) -> bool {
        self.active.load(Ordering::Acquire)
    }
    pub fn admitted(&self) -> bool {
        self.state.lock().unwrap().request.is_some()
    }
    pub fn revoke(&self) {
        self.active.store(false, Ordering::Release);
    }
    pub fn denied(&self) -> bool {
        self.denied.load(Ordering::Acquire)
    }
    fn deny(&self) {
        self.denied.store(true, Ordering::Release);
        self.revoke();
    }
    fn recognizes(&self, url: &str) -> bool {
        url.split_once('#')
            .is_some_and(|(_, fragment)| fragment == self.fragment)
    }
    fn claim(self: &Arc<Self>, url: &str, identifier: u64) -> Option<RequestLease> {
        let mut state = self.state.lock().unwrap();
        if !self.active()
            || state.hop.claimed
            || url != state.hop.url
            || state.request.is_some_and(|previous| previous != identifier)
        {
            return None;
        }
        state.request = Some(identifier);
        state.hop.claimed = true;
        Some(RequestLease {
            permit: self.clone(),
            request: identifier,
            epoch: state.hop.epoch,
        })
    }
}
impl RequestLease {
    fn matches(&self, state: &RequestState, url: &str, identifier: u64) -> bool {
        self.permit.active()
            && state.hop.claimed
            && state.hop.epoch == self.epoch
            && state.request == Some(self.request)
            && identifier == self.request
            && state.hop.url == url
    }
    pub fn allows(&self, url: &str, identifier: u64, network: &NetworkPolicy) -> bool {
        let state = self.permit.state.lock().unwrap();
        self.matches(&state, url, identifier)
            && network.navigation(url).is_ok()
            && http_url(url).is_some()
    }
    pub fn deny(&self) {
        self.permit.deny();
    }
    pub fn redirect(
        &self,
        source_url: &str,
        identifier: u64,
        target: &str,
        network: &NetworkPolicy,
    ) -> Option<String> {
        let mut state = self.permit.state.lock().unwrap();
        let next = (|| {
            if !self.matches(&state, source_url, identifier) {
                return None;
            }
            let target = network.navigation(target).ok()?;
            let url = tagged_url(&target, &self.permit.fragment)?;
            // Validate the exact new value that will be supplied back to CEF.
            network.navigation(&url).ok()?;
            let epoch = state.hop.epoch.checked_add(1)?;
            Some((url, epoch))
        })();
        let Some((url, epoch)) = next else {
            self.permit.deny();
            return None;
        };
        state.hop = Hop {
            epoch,
            url: url.clone(),
            claimed: false,
        };
        Some(url)
    }
}
fn http_url(text: &str) -> Option<url::Url> {
    if text.is_empty()
        || text.len() > MAX_URL
        || text.bytes().any(|byte| byte <= 0x20 || byte == 0x7f)
    {
        return None;
    }
    let url = url::Url::parse(text).ok()?;
    (matches!(url.scheme(), "https" | "http")
        && url.username().is_empty()
        && url.password().is_none())
    .then_some(url)
}
fn tagged_url(text: &str, fragment: &str) -> Option<String> {
    let mut url = http_url(text)?;
    // An HTTP fragment never reaches the server. Replace any server-supplied
    // fragment without changing its authorized origin, path or query.
    url.set_fragment(Some(fragment));
    let result = url.to_string();
    (result.len() <= MAX_URL).then_some(result)
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn network() -> NetworkPolicy {
        NetworkPolicy::new(
            Some(&json!({"allowedOrigins":["https://download.test","https://cdn.test"]})),
            None,
        )
        .unwrap()
    }
    fn owner(access: &Access, url: &str, identifier: u64, download: bool) -> RequestLease {
        let RequestPolicy::Owned(lease) = access.route(Some(url), identifier, download) else {
            panic!("Exact native hop was not admitted");
        };
        lease
    }
    #[test]
    fn native_zero_request_id_claims_only_the_secret_once_independent_of_advisory_flag() {
        for identifier in [0, 7] {
            for flag in [false, true] {
                let access = Access::default();
                let permit = Permit::new("https://download.test/file").unwrap();
                access.install(permit.clone()).unwrap();
                assert!(!permit.admitted());
                assert!(matches!(
                    access.route(Some("https://download.test/file"), identifier, false),
                    RequestPolicy::Ordinary
                ));
                assert!(matches!(
                    access.route(Some("https://download.test/file"), identifier, true),
                    RequestPolicy::Denied
                ));
                assert!(!permit.admitted());
                let lease = owner(&access, permit.request_url(), identifier, flag);
                assert!(permit.admitted());
                assert!(Arc::ptr_eq(&lease.permit, &permit));
                assert!(lease.allows(permit.request_url(), identifier, &network()));
                for repeated_id in [identifier, identifier + 1] {
                    assert!(matches!(
                        access.route(Some(permit.request_url()), repeated_id, flag),
                        RequestPolicy::Denied
                    ));
                }
                assert!(!lease.allows(permit.request_url(), identifier + 1, &network()));
                permit.revoke();
                assert!(!lease.allows(permit.request_url(), identifier, &network()));
                assert!(matches!(
                    access.route(Some(permit.request_url()), identifier, false),
                    RequestPolicy::Denied
                ));
            }
        }
    }
    #[test]
    fn redirects_retain_secret_and_request_identity_with_one_shot_epoch_bound_leases() {
        let access = Access::default();
        let permit = Permit::new("https://download.test/file").unwrap();
        access.install(permit.clone()).unwrap();
        let first = owner(&access, permit.request_url(), 0, false);
        let target = first
            .redirect(
                permit.request_url(),
                0,
                "https://cdn.test/final?q=1#untrusted",
                &network(),
            )
            .unwrap();
        let parsed = url::Url::parse(&target).unwrap();
        assert_eq!(parsed.origin().ascii_serialization(), "https://cdn.test");
        assert_eq!(parsed.path(), "/final");
        assert_eq!(parsed.query(), Some("q=1"));
        assert_eq!(parsed.fragment(), Some(permit.fragment.as_str()));
        assert!(!first.allows(permit.request_url(), 0, &network()));
        assert!(!first.allows(&target, 0, &network()));
        assert!(matches!(
            access.route(Some("https://cdn.test/final?q=1"), 0, false),
            RequestPolicy::Ordinary
        ));
        assert!(matches!(
            access.route(Some(&target), 1, false),
            RequestPolicy::Denied
        ));
        assert!(matches!(
            access.route(Some(permit.request_url()), 0, false),
            RequestPolicy::Denied
        ));
        let second = owner(&access, &target, 0, false);
        assert!(second.allows(&target, 0, &network()));
        assert!(!first.allows(&target, 0, &network()));
        assert!(matches!(
            access.route(Some(&target), 0, false),
            RequestPolicy::Denied
        ));
        // A same-URL redirect is still a new epoch; the old lease cannot load it.
        let same = second.redirect(&target, 0, &target, &network()).unwrap();
        assert_eq!(same, target);
        let third = owner(&access, &same, 0, true);
        assert!(third.allows(&same, 0, &network()));
        assert!(!second.allows(&same, 0, &network()));
        // Even an authentic old handler cannot advance the latest hop.
        assert!(first
            .redirect(
                permit.request_url(),
                0,
                "https://cdn.test/other",
                &network()
            )
            .is_none());
        assert!(permit.denied());
        assert!(!third.allows(&same, 0, &network()));
        assert!(!permit.active());
    }
    #[test]
    fn denied_redirects_wrong_sources_and_revoked_owners_never_arm_or_reactivate_a_hop() {
        for (source, identifier, target) in [
            (true, 0, "https://other.test/file"),
            (true, 0, "file:///tmp/secret"),
            (true, 0, "app://ui/index.html"),
            (true, 0, "https://user@cdn.test/file"),
            (true, 0, "https://cdn.test/\n"),
            (true, 1, "https://cdn.test/file"),
            (false, 0, "https://cdn.test/file"),
        ] {
            let access = Access::default();
            let permit = Permit::new("https://download.test/file").unwrap();
            access.install(permit.clone()).unwrap();
            let lease = owner(&access, permit.request_url(), 0, true);
            assert!(lease
                .redirect(
                    if source {
                        permit.request_url()
                    } else {
                        "https://download.test/file"
                    },
                    identifier,
                    target,
                    &network()
                )
                .is_none());
            assert!(permit.denied());
            assert!(!permit.active());
            assert!(lease
                .redirect(
                    permit.request_url(),
                    0,
                    "https://cdn.test/allowed",
                    &network()
                )
                .is_none());
            assert!(matches!(
                access.route(Some(permit.request_url()), 0, false),
                RequestPolicy::Denied
            ));
        }
        let access = Access::default();
        let permit = Permit::new("https://download.test/file").unwrap();
        access.install(permit.clone()).unwrap();
        let lease = owner(&access, permit.request_url(), 0, true);
        let target = lease
            .redirect(permit.request_url(), 0, "https://cdn.test/ok", &network())
            .unwrap();
        permit.revoke();
        assert!(matches!(
            access.route(Some(&target), 0, false),
            RequestPolicy::Denied
        ));
        assert!(lease
            .redirect(permit.request_url(), 0, "https://cdn.test/ok", &network())
            .is_none());
        assert!(!permit.active());
    }
    #[test]
    fn secret_identity_never_falls_back_to_ordinary_for_wrong_or_stale_targets() {
        let access = Access::default();
        let permit = Permit::new("https://download.test/file").unwrap();
        access.install(permit.clone()).unwrap();
        let wrong = format!("https://download.test/wrong#{}", permit.fragment);
        assert!(matches!(
            access.route(Some(&wrong), 0, false),
            RequestPolicy::Denied
        ));
        assert!(!permit.admitted());
        let lease = owner(&access, permit.request_url(), 0, false);
        lease.deny();
        assert!(permit.denied());
        assert!(matches!(
            access.route(Some(&wrong), 0, false),
            RequestPolicy::Denied
        ));
        assert!(matches!(access.route(None, 0, true), RequestPolicy::Denied));
    }
    #[test]
    fn native_url_bounds_include_the_secret_on_initial_and_redirect_hops() {
        let prefix = "https://download.test/";
        let suffix = 1 + "bunly-download=".len() + 64;
        let exact = format!("{prefix}{}", "a".repeat(MAX_URL - prefix.len() - suffix));
        let permit = Permit::new(&exact).unwrap();
        assert_eq!(permit.request_url().len(), MAX_URL);
        assert!(Permit::new(&(exact.clone() + "a")).is_err());
        let access = Access::default();
        access.install(permit.clone()).unwrap();
        let first = owner(&access, permit.request_url(), 0, true);
        let target = first
            .redirect(permit.request_url(), 0, &exact, &network())
            .unwrap();
        assert_eq!(target.len(), MAX_URL);
        let second = owner(&access, &target, 0, true);
        assert!(second
            .redirect(&target, 0, &(exact + "a"), &network())
            .is_none());
        assert!(permit.denied());
        assert!(!permit.active());
    }
    #[test]
    fn operation_and_session_retirement_keep_old_leases_inert_without_reusing_identity() {
        let network = network();
        let access = Access::default();
        let first = Permit::new("https://download.test/file").unwrap();
        access.install(first.clone()).unwrap();
        let lease = owner(&access, first.request_url(), 0, true);
        network.retire();
        assert!(!lease.allows(first.request_url(), 0, &network));
        assert!(lease
            .redirect(first.request_url(), 0, "https://cdn.test/final", &network)
            .is_none());
        assert!(first.denied());
        assert!(access
            .install(Permit::new("https://download.test/file").unwrap())
            .is_err());
        access.clear(&first);
        let second = Permit::new("https://download.test/file").unwrap();
        assert_ne!(first.request_url(), second.request_url());
        access.install(second.clone()).unwrap();
        access.clear(&first);
        assert!(Arc::ptr_eq(
            &owner(&access, second.request_url(), 0, true).permit,
            &second
        ));
        assert!(!lease.allows(first.request_url(), 0, &network));
    }
    #[test]
    fn a_redirect_cannot_wrap_the_epoch_and_restore_an_old_handler() {
        let access = Access::default();
        let permit = Permit::new("https://download.test/file").unwrap();
        permit.state.lock().unwrap().hop.epoch = u64::MAX;
        access.install(permit.clone()).unwrap();
        let lease = owner(&access, permit.request_url(), 0, true);
        assert!(lease
            .redirect(
                permit.request_url(),
                0,
                "https://cdn.test/final",
                &network()
            )
            .is_none());
        assert!(permit.denied());
        assert!(!permit.active());
    }
    #[test]
    fn competing_zero_id_claims_cannot_duplicate_a_handler_lease() {
        let access = Arc::new(Access::default());
        let permit = Permit::new("https://download.test/file").unwrap();
        access.install(permit.clone()).unwrap();
        let barrier = Arc::new(std::sync::Barrier::new(8));
        let threads: Vec<_> = (0..8)
            .map(|_| {
                let access = access.clone();
                let permit = permit.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    barrier.wait();
                    matches!(
                        access.route(Some(permit.request_url()), 0, false),
                        RequestPolicy::Owned(_)
                    )
                })
            })
            .collect();
        assert_eq!(
            threads
                .into_iter()
                .filter_map(|thread| thread.join().unwrap().then_some(()))
                .count(),
            1
        );
    }
}
