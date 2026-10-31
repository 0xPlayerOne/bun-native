//! Window-scoped, explicitly granted work. Neither the UI thread nor the tree
//! command queue waits for an external clipboard owner.

use crate::channel::EventSink;
use async_channel::{Receiver, Sender};
use bun_native_protocol::{
    ClipboardText, ErrorCode, Event, MAX_SERVICE_REQUESTS, RequestId, WindowId,
};
use gpui::{App, Task, Window};
use std::cell::RefCell;
use std::collections::BTreeMap;
use std::rc::Rc;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

mod stream;
mod x11;

const TRANSFER_TIMEOUT: Duration = Duration::from_secs(2);
const WORKER_POLL: Duration = Duration::from_millis(5);
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
}

impl Budget {
    fn check(&self) -> Result<(), Failure> {
        if self.cancelled.load(Ordering::Acquire) || self.stopping.load(Ordering::Acquire) {
            Err((
                ErrorCode::Cancelled,
                "native clipboard request was cancelled",
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
}

struct Pending {
    window: WindowId,
    cancelled: Arc<AtomicBool>,
}

struct Worker {
    jobs: Sender<Job>,
    thread: JoinHandle<()>,
}

struct Inner {
    pending: RefCell<BTreeMap<RequestId, Pending>>,
    worker: RefCell<Option<Worker>>,
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
            worker: RefCell::new(None),
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
        if self.0.worker.borrow().is_none() {
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
            },
        };
        self.0
            .worker
            .borrow()
            .as_ref()
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
            let stopping = self.0.stopping.clone();
            let thread = std::thread::Builder::new()
                .name("bun-native-clipboard".into())
                .spawn(move || worker(config, requests, results, stopping))
                .map_err(|_| {
                    (
                        ErrorCode::NativeFailure,
                        "cannot start native clipboard worker",
                    )
                })?;
            self.0.worker.replace(Some(Worker { jobs, thread }));
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
        let worker = self.0.worker.borrow_mut().take()?;
        Some(cx.background_executor().spawn(async move {
            drop(worker.jobs);
            let _ = worker.thread.join();
        }))
    }
}

fn worker(
    config: x11::Config,
    jobs: Receiver<Job>,
    results: Sender<Completion>,
    stopping: Arc<AtomicBool>,
) {
    let mut owner = None;
    while !stopping.load(Ordering::Acquire) {
        match jobs.try_recv() {
            Ok(job) => {
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
                let budget = Budget {
                    deadline: Instant::now() + TRANSFER_TIMEOUT,
                    cancelled: Arc::new(AtomicBool::new(false)),
                    stopping: stopping.clone(),
                };
                if x11::serve(&mut owner, &budget).is_err() {
                    owner = None;
                }
                std::thread::sleep(WORKER_POLL);
            }
        }
    }
    // Dropping the connection relinquishes only this worker's selection. No
    // previous external owner is cleared or restored.
}
