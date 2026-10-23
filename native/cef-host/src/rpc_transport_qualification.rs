//! Fixed contributor-only CPU throttling. No public debugging endpoint, arbitrary
//! method/expression or production switch. Real CEF completion, not dispatch, is
//! the receipt. All registrations are bounded and released before CefShutdown.
use crate::{capability_policy::DocumentScope, host};
use cef::*;
use std::{
    cell::{Cell, RefCell},
    collections::BTreeMap,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
};
const MAX_DEADLINES: usize = 64;
static DEADLINES: AtomicUsize = AtomicUsize::new(0);
struct DeadlinePermit {
    used: &'static AtomicUsize,
}
impl DeadlinePermit {
    fn acquire(used: &'static AtomicUsize) -> Option<Arc<Self>> {
        used.fetch_update(Ordering::AcqRel, Ordering::Acquire, |value| {
            (value < MAX_DEADLINES).then_some(value + 1)
        })
        .ok()?;
        Some(Arc::new(Self { used }))
    }
}
impl Drop for DeadlinePermit {
    fn drop(&mut self) {
        self.used.fetch_sub(1, Ordering::AcqRel);
    }
}
pub(crate) fn allowed_fixture(value: &str, rate: i32) -> bool {
    if !matches!(rate, 1 | 4) {
        return false;
    }
    url::Url::parse(value).ok().is_some_and(|url| {
        url.scheme() == "app"
            && url.host_str() == Some("ui")
            && url.port().is_none()
            && url.username().is_empty()
            && url.password().is_none()
            && url.path() == "/transport.html"
    })
}

struct Pending {
    request: u64,
    rate: i32,
    browser: i32,
    scope: DocumentScope,
    registration: Option<Registration>,
}
thread_local! {
    static NEXT:Cell<i32>=const { Cell::new(1000000) };
    static PENDING:RefCell<BTreeMap<i32,Pending>>=const { RefCell::new(BTreeMap::new()) };
}
fn complete(message: i32, browser: Option<i32>, success: bool) {
    let pending = PENDING.with(|state| state.borrow_mut().remove(&message));
    if let Some(pending) = pending {
        let valid = success
            && browser == Some(pending.browser)
            && host::qualification_scope_live(&pending.scope);
        if valid {
            eprintln!(
                "{}",
                serde_json::json!({"event":"bunly.native.transport-throttle","rate":pending.rate,"completed":true})
            );
            host::reply(pending.request, serde_json::Value::Null);
        } else {
            host::error(
                pending.request,
                "Native throttle probe failed or its owner retired",
            );
        }
        // Registration release may call CEF. No registry borrow survives.
        drop(pending);
    }
}
wrap_dev_tools_message_observer! {
    struct ThrottleObserver { message:i32 }
    impl DevToolsMessageObserver {
        fn on_dev_tools_method_result(&self,browser:Option<&mut Browser>,message:i32,success:i32,result:Option<&[u8]>) {
            if message==self.message {
                let bounded=result.is_none_or(|value|value.len()<=1024);
                complete(message,browser.map(|browser|browser.identifier()),success!=0 && bounded);
            }
        }
        fn on_dev_tools_agent_detached(&self,_browser:Option<&mut Browser>) { complete(self.message,None,false); }
    }
}
wrap_task! {
    struct ThrottleDeadline { message:i32, _permit:Arc<DeadlinePermit> }
    impl Task { fn execute(&self) { complete(self.message,None,false); } }
}
pub fn throttle(
    request: u64,
    browser: Browser,
    scope: DocumentScope,
    rate: i32,
) -> Result<(), String> {
    if !matches!(rate, 1 | 4) || !host::qualification_scope_live(&scope) {
        return Err("Invalid fixed throttle scope".into());
    }
    if PENDING.with(|state| state.borrow().len() >= 8) {
        return Err("Throttle probe capacity exceeded".into());
    }
    let permit =
        DeadlinePermit::acquire(&DEADLINES).ok_or("Throttle deadline capacity exceeded")?;
    let message = NEXT
        .with(|next| {
            let value = next.get().checked_add(1)?;
            next.set(value);
            Some(value)
        })
        .ok_or("Throttle message identity exhausted")?;
    let host = browser.host().ok_or("Throttle browser host unavailable")?;
    let mut params = dictionary_value_create().ok_or("Throttle allocation failed")?;
    params.set_double(Some(&CefString::from("rate")), f64::from(rate));
    // Install state before callback-capable CEF operations; no RefCell borrow
    // remains across registration, dispatch, result receipt or final release.
    let browser_id = browser.identifier();
    PENDING.with(|state| {
        state.borrow_mut().insert(
            message,
            Pending {
                request,
                rate,
                browser: browser_id,
                scope,
                registration: None,
            },
        )
    });
    let mut observer = ThrottleObserver::new(message);
    let Some(registration) = host.add_dev_tools_message_observer(Some(&mut observer)) else {
        complete(message, None, false);
        return Ok(());
    };
    let mut registration = Some(registration);
    let retained = PENDING.with(|state| {
        let mut state = state.borrow_mut();
        if let Some(pending) = state.get_mut(&message) {
            pending.registration = registration.take();
            true
        } else {
            false
        }
    });
    drop(registration);
    if !retained {
        return Ok(());
    }
    let mut deadline = ThrottleDeadline::new(message, permit);
    if post_delayed_task(ThreadId::UI, Some(&mut deadline), 5000) == 0 {
        complete(message, None, false);
        return Ok(());
    }
    if host.execute_dev_tools_method(
        message,
        Some(&CefString::from("Emulation.setCPUThrottlingRate")),
        Some(&mut params),
    ) != message
    {
        complete(message, None, false);
    }
    Ok(())
}
pub fn close() {
    let pending = PENDING.with(|state| std::mem::take(&mut *state.borrow_mut()));
    for (_, pending) in pending {
        host::error(pending.request, "Throttle probe cancelled by host teardown");
        drop(pending);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn completed_probe_deadlines_remain_bounded_until_actual_task_disposal() {
        static USED: AtomicUsize = AtomicUsize::new(0);
        let permits = (0..MAX_DEADLINES)
            .map(|_| DeadlinePermit::acquire(&USED).unwrap())
            .collect::<Vec<_>>();
        assert!(DeadlinePermit::acquire(&USED).is_none());
        let retained = permits[0].clone();
        drop(permits);
        assert_eq!(USED.load(Ordering::Acquire), 1);
        drop(retained);
        assert_eq!(USED.load(Ordering::Acquire), 0);
    }
    #[test]
    fn fixed_throttle_does_not_accept_arbitrary_origins_paths_or_rates() {
        assert!(allowed_fixture("app://ui/transport.html?mode=native", 4));
        assert!(allowed_fixture("app://ui/transport.html", 1));
        for value in [
            "https://ui/transport.html",
            "app://foreign/transport.html",
            "app://ui/other.html",
            "app://user@ui/transport.html",
            "app://ui:88/transport.html",
        ] {
            assert!(!allowed_fixture(value, 4));
        }
        for rate in [0, 2, 8, -1, i32::MAX] {
            assert!(!allowed_fixture("app://ui/transport.html", rate));
        }
    }
}
