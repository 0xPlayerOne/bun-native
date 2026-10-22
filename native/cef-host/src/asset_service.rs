//! Bounded native asset work. Workers never retain a handler pointer or expose unverified bytes.
use crate::resources::{failure, AssetPlan, AssetResponse, Assets, VerificationBuffer};
use std::{
    collections::VecDeque,
    panic::{catch_unwind, AssertUnwindSafe},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Condvar, Mutex, Weak,
    },
    thread::{self, JoinHandle, ThreadId},
};
const WORKERS: usize = 2;
const MAX_REQUESTS: usize = 64;
const MAX_RETAINED_BYTES: usize = 64 * 1024 * 1024;
#[derive(Default)]
struct Usage {
    requests: usize,
    bytes: usize,
}
struct Budget {
    usage: Mutex<Usage>,
    max_requests: usize,
    max_bytes: usize,
}
struct Lease {
    budget: Arc<Budget>,
    bytes: usize,
}
impl Lease {
    fn shrink(&mut self, bytes: usize) {
        assert!(bytes <= self.bytes);
        self.budget.usage.lock().unwrap().bytes -= self.bytes - bytes;
        self.bytes = bytes;
    }
}
impl Drop for Lease {
    fn drop(&mut self) {
        let mut usage = self.budget.usage.lock().unwrap();
        usage.requests -= 1;
        usage.bytes -= self.bytes;
    }
}
impl Budget {
    fn reserve(self: &Arc<Self>, bytes: usize) -> Option<Lease> {
        let mut usage = self.usage.lock().unwrap();
        if usage.requests >= self.max_requests || bytes > self.max_bytes.saturating_sub(usage.bytes)
        {
            return None;
        }
        usage.requests += 1;
        usage.bytes += bytes;
        Some(Lease {
            budget: self.clone(),
            bytes,
        })
    }
}
struct JobToken;
type Work = Box<dyn FnOnce(&mut VerificationBuffer) + Send>;
struct Job {
    token: Arc<JobToken>,
    work: Work,
}
#[derive(Default)]
struct Queue {
    jobs: VecDeque<Job>,
    stopped: bool,
}
struct WorkQueue {
    queue: Mutex<Queue>,
    ready: Condvar,
}
struct Queued {
    token: Arc<JobToken>,
    queue: Weak<WorkQueue>,
}
impl Queued {
    fn cancel(self) {
        let Some(shared) = self.queue.upgrade() else {
            return;
        };
        let removed = {
            let mut queue = shared.queue.lock().unwrap();
            queue
                .jobs
                .iter()
                .position(|job| Arc::ptr_eq(&job.token, &self.token))
                .and_then(|index| queue.jobs.remove(index))
        };
        // Drop the queued plan, callback and reservation outside the queue lock.
        // A running job owns its reservation until its real buffer is discarded.
        drop(removed);
    }
}
struct Pool {
    shared: Arc<WorkQueue>,
    workers: Mutex<Vec<JoinHandle<()>>>,
    shutdown_lock: Mutex<()>,
    budget: Arc<Budget>,
}
impl Pool {
    fn new(workers: usize, requests: usize, bytes: usize) -> std::io::Result<Self> {
        let pool = Self {
            shared: Arc::new(WorkQueue {
                queue: Mutex::new(Queue::default()),
                ready: Condvar::new(),
            }),
            workers: Mutex::new(Vec::new()),
            shutdown_lock: Mutex::new(()),
            budget: Arc::new(Budget {
                usage: Mutex::new(Usage::default()),
                max_requests: requests,
                max_bytes: bytes,
            }),
        };
        for number in 0..workers {
            let shared = pool.shared.clone();
            match thread::Builder::new()
                .name(format!("bunly-assets-{number}"))
                .spawn(move || {
                    // One reusable scratch buffer per worker, independent of asset/request sizes.
                    let mut buffer = [0; crate::resources::VERIFY_BUFFER_BYTES];
                    loop {
                        let job = {
                            let mut queue = shared.queue.lock().unwrap();
                            while queue.jobs.is_empty() && !queue.stopped {
                                queue = shared.ready.wait(queue).unwrap();
                            }
                            if queue.stopped {
                                return;
                            }
                            queue.jobs.pop_front().unwrap()
                        };
                        let _ = catch_unwind(AssertUnwindSafe(|| (job.work)(&mut buffer)));
                    }
                }) {
                Ok(worker) => pool.workers.lock().unwrap().push(worker),
                Err(error) => {
                    pool.shutdown();
                    return Err(error);
                }
            }
        }
        Ok(pool)
    }
    fn submit(
        &self,
        bytes: usize,
        task: impl FnOnce(Lease, &mut VerificationBuffer) + Send + 'static,
    ) -> Option<Queued> {
        let mut queue = self.shared.queue.lock().unwrap();
        if queue.stopped {
            return None;
        }
        let lease = self.budget.reserve(bytes)?;
        let token = Arc::new(JobToken);
        queue.jobs.push_back(Job {
            token: token.clone(),
            work: Box::new(move |buffer| task(lease, buffer)),
        });
        self.shared.ready.notify_one();
        Some(Queued {
            token,
            queue: Arc::downgrade(&self.shared),
        })
    }
    fn shutdown(&self) {
        // Concurrent callers must wait for worker joins, not just the stop flag.
        let _shutdown = self.shutdown_lock.lock().unwrap();
        let jobs = {
            let mut queue = self.shared.queue.lock().unwrap();
            queue.stopped = true;
            std::mem::take(&mut queue.jobs)
        };
        drop(jobs);
        self.shared.ready.notify_all();
        for worker in std::mem::take(&mut *self.workers.lock().unwrap()) {
            let _ = worker.join();
        }
    }
    #[cfg(test)]
    fn submit_test(
        &self,
        bytes: usize,
        task: impl FnOnce(Lease, &mut VerificationBuffer) + Send + 'static,
    ) -> bool {
        self.submit(bytes, task).is_some()
    }
}
impl Drop for Pool {
    fn drop(&mut self) {
        self.shutdown();
    }
}
pub(crate) struct ResponseMetadata {
    pub status: i32,
    pub mime: String,
    pub headers: Vec<(String, String)>,
    pub length: usize,
}
struct Reply {
    response: AssetResponse,
    lease: Option<Lease>,
}
/// A posted CEF task remains allocated even when its request has been cancelled.
/// Keep this independent permit until that task (including wrapper clones) dies.
#[derive(Clone)]
pub(crate) struct Continuation {
    _lease: Arc<Lease>,
}
struct State {
    plan: Option<AssetPlan>,
    queued: Option<Queued>,
    reply: Option<Reply>,
    cursor: usize,
    started: bool,
    continued: bool,
    callback_thread: Option<ThreadId>,
}
/// The worker and posted continuation retain only detached, reference-counted state.
pub(crate) struct Request {
    cancelled: AtomicBool,
    active: AtomicBool,
    state: Mutex<State>,
    callback_finished: Condvar,
}
pub(crate) enum Open {
    Pending,
    Ready,
    Cancelled,
}
struct Continuing<'a>(&'a Request);
impl Drop for Continuing<'_> {
    fn drop(&mut self) {
        let mut state = self.0.state.lock().unwrap();
        state.callback_thread = None;
        if self.0.cancelled.load(Ordering::Acquire)
            || state
                .reply
                .as_ref()
                .is_none_or(|reply| reply.lease.is_none())
        {
            self.0.active.store(false, Ordering::Release);
        }
        drop(state);
        self.0.callback_finished.notify_all();
    }
}
impl Request {
    pub(crate) fn new(plan: AssetPlan) -> Arc<Self> {
        Arc::new(Self {
            cancelled: AtomicBool::new(false),
            active: AtomicBool::new(false),
            state: Mutex::new(State {
                plan: Some(plan),
                queued: None,
                reply: None,
                cursor: 0,
                started: false,
                continued: false,
                callback_thread: None,
            }),
            callback_finished: Condvar::new(),
        })
    }
    pub(crate) fn cancel(&self) {
        self.cancelled.store(true, Ordering::Release);
        let (queued, reply) = {
            let mut state = self.state.lock().unwrap();
            state.plan = None;
            (state.queued.take(), state.reply.take())
        };
        if let Some(queued) = queued {
            queued.cancel();
        }
        drop(reply);
        let mut state = self.state.lock().unwrap();
        // Native cancel/drop normally runs on IO; permit synchronous CEF reentry
        // from cont() on that same thread. Main-thread shutdown waits for any
        // claimed continuation to finish before CEF can be torn down.
        while state
            .callback_thread
            .is_some_and(|owner| owner != thread::current().id())
        {
            state = self.callback_finished.wait(state).unwrap();
        }
        if state.callback_thread.is_none() {
            self.active.store(false, Ordering::Release);
        }
    }
    pub(crate) fn continue_if_live(&self, continuation: impl FnOnce()) -> bool {
        {
            let mut state = self.state.lock().unwrap();
            if self.cancelled.load(Ordering::Acquire) || state.continued || state.reply.is_none() {
                return false;
            }
            state.continued = true;
            state.callback_thread = Some(thread::current().id());
        }
        let _claim = Continuing(self);
        // No state/queue/budget lock is held while calling into CEF.
        continuation();
        true
    }
    pub(crate) fn start(
        self: &Arc<Self>,
        service: &Service,
        ready: impl FnOnce(Continuation) + Send + 'static,
    ) -> Open {
        let mut state = self.state.lock().unwrap();
        if state.started || self.cancelled.load(Ordering::Acquire) {
            return Open::Cancelled;
        }
        state.started = true;
        let plan = state.plan.take().unwrap();
        let bytes = plan.retained_bytes();
        let mut requests = service.requests.lock().unwrap();
        if service.stopped.load(Ordering::Acquire) {
            self.cancelled.store(true, Ordering::Release);
            return Open::Cancelled;
        }
        requests.retain(|item| {
            item.upgrade()
                .is_some_and(|request| request.active.load(Ordering::Acquire))
        });
        if requests.len() >= MAX_REQUESTS {
            return Self::overloaded(&mut state);
        }
        let Some(permit) = service.continuations.reserve(0) else {
            return Self::overloaded(&mut state);
        };
        let continuation = Continuation {
            _lease: Arc::new(permit),
        };
        let request = self.clone();
        self.active.store(true, Ordering::Release);
        let queued = service.pool.submit(bytes, move |mut lease, buffer| {
            let response = catch_unwind(AssertUnwindSafe(|| {
                plan.execute_with_buffer(&request.cancelled, buffer)
            }))
            .unwrap_or_else(|_| failure(500));
            // Errors need not hold their original byte reservation.
            lease.shrink(response.body.len());
            {
                let mut state = request.state.lock().unwrap();
                state.queued = None;
                if request.cancelled.load(Ordering::Acquire) {
                    return;
                }
                state.reply = Some(Reply {
                    response,
                    lease: Some(lease),
                });
            }
            // Posting may race cancellation; the IO task must claim continue_if_live.
            if !request.cancelled.load(Ordering::Acquire) {
                ready(continuation);
            }
        });
        if let Some(queued) = queued {
            state.queued = Some(queued);
            requests.push(Arc::downgrade(self));
            Open::Pending
        } else {
            self.active.store(false, Ordering::Release);
            Self::overloaded(&mut state)
        }
    }
    fn overloaded(state: &mut State) -> Open {
        state.reply = Some(Reply {
            response: failure(503),
            lease: None,
        });
        Open::Ready
    }
    pub(crate) fn headers(&self) -> Option<ResponseMetadata> {
        let mut state = self.state.lock().unwrap();
        if self.cancelled.load(Ordering::Acquire) {
            return None;
        }
        let reply = state.reply.as_mut()?;
        let metadata = ResponseMetadata {
            status: reply.response.status,
            mime: reply.response.mime.clone(),
            headers: reply.response.headers.clone(),
            length: reply.response.body.len(),
        };
        if reply.response.body.is_empty() {
            // HEAD/304/failures may never receive a read() call.
            reply.lease = None;
            if state.continued && state.callback_thread.is_none() {
                self.active.store(false, Ordering::Release);
            }
        }
        Some(metadata)
    }
    pub(crate) fn read(&self, output: &mut [u8]) -> usize {
        let mut state = self.state.lock().unwrap();
        if self.cancelled.load(Ordering::Acquire) || output.is_empty() {
            return 0;
        }
        let Some(reply) = &state.reply else {
            return 0;
        };
        let start = state.cursor;
        let count = output
            .len()
            .min(reply.response.body.len().saturating_sub(start));
        output[..count].copy_from_slice(&reply.response.body[start..start + count]);
        let done = start + count == reply.response.body.len();
        state.cursor += count;
        if done {
            state.reply = None;
            if state.continued && state.callback_thread.is_none() {
                self.active.store(false, Ordering::Release);
            }
        }
        count
    }
}
pub(crate) struct Service {
    pub assets: Assets,
    pool: Pool,
    stopped: AtomicBool,
    requests: Mutex<Vec<Weak<Request>>>,
    shutdown_lock: Mutex<()>,
    continuations: Arc<Budget>,
}
impl Service {
    pub(crate) fn new(assets: Assets) -> std::io::Result<Self> {
        Ok(Self {
            assets,
            pool: Pool::new(WORKERS, MAX_REQUESTS, MAX_RETAINED_BYTES)?,
            stopped: AtomicBool::new(false),
            requests: Mutex::new(Vec::new()),
            shutdown_lock: Mutex::new(()),
            continuations: Arc::new(Budget {
                usage: Mutex::new(Usage::default()),
                max_requests: MAX_REQUESTS,
                max_bytes: 0,
            }),
        })
    }
    pub(crate) fn shutdown(&self) {
        let _shutdown = self.shutdown_lock.lock().unwrap();
        self.stopped.store(true, Ordering::Release);
        let requests = std::mem::take(&mut *self.requests.lock().unwrap());
        for request in requests.into_iter().filter_map(|request| request.upgrade()) {
            request.cancel();
        }
        self.pool.shutdown();
    }
}
impl Drop for Service {
    fn drop(&mut self) {
        self.shutdown();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::Duration;

    #[test]
    fn reservations_follow_retained_bytes_not_worker_completion() {
        let pool = Pool::new(1, 2, 100).unwrap();
        let (tx, rx) = mpsc::channel();
        assert!(pool.submit_test(80, move |lease, _| tx.send(lease).unwrap()));
        let lease = rx.recv_timeout(Duration::from_secs(3)).unwrap();
        assert!(!pool.submit_test(21, |_, _| {}));
        assert_eq!(pool.budget.usage.lock().unwrap().bytes, 80);
        drop(lease);
        assert!(pool.submit_test(100, |_, _| {}));
        pool.shutdown();
        assert_eq!(pool.budget.usage.lock().unwrap().bytes, 0);
        assert_eq!(pool.budget.usage.lock().unwrap().requests, 0);
    }

    #[test]
    fn queued_work_is_bounded_and_discarded_on_shutdown() {
        let pool = Arc::new(Pool::new(1, 2, 100).unwrap());
        let (started, began) = mpsc::channel();
        let (release, wait) = mpsc::channel();
        assert!(pool.submit_test(40, move |_, _| {
            started.send(()).unwrap();
            wait.recv().unwrap();
        }));
        began.recv_timeout(Duration::from_secs(3)).unwrap();
        assert!(pool.submit_test(40, |_, _| panic!("queued work must never execute")));
        assert!(!pool.submit_test(1, |_, _| {}));
        let other = pool.clone();
        let close = thread::spawn(move || other.shutdown());
        // Synchronize on stopped state, not a sleep-based expectation.
        while !pool.shared.queue.lock().unwrap().stopped {
            thread::yield_now();
        }
        assert!(!pool.submit_test(1, |_, _| {}));
        release.send(()).unwrap();
        close.join().unwrap();
        assert_eq!(pool.budget.usage.lock().unwrap().bytes, 0);
    }

    #[test]
    fn byte_and_request_limits_are_independent() {
        let budget = Arc::new(Budget {
            usage: Mutex::new(Usage::default()),
            max_requests: 2,
            max_bytes: 10,
        });
        let one = budget.reserve(0).unwrap();
        let two = budget.reserve(0).unwrap();
        assert!(budget.reserve(0).is_none());
        drop(one);
        drop(two);
        assert!(budget.reserve(11).is_none());
        assert!(budget.reserve(10).is_some());
    }
    fn fixture_directory() -> std::path::PathBuf {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let namespace = format!(
            "bunly-asset-service-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        );
        for _ in 0..64 {
            let root = std::env::temp_dir().join(format!(
                "{namespace}-{}",
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            match std::fs::create_dir(&root) {
                Ok(()) => return root,
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => panic!("cannot create asset-service fixture: {error}"),
            }
        }
        panic!("asset-service fixture directory collision limit exceeded");
    }
    fn fixture() -> (Service, std::path::PathBuf) {
        use sha2::{Digest, Sha256};
        let root = fixture_directory();
        std::fs::write(root.join("index.html"), b"abc").unwrap();
        std::fs::write(root.join("assets.json"), serde_json::json!({"index.html": {"bytes":3,"sha256":format!("{:x}",Sha256::digest(b"abc"))}}).to_string()).unwrap();
        (Service::new(Assets::load(&root).unwrap()).unwrap(), root)
    }
    #[test]
    fn completion_delivers_verified_bytes_and_releases_reservation_on_eof() {
        let (service, root) = fixture();
        let request = Request::new(service.assets.plan("app://ui/", "GET", "", "", ""));
        let (tx, rx) = mpsc::channel();
        assert!(matches!(
            request.start(&service, move |_| tx.send(()).unwrap()),
            Open::Pending
        ));
        rx.recv_timeout(Duration::from_secs(3)).unwrap();
        assert_eq!(request.headers().unwrap().status, 200);
        assert_eq!(service.pool.budget.usage.lock().unwrap().bytes, 3);
        let mut output = [0; 2];
        assert_eq!(request.read(&mut output), 2);
        assert_eq!(output, *b"ab");
        assert_eq!(request.read(&mut output), 1);
        assert_eq!(output[0], b'c');
        assert_eq!(request.read(&mut output), 0);
        assert_eq!(service.pool.budget.usage.lock().unwrap().bytes, 0);
        request.cancel();
        request.cancel();
        service.shutdown();
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn cancellation_of_queued_work_never_invokes_completion() {
        let (service, root) = fixture();
        let mut releases = Vec::new();
        for _ in 0..WORKERS {
            let (tx, rx) = mpsc::channel();
            let (release, wait) = mpsc::channel();
            assert!(service.pool.submit_test(0, move |_, _| {
                tx.send(()).unwrap();
                wait.recv().unwrap();
            }));
            rx.recv_timeout(Duration::from_secs(3)).unwrap();
            releases.push(release);
        }
        let request = Request::new(service.assets.plan("app://ui/", "GET", "", "", ""));
        let (tx, rx) = mpsc::channel();
        assert!(matches!(
            request.start(&service, move |_| {
                let _ = tx.send(());
            }),
            Open::Pending
        ));
        request.cancel();
        // Cancellation must release a queued reservation while every worker is
        // still blocked. Waiting for the job to reach a worker is insufficient.
        assert_eq!(service.pool.budget.usage.lock().unwrap().bytes, 0);
        assert_eq!(service.pool.budget.usage.lock().unwrap().requests, WORKERS);
        assert!(service.pool.shared.queue.lock().unwrap().jobs.is_empty());
        for release in releases {
            release.send(()).unwrap();
        }
        service.shutdown();
        assert!(rx.recv_timeout(Duration::from_millis(50)).is_err());
        assert!(request.headers().is_none());
        assert_eq!(service.pool.budget.usage.lock().unwrap().bytes, 0);
        assert!(matches!(request.start(&service, |_| {}), Open::Cancelled));
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn admission_rejects_new_work_after_shutdown_without_callbacks() {
        let (service, root) = fixture();
        let request = Request::new(service.assets.plan("app://ui/", "GET", "", "", ""));
        service.shutdown();
        assert!(matches!(
            request.start(&service, |_| panic!("closed callback")),
            Open::Cancelled
        ));
        assert!(request.headers().is_none());
        std::fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn planning_does_not_open_or_stat_files_and_execution_revalidates() {
        let (service, root) = fixture();
        std::fs::remove_file(root.join("index.html")).unwrap();
        let plan = service.assets.plan("app://ui/", "GET", "", "", "");
        assert_eq!(plan.retained_bytes(), 3);
        assert_eq!(plan.execute(&AtomicBool::new(false)).status, 403);
        service.shutdown();
        std::fs::remove_dir_all(root).unwrap();
    }

    fn completed(service: &Service, method: &str) -> Arc<Request> {
        let request = Request::new(service.assets.plan("app://ui/", method, "", "", ""));
        let (tx, rx) = mpsc::channel();
        assert!(matches!(
            request.start(service, move |_| tx.send(()).unwrap()),
            Open::Pending
        ));
        rx.recv_timeout(Duration::from_secs(3)).unwrap();
        request
    }

    #[test]
    fn completed_bodyless_requests_do_not_accumulate_reservations_or_registry_entries() {
        let (service, root) = fixture();
        let mut retained_handlers = Vec::new();
        for _ in 0..MAX_REQUESTS * 3 {
            let request = completed(&service, "HEAD");
            assert!(request.continue_if_live(|| {}));
            let metadata = request.headers().unwrap();
            assert_eq!(metadata.status, 200);
            assert_eq!(metadata.length, 0);
            assert_eq!(service.pool.budget.usage.lock().unwrap().requests, 0);
            assert_eq!(service.pool.budget.usage.lock().unwrap().bytes, 0);
            assert!(service.requests.lock().unwrap().len() <= 1);
            retained_handlers.push(request);
        }
        service.shutdown();
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn cancelled_completion_cannot_continue_or_retain_verified_body() {
        let (service, root) = fixture();
        let request = completed(&service, "GET");
        assert_eq!(service.pool.budget.usage.lock().unwrap().bytes, 3);
        request.cancel();
        assert!(!request.continue_if_live(|| panic!("disposed continuation")));
        assert!(request.headers().is_none());
        assert_eq!(service.pool.budget.usage.lock().unwrap().bytes, 0);
        assert_eq!(service.pool.budget.usage.lock().unwrap().requests, 0);
        service.shutdown();
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn continuation_allows_same_thread_reentrant_cancel_without_holding_state_lock() {
        let (service, root) = fixture();
        let request = completed(&service, "GET");
        assert!(request.continue_if_live(|| {
            assert_eq!(request.headers().unwrap().status, 200);
            request.cancel();
            assert!(request.headers().is_none());
        }));
        assert!(!request.continue_if_live(|| panic!("duplicate continuation")));
        assert!(!request.active.load(Ordering::Acquire));
        assert_eq!(service.pool.budget.usage.lock().unwrap().bytes, 0);
        service.shutdown();
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn shutdown_fences_a_claimed_continuation_before_returning() {
        let (service, root) = fixture();
        let request = completed(&service, "GET");
        let (started, began) = mpsc::channel();
        let (release, wait) = mpsc::channel();
        let finished = Arc::new(AtomicBool::new(false));
        let on_io = request.clone();
        let completed = finished.clone();
        let callback = thread::spawn(move || {
            assert!(on_io.continue_if_live(|| {
                started.send(()).unwrap();
                wait.recv_timeout(Duration::from_secs(3)).unwrap();
                completed.store(true, Ordering::Release);
            }));
        });
        began.recv_timeout(Duration::from_secs(3)).unwrap();
        let observed = request.clone();
        let releaser = thread::spawn(move || {
            let deadline = std::time::Instant::now() + Duration::from_secs(3);
            while !observed.cancelled.load(Ordering::Acquire) {
                assert!(std::time::Instant::now() < deadline);
                thread::yield_now();
            }
            release.send(()).unwrap();
        });
        service.shutdown();
        assert!(finished.load(Ordering::Acquire));
        releaser.join().unwrap();
        callback.join().unwrap();
        assert_eq!(service.pool.budget.usage.lock().unwrap().requests, 0);
        assert!(!request.continue_if_live(|| panic!("late callback")));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_bodyless_reply_stays_registered_while_its_continuation_is_executing() {
        let (service, root) = fixture();
        let request = completed(&service, "HEAD");
        assert!(request.continue_if_live(|| {
            assert_eq!(request.headers().unwrap().length, 0);
            assert_eq!(service.pool.budget.usage.lock().unwrap().requests, 0);
            assert!(request.active.load(Ordering::Acquire));
        }));
        assert!(!request.active.load(Ordering::Acquire));
        service.shutdown();
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn worker_scratch_is_fixed_and_reused_across_tasks() {
        let pool = Pool::new(1, 2, 100).unwrap();
        let (tx, rx) = mpsc::channel();
        assert!(pool.submit_test(0, move |_, buffer| {
            buffer[0] = 42;
            tx.send(buffer.as_ptr() as usize).unwrap();
        }));
        let first = rx.recv_timeout(Duration::from_secs(3)).unwrap();
        let (tx, rx) = mpsc::channel();
        assert!(pool.submit_test(0, move |_, buffer| {
            assert_eq!(buffer.len(), 64 * 1024);
            assert_eq!(buffer[0], 42);
            tx.send(buffer.as_ptr() as usize).unwrap();
        }));
        assert_eq!(rx.recv_timeout(Duration::from_secs(3)).unwrap(), first);
        pool.shutdown();
    }

    #[test]
    fn cancelled_posted_continuations_remain_bounded_until_their_actual_disposal() {
        let (service, root) = fixture();
        let mut posted = Vec::new();
        for _ in 0..MAX_REQUESTS {
            let request = Request::new(service.assets.plan("app://ui/", "GET", "", "", ""));
            let (tx, rx) = mpsc::channel();
            assert!(matches!(
                request.start(&service, move |permit| tx.send(permit).unwrap()),
                Open::Pending
            ));
            posted.push(rx.recv_timeout(Duration::from_secs(3)).unwrap());
            request.cancel();
            // The body is already gone, but the simulated stalled CEF task still exists.
            assert_eq!(service.pool.budget.usage.lock().unwrap().bytes, 0);
            assert_eq!(service.pool.budget.usage.lock().unwrap().requests, 0);
        }
        assert_eq!(
            service.continuations.usage.lock().unwrap().requests,
            MAX_REQUESTS
        );
        let rejected = Request::new(service.assets.plan("app://ui/", "GET", "", "", ""));
        assert!(matches!(
            rejected.start(&service, |_| panic!("unbounded continuation")),
            Open::Ready
        ));
        assert_eq!(rejected.headers().unwrap().status, 503);
        // Wrapper clones also retain the same permit until the last real owner is dropped.
        let retained = posted[0].clone();
        posted.clear();
        assert_eq!(service.continuations.usage.lock().unwrap().requests, 1);
        drop(retained);
        assert_eq!(service.continuations.usage.lock().unwrap().requests, 0);
        let request = completed(&service, "GET");
        request.cancel();
        service.shutdown();
        assert_eq!(service.continuations.usage.lock().unwrap().requests, 0);
        std::fs::remove_dir_all(root).unwrap();
    }
}
