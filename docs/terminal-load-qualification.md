# Sustained graphical terminal load

The separate [native window-state profile](terminal-window-load.md) adds explicit
foreground/background/hidden/minimized readback without relabeling the historical
visible/hidden results below. Its current-head platform acceptance remains separate.

See [the executed follow-up](terminal-load-followup.md) for the corrected current-source bootstrap, combined qualifier, actual Electron addon, and retained failure diagnostics.

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
qualifier. Native source is unchanged; a prepared CEF 156.0.7/Bun (version redacted) application
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
The [maintained Electron addon](terminal-load-followup.md) now executes this producer/consumer workload with equal Bun PTYs. The legacy scenario API still refuses it. Matched-engine/security, byte-identical output and quiet calibration remain necessary for comparison and measured performance budgets.

Platform execution, native OS state readback where needed, true producer clock
correlation, physical-input acceptance, a measured plateau/regression decision,
and the separately owned #25 parent-loss blocker remain explicit milestone gates.
No codec/native ratio or successful functional profile establishes end-user
performance, production readiness or a historical native watchdog fix.

## Retained macOS acceptance attempt

The [evidence manifest](../evidence/m5-terminal-load/manifest.json) and
[compressed raw export](../evidence/m5-terminal-load/raw-evidence.json.gz) retain
all five development/qualification attempts, including the sandbox setup failure,
initial harness failures and the successful exploratory visible/hidden run.
Fixture nonces and local user/temporary paths are redacted; original file hashes,
ordered samples, outcomes, complete batch records and native receipts remain.
No binary, browser profile, credential or crash dump is included.

The final declared profile ran on clean source
`c23014dbb7f4d04a323ca23c935f1bc9c47c7978` with Bun (version redacted) and the immutable
`c17d20f` native input. The unchanged CEF library identifies as
`156.0.7+g47dbc1d+chromium-156.0.8078.17`. After #115 merged, the unpublished
implementation was rebased onto `6c01202` as
`db1a8028afcddd1d1525fcb6c196635638adfbbd`; the entire implementation Git tree
remained exactly `6efdcd2afbda627fd9dbb26e0606f9e8a5d3329a`. This records code
identity across the rebase; it does not pretend a second native run occurred.

**The repeated profile failed acceptance: 7/12 launches passed, 5/12 failed.**
Those counts include one warmup per mode; measured launches were 6 passed and
4 failed. Every planned trial ran, and input/prepared inventories and source
hashes stayed unchanged. The original schema-2 functional compatibility run
passed separately on the same clean implementation.

| Trial  | Mode    | Retained outcome                                                                                                                  |
| ------ | ------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Warmup | Hidden  | Stream deadline during sustained batch 205; ordinary cleanup completed                                                            |
| 1      | Hidden  | Load-operation deadline at batch 413; subsequent CEF teardown watchdog, one observed utility orphan, failed cleanup qualification |
| 2      | Hidden  | Load-operation deadline at batch 347; ordinary cleanup completed                                                                  |
| 3      | Visible | All 700 batches completed; subsequent CEF teardown watchdog, one observed utility orphan, failed cleanup qualification            |
| 3      | Hidden  | Load-operation deadline at batch 325; ordinary cleanup completed                                                                  |

The observer terminated the two observed utility orphans and recorded zero
post-cleanup surviving processes. That does **not** erase the orphan or failed
clone-cleanup qualifications. No historical watchdog fix or #25 parent-loss
resolution is inferred. The stream handoff, renderer and scheduling contribution
to these deadlines remains unresolved; successful hidden trials do not prove the
failed trials were merely browser throttling.

Successful measured visible trials had sustained-phase RSS quarter medians
rising from approximately 830–843 MiB in the first quarter to 899–909 MiB in the
last. This is not a demonstrated plateau. Successful-trial application RPC tails
and repeated-launch bootstrap summaries are retained in the archive, conditioned
on those successes; the failed trials prevent a reliable responsiveness or
performance-budget acceptance claim.

Replay the published observations against their recorded historical source fingerprints:

```sh
bun scripts/verify-terminal-load-evidence.ts --historical
```

A successful replay means the export is internally consistent: it must reproduce
**7 passes and 5 retained failures**, not turn this profile green. The replay also
rechecks the original functional receipt and verifies the recorded source snapshot. The follow-up replay separately checks the current executed implementation.

Completed local checks on the qualified implementation:
`bun run check:portable` (840 TypeScript passes, one existing skip, 229 Python
passes, browser/reference typechecks, boundaries, formatting/lint and build),
`bun run check:foundation` (145 passes), `bun run check:workflows`, and
`bun run foundry:doctor`. Doctor retains its existing unreleased-runtime-pin
warning. Normal commit hooks passed. Native Rust checks/build were not rerun:
there are no native source changes and this uses the explicitly supplied immutable
bundle. Windows/Linux load execution and coordinator review remain pending.
