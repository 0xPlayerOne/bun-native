//! The D-Bus session-bus plumbing shared by the Linux services that talk to a
//! desktop server over it (file dialogs through xdg-desktop-portal,
//! notifications through `org.freedesktop.Notifications`).
//!
//! Each service owns one lazily opened connection, one signal listener on that
//! connection, and a count of its outstanding bus operations so shutdown can
//! wait for them within a bound. The service keeps its own registry, signal
//! parsing and delivery rules; this module only owns the connection's
//! lifetime and the bounds every bus operation runs under.

use bun_native_protocol::ErrorCode;
use futures::FutureExt;
use futures::future::Shared;
use futures_lite::StreamExt;
use gpui::{App, AsyncApp, Task};
use std::cell::{Cell, RefCell};
use std::ops::ControlFlow;
use std::rc::Rc;
use std::time::Duration;

pub(crate) type Failure = (ErrorCode, &'static str);

/// The one connection a service opens, shared by every operation waiting on it.
pub(crate) type Link = Shared<Task<Result<zbus::Connection, Failure>>>;

/// Every bus operation, including connection setup, is bounded.
pub(crate) const TIMEOUT: Duration = Duration::from_secs(2);
const MAX_QUEUED_SIGNALS: usize = 64;
const DRAIN_POLL: Duration = Duration::from_millis(5);

/// The texts a service reports for the failures this module detects.
pub(crate) struct Messages {
    /// An operation did not finish within [`TIMEOUT`].
    pub(crate) timed_out: &'static str,
    /// The signal match rule could not be built or registered.
    pub(crate) subscribe_failed: &'static str,
}

struct BusState {
    link: RefCell<Option<Link>>,
    listener: RefCell<Option<Task<()>>>,
    in_flight: Cell<usize>,
    messages: Messages,
}

/// A service's connection, listener and in-flight operation count.
pub(crate) struct SessionBus(Rc<BusState>);

impl SessionBus {
    pub(crate) fn new(messages: Messages) -> Self {
        Self(Rc::new(BusState {
            link: RefCell::new(None),
            listener: RefCell::new(None),
            in_flight: Cell::new(0),
            messages,
        }))
    }

    /// Run one bus operation on the UI executor, counted until it finishes.
    pub(crate) fn spawn<S: 'static>(
        &self,
        service: S,
        cx: &mut App,
        work: impl AsyncFnOnce(S, &mut AsyncApp) + 'static,
    ) {
        let shared = self.0.clone();
        shared.in_flight.set(shared.in_flight.get() + 1);
        cx.spawn(async move |cx| {
            work(service, cx).await;
            shared.in_flight.set(shared.in_flight.get() - 1);
        })
        .detach();
    }

    /// The service's connection, opened on first use. Once it is open, every
    /// signal matching `rule` is handed to `signal` until it answers `Break`.
    /// The listener lives as long as this value and is dropped by [`drain`].
    ///
    /// [`drain`]: Self::drain
    pub(crate) fn link(
        &self,
        cx: &mut App,
        rule: fn() -> zbus::Result<zbus::MatchRule<'static>>,
        signal: impl FnMut(&zbus::Message, &mut AsyncApp) -> ControlFlow<()> + 'static,
    ) -> Link {
        if let Some(link) = &*self.0.link.borrow() {
            return link.clone();
        }
        let weak = Rc::downgrade(&self.0);
        let timed_out = self.0.messages.timed_out;
        let subscribe_failed = self.0.messages.subscribe_failed;
        let link: Link = cx
            .spawn(async move |cx| {
                let connection = bounded(cx, timed_out, connect()).await?;
                let signals = bounded(
                    cx,
                    timed_out,
                    subscribe(connection.clone(), rule, subscribe_failed),
                )
                .await?;
                let listener = cx.spawn(async move |cx| listen(signals, signal, cx).await);
                if let Some(shared) = weak.upgrade() {
                    shared.listener.replace(Some(listener));
                }
                Ok(connection)
            })
            .shared();
        self.0.link.replace(Some(link.clone()));
        link
    }

    /// Bound `work` by [`TIMEOUT`], reporting this service's timeout text.
    pub(crate) async fn bounded<T>(
        &self,
        cx: &mut AsyncApp,
        work: impl Future<Output = Result<T, Failure>>,
    ) -> Result<T, Failure> {
        bounded(cx, self.0.messages.timed_out, work).await
    }

    /// When a connection was ever opened, wait within twice the bound for
    /// every outstanding operation, then drop the listener and the connection.
    pub(crate) fn drain(&self, cx: &mut App) -> Option<Task<()>> {
        self.0.link.borrow().as_ref()?;
        let shared = self.0.clone();
        Some(cx.spawn(async move |cx| {
            let deadline = std::time::Instant::now() + TIMEOUT * 2;
            while shared.in_flight.get() > 0 && std::time::Instant::now() < deadline {
                cx.background_executor().timer(DRAIN_POLL).await;
            }
            shared.listener.replace(None);
            shared.link.replace(None);
        }))
    }
}

/// A session bus is configured. Whether its server answers is only known
/// when it is first asked, and is reported then.
pub(crate) fn session_bus_configured() -> bool {
    std::env::var_os("DBUS_SESSION_BUS_ADDRESS").is_some_and(|address| !address.is_empty())
        || std::env::var_os("XDG_RUNTIME_DIR")
            .is_some_and(|directory| std::path::Path::new(&directory).join("bus").exists())
}

async fn bounded<T>(
    cx: &mut AsyncApp,
    timed_out: &'static str,
    work: impl Future<Output = Result<T, Failure>>,
) -> Result<T, Failure> {
    let timer = cx.background_executor().timer(TIMEOUT);
    // `or` polls `work` first, so a ready answer wins over the timer.
    futures_lite::future::or(work, async move {
        timer.await;
        Err((ErrorCode::OperationTimedOut, timed_out))
    })
    .await
}

async fn connect() -> Result<zbus::Connection, Failure> {
    zbus::Connection::session().await.map_err(|_| {
        (
            ErrorCode::ServiceUnavailable,
            "cannot connect to the D-Bus session bus",
        )
    })
}

async fn subscribe(
    connection: zbus::Connection,
    rule: fn() -> zbus::Result<zbus::MatchRule<'static>>,
    failed: &'static str,
) -> Result<zbus::MessageStream, Failure> {
    let failed = |_| (ErrorCode::NativeFailure, failed);
    let rule = rule().map_err(failed)?;
    zbus::MessageStream::for_match_rule(rule, &connection, Some(MAX_QUEUED_SIGNALS))
        .await
        .map_err(failed)
}

async fn listen(
    mut signals: zbus::MessageStream,
    mut signal: impl FnMut(&zbus::Message, &mut AsyncApp) -> ControlFlow<()>,
    cx: &mut AsyncApp,
) {
    while let Some(Ok(message)) = signals.next().await {
        if signal(&message, cx).is_break() {
            return;
        }
    }
}

/// The unique name of the connection that sent `message`.
pub(crate) fn sender(message: &zbus::Message) -> Option<zbus::names::OwnedUniqueName> {
    Some(message.header().sender()?.to_owned().into())
}
