//! Window-scoped, explicitly granted work. Neither the UI thread nor the tree
//! command queue waits for an external clipboard owner.

use crate::channel::EventSink;
use async_channel::{Receiver, Sender};
use bun_native_protocol::{
    ClipboardText, ErrorCode, Event, MAX_SERVICE_REQUESTS, RequestId, WindowId,
};
use gpui::{App, BackgroundExecutor, Task, Window};
use std::cell::RefCell;
use std::collections::BTreeMap;
use std::rc::Rc;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

mod auth;
mod stream;
mod wake;
mod x11;

const TRANSFER_TIMEOUT: Duration = Duration::from_secs(2);
const WORKER_POLL: Duration = Duration::from_millis(5);
const MAX_INBOUND_BYTES: usize = 262_144;
type Failure = (ErrorCode, &'static str);

pub(crate) enum Operation {
    Read,
    Write(String),
}

enum Response {
    Read(ClipboardText),
    Written,
}

struct Job {
    id: RequestId,
    operation: Operation,
    budget: Budget,
}

struct Completion {
    id: RequestId,
    result: Result<Response, Failure>,
}

#[derive(Clone)]
struct Budget {
    deadline: Instant,
    cancelled: Arc<AtomicBool>,
    stopping: Arc<AtomicBool>,
    inbound: Arc<AtomicUsize>,
}

impl Budget {
    fn check(&self) -> Result<(), Failure> {
        if self.cancelled.load(Ordering::Acquire) || self.stopping.load(Ordering::Acquire) {
            Err((
                ErrorCode::Cancelled,
                "native clipboard request was cancelled",
            ))
        } else if self.inbound.load(Ordering::Relaxed) > MAX_INBOUND_BYTES {
            Err((
                ErrorCode::LimitExceeded,
                "native clipboard transfer exceeded its inbound byte budget",
            ))
        } else if Instant::now() >= self.deadline {
            Err((
                ErrorCode::OperationTimedOut,
                "native clipboard transfer exceeded its total two-second bound",
            ))
        } else {
            Ok(())
        }
    }

    fn failure(&self) -> Failure {
        self.check().err().unwrap_or((
            ErrorCode::NativeFailure,
            "native X11 clipboard operation failed",
        ))
    }

    fn input_allowance(&self) -> usize {
        let remaining = MAX_INBOUND_BYTES.saturating_sub(self.inbound.load(Ordering::Relaxed));
        if remaining == 0 {
            self.inbound.store(MAX_INBOUND_BYTES + 1, Ordering::Relaxed);
        }
        remaining
    }
}

struct Pending {
    window: WindowId,
    cancelled: Arc<AtomicBool>,
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
    fn running(&self) -> Option<&Worker> {
        match self {
            Self::Running(worker) => Some(worker),
            _ => None,
        }
    }

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
    pending: RefCell<BTreeMap<RequestId, Pending>>,
    worker: RefCell<WorkerState>,
    stopping: Arc<AtomicBool>,
    events: EventSink,
    config: Option<x11::Config>,
}

impl Drop for Inner {
    fn drop(&mut self) {
        // Normal session termination joins explicitly off the UI thread. This
        // also revokes I/O if GPUI exits through an independent fatal path.
        self.stopping.store(true, Ordering::Release);
    }
}

#[derive(Clone)]
pub(crate) struct Clipboard(Rc<Inner>);

impl Clipboard {
    pub(crate) fn new(events: EventSink, cx: &App) -> Self {
        Self(Rc::new(Inner {
            pending: RefCell::new(BTreeMap::new()),
            worker: RefCell::new(WorkerState::NotStarted),
            stopping: Arc::new(AtomicBool::new(false)),
            events,
            config: x11::Config::from_app(cx),
        }))
    }

    pub(crate) fn available(&self) -> bool {
        self.0.config.is_some()
    }

    pub(crate) fn supports_window(window: &Window) -> bool {
        {
            use raw_window_handle::{HasWindowHandle, RawWindowHandle};
            matches!(
                HasWindowHandle::window_handle(window).map(|handle| handle.as_raw()),
                Ok(RawWindowHandle::Xcb(_) | RawWindowHandle::Xlib(_))
            )
        }
    }

    pub(crate) fn submit(
        &self,
        id: RequestId,
        window: WindowId,
        operation: Operation,
        cx: &mut App,
    ) -> Result<(), Failure> {
        if !self.available() {
            return Err((
                ErrorCode::ServiceUnavailable,
                "clipboard text is implemented only for a local Linux X11 session",
            ));
        }
        if self.0.pending.borrow().len() >= MAX_SERVICE_REQUESTS {
            return Err((
                ErrorCode::LimitExceeded,
                "native service request limit exceeded",
            ));
        }
        if self.0.stopping.load(Ordering::Acquire) {
            return Err((
                ErrorCode::Cancelled,
                "native clipboard worker is shutting down",
            ));
        }
        if self.0.worker.borrow().running().is_none() {
            self.start(cx)?;
        }
        let cancelled = Arc::new(AtomicBool::new(false));
        let job = Job {
            id,
            operation,
            budget: Budget {
                deadline: Instant::now() + TRANSFER_TIMEOUT,
                cancelled: cancelled.clone(),
                stopping: self.0.stopping.clone(),
                inbound: Arc::new(AtomicUsize::new(0)),
            },
        };
        self.0
            .worker
            .borrow()
            .running()
            .ok_or((
                ErrorCode::NativeFailure,
                "native clipboard worker is unavailable",
            ))?
            .jobs
            .try_send(job)
            .map_err(|_| {
                (
                    ErrorCode::LimitExceeded,
                    "native clipboard worker queue is full or closed",
                )
            })?;
        self.0
            .pending
            .borrow_mut()
            .insert(id, Pending { window, cancelled });
        let wake_failed = self
            .0
            .worker
            .borrow()
            .running()
            .is_some_and(|worker| worker.wake.notify().is_err());
        if wake_failed {
            self.cancel(
                None,
                ErrorCode::NativeFailure,
                "cannot notify native clipboard worker",
                cx,
            );
            self.0.stopping.store(true, Ordering::Release);
            // Retain this join even though the failure has already revoked the
            // requests. Session shutdown must await it before its final reply.
            self.0
                .worker
                .borrow_mut()
                .begin_stop(cx.background_executor());
        }
        Ok(())
    }

    fn start(&self, cx: &mut App) -> Result<(), Failure> {
        {
            let config = self.0.config.clone().ok_or((
                ErrorCode::ServiceUnavailable,
                "native clipboard backend is unavailable",
            ))?;
            let (jobs, requests) = async_channel::bounded(MAX_SERVICE_REQUESTS);
            let (results, responses) = async_channel::bounded(MAX_SERVICE_REQUESTS);
            let (wake, notification) = wake::pair().map_err(|_| {
                (
                    ErrorCode::NativeFailure,
                    "cannot create native clipboard worker notification",
                )
            })?;
            let stopping = self.0.stopping.clone();
            let thread = std::thread::Builder::new()
                .name("bun-native-clipboard".into())
                .spawn(move || worker(config, requests, results, stopping, notification))
                .map_err(|_| {
                    (
                        ErrorCode::NativeFailure,
                        "cannot start native clipboard worker",
                    )
                })?;
            self.0
                .worker
                .replace(WorkerState::Running(Worker { jobs, wake, thread }));
            let clipboard = self.clone();
            cx.spawn(async move |cx| {
                while let Ok(completion) = responses.recv().await {
                    cx.update(|cx| clipboard.complete(completion, cx));
                }
                cx.update(|cx| {
                    clipboard.cancel(
                        None,
                        ErrorCode::NativeFailure,
                        "native clipboard worker stopped",
                        cx,
                    )
                });
            })
            .detach();
            Ok(())
        }
    }

    fn complete(&self, completion: Completion, cx: &mut App) {
        let Some(pending) = self.0.pending.borrow_mut().remove(&completion.id) else {
            return;
        };
        let event = match completion.result {
            Ok(Response::Read(result)) => Event::ClipboardText {
                id: completion.id,
                window_id: pending.window,
                result,
            },
            Ok(Response::Written) => Event::ClipboardWritten {
                id: completion.id,
                window_id: pending.window,
            },
            Err((code, message)) => Event::Error {
                id: Some(completion.id),
                code,
                message: message.into(),
            },
        };
        self.0.events.send(event, cx);
    }

    pub(crate) fn cancel(
        &self,
        window: Option<WindowId>,
        code: ErrorCode,
        message: &'static str,
        cx: &mut App,
    ) {
        self.0.pending.borrow_mut().retain(|id, pending| {
            if window.is_some_and(|id| id != pending.window) {
                return true;
            }
            pending.cancelled.store(true, Ordering::Release);
            self.0.events.send(
                Event::Error {
                    id: Some(*id),
                    code,
                    message: message.into(),
                },
                cx,
            );
            false
        });
    }

    pub(crate) fn stop(&self, cx: &mut App) -> Option<Task<()>> {
        self.0.stopping.store(true, Ordering::Release);
        self.cancel(
            None,
            ErrorCode::Cancelled,
            "native clipboard request cancelled during shutdown",
            cx,
        );
        let mut worker = self.0.worker.borrow_mut();
        worker.begin_stop(cx.background_executor());
        worker.take_join()
    }
}

fn worker(
    config: x11::Config,
    jobs: Receiver<Job>,
    results: Sender<Completion>,
    stopping: Arc<AtomicBool>,
    notification: wake::Receiver,
) {
    let mut owner = None;
    let idle_cancelled = Arc::new(AtomicBool::new(false));
    let mut idle_budget = None;
    while !stopping.load(Ordering::Acquire) {
        match jobs.try_recv() {
            Ok(job) => {
                idle_budget = None;
                let result = job.budget.check().and_then(|()| match job.operation {
                    Operation::Read => {
                        x11::read(&config, &job.budget, &mut owner).map(Response::Read)
                    }
                    Operation::Write(text) => x11::write(&config, &job.budget, &mut owner, text)
                        .map(|()| Response::Written),
                });
                if !job.budget.cancelled.load(Ordering::Acquire) {
                    let mut completion = Completion { id: job.id, result };
                    loop {
                        match results.try_send(completion) {
                            Ok(()) => break,
                            Err(async_channel::TrySendError::Full(value)) => completion = value,
                            Err(async_channel::TrySendError::Closed(_)) => return,
                        }
                        if stopping.load(Ordering::Acquire) {
                            return;
                        }
                        std::thread::sleep(WORKER_POLL);
                    }
                }
            }
            Err(async_channel::TryRecvError::Closed) => break,
            Err(async_channel::TryRecvError::Empty) => {
                if owner.is_some() {
                    let budget = idle_budget.get_or_insert_with(|| Budget {
                        deadline: Instant::now() + TRANSFER_TIMEOUT,
                        cancelled: idle_cancelled.clone(),
                        stopping: stopping.clone(),
                        inbound: Arc::new(AtomicUsize::new(0)),
                    });
                    match x11::serve(&mut owner, budget) {
                        // x11rb can buffer events beyond the first bounded
                        // drain; check jobs again before draining the remainder.
                        Ok(true) => continue,
                        Ok(false) => {}
                        Err(_) => owner = None,
                    }
                }
                idle_budget = None;
                if !matches!(
                    notification.wait(owner.as_ref().map(x11::Owner::fd)),
                    Ok(true)
                ) {
                    break;
                }
            }
        }
    }
    // Dropping the connection relinquishes only this worker's selection. No
    // previous external owner is cleared or restored.
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    #[test]
    fn failed_notification_keeps_the_pending_join_for_shutdown() {
        let executor = gpui_platform::background_executor();
        let (jobs, _requests) = async_channel::bounded(1);
        let (wake, notification) = wake::pair().unwrap();
        drop(notification);
        let (release, wait) = mpsc::channel();
        let exited = Arc::new(AtomicBool::new(false));
        let worker_exited = exited.clone();
        let thread = std::thread::spawn(move || {
            // Even a failed assertion cannot leave this test worker blocked.
            let _ = wait.recv_timeout(Duration::from_secs(2));
            worker_exited.store(true, Ordering::Release);
        });
        let mut worker = WorkerState::Running(Worker { jobs, wake, thread });
        assert!(worker.running().unwrap().wake.notify().is_err());

        // The notification failure starts the join; later shutdown must obtain
        // that same pending task, rather than treating the worker as absent.
        worker.begin_stop(&executor);
        worker.begin_stop(&executor);
        let joined = worker.take_join().expect("shutdown lost the pending join");
        assert!(!joined.is_ready());
        assert!(worker.take_join().is_none());
        let (acknowledge, acknowledged) = mpsc::channel();
        let shutdown = executor.spawn(async move {
            joined.await;
            acknowledge.send(()).unwrap();
        });
        assert!(matches!(
            acknowledged.recv_timeout(Duration::from_millis(30)),
            Err(mpsc::RecvTimeoutError::Timeout)
        ));
        release.send(()).unwrap();
        acknowledged.recv_timeout(Duration::from_secs(1)).unwrap();
        assert!(exited.load(Ordering::Acquire));
        let mut shutdown = std::pin::pin!(shutdown);
        assert!(executor.scheduler_executor().scheduler().block(
            None,
            shutdown.as_mut(),
            Some(Duration::from_secs(1))
        ));
    }
}
