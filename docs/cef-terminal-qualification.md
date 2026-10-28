# Graphical native terminal qualification

This increment adds the first maintained end-to-end qualifier for an actual
prepared CEF host, pinned Bun 1.4.3 PTYs, the independent native binary stream
lane, and graphical `@xterm/xterm` 5.5.0 consumption. It advances the functional
and concurrent-load portions of #24 and #27; it does not close either issue.

## Run boundary

The command accepts only an already prepared native application. It creates an
independent private copy, bundles the fixed backend, child, browser client and
public assets, writes an exact `assets.json`, and inventories that copy before
execution. On macOS, only that private copy is ad-hoc signed through the existing
contributor helper. It never selects production signing, a personal credential
store, a development origin, or a compiler fallback.

```sh
bun run qualify:cef-terminals -- /absolute/path/to/prepared-app --functional
```

An explicit descriptive profile uses `--samples 5..100 --warmups 0..10`. Every
trial and failure remains in the uniquely created `.bunly/m5/graphical-terminals`
run directory. The report records the pinned Bun and CEF identities, source
fingerprints before and after, unchanged input/prepared inventories, ordered raw
process observations, total bytes/elapsed time, control roundtrips, graphical
consumer callback durations, process-tree RSS/thread peaks and sampled CPU data
when the observer provides it. Distributions retain samples in trial order.
There are no retry-to-green loops or busy-machine millisecond pass thresholds.

Functional results are labeled **functional**. They are not a throughput,
latency or baseline win. A baseline remains `NOT_CLAIMED` until an identical
workload executes against the pinned comparison runtime.

## Authority and data path

`CefBackend.serveStreams` supplies the native-authorized opaque `ViewHandle`.
That same object owns `TerminalService` capacity and the shared stream budget;
renderer-supplied terminal numbers and raw PIDs never become authority. Input,
resize, cancellation and explicit fixture gates use the existing RPC service,
whose context is already bound to the current native view/document. The binary
terminal lane remains independent from RPC.

Each of two simultaneous fixed repository children must prove a real TTY. The
fixture exercises bounded input, a real PTY resize with the Windows console-size
refresh, ordered Unicode records and final process exit. It never starts an
arbitrary command, shell, or descendant. The runtime hashes/counts the actual Bun
PTY callback chunks. The browser hashes/counts the same bytes only after
`Terminal.write(bytes, completionCallback)` invokes its completion callback.
Transport-send completion cannot resolve browser consumption.

`@xterm/xterm` 5.5.0 is an MIT-licensed contributor-only fixture dependency.
Its exact registry integrity is retained in `bun.lock`; it is bundled only into
the private qualification application and is not a Bunly runtime dependency.

ConPTY may transform the child byte stream, so acceptance compares runtime PTY
callback bytes to renderer-consumed bytes; it does not compare against the
child's intended stdout encoding. Exact framed record count/order and checksums
still must match. Process exit, PTY lifecycle status, output drain, capacity
release and native host shutdown are separate observations. Linux terminal
status 1 remains `linux-status-1-ambiguous`, never generic clean EOF.

## Concurrent and failure scenarios

- One graphical consumer deliberately withholds its ACK at the sink while an
  independent RPC progress call and sibling terminal input/output complete.
  An explicit RPC gate releases the consumer; no timed sleep releases it.
- A separate fixed child saturates the source while its consumer is held. The
  required outcome is explicit `OVERLOADED`, nonzero child termination and full
  reservation release. Truncated output is never accepted as success.
- A separate native view is navigated with a pending graphical consume. The
  document-bound stream abort must stop and release exactly its owned terminal,
  while the sibling main view completes its terminals.

Both negative controls use the [maintained ordering helper](../examples/cef-terminal/negative-control.ts)
from the actual renderer: arm the sink, request one bounded stall record, await
actual held consumption, then publish the pending marker. Only then does the
overload case request its burst. A transport write acknowledgment alone cannot
establish that the sink is held. Coalesced producer callbacks can otherwise
exceed the source reservation before the first sink invocation, closing the
stream before the renderer can publish its marker.

The strict acceptance parser rejects absent or duplicate receipts, malformed or
partial checksums, record gaps/reordering, false control/consumer/exit/release
claims, runtime/renderer byte divergence, wrong overload/cancellation outcomes,
and any nonzero terminal, stream or native final reservation.

## Unsupported modes and remaining gates

The maintained API includes exact-handle show/hide and the separate
[native window-mode prerequisite](cef-window-modes.md) adds CEF-only readback,
minimize and restore with independent page visibility qualification. The original
functional schema retains its historical labels; it does not qualify combined
background or minimized terminal load. The [sustained load follow-up](terminal-load-qualification.md)
must exercise those native operations on the current source. An inactive visible
window is not proof of foreground interaction, and hidden is not interchangeable
with minimized. No Chromium throttling is disabled.

The fixture covers direct owned children only. Detached descendants, generalized
scrollback/reconnect policy, release qualification, identical-workload competitor
baselines, and measured regression budgets remain open under #24/#25/#27.
The reviewed native-stream and terminal-service increments are integrated.
Local native execution is required alongside parser/contract tests; cross-platform
acceptance still requires the current head's hosted execution.

## Maintained full-acceptance stage

The automatic and manual `full` suite executes the graphical `terminals` stage
after native faults and before disposable credential-provider setup. It collects
its own bounded report family. The six-stage M4 suite stays unchanged. A failed
graphical stage prevents provider setup rather than being counted as a pass.

Graphical consumers inspect actual xterm screen state after its processing callback,
including wrapped Unicode records and ConPTY repaint semantics, rather than parsing
raw VT bytes as plain lines. Their final checksum waits for stream EOF/finalization,
not merely a printed final marker. Source callback counts and stream chunk counts
are distinct: legitimate bounded splitting preserves byte/hash identity and exact
stream-write-to-consumer counts. Instrumentation itself is capped and runtime hashes
are incremental. No unrelated smoke receipt is fabricated to satisfy this workload.

## Retained integration findings

The initial graphical workload reached bulk output, then the fixed eight-chunk
source cap rejected fragmented PTY callbacks. Normal output failure is now reported
immediately instead of becoming a generic missing-marker timeout. The terminal
service's lossless pending-byte coalescing resolved this without changing the
32-KiB source reservation, eight-chunk cap, record volume or overload criterion.
Only unsent blocks coalesce; active and allocated slack remain charged.

The Linux graphical stage in [workflow 40608284146](https://github.com/0xPlayerOne/bunly/actions/runs/40608284146)
failed at source `f82b12cb316617a4fec5578d14ec0a69cd0d042c` while waiting for
`BUNLY_TERMINAL_OVERLOAD_PENDING`. Its native shutdown completed in order with
no observed orphans or survivors. The [failed export](../evidence/m6-managed-development/hosted-failures/run-40608284146-linux-terminals.json.gz)
and its original failed outcome remain retained. The renderer had bypassed the
already tested helper and requested the overload burst before awaiting consumer
entry. An actual-renderer regression reproduces that failure using real xterm
screen processing and TerminalService, with substituted native/PTY edges and
three coalesced callbacks of 16,384, 16,384 and one byte. The wired helper makes
the pending marker precede the burst; the source still rejects the overload and
releases its reservations. The hosted capture does not retain callback grouping,
so its precise scheduling is not reconstructed from this deterministic regression.
The qualifier now fingerprints the helper alongside the renderer. Queue limits,
deadlines and native acceptance requirements are unchanged.

Schema 2 additionally verifies each fixed record's exact index and Unicode text
in the actual terminal screen, not merely equality of two dynamically computed
hashes. A corrupted value with a matching producer/consumer hash must still fail.
The earlier six-launch schema-1 local profile is retained as a checkpoint, not
relabeled as this stronger acceptance.

Consumer callback duration measures the complete sink operation, including any
explicitly held test gate, not pure xterm parsing or display-presentation latency.
Control roundtrip measures the application RPC path, not physical keystroke latency.
Process-tree RSS is sampled resident memory and can double-count shared pages; it
is not an exclusive allocation measurement or a sustained-memory-plateau claim.

## Clean-source local acceptance checkpoint

The retained [local evidence](../evidence/m5-graphical-terminal-local.json) binds
implementation `0434aa4f7cdd2e71ba467f4eb80e9486b73169bc` to one warmup and five
measured native launches. All six schema-2 workloads, exact displayed record
contents, byte/checksum checks, native ordered shutdowns and helper/clone cleanup
passed with unchanged source and input/prepared artifacts. Prior failed trials
remain fingerprinted alongside, not replaced by these successes.

This is a small local functional/descriptive checkpoint. It supplies no identical
competitor baseline, physical-input latency, sustained-memory plateau, measured
release threshold or background/minimized qualification. Current-head hosted
platform acceptance remains necessary before this increment merges.

## Native ownership integration in draft #117

The current fixture obtains `backend.createTerminalDriver({ profile: 'non-detaching' })`
and retains its callback probe around that native driver. Missing or mismatched
packaged owners fail the fixture. Earlier graphical receipts remain historical for
their recorded source; they are not evidence for this new ownership path. The
shared hosted runner executes the actual owner/descendant qualifier before the
unchanged full eight CEF/provider stages. See [native terminal ownership](terminal-owner.md).

## Guarded service-generation integration

The current schema-3 functional receipt also exercises ServiceSupervisor through
CefBackend's installed, hash-verified non-detaching native terminal driver. Three
successive exit-7 generations require explicit readiness, fresh identities and
consumers, fragmented input, exact callback/consumer hashes, output/PTY/process
completion and release/disposal before replacement. A fourth independent guarded
child must remain responsive and finish normally afterward. Stale-generation
input is rejected with no extra launch or replay. A fifth explicitly stopped
service records its real platform exit, never restarts, and returns all terminal,
source, timer and observer reservations to zero.

This is combined native-guardian/service execution, not a standalone driver test
relabeled as native acceptance. The complete native terminal-parent-loss matrix
remains separately required. It does not claim backend replacement, arbitrary
shell job-control containment, Unix guardian hard-kill cleanup or a CEF watchdog
fix. The graphical workload, cancellation/overload controls, exact byte/order
checks and native shutdown gates remain unchanged.

The initial combined run at b5f3004 completed its three native-guarded restart
generations, then the fixture incorrectly wrapped synchronous stale-handle
validation in assert.rejects. The corrected test uses assert.throws and still
requires the exact INVALID_HANDLE code and no additional native launch. The
failed run is retained; no supervisor or native ownership behavior changed.

The subsequent fixture also incorrectly treated every observed ready-state
snapshot as a unique transition, producing nine recorded observer assertions.
The observer is now explicitly one-shot per opaque generation when sending its
non-idempotent test input. It still requires three unique ready generations,
three exact exits and outputs, zero observer failures and no replay. Repeated
state snapshots are a documented observer contract, not new process generations;
no supervisor callback or failure accounting was changed.
