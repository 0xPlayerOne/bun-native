# Runtime terminal service

**Issue:** #24. **Scope:** bounded runtime-owned Bun PTYs over the existing lossless
binary stream contract. Native renderer stream authority and M6 backend replacement
are not part of this increment.

## Ownership and API boundary

`TerminalService` is a stable runtime owner. It receives a host-owned object and an
already-open `BinaryStreamWriter`, reserves terminal and callback-source capacity,
creates an opaque frozen `TerminalHandle`, and only then invokes the PTY driver. The
handle object's identity is authority inside the runtime. Its diagnostic `id`, a
copied object, a process ID, or renderer data cannot address a terminal.

Application service callbacks may request operations but do not own Bun's terminal
or subprocess object. The service retains those objects across callback lifetimes.
No renderer-supplied PID is accepted. A future native supervisor can implement the
strongly typed `TerminalDriver` boundary, but this increment does not add a nominal
hook without a concrete owner or claim process-tree cleanup.

Creation requires:

- an absolute executable and absolute working directory;
- at most 256 nonempty arguments and 64 KiB of encoded argument data;
- an explicit environment of at most 128 entries and 64 KiB, with validated names,
  bounded values and no NULs;
- integer dimensions in `[1, 1000]`; and
- bounded output capacity, queued callback count and spawn deadline.

The runtime does not invoke a shell or interpolate arguments. It inherits no
environment by default. `TERM=xterm-256color` is added when absent; Windows also
copies the current `SystemRoot` when the caller did not supply one because process
creation requires that platform variable. All other variables must be explicit.

## Capacity and data flow

One service instance owns shared global and per-owner terminal count and output-byte
reservations. Defaults are 64 terminals globally, 16 per owner, 16 MiB globally,
4 MiB per owner and 256 KiB per terminal. Admission has no waiting queue. A second
shared `StreamBudget` backs `CallbackStreamSource`; its reservation is deliberately
additional because callback snapshots can remain live while terminal cleanup is in
progress.

All terminal callback sources within one `TerminalService` instance share one
bounded owner-round-robin scheduler.
It admits at most 16 source handoffs per event-loop turn, retains 16 control
slots inside its 256-item queue, and rotates the stable terminal owner before
serving the next queued item. A held writer therefore retains its own active
bytes without blocking another terminal's queued source work. Scheduler capacity
denial fails the exact source as `OVERLOADED`; it never discards terminal bytes.

This is a per-service aggregate budget, independent of the CEF backend's packet
scheduler and other service instances. A standalone `CallbackStreamSource` creates
its own scheduler unless its caller supplies a shared one. Multiple unrelated
instances therefore do not have a single global total dispatch bound. Unit tests
exercise twelve noisy sources sharing one owner beside a quiet owner, including
continuous and microtask-separated refill, exact bytes/hashes, held writer
reservations and settled queues without idle callbacks. Native UI turn scheduling
and representative graphical/platform measurements remain incomplete under #26.

PTY callback bytes pass unchanged into `CallbackStreamSource`, which snapshots and
chunks them before the callback returns. `BinaryStreamWriter.write` supplies the
existing consumer ACK boundary. There is no alternate protocol, implicit string
decoding, replay buffer, scrollback store or reconnect loop. Windows ConPTY may
transform output before Bun invokes the callback; byte counts and hashes begin at
that callback and end at the acknowledged consumer.

Bun 1.4.4 exposes no terminal pause/resume API. If callback-source byte or chunk
capacity is exhausted, the stream reports `OVERLOADED`, cancels the writer, and
signals and closes that exact owned producer. Bytes are never silently discarded.
A peer disconnect or consumer failure uses the same exact-resource fail-stop path.

Input accepts one owned nonempty byte snapshot at a time, up to 64 KiB by default.
Admission reads intrinsic `Uint8Array` slots and requires an exact, non-shared,
non-detached `ArrayBuffer`; proxy, prototype-only and accessor-forged views cannot
substitute their declared buffer, offset or length. All bounds are checked before
the exact view is copied, and the admitted length remains independent of the copy
if a driver later transfers it. Concurrent writes reject instead of queueing. Bun
documents `Terminal.write` as accepting every supplied byte, including bytes
buffered until its drain callback; therefore a rejected write or invalid/partial
driver count is an explicit `IO_FAILED` outcome and stops the resource. The service
never resends an uncertain suffix. Cancellation or absolute-deadline expiry during
an asynchronous driver write settles the caller and stops the owned terminal; the
bounded snapshot may remain retained by a defective driver until that driver
settles.

## Independent lifecycle observations

`observe(handle)` exposes four separate promises:

| Observation      | Meaning                                                                  |
| ---------------- | ------------------------------------------------------------------------ |
| `processExited`  | Actual subprocess result, or an explicit failed observation at deadline  |
| `terminalClosed` | Actual PTY status, or an explicit failed observation at deadline         |
| `outputFinished` | All callback bytes were ACKed, or an explicit stream failure occurred    |
| `released`       | Process, PTY and callback-source ownership reservations are all released |

Process exit never ends the output stream. Only the PTY close callback calls source
EOF, after any earlier callbacks already admitted by the source. Likewise, PTY close
does not establish subprocess exit. Nonzero process exit is returned unchanged and
does not turn a successfully drained byte stream into success for the process.
Linux PTY status 1 on last-slave hangup remains an ambiguous read error; only a
fixture with independent exact-output and process-exit evidence can interpret it.

If only one lifecycle callback arrives, one event-driven deadline bounds the other
observation. The service closes the PTY only after actual child exit. If only PTY
closure arrives, the deadline requests `SIGKILL`; if only process exit arrives, the
service requests PTY close and cancels undrainable output at the deadline. A missing
callback resolves that observation with `observed: false` and
`failure: "DEADLINE_EXCEEDED"`, while the corresponding ownership reservation stays
charged. No timer invents process exit, PTY closure, output drain or release, and no
idle lifecycle poll is installed.

Bun documents that `onExit` may run before `Bun.spawn` returns. The service therefore
establishes the resource and callbacks first, records early output/exit/PTY-close
events, and attaches the returned driver afterward. Cancellation or timeout during
an asynchronous spawn leaves the hidden resource reserved; if the driver later
returns, the service stops that exact process and releases only after observations
settle. A spawn that never settles remains charged rather than opening an admission
escape. Collection is fenced until spawn attachment settles. A rejected spawn or
invalid returned driver settles its failed observations but retains capacity unless
callbacks prove actual process and PTY release. Driver methods are captured once at
attachment so later property replacement cannot change which owned operations are
invoked.

The create `signal` is a document-lifetime revocation signal, not merely a spawn
deadline signal. Aborting it after successful creation stops that exact terminal.
Its listener remains installed through spawn races and is removed exactly once when
the terminal actually retires.

`close` sends `SIGTERM`, while `cancel` and lossless-output failures send `SIGKILL`;
both cancel output explicitly. The PTY close operation runs only after actual child
exit, because real ConPTY close can synchronously wait on a live child. Repeated
close/cancel calls share one deadline and result; cancel can upgrade an active
graceful close. One graceful signal, one possible kill escalation and one post-exit
PTY-close attempt are made—there is no hidden retry loop. `dispose()` likewise
returns the same in-flight or completed aggregate observation on every call. At the
deadline the service does not fabricate exit, PTY close, drain or release. An
uncooperative writer or driver therefore remains in diagnostics and retains
admission. Throwing stop methods are recorded without leaking their error strings.
If an injected close scheduler throws, the service requests `SIGKILL` and returns
the currently observed close snapshot. It does not report deadline expiry or
pretend that process or PTY callbacks occurred; ownership remains charged until
actual release is observed.

## Disconnect and replay policy

A renderer/consumer disconnect stops the terminal. There is no retained scrollback,
automatic reconnect, hidden retry or resume cursor. Reconnecting means creating a
new terminal and stream after the old resource has actually released. User-facing
scrollback belongs to the bounded renderer terminal; durable replay would require a
separately designed cursor and storage policy.

## Qualification and retained limits

Deterministic fake-driver tests cover early callbacks, binary boundaries, global and
per-owner admission, invalid/forged/stale handles, spawn and write cancellation,
intrinsic input slots, shared/detached/forged views, transfer-detach accounting,
partial input, delayed timer execution, document-lifetime revocation, rapid resize,
peer disconnect, output overflow, throwing stops, nonzero exit, partial lifecycle
deadlines, ConPTY-safe callback ordering, coalesced cleanup and reservations retained
by uncooperative or unknown owners. A fixed repository child under pinned Bun 1.4.4
exercises a real PTY, explicit environment, Unicode input, resize, split/invalid byte
output, nonzero exit, PTY closure, acknowledged byte hashes and explicit close
through the headless xterm consumer.

The generic default `BunTerminalDriver` owns and signals only Bun's direct
`Subprocess`. It does not manage detached descendants or Windows jobs and makes no
universal descendant-ownership claim. Native renderer authorization, graphical
xterm behavior, representative latency/RSS qualification, managed backend
replacement and cross-generation terminal adoption remain separate work.

## Final review regressions

Natural process exit preserves the PTY for remaining output until its actual close
callback. Only an explicit stop or the existing finite missing-closure deadline
permits forced PTY close; immediate close could otherwise truncate trailing output.
A regression delivers bytes after process exit and verifies exact acknowledged
output. Non-byte typed arrays reject as input. Executable, working directory and
argument values are snapshotted during validation, so changed getters or a custom
iterator cannot substitute unchecked spawn data. Synchronous abort during a driver
write retains an observer for that operation's later rejection.

## Lossless pending-callback coalescing

Terminal output opts into `CallbackStreamSource.coalescePending`. Arbitrary small
PTY callbacks append to the last **unsent** block; an active writer's block is
never changed. A first partial block is submitted immediately through the same
notification-driven drain, not held for a batching timer or a minimum size.
Default generic callback sources preserve their original chunk behavior unless
explicitly opted in. Byte-stream order and consumer acknowledgments are unchanged.

All block allocation, including unused capacity and transferred active buffers,
is charged against the existing source reservation until actual writer settlement.
A final fractional block uses only the remaining reservation. Frame limits and
byte limits remain simultaneous; overflow still stops the exact owned child.
No terminal output is discarded, replayed or decoded to text in this adapter.
Diagnostics separate payload bytes, allocated bytes, allocation peak and appended
bytes. This is not a whole-process memory bound or a throughput claim.

Terminal diagnostics additionally expose scheduler queue depth, wait time, bounded
turn/yield counts, rejected work, and explicit zero coalesced/dropped scheduler
work. Pending cancellation removes queued source work; an active writer remains
charged until its acknowledgment settles.

Actual graphical integration initially hit an eight-chunk source limit during a
32-record burst because callback boundaries were treated as separate queued
frames. Pending-byte coalescing addresses that fragmentation without increasing
the fixed 32-KiB source budget, the eight-chunk limit or the renderer workload.
The original failed graphical runs and unchanged-source failing coalescing tests
are retained. Byte-exact output and explicit overload still require qualification.

## Opt-in native group owner

The desktop path uses `await backend.createTerminalService({ profile: 'non-detaching' })`.
Its native-owned configuration discovers the verified packaged owner and binds the
host lifetime before admission. Unix retained groups and Windows per-terminal Jobs
supply descendant ownership within the declared profile. The graphical fixture uses
this driver; generic direct Bun use remains explicit and separately documented.
See [native terminal ownership](terminal-owner.md) for protocol, failure accounting,
platform acceptance and unsupported guardian/detached-group boundaries.

## Opted-in service supervision

[ServiceSupervisor](service-supervisor.md) adds explicit readiness and finite
application-child restart around this service. `launch()` returns an admitted
handle, a spawn promise and lifecycle observations together, so supervisors retain
ownership even when spawning fails or times out. `create()` remains the convenience
API for callers that only need successful creation. TerminalService itself never
restarts children or replays input; M6 backend reload and native descendant
containment remain separate.
