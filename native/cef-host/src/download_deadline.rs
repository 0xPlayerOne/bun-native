//! One cancellable worker per admitted transfer; at most eight exist. It posts
//! immediate UI tasks, never long delayed tasks that survive into CefShutdown.
use super::*;
use std::{
    sync::Condvar,
    thread::JoinHandle,
    time::{Duration, Instant},
};

struct Clock {
    at: Instant,
    serial: u64,
    phase: u8,
    fired: bool,
    stopped: bool,
}
pub(super) struct Deadline {
    clock: Arc<(Mutex<Clock>, Condvar)>,
    worker: Option<JoinHandle<()>>,
}
impl Deadline {
    pub fn new(view: u64, id: u64, duration: Duration) -> Result<Self, String> {
        let clock = Arc::new((
            Mutex::new(Clock {
                at: Instant::now() + duration,
                serial: 0,
                phase: 0,
                fired: false,
                stopped: false,
            }),
            Condvar::new(),
        ));
        let worker_clock = clock.clone();
        let worker = std::thread::Builder::new()
            .name("bunly-download-deadline".into())
            .spawn(move || {
                let (lock, wake) = &*worker_clock;
                let mut clock = lock.lock().unwrap();
                loop {
                    if clock.stopped {
                        return;
                    }
                    if clock.fired {
                        clock = wake.wait(clock).unwrap();
                        continue;
                    }
                    let now = Instant::now();
                    if now < clock.at {
                        let remaining = clock.at - now;
                        clock = wake.wait_timeout(clock, remaining).unwrap().0;
                        continue;
                    }
                    let (serial, phase) = (clock.serial, clock.phase);
                    clock.fired = true;
                    drop(clock);
                    let mut task = DownloadDeadlineTask::new(view, id, serial, phase);
                    if post_task(ThreadId::UI, Some(&mut task)) == 0 {
                        fail("Download deadline could not reach the native owner");
                    }
                    clock = lock.lock().unwrap();
                }
            })
            .map_err(|error| error.to_string())?;
        Ok(Self {
            clock,
            worker: Some(worker),
        })
    }
    pub fn arm(&self, phase: u8, duration: Duration) {
        let (lock, wake) = &*self.clock;
        let mut clock = lock.lock().unwrap();
        clock.serial += 1;
        clock.at = Instant::now() + duration;
        clock.phase = phase;
        clock.fired = false;
        wake.notify_one();
    }
    pub fn matches(&self, serial: u64) -> bool {
        self.clock.0.lock().unwrap().serial == serial
    }
}
impl Drop for Deadline {
    fn drop(&mut self) {
        let (lock, wake) = &*self.clock;
        lock.lock().unwrap().stopped = true;
        wake.notify_one();
        if self
            .worker
            .take()
            .is_some_and(|worker| worker.join().is_err())
        {
            FAILED.store(true, Ordering::SeqCst);
        }
    }
}
wrap_task! {
    struct DownloadDeadlineTask { view: u64, id: u64, serial: u64, phase: u8 }
    impl Task { fn execute(&self) { expired(self.view, self.id, self.serial, self.phase); } }
}
