# M5 — streams, terminals and responsiveness

## Existing portable stream foundation

The earlier #23 increment already provides independent binary framing,
OPEN/DATA/ACK/CANCEL/CLOSE/ERROR lifecycle, consumer-completion credit,
per-stream/per-view/global byte and count reservations, one pending write,
finite delivery/consumption deadlines, retained reservations for uncooperative
callbacks, incremental packet decoding, short writes, browser-safe exports and
a real MessageChannel correctness workbench. This increment reuses that protocol;
it does not replace it or claim native renderer integration. See [streams](streams.md).
M4 is now complete for its declared functional scope; its former blocked tasks
are not still outstanding prerequisites.

## Current increment: callback sources and actual pinned PTYs

`CallbackStreamSource` connects a push-only producer to the existing
`BinaryStreamWriter`. One shared `StreamBudget` and stable owner reserve source
capacity before admission. The adapter snapshots only the supplied byte view,
splits within the declared chunk size, bounds both retained bytes and queued
chunks, and waits for the writer's consumer acknowledgment. A source without
pause/resume support explicitly stops on overload instead of silently losing
terminal output or allocating an unbounded promise queue.

This source reservation is **additional** to transport/stream reservations. It
bounds adapter-owned copies, not Bun's callback backing buffer, PTY kernel buffers,
terminal allocations or whole-process RSS. A stopped caller settles promptly, but
an active uncooperative writer retains its source reservation until it settles.
`drained` means source-owned bytes were released, not that a process tree exited.
The owner must implement `stopSource` for exactly the owned resource; failure to
stop is retained diagnostically. No PID/name-based global termination is added.

The maintained `qualify:bun-pty` runs the pinned Bun 1.4.3 against a fixed child
that never launches shells or descendants. It exercises a real TTY, input, resize,
64 ordered Unicode records, terminal closure independently of child exit, and a
MessageChannel stream consumer backed by the actual xterm headless parser. A paused consumer must withhold acknowledgments
while an independent control lane responds. The raw PTY callback byte count/hash
must equal the consumed stream byte count/hash. Cancellation and source overload
are expected nonzero-exit controls, not clean-shutdown passes. Every scenario must
return all three budget pools to zero. There is no retry-to-green.

Bun 1.4.3's terminal surface is checked for absent pause/resume APIs. The selected
current policy is bounded buffering followed by explicit controlled failure, not
a claim that waiting on a callback automatically slows the PTY producer. A later
qualified source-pressure mechanism may improve this without changing lossless
semantics.

## Platform qualification

The `M5 Bun PTY and bounded stream sources` workflow runs the same qualifier on
macOS arm64, Linux x64 and Windows x64. Windows reuses the disposable standard-user
runner, not the hosted administrator. Maintained reports carry clean source
identity and preserve failed cases; raw credential files/profiles are not uploaded.

Pinned-version tests are authoritative. Current upstream documentation describes
POSIX `openpty` and Windows ConPTY; ConPTY can transform VT output, and Windows has
no POSIX termios parity. Therefore the checksum guarantee starts at **PTY callback
bytes**, not the child's original stdout encoding. Arbitrary binary terminal
parity and mouse/IME behavior are not claimed. See Bun's
[PTY documentation](https://bun.com/docs/runtime/child-process) for API context;
platform acceptance requires actual execution of the pinned runtime.

## Remaining M5 work

The native CEF view/document-authorized stream lane is now implemented alongside
RPC; see [native CEF streams](native-streams.md). This still does not close #23,
#24, #25, #26 or #27. Graphical xterm consumption, real application terminal
handles and reconnect/scrollback policy remain open. Process groups/Windows jobs,
detached descendants, readiness/restart policies and generation-safe cleanup are
#25 work. The qualifier stops only its fixed direct child; that is not a universal
supervisor. Fair native scheduling and representative interaction/tail-latency/RSS
measurements remain #26/#27. No performance improvement is inferred from these
functional tests.

The historical CEF teardown intermittency is not declared fixed. #25 owns its
supervision/diagnostic disposition and #27 retains it in load/shutdown acceptance.
M6, not this increment, implements managed backend replacement.

## Retained first-platform failures and corrections

The first hosted matrix (`40074715008`, implementation `b2d41c3`) passed the macOS
PTY job but failed Linux and Windows. Linux delivered all fixture bytes and
records, then the fixture incorrectly required PTY lifecycle status zero. The
pinned Bun source explicitly documents Linux last-slave hangup as EIO and reports
read errors as status 1. This is not the subprocess exit code. Updated receipts
retain the actual status and `cleanTerminalEof: false` rather than inventing clean
EOF. A known finite fixture may qualify complete output only after its exact
record sequence, terminal-consumption hash and zero process exit all pass. This
is **not** a general rule that turns arbitrary PTY read errors into successful
shell completion; that adapter policy remains open in #24/#25.

Windows resize caused terminal repaint sequences and the old newline/JSON parser
failed. The maintained consumer now uses `@xterm/headless` 5.5.0, pinned as a
**contributor-only dev dependency** matching the existing browser xterm version.
Actual stream credit waits for its parser callback. Bounded screen snapshots
verify framed records, proper cursor repaints and Unicode; there is no blanket
ANSI stripping, discarded byte stream or duplicate-record exemption. Byte counts
and hashes still include every raw PTY callback byte. Explicit child console-size
refresh replaces reliance on cached columns or a Windows SIGWINCH that is not
provided by ConPTY. No polling, sleep or deadline extension was added.

A local cancellation control then exposed another fixture assumption: one event
loop turn was not proof that the asynchronous terminal parser finished. Cleanup
now waits for its actual completion promise before checking reservation release.
The earlier failures remain retained and require corrected-head hosted acceptance.
See [Bun PTY provenance](../provenance/bun-pty.md) for pinned source attribution.

## Integration review corrections

PR #104's merged diagnostics, shared M4 suite and explicit evidence decoder are
retained. Review reproduced a callback-source accounting defect when a writer
transferred its supplied buffer: the detached view reported zero bytes, so the
source failed to release its admitted byte count and could falsely overload later
input. Accounting now retains the original admitted length until the write settles.
Prototype-only typed-array lookalikes and proxies also reject through the owned
protocol-failure path instead of throwing out of the callback with a live
reservation. Both regressions failed before the correction. Source, transport,
and consumer reservation lifetimes remain distinct.

The integrated macOS foundation run `40092675168` failed its existing process
reparenting fixture: the observed executable UUID and process version changed
between snapshots. The fixture's parent announced the PID immediately after
spawn, before the child interpreter had announced readiness. The test now waits
for a pipe receipt emitted by the running child before taking either identity
snapshot. A separate test-owned lifetime pipe keeps the child alive across parent
exit and releases it by EOF on cleanup, without timed sleeps or permanent polling.
Full kernel-identity equality remains required; the production observer and its
executable/substitution checks are unchanged. The original failure is retained.

## Bounded callback-source drain turns

The source adapter now yields to the Bun event loop after at most **16 chunk
handoffs** before scheduling further work. The initial drain stays notification-driven;
only pending work creates one owned `setImmediate` continuation. Idle sources do
not install a timer or recurring poll. Cancellation clears a pending continuation,
and no extra output is sent after retirement. Consumer acknowledgment, exact byte
order, byte/count reservations and unsettled-writer ownership remain unchanged.

The counter resets only when that event-loop continuation runs. An empty internal
queue is not evidence that the event loop progressed: a producer can refill it in
a later microtask. Resetting at emptiness would allow the same starvation again.
Counters expose the quantum, executed yields and whether a yield remains pending.

The regression first reproduced all 2,048 immediately acknowledged chunks draining
before an already queued control/cancellation task could run. A three-source
fixture also finished its entire output first. The corrected fixtures require
control progress within 16 handoffs per source, exact eventual byte order, effective
cancellation and released reservations. A separate delayed-microtask refill case
failed the initial candidate and passes the retained-counter correction. These are
finite deterministic scheduling assertions, not a wall-clock latency threshold.
The PTY workflow runs the source regression suite on all three declared platforms
before its actual PTY cases.

This quantum is a conservative implementation bound, not a measured optimal batch
size or production responsiveness claim. It does not preempt a synchronous consumer,
cap arbitrary producer CPU time, reserve a native control lane, or implement global
fair scheduling across CEF views. Full native scheduler/load acceptance under
#26/#27 and terminal supervision remain outstanding; the bounded native stream
authority lane is documented separately in [native CEF streams](native-streams.md).

## Native command control reservations

The next #26 increment reserves bounded request and wire-byte capacity for exact
cleanup/ack operations in the private Bun-to-CEF pipe. Local cancellation retains
its ordinary slot until native acknowledgment; CEF task permits retain native
capacity through final reference release. FIFO order is preserved, not replaced
by a scheduler that can reorder lifecycle effects. An actual native session-disposal
fixture runs behind 96 pending ordinary requests. See
[native control admission](native-control-admission.md) for limits and qualification.

This does not close #23–#27 or implement native-to-Bun event priority, a dedicated
renderer bulk lane, process-tree ownership, or graphical load acceptance.

## Native fault readiness and automatic coverage

The fault fixture now provisions the same bounded RPC service as its packaged
page requires. Previously all four cases failed before fault injection because
page readiness could never complete. Current schema-2 fault acceptance binds
clean source and unchanged artifacts, uses the complete bounded native receipts,
requires ordered teardown and expected failure classification, and verifies an
actual observed non-detached child in the backend-tree case. The automatic
three-platform native lane uses `full`, adding faults before provider setup.
See [fault qualification](cef-fault-qualification.md) for exact guarantees and
limits. This does not close #25 or claim detached PTY supervision or a causal
fix for the historical CEF watchdog.

## Native event output reservations

The reverse private pipe now charges queued and writer-owned frames against
shared byte/count bounds, with finite headroom for small native replies and
lifecycle events. A read-only monitor survives sender closure without hiding an
active blocked write. Existing FIFO order and consumer/RPC authority are unchanged.
The ordinary budget admits the complete existing 128-packet pool after hexadecimal
expansion; saturation remains explicit failure, never a dropped terminal stream.
See [native output admission](native-output-admission.md). Schema-6 native RPC
acceptance requires exercised output-budget diagnostics. Full renderer bulk-lane
integration, global scheduling and descendant supervision remain open.

## Backend exit notification handoff

Shutdown now consumes the existing OS watcher's retained exit notification instead
of running an independent 10-ms process-state poll. The same graceful deadline,
non-reaping Unix ownership check and Windows job lifetime remain in force. EOF,
process exit, output drain and group cleanup remain separate observations. See
[native process exit](native-process-exit.md) for timing, identity and remaining
supervisor boundaries. This does not close #25/#26 or implement detached terminal
ownership, restart policy or managed backend replacement.

## Native CEF stream integration

The existing native document grant now installs a separate frozen stream bridge
with independent subscription, sequences and one-packet pending state. It uses
the portable `BinaryStreamSender`/`BinaryStreamReceiver` and consumer ACK, not RPC
encoding or loopback. A 96-packet stream sublimit inside the unchanged
128-packet/3 MiB native delivery pool preserves RPC/control capacity, and retired
CEF-owned bytes remain charged until exact lane-keyed receipts.

`CefBackend.serveStreams()` supplies a stable view owner, global shared budget and
document abort signal before views exist. The maintained native prebuilt/RPC stage
checks ordered checksums, paused-consumer control progress, multiple streams,
cancellation, child borrowing denial, navigation/return revocation and final zero
stream accounting. No runtime process/thread, deadline, loopback selection or
graphical terminal service is added.
