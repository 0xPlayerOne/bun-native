# Notification-driven backend shutdown

M5 #25/#26 follow-up: reuse the existing OS process-exit watcher when the native
host waits for its one supervised Bun backend to exit.

## Runtime behavior

The watcher already waits on `waitid(..., WNOWAIT)` on Unix or the owned process
handle on Windows. Previously the shutdown thread independently checked process
state every 10 ms during its bounded graceful-exit interval. It now waits on one
retained condition-variable observation published by that same watcher. There is
no additional runtime thread, fixed-rate exit poll, timer service or process.
This removes bounded shutdown polling; it is not a claim that the former idle
runtime permanently polled or that end-user latency or power improved.

The observation is installed before the watcher starts. Completion published
before shutdown is retained; a notification cannot be lost just because no waiter
was sleeping. Only the first observation is accepted, and an error cannot be
replaced by a subsequent successful publication. Mutex poisoning fails closed.
The predicate is checked under its mutex and uses the standard library's
`wait_timeout_while`, including its spurious-wakeup handling.

The existing absolute monotonic graceful-exit deadline is unchanged. Publication
has its own monotonic timestamp: a delayed waiter cannot accept an observation
first published after that deadline. No wakeup restarts the interval. A late or
failed observation remains a failed graceful exit, invoking the existing owned
termination path rather than being called a clean shutdown.

## Identity, EOF and cleanup boundaries

An exit notification is not PID authority and does not reap the child. Unix
shutdown still performs one non-reaping ownership check immediately before its
existing process-group signal, then reaps only after that group cleanup. An
unavailable child identity cannot authorize a process-group signal. Windows keeps
the existing owned Job Object and process-handle lifetime. Native output threads
and their reservations remain owned until actual completion, independently of
the exit observation.

Pipe EOF alone is not process exit, and process exit alone is not output drain:
descendants may keep descriptors open. A real Unix fixture closes stdout while
remaining alive on an independently held input pipe. The notification remains
pending until that process actually exits; repeated non-reaping checks still
find the same owned child before final reaping. Existing native fault scenarios
separately exercise backend exit, an observed non-detached descendant, renderer
failure and GPU recovery on the declared platforms.

This is the existing single-backend ownership model, not generation replacement,
a universal descendant tracker, or a new terminal supervisor. Detached PTY groups,
restart/backoff policy, termination-denial reporting and host-crash handling retain
their remaining #25 requirements. An uninterruptible OS operation or scheduling
pause is not made interruptible by a condition variable. The historical CEF
teardown intermittency is not claimed fixed. M6 owns managed backend replacement.

## Validation

Native regressions cover publication before waiting, first-result retention,
missing/late observations, actual notification delivery, pending timeout, a
notification without a predicate, poisoned state and real pipe-EOF separation.
Tests use finite waits and ownership assertions, not a millisecond performance
threshold. Both native configurations and the current-head three-platform native
fault and ordinary acceptance suites are required before merging this change.

Implementation reference (no source copied):
https://doc.rust-lang.org/std/sync/struct.Condvar.html#method.wait_timeout_while
