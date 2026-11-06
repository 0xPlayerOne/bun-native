//! Shared local-X11 plumbing for native service workers. Each service owns its
//! own connection; this module only bounds connection setup and socket waits.

use bun_native_protocol::ErrorCode;
use gpui::App;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::{Duration, Instant};
use x11rb::reexports::x11rb_protocol::parse_display::parse_display;
use x11rb::rust_connection::RustConnection;

pub(crate) mod auth;
pub(crate) mod stream;
pub(crate) mod wake;

pub(crate) type Failure = (ErrorCode, &'static str);
pub(crate) type XConnection = RustConnection<stream::BoundedStream>;
pub(crate) const TRANSFER_TIMEOUT: Duration = Duration::from_secs(2);
pub(crate) const WORKER_POLL: Duration = Duration::from_millis(5);
pub(crate) const MAX_INBOUND_BYTES: usize = 262_144;

/// One bounded unit of X11 work: a total deadline, owner/session revocation
/// and an inbound byte allowance shared across every read of the burst.
#[derive(Clone)]
pub(crate) struct Budget {
    pub(crate) deadline: Instant,
    pub(crate) cancelled: Arc<AtomicBool>,
    pub(crate) stopping: Arc<AtomicBool>,
    pub(crate) inbound: Arc<AtomicUsize>,
}

impl Budget {
    pub(crate) fn new(cancelled: Arc<AtomicBool>, stopping: Arc<AtomicBool>) -> Self {
        Self {
            deadline: Instant::now() + TRANSFER_TIMEOUT,
            cancelled,
            stopping,
            inbound: Arc::new(AtomicUsize::new(0)),
        }
    }

    pub(crate) fn check(&self) -> Result<(), Failure> {
        if self.cancelled.load(Ordering::Acquire) || self.stopping.load(Ordering::Acquire) {
            Err((
                ErrorCode::Cancelled,
                "native X11 service request was cancelled",
            ))
        } else if self.inbound.load(Ordering::Relaxed) > MAX_INBOUND_BYTES {
            Err((
                ErrorCode::LimitExceeded,
                "native X11 service exceeded its inbound byte budget",
            ))
        } else if Instant::now() >= self.deadline {
            Err((
                ErrorCode::OperationTimedOut,
                "native X11 service exceeded its total two-second bound",
            ))
        } else {
            Ok(())
        }
    }

    pub(crate) fn failure(&self) -> Failure {
        self.check().err().unwrap_or((
            ErrorCode::NativeFailure,
            "native X11 service operation failed",
        ))
    }

    pub(crate) fn input_allowance(&self) -> usize {
        let remaining = MAX_INBOUND_BYTES.saturating_sub(self.inbound.load(Ordering::Relaxed));
        if remaining == 0 {
            self.inbound.store(MAX_INBOUND_BYTES + 1, Ordering::Relaxed);
        }
        remaining
    }
}

/// The local X server that GPUI itself uses. No implicit TCP/DNS session
/// change: SSH-forwarded and remote X11 services remain unavailable.
#[derive(Clone)]
pub(crate) struct Display {
    display: u16,
    pub(crate) screen: usize,
}

impl Display {
    pub(crate) fn from_app(cx: &App) -> Option<Self> {
        if cx.compositor_name() != "X11" {
            return None;
        }
        let environment = cx.graphical_environment()?;
        let display = environment.x11_display?.into_string().ok()?;
        let parsed = parse_display(Some(&display)).ok()?;
        if (!parsed.host.is_empty() && parsed.host != "unix")
            || parsed
                .protocol
                .as_deref()
                .is_some_and(|protocol| protocol != "unix")
        {
            return None;
        }
        Some(Self {
            display: parsed.display,
            screen: usize::from(parsed.screen),
        })
    }

    pub(crate) fn connect(&self, budget: &Budget) -> Result<XConnection, Failure> {
        let (stream, (family, address)) =
            stream::BoundedStream::local(&format!("/tmp/.X11-unix/X{}", self.display), budget)?;
        // Authentication remains local session setup, never a service grant.
        // The same opened regular file is validated and read, with a fixed
        // byte cap. Local filesystem setup remains trusted, not a hard
        // wall-clock I/O guarantee. No credentials enter evidence.
        let authority = std::env::var_os("XAUTHORITY")
            .map(PathBuf::from)
            .or_else(|| {
                std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".Xauthority"))
            });
        let authentication = auth::get(authority.as_deref(), family, &address, self.display);
        budget.check()?;
        let (name, data) = authentication
            .map_err(|_| {
                (
                    ErrorCode::ServiceUnavailable,
                    "X11 authority setup is not a valid bounded regular file",
                )
            })?
            .unwrap_or_default();
        RustConnection::connect_to_stream_with_auth_info(stream, self.screen, name, data)
            .map_err(|_| budget.failure())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn budget() -> Budget {
        Budget::new(
            Arc::new(AtomicBool::new(false)),
            Arc::new(AtomicBool::new(false)),
        )
    }

    #[test]
    fn a_fresh_budget_admits_work_and_reports_a_generic_failure() {
        let before = Instant::now();
        let budget = budget();
        assert!(budget.check().is_ok());
        assert!(budget.deadline >= before + TRANSFER_TIMEOUT);
        assert!(budget.deadline <= Instant::now() + TRANSFER_TIMEOUT);
        assert_eq!(budget.inbound.load(Ordering::Relaxed), 0);
        assert_eq!(budget.failure().0, ErrorCode::NativeFailure);
    }

    #[test]
    fn revocation_outranks_byte_exhaustion_which_outranks_the_deadline() {
        let mut budget = budget();
        budget
            .inbound
            .store(MAX_INBOUND_BYTES + 1, Ordering::Relaxed);
        budget.deadline = Instant::now();
        assert_eq!(budget.check().unwrap_err().0, ErrorCode::LimitExceeded);
        budget.stopping.store(true, Ordering::Release);
        assert_eq!(budget.check().unwrap_err().0, ErrorCode::Cancelled);
        budget.stopping.store(false, Ordering::Release);
        budget.cancelled.store(true, Ordering::Release);
        assert_eq!(budget.failure().0, ErrorCode::Cancelled);
        budget.cancelled.store(false, Ordering::Release);
        budget.inbound.store(0, Ordering::Relaxed);
        // The deadline is inclusive: reaching it is already a timeout.
        assert_eq!(budget.check().unwrap_err().0, ErrorCode::OperationTimedOut);
        assert_eq!(budget.failure().0, ErrorCode::OperationTimedOut);
    }

    #[test]
    fn inbound_limit_admits_its_exact_size_and_is_shared_across_clones() {
        let budget = budget();
        let clone = budget.clone();
        clone.inbound.store(MAX_INBOUND_BYTES, Ordering::Relaxed);
        assert!(budget.check().is_ok());
        clone
            .inbound
            .store(MAX_INBOUND_BYTES + 1, Ordering::Relaxed);
        assert_eq!(budget.check().unwrap_err().0, ErrorCode::LimitExceeded);
        clone.cancelled.store(true, Ordering::Release);
        assert_eq!(budget.check().unwrap_err().0, ErrorCode::Cancelled);
    }

    #[test]
    fn input_allowance_counts_down_and_poisons_an_exhausted_budget() {
        let budget = budget();
        assert_eq!(budget.input_allowance(), MAX_INBOUND_BYTES);
        budget
            .inbound
            .store(MAX_INBOUND_BYTES - 7, Ordering::Relaxed);
        assert_eq!(budget.input_allowance(), 7);
        assert!(budget.check().is_ok());
        // Exactly exhausted: the allowance is zero and the budget now fails,
        // so a reader cannot spin on zero-length reads.
        budget.inbound.store(MAX_INBOUND_BYTES, Ordering::Relaxed);
        assert_eq!(budget.input_allowance(), 0);
        assert_eq!(
            budget.inbound.load(Ordering::Relaxed),
            MAX_INBOUND_BYTES + 1
        );
        assert_eq!(budget.check().unwrap_err().0, ErrorCode::LimitExceeded);
        // Overdrawn counters saturate rather than wrap.
        budget.inbound.store(usize::MAX, Ordering::Relaxed);
        assert_eq!(budget.input_allowance(), 0);
        assert_eq!(
            budget.inbound.load(Ordering::Relaxed),
            MAX_INBOUND_BYTES + 1
        );
    }
}
