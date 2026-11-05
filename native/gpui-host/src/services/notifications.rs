//! Window-owned desktop notifications through the freedesktop.org
//! `org.freedesktop.Notifications` service on the D-Bus session bus.
//!
//! The UI thread owns the registry and decides delivery. Removing an entry
//! stops delivery at once, before the server is asked to close the
//! notification, so an activation already queued for a withdrawn notification
//! is never published. Only signals from the bus connection that answered
//! `Notify` are accepted for that notification.

use crate::channel::EventSink;
use bun_native_protocol::{
    ErrorCode, Event, MAX_NOTIFICATIONS, NotificationDismissal, NotificationId, RequestId, WindowId,
};
use futures::FutureExt;
use futures::future::Shared;
use futures_lite::StreamExt;
use gpui::{App, AsyncApp, Task};
use std::cell::{Cell, RefCell};
use std::collections::{BTreeMap, HashMap, VecDeque};
use std::rc::{Rc, Weak};
use std::time::Duration;
use zbus::names::OwnedUniqueName;

type Failure = (ErrorCode, &'static str);

const NAME: &str = "org.freedesktop.Notifications";
const PATH: &str = "/org/freedesktop/Notifications";
/// Every bus operation, including connection setup, is bounded.
const TIMEOUT: Duration = Duration::from_secs(2);
const MAX_QUEUED_SIGNALS: usize = 64;
/// Closures seen before the matching `Notify` reply was processed.
const MAX_EARLY_CLOSURES: usize = 64;
const DRAIN_POLL: Duration = Duration::from_millis(5);

enum State {
    Posting(RequestId),
    Live { server: OwnedUniqueName, key: u32 },
}

struct Entry {
    window: WindowId,
    state: State,
}

type Link = Shared<Task<Result<zbus::Connection, Failure>>>;

struct Inner {
    entries: RefCell<BTreeMap<NotificationId, Entry>>,
    last_notification: Cell<u64>,
    link: RefCell<Option<Link>>,
    listener: RefCell<Option<Task<()>>>,
    early: RefCell<VecDeque<(OwnedUniqueName, u32, NotificationDismissal)>>,
    in_flight: Cell<usize>,
    stopping: Cell<bool>,
    events: EventSink,
    available: bool,
}

#[derive(Clone)]
pub(crate) struct Notifications(Rc<Inner>);

impl Notifications {
    pub(crate) fn new(events: EventSink, _cx: &App) -> Self {
        Self(Rc::new(Inner {
            entries: RefCell::new(BTreeMap::new()),
            last_notification: Cell::new(0),
            link: RefCell::new(None),
            listener: RefCell::new(None),
            early: RefCell::new(VecDeque::new()),
            in_flight: Cell::new(0),
            stopping: Cell::new(false),
            events,
            available: session_bus_configured(),
        }))
    }

    /// A session bus is configured. Whether a notification server answers is
    /// only known when posting, and is reported then.
    pub(crate) fn available(&self) -> bool {
        self.0.available
    }

    pub(crate) fn post(
        &self,
        request: (RequestId, WindowId, NotificationId),
        title: String,
        body: String,
        cx: &mut App,
    ) -> Result<(), Failure> {
        let (id, window, notification) = request;
        if !self.available() {
            return Err((
                ErrorCode::ServiceUnavailable,
                "notifications require a D-Bus session bus",
            ));
        }
        if notification.get() <= self.0.last_notification.get() {
            return Err((
                ErrorCode::InvalidHandle,
                "notification IDs must increase across the session",
            ));
        }
        if self.0.entries.borrow().len() >= MAX_NOTIFICATIONS {
            return Err((ErrorCode::LimitExceeded, "live notification limit exceeded"));
        }
        if self.0.stopping.get() {
            return Err((
                ErrorCode::Cancelled,
                "notification service is shutting down",
            ));
        }
        let link = self.link(cx);
        self.0.last_notification.set(notification.get());
        self.0.entries.borrow_mut().insert(
            notification,
            Entry {
                window,
                state: State::Posting(id),
            },
        );
        self.spawn(cx, async move |this, cx| {
            let result = bounded(cx, notify(link, title, body)).await;
            cx.update(|cx| this.posted(notification, result, cx));
        });
        Ok(())
    }

    pub(crate) fn withdraw(
        &self,
        id: RequestId,
        window: WindowId,
        notification: NotificationId,
        cx: &mut App,
    ) -> Result<(), Failure> {
        let (server, key) = match self.0.entries.borrow().get(&notification) {
            Some(Entry {
                window: owner,
                state,
            }) if *owner == window => match state {
                State::Posting(_) => {
                    return Err((
                        ErrorCode::InvalidState,
                        "notification is still being posted",
                    ));
                }
                State::Live { server, key } => (server.clone(), *key),
            },
            _ => {
                return Err((
                    ErrorCode::InvalidHandle,
                    "notification is not live for this window",
                ));
            }
        };
        self.0.entries.borrow_mut().remove(&notification);
        let link = self.link(cx);
        self.spawn(cx, async move |this, cx| {
            let result = bounded(cx, close(link, server, key)).await;
            cx.update(|cx| {
                let event = match result {
                    Ok(()) => Event::NotificationWithdrawn {
                        id,
                        window_id: window,
                        notification_id: notification,
                    },
                    Err((code, message)) => Event::Error {
                        id: Some(id),
                        code,
                        message: message.into(),
                    },
                };
                this.0.events.send(event, cx);
            });
        });
        Ok(())
    }

    /// Owner close revokes delivery now and withdraws each live notification.
    pub(crate) fn close_window(&self, window: WindowId, cx: &mut App) {
        let owned: Vec<NotificationId> = self
            .0
            .entries
            .borrow()
            .iter()
            .filter_map(|(id, entry)| (entry.window == window).then_some(*id))
            .collect();
        for notification in owned {
            let Some(entry) = self.0.entries.borrow_mut().remove(&notification) else {
                continue;
            };
            match entry.state {
                State::Posting(id) => self.0.events.send(
                    Event::Error {
                        id: Some(id),
                        code: ErrorCode::InvalidHandle,
                        message: "notification owner window was closed".into(),
                    },
                    cx,
                ),
                State::Live { server, key } => self.discard(server, key, cx),
            }
        }
    }

    /// Withdraw a notification nobody owns any more; the outcome is not
    /// reported, but shutdown waits for it.
    fn discard(&self, server: OwnedUniqueName, key: u32, cx: &mut App) {
        let link = self.link(cx);
        self.spawn(cx, async move |_, cx| {
            let _ = bounded(cx, close(link, server, key)).await;
        });
    }

    fn spawn(&self, cx: &mut App, work: impl AsyncFnOnce(Self, &mut AsyncApp) + 'static) {
        let this = self.clone();
        this.0.in_flight.set(this.0.in_flight.get() + 1);
        cx.spawn(async move |cx| {
            work(this.clone(), cx).await;
            this.0.in_flight.set(this.0.in_flight.get() - 1);
        })
        .detach();
    }

    fn link(&self, cx: &mut App) -> Link {
        if let Some(link) = &*self.0.link.borrow() {
            return link.clone();
        }
        let weak = Rc::downgrade(&self.0);
        let link: Link = cx
            .spawn(async move |cx| {
                let connection = bounded(cx, connect()).await?;
                let signals = bounded(cx, subscribe(connection.clone())).await?;
                let listener = cx.spawn({
                    let weak = weak.clone();
                    async move |cx| listen(weak, signals, cx).await
                });
                if let Some(inner) = weak.upgrade() {
                    inner.listener.replace(Some(listener));
                }
                Ok(connection)
            })
            .shared();
        self.0.link.replace(Some(link.clone()));
        link
    }

    fn posted(
        &self,
        notification: NotificationId,
        result: Result<(OwnedUniqueName, u32, bool), Failure>,
        cx: &mut App,
    ) {
        let mut entries = self.0.entries.borrow_mut();
        let pending = match entries.get_mut(&notification) {
            Some(entry) => match entry.state {
                State::Posting(id) => Some((entry, id)),
                State::Live { .. } => None,
            },
            None => None,
        };
        let Some((entry, id)) = pending else {
            drop(entries);
            // The owner closed or the session stopped while Notify was in
            // flight: nothing owns the posted notification, so close it.
            if let Ok((server, key, _)) = result {
                self.discard(server, key, cx);
            }
            return;
        };
        let window = entry.window;
        let (server, key, activatable) = match result {
            Ok(posted) => posted,
            Err((code, message)) => {
                entries.remove(&notification);
                drop(entries);
                self.0.events.send(
                    Event::Error {
                        id: Some(id),
                        code,
                        message: message.into(),
                    },
                    cx,
                );
                return;
            }
        };
        let early = {
            let mut early = self.0.early.borrow_mut();
            early
                .iter()
                .position(|(sender, closed, _)| *sender == server && *closed == key)
                .and_then(|index| early.remove(index))
        };
        if early.is_some() {
            entries.remove(&notification);
        } else {
            entry.state = State::Live {
                server: server.clone(),
                key,
            };
        }
        drop(entries);
        self.0.events.send(
            Event::NotificationPosted {
                id,
                window_id: window,
                notification_id: notification,
                activatable,
            },
            cx,
        );
        if let Some((_, _, reason)) = early {
            self.dismissed(window, notification, reason, cx);
        }
    }

    fn dismissed(
        &self,
        window: WindowId,
        notification: NotificationId,
        reason: NotificationDismissal,
        cx: &mut App,
    ) {
        self.0.events.ui(
            |sequence| Event::NotificationDismissed {
                sequence,
                window_id: window,
                notification_id: notification,
                reason,
            },
            cx,
        );
    }

    fn find(&self, sender: &OwnedUniqueName, key: u32) -> Option<(NotificationId, WindowId)> {
        self.0
            .entries
            .borrow()
            .iter()
            .find_map(|(id, entry)| match &entry.state {
                State::Live { server, key: live } if server == sender && *live == key => {
                    Some((*id, entry.window))
                }
                _ => None,
            })
    }

    fn signal(&self, signal: Signal, cx: &mut App) {
        match signal {
            Signal::Activated { sender, key } => {
                if let Some((notification, window)) = self.find(&sender, key) {
                    self.0.events.ui(
                        |sequence| Event::NotificationActivated {
                            sequence,
                            window_id: window,
                            notification_id: notification,
                        },
                        cx,
                    );
                }
            }
            Signal::Closed {
                sender,
                key,
                reason,
            } => match self.find(&sender, key) {
                Some((notification, window)) => {
                    self.0.entries.borrow_mut().remove(&notification);
                    self.dismissed(window, notification, reason, cx);
                }
                None => {
                    let posting = self
                        .0
                        .entries
                        .borrow()
                        .values()
                        .any(|entry| matches!(entry.state, State::Posting(_)));
                    if posting {
                        let mut early = self.0.early.borrow_mut();
                        if early.len() == MAX_EARLY_CLOSURES {
                            early.pop_front();
                        }
                        early.push_back((sender, key, reason));
                    }
                }
            },
        }
    }

    /// Revoke every notification, withdraw the live ones from the server and
    /// wait, within the bound, for every outstanding bus operation.
    pub(crate) fn stop(&self, cx: &mut App) -> Option<Task<()>> {
        self.0.stopping.set(true);
        let entries = std::mem::take(&mut *self.0.entries.borrow_mut());
        for entry in entries.into_values() {
            match entry.state {
                State::Posting(id) => self.0.events.send(
                    Event::Error {
                        id: Some(id),
                        code: ErrorCode::Cancelled,
                        message: "notification post cancelled during shutdown".into(),
                    },
                    cx,
                ),
                State::Live { server, key } => self.discard(server, key, cx),
            }
        }
        self.0.link.borrow().as_ref()?;
        let this = self.clone();
        Some(cx.spawn(async move |cx| {
            let deadline = std::time::Instant::now() + TIMEOUT * 2;
            while this.0.in_flight.get() > 0 && std::time::Instant::now() < deadline {
                cx.background_executor().timer(DRAIN_POLL).await;
            }
            this.0.listener.replace(None);
            this.0.link.replace(None);
        }))
    }
}

enum Signal {
    Activated {
        sender: OwnedUniqueName,
        key: u32,
    },
    Closed {
        sender: OwnedUniqueName,
        key: u32,
        reason: NotificationDismissal,
    },
}

fn session_bus_configured() -> bool {
    std::env::var_os("DBUS_SESSION_BUS_ADDRESS").is_some_and(|address| !address.is_empty())
        || std::env::var_os("XDG_RUNTIME_DIR")
            .is_some_and(|directory| std::path::Path::new(&directory).join("bus").exists())
}

async fn bounded<T>(
    cx: &mut AsyncApp,
    work: impl Future<Output = Result<T, Failure>>,
) -> Result<T, Failure> {
    let timer = cx.background_executor().timer(TIMEOUT);
    futures_lite::future::or(work, async move {
        timer.await;
        Err((
            ErrorCode::OperationTimedOut,
            "notification server did not answer within two seconds",
        ))
    })
    .await
}

fn bus_failure(error: &zbus::Error) -> Failure {
    match error {
        zbus::Error::MethodError(name, _, _)
            if name.as_str() == "org.freedesktop.DBus.Error.ServiceUnknown"
                || name.as_str() == "org.freedesktop.DBus.Error.NameHasNoOwner" =>
        {
            (
                ErrorCode::ServiceUnavailable,
                "no desktop notification server is running",
            )
        }
        _ => (
            ErrorCode::NativeFailure,
            "desktop notification server request failed",
        ),
    }
}

async fn connect() -> Result<zbus::Connection, Failure> {
    zbus::Connection::session().await.map_err(|_| {
        (
            ErrorCode::ServiceUnavailable,
            "cannot connect to the D-Bus session bus",
        )
    })
}

async fn subscribe(connection: zbus::Connection) -> Result<zbus::MessageStream, Failure> {
    let failed = |_| {
        (
            ErrorCode::NativeFailure,
            "cannot subscribe to desktop notification signals",
        )
    };
    let rule = zbus::MatchRule::builder()
        .msg_type(zbus::message::Type::Signal)
        .interface(NAME)
        .map_err(failed)?
        .path(PATH)
        .map_err(failed)?
        .build();
    zbus::MessageStream::for_match_rule(rule, &connection, Some(MAX_QUEUED_SIGNALS))
        .await
        .map_err(failed)
}

async fn listen(inner: Weak<Inner>, mut signals: zbus::MessageStream, cx: &mut AsyncApp) {
    while let Some(Ok(message)) = signals.next().await {
        let Some(signal) = parse_signal(&message) else {
            continue;
        };
        let Some(inner) = inner.upgrade() else { return };
        cx.update(|cx| Notifications(inner).signal(signal, cx));
    }
}

fn parse_signal(message: &zbus::Message) -> Option<Signal> {
    let header = message.header();
    let sender = OwnedUniqueName::from(header.sender()?.to_owned());
    match header.member()?.as_str() {
        "ActionInvoked" => {
            let (key, action): (u32, String) = message.body().deserialize().ok()?;
            (action == "default").then_some(Signal::Activated { sender, key })
        }
        "NotificationClosed" => {
            let (key, reason): (u32, u32) = message.body().deserialize().ok()?;
            let reason = match reason {
                1 => NotificationDismissal::Expired,
                2 => NotificationDismissal::Dismissed,
                _ => NotificationDismissal::Closed,
            };
            Some(Signal::Closed {
                sender,
                key,
                reason,
            })
        }
        _ => None,
    }
}

async fn notify(
    link: Link,
    title: String,
    body: String,
) -> Result<(OwnedUniqueName, u32, bool), Failure> {
    let connection = link.await?;
    let capabilities: Vec<String> = connection
        .call_method(Some(NAME), PATH, Some(NAME), "GetCapabilities", &())
        .await
        .map_err(|error| bus_failure(&error))?
        .body()
        .deserialize()
        .map_err(|_| {
            (
                ErrorCode::NativeFailure,
                "notification server returned malformed capabilities",
            )
        })?;
    let has = |name: &str| capabilities.iter().any(|capability| capability == name);
    let activatable = has("actions");
    // Content is plain text; a markup-capable server must not interpret it.
    let body = if has("body-markup") {
        escape_markup(&body)
    } else {
        body
    };
    let actions: &[&str] = if activatable { &["default", ""] } else { &[] };
    let hints: HashMap<&str, zbus::zvariant::Value<'_>> = HashMap::new();
    let reply = connection
        .call_method(
            Some(NAME),
            PATH,
            Some(NAME),
            "Notify",
            &(
                "",
                0_u32,
                "",
                title.as_str(),
                body.as_str(),
                actions,
                hints,
                -1_i32,
            ),
        )
        .await
        .map_err(|error| bus_failure(&error))?;
    let header = reply.header();
    let server = OwnedUniqueName::from(
        header
            .sender()
            .ok_or((
                ErrorCode::NativeFailure,
                "notification server reply has no sender",
            ))?
            .to_owned(),
    );
    let key: u32 = reply.body().deserialize().map_err(|_| {
        (
            ErrorCode::NativeFailure,
            "notification server returned a malformed notification ID",
        )
    })?;
    Ok((server, key, activatable))
}

async fn close(link: Link, server: OwnedUniqueName, key: u32) -> Result<(), Failure> {
    let connection = link.await?;
    match connection
        .call_method(
            Some(server.as_str()),
            PATH,
            Some(NAME),
            "CloseNotification",
            &key,
        )
        .await
    {
        // The specification answers an already-closed notification with an
        // error reply; either way the server no longer shows it.
        Ok(_) | Err(zbus::Error::MethodError(..)) => Ok(()),
        Err(_) => Err((
            ErrorCode::NativeFailure,
            "cannot withdraw the desktop notification",
        )),
    }
}

fn escape_markup(text: &str) -> String {
    let mut escaped = String::with_capacity(text.len());
    for character in text.chars() {
        match character {
            '&' => escaped.push_str("&amp;"),
            '<' => escaped.push_str("&lt;"),
            '>' => escaped.push_str("&gt;"),
            other => escaped.push(other),
        }
    }
    escaped
}

#[cfg(test)]
mod tests {
    use super::escape_markup;

    #[test]
    fn plain_text_is_never_interpreted_as_markup() {
        assert_eq!(
            escape_markup("<b>a</b> & <a href=\"x\">"),
            "&lt;b&gt;a&lt;/b&gt; &amp; &lt;a href=\"x\"&gt;"
        );
        assert_eq!(escape_markup("line\nnext"), "line\nnext");
    }
}
