# Explicit application service restart

**Issue:** #25. `ServiceSupervisor` wraps a supplied `TerminalService` and its actual
owned process/PTY notifications. This is opt-in application child/service restart.
It does not replace/reload the Bun backend (M6), adopt terminal generations, or
solve native parent-loss, descendant-group or Windows job containment.

## Configuration and ownership

Construct a supervisor with a shared terminal service, stable host-owned `owner`
object, fixed `launch`, and required `createOutput(context)` factory. Call `start()`
once. Launch strings are executable/argv/cwd/environment data validated by
TerminalService; no shell interpolation, PID/name scan or caller-selected signal
target is introduced. The configured launch is snapshotted and repeated only when
the application explicitly opts in. Generic interactive one-off commands are not
asserted safe to restart.

Every attempt creates a fresh frozen `ServiceGeneration` object. Its `attempt`
number is diagnostic, never authority. `write`, `resize`, `signal`, and `close`
require the current exact object. Old, copied and foreign objects reject before
addressing a driver. Explicit `signal` disables retry for that attempt; `close`,
`stop`, owner `signal` revocation (including navigation retirement), and `dispose`
permanently retire the supervisor. A new supervisor requires a new explicit
application decision; `start()` cannot reset its lifetime quota.

The output factory receives `{ generation, signal }` and must allocate a **new
bounded writer/consumer per generation**, returning `{ writer, dispose }`.
The supervisor rejects reuse of a writer object. `dispose()` must release that
consumer's resources; it is called only after actual terminal/driver/output release
and readiness callback settlement, or to clean a factory result received after
cancellation. No input buffers, bytes, application requests or non-idempotent RPC
operations are replayed. Output reaches the required writer through the existing
lossless callback source; consumer errors and overflow fail closed, never silently
discard output or authorize a restart.

A factory that throws before returning must clean up anything it privately
acquired. Returned resources must supply a valid disposal callback. Missing or
throwing disposal is unknown cleanup: the generation remains held, with
`cleanupPending: true`, and cannot restart. Required/optional configuration callbacks
are validated before listeners or output acquisition. Callbacks are trusted
application code; a synchronous callback cannot be preempted. A promise that never
settles can hold its generation indefinitely, but cannot open another launch or
reset any budget. Late rejection is observed, not an unhandled rejection.

## Readiness and observations

`snapshot` is a frozen current record, with state, opaque generation, total attempts,
readiness outcome, failure reason, exact process exit, separate PTY closure and
output outcome, `cleanupPending`, and next attempt's monotonic time. The states are
`starting`, `ready`, `stopping`, `backoff`, `failed`, and `stopped`. Failed or stopping
with pending cleanup is not a released resource.

Without a readiness callback, `ready` means **driver attached**, recorded as
`readiness: 'driver-attached'`. It does not prove a listening server, application
initialization, descendant readiness, or useful service response. Optional
`readiness(context)` must resolve exactly `true` to establish the application's
own documented predicate; this is recorded as `handshake`. False/throw records
`rejected`; expiration records `timed-out`; deliberate stop while pending records
`cancelled`; natural exit before readiness records `exited`.

`startupTimeoutMs` (default 5 seconds, integer 1–60,000 ms) is an absolute monotonic
bound spanning output creation, spawn attachment and optional handshake. It is
checked on callback completion as well as timer delivery. No sleeps or idle polls
stand in for readiness. Timeout requests the existing finite graceful close and
kill escalation. This settles the readiness decision, **not** an uncooperative
callback or process. The callback receives an abort signal and should cooperate.

`TerminalService.launch()` exposes `{ handle, started, observation }` immediately
after admission, unlike the convenience `create()` promise. Observe `started`
rejections and retain `observation.released`: a rejected/timed-out spawn can still
own a late driver, process, output, and reservations. Pre-admission validation or
capacity failures throw without a launch. The supervisor consumes this tracked
API so an unsuccessful spawn cannot hide ownership from its retry gate.

Natural zero exit is success and never restarts; nonzero or signalled exit is a
process failure. Exit code, signal, wait error and observed/failure status remain
separate from PTY status and output drain. Linux PTY last-slave status 1 remains
ambiguous; qualification checks exact output independently. Unobserved cleanup,
spawn uncertainty, output failure, explicit stop/revocation and overflow disable
replacement even if resources eventually release. Exit during an in-flight input
write can cancel output through TerminalService; this also fails closed without
replaying the uncertain input. Readiness failure/timeout can
retry only after all real reservations and callbacks settle.

## Finite restart and callback bounds

Restart defaults to `{ mode: 'never' }`. Explicit `on-failure` requires all of:

- `maxAttempts`: total lifetime launches including the first, integer 1–1024;
- `initialBackoffMs` and `maxBackoffMs`: integers 1–60,000, initial ≤ max; and
- `totalBudgetMs`: integer 1–86,400,000, measured from the one `start()` call.

After eligible failure and cleanup, delay is
`min(maxBackoffMs, initialBackoffMs * 2 ** (attempts - 1))`. Readiness success never
resets attempts or the absolute budget. A replacement must begin strictly before
the total deadline; an impossible delay or late timer produces `RESTART_DEADLINE`.
Exhaustion produces `ATTEMPTS_EXHAUSTED` while retaining the last exact exit and
readiness result. This budget bounds **restart admission**, not the lifetime of a
healthy running child. It does not manufacture termination at the budget boundary.

There is at most one active generation and one supervisor startup/backoff timer.
Stop/dispose cancels it; an epoch fence makes a previously queued callback inert.
The existing TerminalService separately owns finite spawn, input, close and missing
lifecycle timers. One shared TerminalService bounds aggregate terminal count and
output reservations across owners; those are not separate quotas for each
supervisor. Supervisor instances and application consumer allocations are not
process-wide admission bounded: the application must bound how many it creates.

Optional `onChange(snapshot)` has one observer slot, at most one in-flight call and
one coalesced latest notification; there is no history or event queue. It can read
snapshots and stop/dispose reentrantly. Notifications may coalesce intermediate
states; inspect the retained snapshot for current truth. Throw/rejection increments
a bounded-lifetime diagnostic count and cannot corrupt lifecycle state. An
uncooperative asynchronous observer blocks replacement, not process cleanup.
Disposal drops its queued delivery and callback reference; already executing work
must settle. No subscription collection grows across generations.

`stop()`/`dispose()` return immediately after requesting owned cleanup.
`settled` resolves after actual work and observer settlement; it has **no fabricated
success deadline**. For denied/unknown cleanup it can remain pending indefinitely;
inspect `snapshot` and TerminalService diagnostics for the finite timeout outcome.
Dispose does not dispose the shared TerminalService or unrelated children.

## Maintained qualification

`bun run qualify:services` runs deterministic scheduler/driver regressions and real
pinned Bun 1.4.4 PTYs. The fixed child uses explicit environment and argv, readiness
output and explicit fixture input. Three successive nonzero generations verify
fresh identities, disposal before replacement, exact output hashes from driver
callbacks through consumer acknowledgments, and clean held ownership. An
independent unrelated child remains responsive and exits naturally afterward.
An explicit-stop case retains the pinned Bun exit callback, including its
`SIGTERM` label on Windows; that is not a claim of POSIX signal delivery by Windows. There are no POSIX-only skips masquerading as Windows execution.

The existing `.github/workflows/bun-pty.yml` runs this optional qualification command
on its macOS/Linux lane and inside `hosted-windows.ps1 -Suite pty`'s actual standard
user. Local macOS execution does not establish Windows/Linux acceptance; those
platform runs remain required before merge. No workflow settings or billing flags
are changed by this increment. Native descendant ownership and full M5 acceptance
remain independent gates.

## Retained Windows qualification correction

The first integrated Windows runs failed both real-service scenarios. The restart
fixture reached readiness but never completed its cooked-console input, then the
test runner stopped it at the unchanged 20-second test deadline. The child now uses
the same raw-mode `process.stdin` callback surface already qualified by the terminal
service, accumulates bounded complete lines, and flushes its final output before
exit. Every supervised generation is deliberately sent fragmented `finish` input.
No supervisor restart/deadline or output-release criterion was relaxed.

The explicit-stop fixture also incorrectly assumed Windows would report no signal
label. The actual pinned Bun `onExit` callback reports `SIGTERM`; the assertion now
preserves that runtime observation rather than replacing it with assumed OS
semantics. Both original failed hosted runs remain retained.
