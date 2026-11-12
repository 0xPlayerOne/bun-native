//! Plain-text user notifications through `UNUserNotificationCenter`.
//!
//! The framework serves only an application bundle: for a bare executable,
//! `currentNotificationCenter` raises `NSInternalInconsistencyException` and
//! aborts the process. [`bundled`] is therefore checked before anything here
//! touches the center.
//!
//! Every post first asks for alert authorization. The first request for a
//! bundle shows the OS permission prompt and completes only when the user
//! answers; later requests complete at once with the stored answer. The
//! center reports through completion handlers and its delegate on arbitrary
//! threads, so outcomes go to a `Send` sink as [`CenterEvent`]s naming the
//! request identifier. Nothing else crosses threads.
//!
//! Those completion handlers retain the center itself, so they can still add
//! a notification after the [`Center`] is closed or dropped. A shared
//! [`PostGate`] decides each late completion: after close, an authorization
//! adds nothing and an addition that completes is withdrawn at once, and
//! close withdraws every addition already reported but not yet settled by
//! its owner. No notification can stay on screen after its owner stopped.
#![allow(unsafe_code)] // Reviewed delegate class, framework constants and NSError pointers.

use crate::{SurfaceError, main_thread};
use block2::RcBlock;
use objc2::rc::Retained;
use objc2::runtime::{Bool, NSObject, NSObjectProtocol, ProtocolObject};
use objc2::{AnyThread, DefinedClass, define_class, msg_send};
use objc2_foundation::{NSArray, NSBundle, NSError, NSSet, NSString};
use objc2_user_notifications::{
    UNAuthorizationOptions, UNMutableNotificationContent, UNNotification, UNNotificationCategory,
    UNNotificationCategoryOptions, UNNotificationDefaultActionIdentifier,
    UNNotificationDismissActionIdentifier, UNNotificationPresentationOptions,
    UNNotificationRequest, UNNotificationResponse, UNUserNotificationCenter,
    UNUserNotificationCenterDelegate,
};
use std::collections::BTreeSet;
use std::sync::{Arc, Mutex, MutexGuard};

/// The one category every notification uses: no actions, and a dismissal
/// callback (`UNNotificationCategoryOptionCustomDismissAction`).
const CATEGORY: &str = "dev.bunnative.notification";

/// Whether this process runs from an application bundle that has an
/// identifier, the only case the framework serves.
pub fn bundled() -> bool {
    let bundle = NSBundle::mainBundle();
    bundle.bundleIdentifier().is_some() && bundle.bundlePath().to_string().ends_with(".app")
}

/// Why a post did not reach the notification center.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PostFailure {
    /// The user has not allowed alerts for this application.
    Denied,
    /// The framework reported an error.
    Failed,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CenterEvent {
    /// The post with this identifier finished.
    Posted {
        identifier: String,
        result: Result<(), PostFailure>,
    },
    /// The user activated (clicked) the notification.
    Activated { identifier: String },
    /// The user dismissed the notification.
    Dismissed { identifier: String },
}

/// The action a response names, as an event for that identifier.
pub fn response_event(identifier: String, default: bool, dismiss: bool) -> Option<CenterEvent> {
    if default {
        Some(CenterEvent::Activated { identifier })
    } else if dismiss {
        Some(CenterEvent::Dismissed { identifier })
    } else {
        None
    }
}

/// The post outcome from an authorization answer.
pub fn authorization(granted: bool, failed: bool) -> Result<(), PostFailure> {
    match (granted, failed) {
        (true, _) => Ok(()),
        (false, true) => Err(PostFailure::Failed),
        (false, false) => Err(PostFailure::Denied),
    }
}

type Sink = Arc<dyn Fn(CenterEvent) + Send + Sync>;

struct DelegateIvars {
    sink: Sink,
}

define_class!(
    // SAFETY: NSObject has no subclassing requirements and this class has no Drop.
    #[unsafe(super(NSObject))]
    #[name = "BunNativeNotificationDelegate"]
    #[ivars = DelegateIvars]
    struct Delegate;

    unsafe impl NSObjectProtocol for Delegate {}

    unsafe impl UNUserNotificationCenterDelegate for Delegate {
        #[unsafe(method(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:))]
        fn did_receive(
            &self,
            _center: &UNUserNotificationCenter,
            response: &UNNotificationResponse,
            completion: &block2::DynBlock<dyn Fn()>,
        ) {
            let identifier = response.notification().request().identifier().to_string();
            let action = response.actionIdentifier();
            // SAFETY: framework-provided constant strings.
            let (default, dismiss) = unsafe {
                (
                    *action == *UNNotificationDefaultActionIdentifier,
                    *action == *UNNotificationDismissActionIdentifier,
                )
            };
            if let Some(event) = response_event(identifier, default, dismiss) {
                (self.ivars().sink)(event);
            }
            completion.call(());
        }

        // Without this the OS suppresses the banner while the application is
        // frontmost; posting is the application's decision.
        #[unsafe(method(userNotificationCenter:willPresentNotification:withCompletionHandler:))]
        fn will_present(
            &self,
            _center: &UNUserNotificationCenter,
            _notification: &UNNotification,
            completion: &block2::DynBlock<dyn Fn(UNNotificationPresentationOptions)>,
        ) {
            completion
                .call((UNNotificationPresentationOptions::Banner
                    | UNNotificationPresentationOptions::List,));
        }
    }
);

impl Delegate {
    fn new(sink: Sink) -> Retained<Self> {
        let this = Self::alloc().set_ivars(DelegateIvars { sink });
        // SAFETY: NSObject's designated initializer on a freshly allocated object.
        unsafe { msg_send![super(this), init] }
    }
}

/// What a late successful addition must do.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Addition {
    /// The center is open: report it; its owner settles it.
    Report,
    /// The center closed, or its owner cancelled this post, while it was in
    /// flight: remove it now.
    Withdraw,
}

/// Shared by a [`Center`] and every completion handler of its posts. Each
/// decision is made under one lock, so a completion either runs before close
/// or [`PostGate::cancel`] (which then withdraw what it reported) or after
/// them (and adds nothing, or withdraws itself).
#[derive(Default)]
struct PostGate(Mutex<GateState>);

#[derive(Default)]
struct GateState {
    closed: bool,
    /// Posts whose authorization or addition has not completed.
    in_flight: BTreeSet<String>,
    /// In-flight posts their owner gave up on: added nothing, or withdrawn.
    cancelled: BTreeSet<String>,
    /// Reported additions whose owner has not settled them yet.
    unsettled: BTreeSet<String>,
}

impl GateState {
    fn finish(&mut self, identifier: &str) {
        self.in_flight.remove(identifier);
        self.cancelled.remove(identifier);
    }
}

impl PostGate {
    fn state(&self) -> MutexGuard<'_, GateState> {
        // The lock guards plain data; a panic elsewhere cannot leave it torn.
        self.0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// A post was sent to the center.
    fn begin(&self, identifier: &str) {
        self.state().in_flight.insert(identifier.to_owned());
    }

    /// Whether an authorized post may still be added. A refused post is
    /// finished: no completion follows.
    fn may_add(&self, identifier: &str) -> bool {
        let mut state = self.state();
        if state.closed || state.cancelled.contains(identifier) {
            state.finish(identifier);
            return false;
        }
        true
    }

    /// A successful addition completed.
    fn added(&self, identifier: &str) -> Addition {
        let mut state = self.state();
        let cancelled = state.cancelled.contains(identifier);
        state.finish(identifier);
        if state.closed || cancelled {
            return Addition::Withdraw;
        }
        state.unsettled.insert(identifier.to_owned());
        Addition::Report
    }

    /// Authorization was refused or the addition failed: nothing was added.
    fn failed(&self, identifier: &str) {
        self.state().finish(identifier);
    }

    /// The owner gave up on a post that has not reached it (a timeout or a
    /// revoked owner). An in-flight post adds nothing or withdraws its own
    /// addition; returns whether one already reported must be removed now.
    fn cancel(&self, identifier: &str) -> bool {
        let mut state = self.state();
        if state.unsettled.remove(identifier) {
            return true;
        }
        if state.in_flight.contains(identifier) {
            state.cancelled.insert(identifier.to_owned());
        }
        false
    }

    /// The owner took responsibility for a reported addition.
    fn settle(&self, identifier: &str) {
        self.state().unsettled.remove(identifier);
    }

    /// Refuse every later addition; return the reported, unsettled ones.
    fn close(&self) -> Vec<String> {
        let mut state = self.state();
        state.closed = true;
        std::mem::take(&mut state.unsettled).into_iter().collect()
    }
}

fn remove(center: &UNUserNotificationCenter, identifiers: &[String]) {
    if identifiers.is_empty() {
        return;
    }
    let identifiers = NSArray::from_retained_slice(
        &identifiers
            .iter()
            .map(|identifier| NSString::from_str(identifier))
            .collect::<Vec<_>>(),
    );
    center.removePendingNotificationRequestsWithIdentifiers(&identifiers);
    center.removeDeliveredNotificationsWithIdentifiers(&identifiers);
}

/// This process's notification center, with its delegate installed. Closing
/// or dropping it withdraws every post its owner has not settled.
pub struct Center {
    center: Retained<UNUserNotificationCenter>,
    /// The center's delegate property is weak; this keeps it alive.
    _delegate: Retained<Delegate>,
    sink: Sink,
    gate: Arc<PostGate>,
}

impl Center {
    /// Connect to the center. Fails outside an application bundle without
    /// touching the framework.
    pub fn new(sink: impl Fn(CenterEvent) + Send + Sync + 'static) -> Result<Self, SurfaceError> {
        let _main_thread = main_thread()?;
        if !bundled() {
            return Err(SurfaceError::NotBundled);
        }
        let sink: Sink = Arc::new(sink);
        let center = UNUserNotificationCenter::currentNotificationCenter();
        let delegate = Delegate::new(sink.clone());
        center.setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
        let category =
            UNNotificationCategory::categoryWithIdentifier_actions_intentIdentifiers_options(
                &NSString::from_str(CATEGORY),
                &NSArray::new(),
                &NSArray::new(),
                UNNotificationCategoryOptions::CustomDismissAction,
            );
        center.setNotificationCategories(&NSSet::from_retained_slice(&[category]));
        Ok(Self {
            center,
            _delegate: delegate,
            sink,
            gate: Arc::default(),
        })
    }

    /// Ask for authorization, then deliver the notification now. The outcome
    /// arrives as [`CenterEvent::Posted`]; it waits for the user's answer the
    /// first time this bundle asks. A successful post stays unsettled until
    /// the owner calls [`Center::settle`]; after [`Center::close`] a late
    /// authorization adds nothing and a late addition is withdrawn.
    pub fn post(&self, identifier: &str, title: &str, body: &str) {
        let center = self.center.clone();
        let sink = self.sink.clone();
        let gate = self.gate.clone();
        gate.begin(identifier);
        let (identifier, title, body) = (identifier.to_owned(), title.to_owned(), body.to_owned());
        let authorized = RcBlock::new(move |granted: Bool, error: *mut NSError| {
            let posted = |result| {
                sink(CenterEvent::Posted {
                    identifier: identifier.clone(),
                    result,
                })
            };
            if let Err(failure) = authorization(granted.as_bool(), !error.is_null()) {
                gate.failed(&identifier);
                posted(Err(failure));
                return;
            }
            // Closed or cancelled while the prompt was open: nothing owns
            // the post, so nothing is added.
            if !gate.may_add(&identifier) {
                return;
            }
            let content = UNMutableNotificationContent::new();
            content.setTitle(&NSString::from_str(&title));
            content.setBody(&NSString::from_str(&body));
            content.setCategoryIdentifier(&NSString::from_str(CATEGORY));
            let request = UNNotificationRequest::requestWithIdentifier_content_trigger(
                &NSString::from_str(&identifier),
                &content,
                None,
            );
            let (sink, gate, identifier) = (sink.clone(), gate.clone(), identifier.clone());
            let owner = center.clone();
            let added = RcBlock::new(move |error: *mut NSError| {
                let result = if error.is_null() {
                    match gate.added(&identifier) {
                        Addition::Report => Ok(()),
                        Addition::Withdraw => {
                            remove(&owner, std::slice::from_ref(&identifier));
                            return;
                        }
                    }
                } else {
                    gate.failed(&identifier);
                    Err(PostFailure::Failed)
                };
                sink(CenterEvent::Posted {
                    identifier: identifier.clone(),
                    result,
                });
            });
            center.addNotificationRequest_withCompletionHandler(&request, Some(&added));
        });
        self.center
            .requestAuthorizationWithOptions_completionHandler(
                UNAuthorizationOptions::Alert,
                &authorized,
            );
    }

    /// The owner received a successful [`CenterEvent::Posted`] and now
    /// withdraws it itself when it must.
    pub fn settle(&self, identifier: &str) {
        self.gate.settle(identifier);
    }

    /// The owner gave up on this post before receiving its outcome (it timed
    /// out or its owner was revoked) while the center stays open. A late
    /// authorization adds nothing, a late addition is withdrawn at once, and
    /// one already reported is withdrawn now.
    pub fn cancel(&self, identifier: &str) {
        if self.gate.cancel(identifier) {
            remove(&self.center, &[identifier.to_owned()]);
        }
    }

    /// Refuse every post still in flight and withdraw the reported posts the
    /// owner has not settled. Later completions withdraw their own addition.
    pub fn close(&self) {
        remove(&self.center, &self.gate.close());
    }

    /// Remove a pending or delivered notification. No callback follows.
    pub fn withdraw(&self, identifier: &str) {
        self.gate.settle(identifier);
        remove(&self.center, &[identifier.to_owned()]);
    }
}

impl Drop for Center {
    fn drop(&mut self) {
        self.close();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_default_and_dismiss_actions_are_reported() {
        assert_eq!(
            response_event("a".into(), true, false),
            Some(CenterEvent::Activated {
                identifier: "a".into()
            })
        );
        assert_eq!(
            response_event("a".into(), false, true),
            Some(CenterEvent::Dismissed {
                identifier: "a".into()
            })
        );
        assert_eq!(response_event("a".into(), false, false), None);
    }

    #[test]
    fn authorization_answers_map_to_post_outcomes() {
        assert_eq!(authorization(true, false), Ok(()));
        assert_eq!(authorization(false, false), Err(PostFailure::Denied));
        assert_eq!(authorization(false, true), Err(PostFailure::Failed));
    }

    #[test]
    fn a_post_pending_at_close_is_never_added_or_is_withdrawn() {
        // post pending -> close -> late authorization: nothing is added.
        let gate = PostGate::default();
        gate.begin("a");
        assert!(gate.close().is_empty());
        assert!(!gate.may_add("a"));
        // post pending -> authorized -> close -> late addition succeeds: it
        // is withdrawn, not reported.
        let gate = PostGate::default();
        gate.begin("a");
        assert!(gate.may_add("a"));
        assert!(gate.close().is_empty());
        assert_eq!(gate.added("a"), Addition::Withdraw);
        assert!(gate.close().is_empty(), "a withdrawn addition is not kept");
    }

    #[test]
    fn close_withdraws_reported_posts_the_owner_has_not_settled() {
        // The addition is reported, then the owner stops before receiving
        // it: close returns it for withdrawal.
        let gate = PostGate::default();
        for identifier in ["a", "b"] {
            gate.begin(identifier);
            assert!(gate.may_add(identifier));
        }
        assert_eq!(gate.added("a"), Addition::Report);
        assert_eq!(gate.added("b"), Addition::Report);
        // The owner received and settled "b"; it withdraws it itself.
        gate.settle("b");
        assert_eq!(gate.close(), ["a".to_owned()]);
        assert_eq!(gate.added("c"), Addition::Withdraw);
    }

    fn idle(gate: &PostGate) -> bool {
        let state = gate.state();
        state.in_flight.is_empty() && state.cancelled.is_empty() && state.unsettled.is_empty()
    }

    #[test]
    fn a_post_cancelled_before_its_grant_is_never_added_while_others_post() {
        // post -> expiry (the center stays open) -> late grant: no add.
        let gate = PostGate::default();
        gate.begin("expired");
        gate.begin("live");
        assert!(!gate.cancel("expired"), "nothing was added yet");
        assert!(!gate.may_add("expired"));
        // An unrelated post on the same open center still completes.
        assert!(gate.may_add("live"));
        assert_eq!(gate.added("live"), Addition::Report);
        gate.settle("live");
        assert!(idle(&gate), "a cancelled post leaves nothing behind");
    }

    #[test]
    fn a_post_cancelled_during_its_addition_is_withdrawn_when_it_lands() {
        // expiry during add -> late success: immediate withdrawal.
        let gate = PostGate::default();
        gate.begin("a");
        assert!(gate.may_add("a"));
        assert!(!gate.cancel("a"));
        assert_eq!(gate.added("a"), Addition::Withdraw);
        assert!(idle(&gate));
        // A reported addition the owner had not received yet is removed by
        // the cancel itself.
        gate.begin("b");
        assert!(gate.may_add("b"));
        assert_eq!(gate.added("b"), Addition::Report);
        assert!(gate.cancel("b"));
        assert!(idle(&gate));
    }

    #[test]
    fn failures_and_cancels_of_finished_posts_keep_nothing() {
        let gate = PostGate::default();
        gate.begin("denied");
        gate.failed("denied");
        assert!(!gate.cancel("denied"));
        gate.begin("refused");
        assert!(gate.may_add("refused"));
        gate.failed("refused");
        assert!(!gate.cancel("refused"));
        assert!(idle(&gate));
    }

    #[test]
    fn a_test_binary_is_not_a_bundle_and_never_reaches_the_center() {
        // `cargo test` runs a bare executable: the guard must refuse before
        // the framework could abort the process.
        assert!(!bundled());
    }
}
