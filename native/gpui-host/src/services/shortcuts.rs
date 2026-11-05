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
        if !self.available() {
            return Err((
                ErrorCode::ServiceUnavailable,
                "global shortcuts are implemented only for a local Linux X11 session",
            ));
        }
        if shortcut.get() <= self.0.last_shortcut.get() {
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
        if self.0.registrations.borrow().len() + self.0.releasing.borrow().len()
            >= MAX_GLOBAL_SHORTCUTS
        {
            return Err((
                ErrorCode::LimitExceeded,
                "global shortcut registration limit exceeded",
            ));
        }
        if self
            .0
            .registrations
            .borrow()
            .values()
            .any(|registration| registration.combination == combination)
        {
            return Err((
                ErrorCode::Conflict,
                "this key combination is already registered by this application",
            ));
        }
        if self.0.stopping.load(Ordering::Acquire) {
            return Err((
                ErrorCode::Cancelled,
                "global shortcut service is shutting down",
            ));
        }
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
