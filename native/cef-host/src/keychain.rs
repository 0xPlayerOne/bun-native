//! Do not block unattended shutdown on credential-consent UI. Persistent contexts
//! disable cookie persistence until an app-specific credential provider is qualified.
//! This process-local setting grants no Keychain access, changes no ACL or trust
//! store, and does not replace encryption with a mock/plaintext implementation.
//! CEF 156 exposes application-specific Keychain names, but this prerequisite
//! upgrade does not configure or qualify a provider. Persistent cookies remain
//! unsupported until application identity, provider failure and restart are tested.
use std::{marker::PhantomData, rc::Rc};

#[link(name = "Security", kind = "framework")]
extern "C" {
    fn SecKeychainGetUserInteractionAllowed(state: *mut u8) -> i32;
    fn SecKeychainSetUserInteractionAllowed(state: u8) -> i32;
}

fn interaction_allowed() -> Result<u8, String> {
    let mut state = 0;
    // The API writes one Darwin Boolean to a live, exclusively borrowed byte.
    let result = unsafe { SecKeychainGetUserInteractionAllowed(&mut state) };
    if result != 0 {
        return Err(format!(
            "Cannot inspect process Keychain interaction policy: {result}"
        ));
    }
    Ok(state)
}

/// Owns the process-local policy on CEF's main thread for the native host lifetime.
pub struct NonInteractiveKeychain {
    previous: u8,
    _main_thread: PhantomData<Rc<()>>,
}
impl NonInteractiveKeychain {
    pub fn enter() -> Result<Self, String> {
        let previous = interaction_allowed()?;
        // Disallow new consent UI. Authorization failures remain failures; no
        // item is queried, imported, unlocked, or granted access by this call.
        let result = unsafe { SecKeychainSetUserInteractionAllowed(0) };
        if result != 0 {
            return Err(format!(
                "Cannot set process Keychain interaction policy: {result}"
            ));
        }
        let guard = Self {
            previous,
            _main_thread: PhantomData,
        };
        if interaction_allowed()? != 0 {
            return Err("Process Keychain policy did not become non-interactive".into());
        }
        Ok(guard)
    }
}
impl Drop for NonInteractiveKeychain {
    fn drop(&mut self) {
        // CEF shutdown has finished before the guard is released. Restore the
        // original process setting, never a guessed machine-wide preference.
        let result = unsafe { SecKeychainSetUserInteractionAllowed(self.previous) };
        if result != 0 {
            eprintln!("{{\"event\":\"bunly.keychain-policy-restore-failed\",\"status\":{result}}}");
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn process_policy_roundtrip_never_reads_a_credential() {
        let before = interaction_allowed().unwrap();
        {
            let _guard = NonInteractiveKeychain::enter().unwrap();
            assert_eq!(interaction_allowed().unwrap(), 0);
        }
        assert_eq!(interaction_allowed().unwrap(), before);
    }
}
