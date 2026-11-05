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
