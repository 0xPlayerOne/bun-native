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

The strict acceptance parser rejects absent or duplicate receipts, malformed or
partial checksums, record gaps/reordering, false control/consumer/exit/release
claims, runtime/renderer byte divergence, wrong overload/cancellation outcomes,
and any nonzero terminal, stream or native final reservation.

## Unsupported modes and remaining gates

The current maintained native API can create and close a visible window but has
no qualified background-visibility or minimize control. The report therefore
records foreground as the actually exercised visible window and both background
and minimized as `NOT_QUALIFIED`; it does not invent those modes or disable
Chromium throttling.

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
