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
    /// The center closed while it was in flight: remove it now.
    Withdraw,
}

/// Shared by a [`Center`] and every completion handler of its posts. Each
/// decision is made under one lock, so a completion either runs before close
/// (and close withdraws what it reported) or after it (and withdraws itself).
#[derive(Default)]
struct PostGate(Mutex<GateState>);

#[derive(Default)]
struct GateState {
    closed: bool,
    /// Reported additions whose owner has not settled them yet.
    unsettled: BTreeSet<String>,
}

impl PostGate {
    fn state(&self) -> MutexGuard<'_, GateState> {
        // The lock guards plain data; a panic elsewhere cannot leave it torn.
        self.0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Whether an authorized post may still be added.
    fn may_add(&self) -> bool {
        !self.state().closed
    }

    /// A successful addition completed.
    fn added(&self, identifier: &str) -> Addition {
        let mut state = self.state();
        if state.closed {
            return Addition::Withdraw;
        }
        state.unsettled.insert(identifier.to_owned());
        Addition::Report
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
        let (identifier, title, body) = (identifier.to_owned(), title.to_owned(), body.to_owned());
        let authorized = RcBlock::new(move |granted: Bool, error: *mut NSError| {
            let posted = |result| {
                sink(CenterEvent::Posted {
                    identifier: identifier.clone(),
                    result,
                })
            };
            if let Err(failure) = authorization(granted.as_bool(), !error.is_null()) {
                posted(Err(failure));
                return;
            }
            // Closed while the prompt was open: nothing owns the post.
            if !gate.may_add() {
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
        assert!(gate.may_add());
        assert!(gate.close().is_empty());
        assert!(!gate.may_add());
        // post pending -> authorized -> close -> late addition succeeds: it
        // is withdrawn, not reported.
        let gate = PostGate::default();
        assert!(gate.may_add());
        assert!(gate.close().is_empty());
        assert_eq!(gate.added("a"), Addition::Withdraw);
        assert!(gate.close().is_empty(), "a withdrawn addition is not kept");
    }

    #[test]
    fn close_withdraws_reported_posts_the_owner_has_not_settled() {
        // The addition is reported, then the owner stops before receiving
        // it: close returns it for withdrawal.
        let gate = PostGate::default();
        assert_eq!(gate.added("a"), Addition::Report);
        assert_eq!(gate.added("b"), Addition::Report);
        // The owner received and settled "b"; it withdraws it itself.
        gate.settle("b");
        assert_eq!(gate.close(), ["a".to_owned()]);
        assert_eq!(gate.added("c"), Addition::Withdraw);
    }

    #[test]
    fn a_test_binary_is_not_a_bundle_and_never_reaches_the_center() {
        // `cargo test` runs a bare executable: the guard must refuse before
        // the framework could abort the process.
        assert!(!bundled());
    }
}
