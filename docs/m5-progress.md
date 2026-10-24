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
xterm allocations or whole-process RSS. A stopped caller settles promptly, but
an active uncooperative writer retains its source reservation until it settles.
`drained` means source-owned bytes were released, not that a process tree exited.
The owner must implement `stopSource` for exactly the owned resource; failure to
stop is retained diagnostically. No PID/name-based global termination is added.

The maintained `qualify:bun-pty` runs the pinned Bun 1.4.3 against a fixed child
that never launches shells or descendants. It exercises a real TTY, input, resize,
64 ordered Unicode records, terminal EOF independently of child exit, and a
MessageChannel stream consumer. A paused consumer must withhold acknowledgments
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

This does not close #23, #24, #25, #26 or #27. Native CEF view/document authorization
and bulk/control transport integration, xterm consumption, real application terminal
handles and reconnect/scrollback policy remain open. Process groups/Windows jobs,
detached descendants, readiness/restart policies and generation-safe cleanup are
#25 work. The qualifier stops only its fixed direct child; that is not a universal
supervisor. Fair native scheduling and representative interaction/tail-latency/RSS
measurements remain #26/#27. No performance improvement is inferred from these
functional tests.

The historical CEF teardown intermittency is not declared fixed. #25 owns its
supervision/diagnostic disposition and #27 retains it in load/shutdown acceptance.
M6, not this increment, implements managed backend replacement.
