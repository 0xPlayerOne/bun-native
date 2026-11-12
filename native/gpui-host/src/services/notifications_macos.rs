//! Window-owned user notifications on macOS through
//! `UNUserNotificationCenter`.
//!
//! The service exists only when the host runs from an application bundle:
//! the framework serves nothing else. The UI thread owns the registry and
//! decides delivery. The center reports posts, activations and dismissals on
//! its own threads; they are queued to a GPUI task and matched by request
//! identifier, so an activation for a withdrawn notification is never
//! published. Every post asks for authorization first, and the first post of
//! a bundle shows the OS permission prompt. A post is answered within
//! [`POST_BOUND`]: one still waiting for the user's answer then rejects with
//! `operation_timed_out`, and a later grant adds nothing. A request the host
//! leaves unanswered past the client's request timeout (five seconds by
//! default) would end the whole session. Withdrawal, owner close and shutdown
//! do not wait.

use crate::channel::EventSink;
use crate::services::report_pump::{self, ReportLink};
use bun_native_macos_surface::notifications::{self, Center, CenterEvent, PostFailure};
use bun_native_protocol::{
    ErrorCode, Event, MAX_NOTIFICATIONS, NotificationDismissal, NotificationId, RequestId, WindowId,
};
use gpui::{App, Task};
use std::cell::{Cell, RefCell};
use std::collections::BTreeMap;
use std::rc::Rc;
use std::time::Duration;

type Failure = (ErrorCode, &'static str);

/// How long a post waits for authorization and the center's addition, as a
/// Linux post waits for the notification server.
const POST_BOUND: Duration = Duration::from_secs(2);
const POST_TIMED_OUT: &str = "notification authorization did not finish within two seconds; \
the OS permission prompt may be waiting for the user";

/// Center reports waiting for the UI. Posts are bounded by the live limit;
/// activations beyond the rest are dropped, as on Linux.
const MAX_REPORTS: usize = MAX_NOTIFICATIONS * 2 + 64;

enum State {
    Posting(RequestId),
    Live,
}

struct Entry {
    window: WindowId,
    identifier: String,
    state: State,
}

struct Inner {
    entries: RefCell<BTreeMap<NotificationId, Entry>>,
    last_notification: Cell<u64>,
    stopping: Cell<bool>,
    events: EventSink,
    available: bool,
    center: RefCell<Option<Center>>,
    /// Closes the report channel on shutdown or drop, ending the worker,
    /// which holds this service only weakly (see `report_pump`).
    reports: RefCell<Option<ReportLink<CenterEvent>>>,
}

#[derive(Clone)]
pub(crate) struct Notifications(Rc<Inner>);

impl Notifications {
    pub(crate) fn new(events: EventSink, _cx: &App) -> Self {
        Self(Rc::new(Inner {
            entries: RefCell::new(BTreeMap::new()),
            last_notification: Cell::new(0),
            stopping: Cell::new(false),
            events,
            available: notifications::bundled(),
            center: RefCell::new(None),
            reports: RefCell::new(None),
        }))
    }

    /// The host runs from an application bundle with an identifier.
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
        check_post(
            self.available(),
            self.0.last_notification.get(),
            notification,
            self.0.entries.borrow().len(),
            self.0.stopping.get(),
        )?;
        self.connect(cx)?;
        let identifier = identifier(std::process::id(), notification);
        self.0.last_notification.set(notification.get());
        self.0.entries.borrow_mut().insert(
            notification,
            Entry {
                window,
                identifier: identifier.clone(),
                state: State::Posting(id),
            },
        );
        if let Some(center) = &*self.0.center.borrow() {
            center.post(&identifier, &title, &body);
        }
        let service = Rc::downgrade(&self.0);
        cx.spawn(async move |cx| {
            cx.background_executor().timer(POST_BOUND).await;
            if let Some(inner) = service.upgrade() {
                cx.update(|cx| Notifications(inner).expire(notification, id, cx));
            }
        })
        .detach();
        Ok(())
    }

    /// The bound passed: a post still waiting for authorization or its
    /// addition is rejected. A grant or addition that completes later finds
    /// no entry and is withdrawn (see [`Self::report`]).
    fn expire(&self, notification: NotificationId, id: RequestId, cx: &mut App) {
        let expired = {
            let mut entries = self.0.entries.borrow_mut();
            let posting = entries
                .get(&notification)
                .is_some_and(|entry| still_posting(&entry.state, id));
            if posting {
                entries.remove(&notification);
            }
            posting
        };
        if expired {
            self.0.events.send(
                Event::Error {
                    id: Some(id),
                    code: ErrorCode::OperationTimedOut,
                    message: POST_TIMED_OUT.into(),
                },
                cx,
            );
        }
    }

    fn connect(&self, cx: &mut App) -> Result<(), Failure> {
        if self.0.center.borrow().is_some() {
            return Ok(());
        }
        let (sender, link, reports) = report_pump::channel::<CenterEvent>(MAX_REPORTS);
        let center = Center::new(move |event| {
            // Fails once the service stopped or was dropped: nothing owns
            // the outcome any more.
            let _ = sender.try_send(event);
        })
        .map_err(|_| {
            (
                ErrorCode::NativeFailure,
                "cannot connect to the user notification center",
            )
        })?;
        self.0.center.replace(Some(center));
        self.0.reports.replace(Some(link));
        let service = Rc::downgrade(&self.0);
        cx.spawn(async move |cx| {
            report_pump::pump(service, reports, |inner, report| {
                cx.update(|cx| Notifications(inner).report(report, cx));
            })
            .await;
        })
        .detach();
        Ok(())
    }

    fn find(&self, identifier: &str) -> Option<NotificationId> {
        self.0
            .entries
            .borrow()
            .iter()
            .find_map(|(id, entry)| (entry.identifier == identifier).then_some(*id))
    }

    fn report(&self, report: CenterEvent, cx: &mut App) {
        match report {
            CenterEvent::Posted { identifier, result } => {
                // From here this registry withdraws a successful post itself:
                // when revoked below, on withdrawal, owner close or shutdown.
                if let Some(center) = &*self.0.center.borrow() {
                    center.settle(&identifier);
                }
                let Some(notification) = self.find(&identifier) else {
                    // Revoked while posting: nothing owns it any more.
                    if result.is_ok() {
                        self.withdraw_identifier(&identifier);
                    }
                    return;
                };
                let mut entries = self.0.entries.borrow_mut();
                let Some(entry) = entries.get_mut(&notification) else {
                    return;
                };
                let State::Posting(id) = entry.state else {
                    return;
                };
                let window = entry.window;
                let event = match result {
                    Ok(()) => {
                        entry.state = State::Live;
                        Event::NotificationPosted {
                            id,
                            window_id: window,
                            notification_id: notification,
                            // Clicking a delivered notification always
                            // reports the default action.
                            activatable: true,
                        }
                    }
                    Err(failure) => {
                        entries.remove(&notification);
                        let (code, message) = post_failure(failure);
                        Event::Error {
                            id: Some(id),
                            code,
                            message: message.into(),
                        }
                    }
                };
                drop(entries);
                self.0.events.send(event, cx);
            }
            CenterEvent::Activated { identifier } => {
                let Some(notification) = self.find(&identifier) else {
                    return;
                };
                let window = match self.0.entries.borrow().get(&notification) {
                    Some(Entry {
                        window,
                        state: State::Live,
                        ..
                    }) => *window,
                    _ => return,
                };
                self.0.events.ui(
                    |sequence| Event::NotificationActivated {
                        sequence,
                        window_id: window,
                        notification_id: notification,
                    },
                    cx,
                );
            }
            CenterEvent::Dismissed { identifier } => {
                let Some(notification) = self.find(&identifier) else {
                    return;
                };
                let mut entries = self.0.entries.borrow_mut();
                if !matches!(
                    entries.get(&notification),
                    Some(Entry {
                        state: State::Live,
                        ..
                    })
                ) {
                    return;
                }
                let Some(entry) = entries.remove(&notification) else {
                    return;
                };
                drop(entries);
                self.0.events.ui(
                    |sequence| Event::NotificationDismissed {
                        sequence,
                        window_id: entry.window,
                        notification_id: notification,
                        reason: NotificationDismissal::Dismissed,
                    },
                    cx,
                );
            }
        }
    }

    fn withdraw_identifier(&self, identifier: &str) {
        if let Some(center) = &*self.0.center.borrow() {
            center.withdraw(identifier);
        }
    }

    pub(crate) fn withdraw(
        &self,
        id: RequestId,
        window: WindowId,
        notification: NotificationId,
        cx: &mut App,
    ) -> Result<(), Failure> {
        let identifier = match self.0.entries.borrow().get(&notification) {
            Some(entry) if entry.window == window => match entry.state {
                State::Posting(_) => {
                    return Err((
                        ErrorCode::InvalidState,
                        "notification is still being posted",
                    ));
                }
                State::Live => entry.identifier.clone(),
            },
            _ => {
                return Err((
                    ErrorCode::InvalidHandle,
                    "notification is not live for this window",
                ));
            }
        };
        self.0.entries.borrow_mut().remove(&notification);
        self.withdraw_identifier(&identifier);
        self.0.events.send(
            Event::NotificationWithdrawn {
                id,
                window_id: window,
                notification_id: notification,
            },
            cx,
        );
        Ok(())
    }

    /// Owner close revokes delivery now and withdraws each live notification.
    pub(crate) fn close_window(&self, window: WindowId, cx: &mut App) {
        self.revoke(
            Some(window),
            (
                ErrorCode::InvalidHandle,
                "notification owner window was closed",
            ),
            cx,
        );
    }

    fn revoke(&self, window: Option<WindowId>, (code, message): Failure, cx: &mut App) {
        let owned: Vec<NotificationId> = self
            .0
            .entries
            .borrow()
            .iter()
            .filter_map(|(id, entry)| {
                window
                    .is_none_or(|window| entry.window == window)
                    .then_some(*id)
            })
            .collect();
        for notification in owned {
            let Some(entry) = self.0.entries.borrow_mut().remove(&notification) else {
                continue;
            };
            match entry.state {
                // A post that completes later is withdrawn then.
                State::Posting(id) => self.0.events.send(
                    Event::Error {
                        id: Some(id),
                        code,
                        message: message.into(),
                    },
                    cx,
                ),
                State::Live => self.withdraw_identifier(&entry.identifier),
            }
        }
    }

    /// Revoke every notification and withdraw the live ones. The center's
    /// removal calls do not report back, so there is nothing to wait for.
    pub(crate) fn stop(&self, cx: &mut App) -> Option<Task<()>> {
        self.0.stopping.set(true);
        self.revoke(
            None,
            (
                ErrorCode::Cancelled,
                "notification post cancelled during shutdown",
            ),
            cx,
        );
        // Close the center, then release it and end the worker. Close
        // withdraws every successful post this registry has not received
        // yet; a native completion still in flight retains the OS center, so
        // the center's gate makes it add nothing, or withdraw what it added,
        // instead of reporting to the closed channel.
        if let Some(center) = self.0.center.take() {
            center.close();
        }
        if let Some(link) = self.0.reports.take() {
            link.close();
        }
        None
    }
}

/// Whether an entry is still the post `id` started.
fn still_posting(state: &State, id: RequestId) -> bool {
    matches!(state, State::Posting(posting) if *posting == id)
}

/// Unique per host process and notification, so a later host never matches
/// an earlier host's delivered notification.
fn identifier(process: u32, notification: NotificationId) -> String {
    format!("dev.bunnative.{process}.{}", notification.get())
}

fn post_failure(failure: PostFailure) -> Failure {
    match failure {
        PostFailure::Denied => (
            ErrorCode::PermissionDenied,
            "the user has not allowed notifications for this application",
        ),
        PostFailure::Failed => (
            ErrorCode::NativeFailure,
            "the user notification center refused the notification",
        ),
    }
}

/// The argument and capacity checks for a new notification, in reply order.
fn check_post(
    available: bool,
    last_notification: u64,
    notification: NotificationId,
    live: usize,
    stopping: bool,
) -> Result<(), Failure> {
    if !available {
        return Err((
            ErrorCode::ServiceUnavailable,
            "notifications on macOS require the host to run from an application bundle",
        ));
    }
    if notification.get() <= last_notification {
        return Err((
            ErrorCode::InvalidHandle,
            "notification IDs must increase across the session",
        ));
    }
    if live >= MAX_NOTIFICATIONS {
        return Err((ErrorCode::LimitExceeded, "live notification limit exceeded"));
    }
    if stopping {
        return Err((
            ErrorCode::Cancelled,
            "notification service is shutting down",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn id(value: u64) -> NotificationId {
        NotificationId::try_from(value).unwrap()
    }

    #[test]
    fn checks_bundle_then_ids_then_limit_then_shutdown() {
        assert_eq!(check_post(true, 1, id(2), 0, false), Ok(()));
        assert_eq!(
            check_post(false, 9, id(1), usize::MAX, true).unwrap_err().0,
            ErrorCode::ServiceUnavailable
        );
        assert_eq!(
            check_post(true, 5, id(5), usize::MAX, true).unwrap_err().0,
            ErrorCode::InvalidHandle
        );
        assert_eq!(
            check_post(true, 0, id(1), MAX_NOTIFICATIONS, true)
                .unwrap_err()
                .0,
            ErrorCode::LimitExceeded
        );
        assert_eq!(
            check_post(true, 0, id(1), MAX_NOTIFICATIONS - 1, true)
                .unwrap_err()
                .0,
            ErrorCode::Cancelled
        );
    }

    #[test]
    fn a_denied_prompt_is_a_permission_error() {
        assert_eq!(
            post_failure(PostFailure::Denied).0,
            ErrorCode::PermissionDenied
        );
        assert_eq!(
            post_failure(PostFailure::Failed).0,
            ErrorCode::NativeFailure
        );
    }

    #[test]
    fn only_the_same_unanswered_post_expires() {
        let request = |value: u64| RequestId::try_from(value).unwrap();
        assert!(still_posting(&State::Posting(request(3)), request(3)));
        assert!(!still_posting(&State::Posting(request(4)), request(3)));
        assert!(!still_posting(&State::Live, request(3)));
    }

    #[test]
    fn identifiers_name_the_process_and_notification() {
        assert_eq!(identifier(42, id(7)), "dev.bunnative.42.7");
        assert_ne!(identifier(42, id(7)), identifier(43, id(7)));
    }

    #[test]
    fn a_test_binary_has_no_notification_service() {
        assert!(!notifications::bundled());
    }
}
