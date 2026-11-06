//! Window-owned OS-wide key registrations. The UI thread owns the registry and
//! decides delivery; a worker holds the passive X11 key grabs.
//!
//! Removing a registration from the registry stops delivery immediately, before
//! the worker releases its grab. A press already queued by the X server for a
//! released registration is therefore never published.

use crate::channel::EventSink;
use async_channel::{Receiver, Sender};
use bun_native_protocol::{
    ErrorCode, Event, MAX_GLOBAL_SHORTCUTS, RequestId, ShortcutId, ShortcutModifiers, WindowId,
};
use gpui::{App, BackgroundExecutor, Task, Window};
use std::cell::{Cell, RefCell};
use std::collections::BTreeMap;
use std::rc::Rc;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread::JoinHandle;

mod grab;

use super::x11::{self, Display, Failure, WORKER_POLL, wake};

/// Jobs are bounded by the registration limit: each registration has at most
/// one grab and one release job outstanding.
const MAX_JOBS: usize = MAX_GLOBAL_SHORTCUTS * 2;
const MAX_RESULTS: usize = MAX_JOBS + 64;

#[derive(Clone, Copy, PartialEq, Eq)]
struct Combination {
    key: grab::Key,
    modifiers: ShortcutModifiers,
}

enum Job {
    Grab {
        shortcut: ShortcutId,
        combination: Combination,
    },
    Release {
        shortcut: ShortcutId,
    },
}

enum Outcome {
    Grabbed {
        shortcut: ShortcutId,
        result: Result<(), Failure>,
    },
    Released {
        shortcut: ShortcutId,
    },
    Pressed {
        shortcut: ShortcutId,
    },
}

enum State {
    Pending(RequestId),
    Active,
}

struct Registration {
    window: WindowId,
    combination: Combination,
    state: State,
}

struct Worker {
    jobs: Sender<Job>,
    wake: wake::Sender,
    thread: JoinHandle<()>,
}

enum WorkerState {
    NotStarted,
    Running(Worker),
    Stopping(Task<()>),
    Stopped,
}

impl WorkerState {
    fn begin_stop(&mut self, executor: &BackgroundExecutor) {
        *self = match std::mem::replace(self, Self::Stopped) {
            Self::Running(worker) => Self::Stopping(executor.spawn(async move {
                drop(worker.jobs);
                drop(worker.wake);
                let _ = worker.thread.join();
            })),
            state => state,
        };
    }

    fn take_join(&mut self) -> Option<Task<()>> {
        match std::mem::replace(self, Self::Stopped) {
            Self::Stopping(task) => Some(task),
            state => {
                *self = state;
                None
            }
        }
    }
}

struct Inner {
    registrations: RefCell<BTreeMap<ShortcutId, Registration>>,
    /// Released registrations whose grab the worker has not yet dropped, with
    /// the unregistration request to acknowledge, if any.
    releasing: RefCell<BTreeMap<ShortcutId, Option<(RequestId, WindowId)>>>,
    last_shortcut: Cell<u64>,
    worker: RefCell<WorkerState>,
    stopping: Arc<AtomicBool>,
    events: EventSink,
    display: Option<Display>,
}

impl Drop for Inner {
    fn drop(&mut self) {
        self.stopping.store(true, Ordering::Release);
    }
}

#[derive(Clone)]
pub(crate) struct Shortcuts(Rc<Inner>);

impl Shortcuts {
    pub(crate) fn new(events: EventSink, cx: &App) -> Self {
        Self(Rc::new(Inner {
            registrations: RefCell::new(BTreeMap::new()),
            releasing: RefCell::new(BTreeMap::new()),
            last_shortcut: Cell::new(0),
            worker: RefCell::new(WorkerState::NotStarted),
            stopping: Arc::new(AtomicBool::new(false)),
            events,
            display: Display::from_app(cx),
        }))
    }

    pub(crate) fn available(&self) -> bool {
        self.0.display.is_some()
    }

    pub(crate) fn supports_window(window: &Window) -> bool {
        use raw_window_handle::{HasWindowHandle, RawWindowHandle};
        matches!(
            HasWindowHandle::window_handle(window).map(|handle| handle.as_raw()),
            Ok(RawWindowHandle::Xcb(_) | RawWindowHandle::Xlib(_))
        )
    }

    pub(crate) fn register(
        &self,
        request: (RequestId, WindowId, ShortcutId),
        key: &str,
        modifiers: ShortcutModifiers,
        cx: &mut App,
    ) -> Result<(), Failure> {
        let (id, window, shortcut) = request;
        let combination = check_register(
            self.available(),
            self.0.last_shortcut.get(),
            (shortcut, key, modifiers),
            self.0.registrations.borrow().len() + self.0.releasing.borrow().len(),
            self.0
                .registrations
                .borrow()
                .values()
                .map(|registration| registration.combination),
            self.0.stopping.load(Ordering::Acquire),
        )?;
        self.submit(
            Job::Grab {
                shortcut,
                combination,
            },
            cx,
        )?;
        self.0.last_shortcut.set(shortcut.get());
        self.0.registrations.borrow_mut().insert(
            shortcut,
            Registration {
                window,
                combination,
                state: State::Pending(id),
            },
        );
        Ok(())
    }

    pub(crate) fn unregister(
        &self,
        id: RequestId,
        window: WindowId,
        shortcut: ShortcutId,
        cx: &mut App,
    ) -> Result<(), Failure> {
        match self.0.registrations.borrow().get(&shortcut) {
            Some(registration) if registration.window == window => {
                if let State::Pending(_) = registration.state {
                    return Err((
                        ErrorCode::InvalidState,
                        "global shortcut registration is still pending",
                    ));
                }
            }
            _ => {
                return Err((
                    ErrorCode::InvalidHandle,
                    "global shortcut is not registered by this window",
                ));
            }
        }
        self.release(shortcut, Some((id, window)), cx);
        Ok(())
    }

    /// Owner close revokes delivery now and releases each OS grab.
    pub(crate) fn close_window(&self, window: WindowId, cx: &mut App) {
        let owned: Vec<ShortcutId> = self
            .0
            .registrations
            .borrow()
            .iter()
            .filter_map(|(id, registration)| (registration.window == window).then_some(*id))
            .collect();
        for shortcut in owned {
            self.release(shortcut, None, cx);
        }
    }

    fn release(&self, shortcut: ShortcutId, reply: Option<(RequestId, WindowId)>, cx: &mut App) {
        let Some(registration) = self.0.registrations.borrow_mut().remove(&shortcut) else {
            return;
        };
        if let State::Pending(id) = registration.state {
            self.0.events.send(
                Event::Error {
                    id: Some(id),
                    code: ErrorCode::InvalidHandle,
                    message: "global shortcut owner window was closed".into(),
                },
                cx,
            );
        }
        self.0.releasing.borrow_mut().insert(shortcut, reply);
        if let Err((code, message)) = self.submit(Job::Release { shortcut }, cx) {
            // Without a worker there is no grab left to release.
            self.released(shortcut, Some((code, message)), cx);
        }
    }

    fn submit(&self, job: Job, cx: &mut App) -> Result<(), Failure> {
        if matches!(*self.0.worker.borrow(), WorkerState::NotStarted) {
            self.start(cx)?;
        }
        let state = self.0.worker.borrow();
        let WorkerState::Running(worker) = &*state else {
            return Err((
                ErrorCode::NativeFailure,
                "global shortcut worker is unavailable",
            ));
        };
        worker.jobs.try_send(job).map_err(|_| {
            (
                ErrorCode::LimitExceeded,
                "global shortcut worker queue is full or closed",
            )
        })?;
        if worker.wake.notify().is_ok() {
            return Ok(());
        }
        drop(state);
        // A queued grab could otherwise complete unobserved. Stopping drops the
        // worker's connection, which releases every grab it holds; session
        // shutdown still awaits this join.
        self.0.stopping.store(true, Ordering::Release);
        self.0
            .worker
            .borrow_mut()
            .begin_stop(cx.background_executor());
        Err((
            ErrorCode::NativeFailure,
            "cannot notify global shortcut worker",
        ))
    }

    fn start(&self, cx: &mut App) -> Result<(), Failure> {
        let display = self.0.display.clone().ok_or((
            ErrorCode::ServiceUnavailable,
            "global shortcut backend is unavailable",
        ))?;
        let (jobs, requests) = async_channel::bounded(MAX_JOBS);
        let (results, outcomes) = async_channel::bounded(MAX_RESULTS);
        let (wake, notification) = wake::pair().map_err(|_| {
            (
                ErrorCode::NativeFailure,
                "cannot create global shortcut worker notification",
            )
        })?;
        let stopping = self.0.stopping.clone();
        let thread = std::thread::Builder::new()
            .name("bun-native-shortcuts".into())
            .spawn(move || worker(display, requests, results, stopping, notification))
            .map_err(|_| {
                (
                    ErrorCode::NativeFailure,
                    "cannot start global shortcut worker",
                )
            })?;
        self.0
            .worker
            .replace(WorkerState::Running(Worker { jobs, wake, thread }));
        let shortcuts = self.clone();
        cx.spawn(async move |cx| {
            while let Ok(outcome) = outcomes.recv().await {
                cx.update(|cx| shortcuts.complete(outcome, cx));
            }
            cx.update(|cx| shortcuts.lost(cx));
        })
        .detach();
        Ok(())
    }

    fn complete(&self, outcome: Outcome, cx: &mut App) {
        match outcome {
            Outcome::Pressed { shortcut } => {
                let window = match self.0.registrations.borrow().get(&shortcut) {
                    Some(Registration {
                        window,
                        state: State::Active,
                        ..
                    }) => *window,
                    _ => return,
                };
                self.0.events.ui(
                    |sequence| Event::GlobalShortcut {
                        sequence,
                        window_id: window,
                        shortcut_id: shortcut,
                    },
                    cx,
                );
            }
            Outcome::Grabbed { shortcut, result } => {
                let mut registrations = self.0.registrations.borrow_mut();
                let Some(registration) = registrations.get_mut(&shortcut) else {
                    // The owner closed while the grab was in flight; release
                    // has already been queued after this grab.
                    return;
                };
                let State::Pending(id) = registration.state else {
                    return;
                };
                let window = registration.window;
                let event = match result {
                    Ok(()) => {
                        registration.state = State::Active;
                        Event::GlobalShortcutRegistered {
                            id,
                            window_id: window,
                            shortcut_id: shortcut,
                        }
                    }
                    Err((code, message)) => {
                        registrations.remove(&shortcut);
                        Event::Error {
                            id: Some(id),
                            code,
                            message: message.into(),
                        }
                    }
                };
                drop(registrations);
                self.0.events.send(event, cx);
            }
            Outcome::Released { shortcut } => self.released(shortcut, None, cx),
        }
    }

    fn released(&self, shortcut: ShortcutId, failure: Option<Failure>, cx: &mut App) {
        let Some(reply) = self.0.releasing.borrow_mut().remove(&shortcut) else {
            return;
        };
        let Some((id, window)) = reply else { return };
        let event = match failure {
            None => Event::GlobalShortcutUnregistered {
                id,
                window_id: window,
                shortcut_id: shortcut,
            },
            Some((code, message)) => Event::Error {
                id: Some(id),
                code,
                message: message.into(),
            },
        };
        self.0.events.send(event, cx);
    }

    /// The worker exited: its connection, and therefore every grab, is gone.
    fn lost(&self, cx: &mut App) {
        self.0.stopping.store(true, Ordering::Release);
        let registrations = std::mem::take(&mut *self.0.registrations.borrow_mut());
        for registration in registrations.into_values() {
            if let State::Pending(id) = registration.state {
                self.0.events.send(
                    Event::Error {
                        id: Some(id),
                        code: ErrorCode::NativeFailure,
                        message: "global shortcut worker stopped".into(),
                    },
                    cx,
                );
            }
        }
        let releasing: Vec<ShortcutId> = self.0.releasing.borrow().keys().copied().collect();
        for shortcut in releasing {
            // Closing the X connection released the grab; acknowledge it.
            self.released(shortcut, None, cx);
        }
    }

    pub(crate) fn stop(&self, cx: &mut App) -> Option<Task<()>> {
        self.0.stopping.store(true, Ordering::Release);
        let registrations = std::mem::take(&mut *self.0.registrations.borrow_mut());
        for registration in registrations.into_values() {
            if let State::Pending(id) = registration.state {
                self.0.events.send(
                    Event::Error {
                        id: Some(id),
                        code: ErrorCode::Cancelled,
                        message: "global shortcut registration cancelled during shutdown".into(),
                    },
                    cx,
                );
            }
        }
        self.0.releasing.borrow_mut().clear();
        let mut worker = self.0.worker.borrow_mut();
        worker.begin_stop(cx.background_executor());
        worker.take_join()
    }
}

fn worker(
    display: Display,
    jobs: Receiver<Job>,
    results: Sender<Outcome>,
    stopping: Arc<AtomicBool>,
    notification: wake::Receiver,
) {
    let idle = Arc::new(AtomicBool::new(false));
    let mut grabs: Option<grab::Grabs> = None;
    let deliver = |outcome: Outcome| -> bool {
        let mut outcome = outcome;
        loop {
            match results.try_send(outcome) {
                Ok(()) => return true,
                // Activations are edge notifications; under UI backpressure a
                // dropped press is preferable to an unbounded queue.
                Err(async_channel::TrySendError::Full(Outcome::Pressed { .. })) => return true,
                Err(async_channel::TrySendError::Full(value)) => outcome = value,
                Err(async_channel::TrySendError::Closed(_)) => return false,
            }
            if stopping.load(Ordering::Acquire) {
                return false;
            }
            std::thread::sleep(WORKER_POLL);
        }
    };
    while !stopping.load(Ordering::Acquire) {
        match jobs.try_recv() {
            Ok(Job::Grab {
                shortcut,
                combination,
            }) => {
                let budget = x11::Budget::new(idle.clone(), stopping.clone());
                if grabs.is_none() {
                    match grab::Grabs::connect(&display, &budget) {
                        Ok(connected) => grabs = Some(connected),
                        Err(failure) => {
                            if !deliver(Outcome::Grabbed {
                                shortcut,
                                result: Err(failure),
                            }) {
                                return;
                            }
                            continue;
                        }
                    }
                }
                let connection = grabs.as_mut().expect("connected above");
                let result =
                    connection.grab(shortcut, combination.key, combination.modifiers, &budget);
                if !deliver(Outcome::Grabbed { shortcut, result }) {
                    return;
                }
            }
            Ok(Job::Release { shortcut }) => {
                if let Some(connection) = grabs.as_mut() {
                    let budget = x11::Budget::new(idle.clone(), stopping.clone());
                    if connection.release(shortcut, &budget).is_err() {
                        // A failed ungrab leaves no trustworthy grab state.
                        return;
                    }
                }
                if !deliver(Outcome::Released { shortcut }) {
                    return;
                }
            }
            Err(async_channel::TryRecvError::Closed) => break,
            Err(async_channel::TryRecvError::Empty) => {
                if let Some(connection) = grabs.as_mut() {
                    let budget = x11::Budget::new(idle.clone(), stopping.clone());
                    match connection.drain(&budget) {
                        Ok((pressed, more)) => {
                            for shortcut in pressed {
                                if !deliver(Outcome::Pressed { shortcut }) {
                                    return;
                                }
                            }
                            if more {
                                continue;
                            }
                        }
                        Err(_) => return,
                    }
                }
                if !matches!(
                    notification.wait(grabs.as_ref().map(grab::Grabs::fd)),
                    Ok(true)
                ) {
                    break;
                }
            }
        }
    }
    // Dropping the connection makes the X server release every grab it holds.
}

/// The argument and capacity checks for a new registration, in reply order.
/// `live` counts registrations plus grabs still being released.
fn check_register(
    available: bool,
    last_shortcut: u64,
    (shortcut, key, modifiers): (ShortcutId, &str, ShortcutModifiers),
    live: usize,
    mut registered: impl Iterator<Item = Combination>,
    stopping: bool,
) -> Result<Combination, Failure> {
    if !available {
        return Err((
            ErrorCode::ServiceUnavailable,
            "global shortcuts are implemented only for a local Linux X11 session",
        ));
    }
    if shortcut.get() <= last_shortcut {
        return Err((
            ErrorCode::InvalidHandle,
            "global shortcut IDs must increase across the session",
        ));
    }
    let key = grab::Key::parse(key).ok_or((
        ErrorCode::InvalidCommand,
        "global shortcut key is outside the supported set",
    ))?;
    let combination = Combination { key, modifiers };
    if live >= MAX_GLOBAL_SHORTCUTS {
        return Err((
            ErrorCode::LimitExceeded,
            "global shortcut registration limit exceeded",
        ));
    }
    if registered.any(|existing| existing == combination) {
        return Err((
            ErrorCode::Conflict,
            "this key combination is already registered by this application",
        ));
    }
    if stopping {
        return Err((
            ErrorCode::Cancelled,
            "global shortcut service is shutting down",
        ));
    }
    Ok(combination)
}

#[cfg(test)]
mod tests {
    use super::*;

    const CONTROL: ShortcutModifiers = ShortcutModifiers {
        control: true,
        alt: false,
        shift: false,
        platform: false,
    };

    fn combination(key: &str, modifiers: ShortcutModifiers) -> Combination {
        Combination {
            key: grab::Key::parse(key).unwrap(),
            modifiers,
        }
    }

    /// `request` is (shortcut ID, key, modifiers).
    fn check(
        available: bool,
        last: u64,
        request: (u64, &str, ShortcutModifiers),
        live: usize,
        registered: &[Combination],
        stopping: bool,
    ) -> Result<Combination, Failure> {
        let (shortcut, key, modifiers) = request;
        check_register(
            available,
            last,
            (ShortcutId::try_from(shortcut).unwrap(), key, modifiers),
            live,
            registered.iter().copied(),
            stopping,
        )
    }

    #[test]
    fn accepts_a_new_combination_below_the_limit() {
        let existing = [combination("a", CONTROL)];
        let result = check(true, 1, (2, "f12", CONTROL), 1, &existing, false);
        assert!(result.ok() == Some(combination("f12", CONTROL)));
        // The same key with other modifiers is a different combination.
        let alt = ShortcutModifiers {
            alt: true,
            ..CONTROL
        };
        assert!(check(true, 1, (2, "a", alt), 1, &existing, false).is_ok());
    }

    #[test]
    fn unavailable_service_is_reported_before_any_other_check() {
        let result = check(false, 9, (1, "", CONTROL), usize::MAX, &[], true);
        assert_eq!(
            result.err(),
            Some((
                ErrorCode::ServiceUnavailable,
                "global shortcuts are implemented only for a local Linux X11 session"
            ))
        );
    }

    #[test]
    fn shortcut_ids_must_strictly_increase() {
        for (last, shortcut) in [(5, 5), (5, 4), (u64::from(u32::MAX), 1)] {
            let result = check(true, last, (shortcut, "", CONTROL), usize::MAX, &[], true);
            assert_eq!(
                result.err(),
                Some((
                    ErrorCode::InvalidHandle,
                    "global shortcut IDs must increase across the session"
                )),
                "{last} -> {shortcut}"
            );
        }
        assert!(check(true, 0, (1, "a", CONTROL), 0, &[], false).is_ok());
        assert!(check(true, 5, (6, "a", CONTROL), 0, &[], false).is_ok());
    }

    #[test]
    fn keys_outside_the_closed_set_are_rejected_before_capacity() {
        for key in ["", "A", "f0", "f13", "space", "aa"] {
            assert_eq!(
                check(true, 0, (1, key, CONTROL), usize::MAX, &[], true).err(),
                Some((
                    ErrorCode::InvalidCommand,
                    "global shortcut key is outside the supported set"
                )),
                "{key}"
            );
        }
    }

    #[test]
    fn registrations_and_pending_releases_share_one_limit() {
        let last_slot = MAX_GLOBAL_SHORTCUTS - 1;
        assert!(check(true, 0, (1, "a", CONTROL), last_slot, &[], false).is_ok());
        // The limit is checked before conflicts and shutdown.
        let existing = [combination("a", CONTROL)];
        for live in [MAX_GLOBAL_SHORTCUTS, MAX_GLOBAL_SHORTCUTS + 1] {
            assert_eq!(
                check(true, 0, (1, "a", CONTROL), live, &existing, true).err(),
                Some((
                    ErrorCode::LimitExceeded,
                    "global shortcut registration limit exceeded"
                ))
            );
        }
    }

    #[test]
    fn a_registered_combination_conflicts_before_shutdown() {
        let existing = [combination("b", CONTROL), combination("a", CONTROL)];
        assert_eq!(
            check(true, 0, (1, "a", CONTROL), 2, &existing, true).err(),
            Some((
                ErrorCode::Conflict,
                "this key combination is already registered by this application"
            ))
        );
    }

    #[test]
    fn shutdown_is_reported_after_every_argument_check_passes() {
        assert_eq!(
            check(true, 0, (1, "a", CONTROL), 0, &[], true).err(),
            Some((
                ErrorCode::Cancelled,
                "global shortcut service is shutting down"
            ))
        );
    }
}
