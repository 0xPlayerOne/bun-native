# Sustained graphical terminal load

This separate `graphical-pty-load-v1` profile advances #27. It does not close #27
or replace the schema-2 functional workload in
[graphical terminal qualification](cef-terminal-qualification.md). The original
workload remains required for Unicode/input/resize, held-consumer sibling/RPC
progress, navigation cancellation and controlled overload. Managed backend
replacement is M6; physical-input/dialog automation is not provided here.

## Invocation and workload

```sh
bun scripts/qualify-cef-terminals.ts PREPARED_APP --load --functional
bun scripts/qualify-cef-terminals.ts PREPARED_APP --load --samples 5 --warmups 1
```

The first command executes **one complete load trial per visibility mode**, not a
shortened workload. The second requires clean committed source and retains every
warmup and measured attempt. The private clone, ad-hoc signing, binary identity,
input/prepared inventories and process observer are the same as the functional
qualifier. Native source is unchanged; a prepared CEF 156.0.7/Bun 1.4.3 application
is required. Builds do not compile or download a native fallback.

Each of two real, direct Bun PTYs emits 700 batches of 32 numbered Unicode
records plus a completion record. Every byte enters graphical xterm 5.5.0.
The normal bounded scrollback is retained; displayed indices and exact record
contents are checked incrementally. A bounded per-batch byte buffer supplies
SHA-256 comparison with actual Bun PTY callback bytes. Stream callback counts,
PTY callback counts and bytes are separate. Final records, stream finalization,
process exit, PTY close, reservations and native shutdown are checked separately.

| Phase     | Batches per terminal | Offered interval | Minimum phase duration |
| --------- | -------------------: | ---------------: | ---------------------: |
| Warmup    |                   20 |           100 ms |                    2 s |
| Ramp      |                   40 |            50 ms |                    2 s |
| Sustained |                  600 |            50 ms |                   30 s |
| Recovery  |                   40 |           100 ms |                    4 s |

Pacing defines offered load; it is not a state-readiness sleep. At most one
batch per terminal is outstanding. Both consumer receipt and stream ACK must
complete before the next batch. Late work is retained, and schedule lag is
recorded rather than dropping records or issuing catch-up bursts. This is a
paced workload with backpressure, not a saturation-throughput claim. The
functional profile separately requires explicit failure for a saturated stalled
consumer. Instrumentation is bounded by batch count, callback count and byte
limits and is included in observed cost.

## Visibility and authority

`CefBackend.showWindow(window, boolean)` calls the existing native show/hide
operation using the runtime-owned opaque window handle. The initial page must
report `document.visibilityState === 'visible'`; hidden load starts only after
its native-bound RPC receives an actual `visibilitychange` callback reporting
hidden. Each batch also reports its current visibility. No page selects a PID,
window, or authority grant. The browser callback proves document visibility;
it is **not native OS focus/minimize readback**. Visible is not relabeled
foreground; hidden is not relabeled minimized. Occlusion, focus and minimization
remain unqualified. Chromium background throttling stays at its default.

## Measurements and interpretation

Raw per-batch JSONL and ordered external process observations remain in the
unique run directory, including failed/partial trials. The report includes:

- Actual consumed bytes/elapsed throughput and finite output integrity.
- Application progress RPC roundtrip p95/p99, issued while xterm processes data.
- Summed xterm write-callback time per batch, separately from RPC time.
- First actual PTY output callback to both graphical consumption ACKs, using the
  backend monotonic clock. This includes return-ACK overhead, and is an upper
  bound on PTY-callback-to-consumption latency. Child emission before that first
  callback is not timed.
- Backend producer-trigger to both consumption ACKs: a conservative upper bound
  including PTY input, scheduling, output, graphical processing and ACK return.
  It is not a synchronized child-production timestamp or physical input/paint.
- Offered-schedule lag, runtime reservations, controller queue peaks, and bounded
  consumer retention. Reservation limits are not observed heap/RSS.
- Per-phase full-process-tree RSS distributions and quarter medians, plus CPU
  deltas matched by PID **and creation time**. RSS can double-count shared pages;
  sampling can miss short-lived descendants and CPU outside adjacent observations.

Mode order is seeded (`2709`) per repetition. The report also retains bootstrap
mean intervals across per-launch throughput and per-launch p95/p99 statistics.
Those are intervals for the mean of launch statistics, not population tail
confidence bounds. Warmups and all failed launches remain in the validity record.

Within-launch observations are correlated. Their percentiles are descriptive;
no independent-sample tail confidence interval is invented. Repeated-launch
results must retain failures and warmups before any uncertainty or budget review.
A rising RSS trend is visible in raw data and quarter medians, never automatically
called a plateau. Neither RSS nor latency has an invented hard threshold.
Deterministic finite byte/count/reservation limits are correctness gates.

The load profile uses its own bounded 90-second observation envelope for the
38-second minimum workload. Existing functional/native/stream deadlines are
unchanged. A throttled mode that cannot finish remains failed; the harness does
not lower output volume or increase stream deadlines to produce a pass.

## Baselines and closure

The qualifier executes a capability preflight against the pinned #10 adapters
for the exact `graphical-pty-load-v1` scenario and fingerprints the adapter sources
and lockfiles. This is a refusal record, not an actual baseline runtime trial. Existing terminal-render scenarios are synthetic ANSI streams, not this
two-PTY workload. An unsupported same-workload request supplies no timing and
cannot enter a ratio. Electrobun's pinned CEF sandbox profile remains unverified;
no pin, browser security flag or packaged Bun version is silently replaced.
A same-workload maintained baseline adapter and matched-engine/security quiet
calibration remain necessary for comparison and measured performance budgets.

Platform execution, native OS state readback where needed, true producer clock
correlation, physical-input acceptance, a measured plateau/regression decision,
and the separately owned #25 parent-loss blocker remain explicit milestone gates.
No codec/native ratio or successful functional profile establishes end-user
performance, production readiness or a historical native watchdog fix.
