# M5 terminal load follow-up

PR #118 advances #27 but **does not complete M5**. The maintained combined
qualifier now executes the required #115 functional case, the full CEF load in
visible/hidden modes, and a pinned Electron load addon. It retains failed trials
and has no performance ratio or calibrated wall-clock budget.

```sh
# Bun 1.4.3; PYTHON points at the existing psutil environment.
# Optional BUNLY_ELECTRON_EXECUTABLE selects an existing Electron 44.9.3 binary.
bun scripts/qualify-m5-terminals.ts PREPARED_APP --functional
bun scripts/qualify-m5-terminals.ts PREPARED_APP --samples 5 --warmups 1
bun scripts/verify-terminal-load-evidence.ts --historical
bun scripts/verify-terminal-load-followup.ts
```

`--functional` runs each **complete** 700-batch load once per mode, plus the
original functional scenario. The repeated command runs every planned warmup
and trial, including after failures. These are awaited executions, not a queued
promise of later qualification. A failed case makes the combined command fail;
`milestoneAccepted` remains false while the outstanding acceptance gates below
exist, even when a small combined run passes.

## Corrected executed-source identity

The earlier terminal qualifier replaced `application.js` but retained the
prepared input's `backend/main.js`. That bootstrap embeds `CefBackend`, so source
fingerprints could describe #116 while the executed CEF lane implementation was
older. `build-terminal-backend.ts` now rebuilds **bootstrap, application, and PTY
child** from current source, records their byte counts/hashes, and fingerprints
all runtime/client/contracts source files plus the bootstrap and build helper.
The stale-bootstrap regression failed before correction and now compares the
prepared bootstrap byte-for-byte with an independent current-source build.

Merged #115 (`6c01202`) was already in this branch. Merged #116 (`1883c4e`) was
integrated with a normal merge, preserving the `cef-lane-transport.ts` and
`fair-scheduler.ts` fingerprints. No native source changed. The immutable
`c17d20f` native input is source-identical to this branch's native CEF code; the
current JavaScript runtime is rebuilt inside each private clone. This does not
qualify unmerged #119 native window-state code using an old binary.

## Executed results and retained failures

[Manifest](../evidence/m5-terminal-load-followup/manifest.json) and
[raw sanitized archive](../evidence/m5-terminal-load-followup/raw-evidence.json.gz)
retain eight new runs, all raw batch rows, metrics, outcomes and bounded failure
diagnostics. Nonces/local paths are removed and process IDs use consistent
pseudonyms. Private observer logs, applications and real PIDs stay out of Git.
The original five-run archive and its 7/12 accepted final profile are unchanged.

| Cohort                               | Source    | Accepted launches | Meaning                                                                                                          |
| ------------------------------------ | --------- | ----------------: | ---------------------------------------------------------------------------------------------------------------- |
| Original repeated profile            | `c23014d` |              7/12 | Four workload failures, two watchdogs; one overlap. Preserved unchanged.                                         |
| Instrumented mixed-bootstrap profile | `f27e7ac` |             10/12 | One hidden workload failure; two watchdogs with overlap. **Not current CEF backend qualification.**              |
| Corrected-bootstrap repeated profile | `e96d095` |              9/12 | Hidden workload failures at batches 150 and 342; visible trial 1 completed work then hit a teardown watchdog.    |
| Final combined functional execution  | `1379a09` |               5/5 | #115 functional, CEF visible/hidden and Electron visible/hidden; no repeated-profile or milestone pass inferred. |

The final combined run and all its child reports start/end on clean
`1379a092aca14909b728ae689002827d35c52d5d`. The later evidence/documentation commit
does not change those executed sources; the replay checks their current hashes.
The new archive replays 28 passes and **five retained failed launches**, in
addition to the unchanged historical archive. Exploratory dirty-source runs and
the sandbox-denied setup attempt remain explicitly separate.

### Failure localization

The corrected repeated run captured partial PTY consumption and pending control
RPCs at batches 150 and 342. Native RPC/stream revocation followed the last
reported packets by about 5.01/5.02 seconds, before the 15-second workload wait
expired. The last renderer snapshots precede digest/consumer completion; because
the diagnostic channel itself can stall, they do not prove no later unreported
renderer work occurred. This narrows investigation to control/native delivery
and renderer scheduling; it **does not establish background throttling as the
root cause or claim a native fix**.

Maintained diagnostics retain the current batch/phase/wait operation, latest
consumer stage, control state, bytes/callbacks/records, ACK byte counts, visibility
receipts, the last 16 native packet/lifecycle metadata events, connection abort
reason, runtime/scheduler/RPC/stream budgets and a native queue snapshot. There
is one in-flight diagnostic and one overwritten latest snapshot per terminal;
no unbounded diagnostic history or polling is added. Its overhead is part of
the workload and can affect timing. Snapshots taken after failure explicitly
say protocol revocation may already have drained queues; zero then does not
prove the queues were empty before the stall.

A revoked connection now rejects the consumer wait immediately as
`CONNECTION_REVOKED`, rather than being hidden by a later generic workload
error. Two deterministic failing-first tests cover pending and already-aborted
waits. No native, RPC or stream deadline was extended. Teardown phase completion,
backend exit, watchdog, command cleanup and actual workload acceptance remain
separate. A historical replay regression reproduces four workload failures,
two watchdogs, one overlap and three failed workloads with completed teardown
phases. Native shutdown remains untouched.

## Executed Electron addon

`benchmarks/adapters/electron/terminal-load/` uses the existing pinned Electron
**44.9.3** binary. Actual macOS arm64 execution reports Node **24.22.0** and
Chromium **152.0.7977.167**. Main-process preferences and sandboxed preload
receipts verify sandboxing/context isolation; the page checks Node globals are
absent. Permissions and new windows are denied. No dependency, pin, browser
flag or background-throttling setting changed.

The topology is **Electron Node main + one Bun 1.4.3 controller + two real Bun
PTY children**. This isolates renderer/transport behavior with equal Bun PTY
producers; it is not ordinary Electron with a Node PTY backend. The addon shares
the exact producer, 700 batches × 32 records × two terminals, phase cadence,
graphical xterm 5.5.0 consumer, screen/parser checks, per-batch hashes, bounded
stream protocol, ACK backpressure, final records and exit/release checks. Control
uses Electron IPC with the shared typed schema; stream packets use Electron IPC
and bounded base64 stdio. Native CEF control/stream transport differs.

Both final modes executed and passed. These are actual runtime trials, unlike
the legacy adapter API's preserved capability-refusal preflight. Electrobun
remains refused because same-workload PTYs and its security profile are not
qualified; no zero timing is invented.

Raw PTY callback byte totals vary slightly across these executions (approximately
5.40 MB per load, excluding final records). Matching parsed fixed records and
per-trial producer/consumer hashes do not establish byte-identical output across
adapters: several batch receipts differ by one byte. The origin of that PTY-side
framing variance remains unqualified. Combined with unmatched Chromium versions,
different transports/topology and uncontrolled local environment, it prevents a
baseline ratio or performance advantage claim.

## Bounded measurements

Each trial consumes 44,800 numbered payload records, 1,400 batch completion
records and two final records. Instrumentation uses actual callback/byte counts
and bounded per-batch buffers; it does not invent a production timestamp.
`ptyCallbackToConsumptionAckMs` starts at the first Bun PTY callback and ends
after both consumers' receipts and stream ACKs. It is an upper bound including
controller/RPC/hash/peer wait, not true child-production latency, physical input,
or paint latency. Control and xterm callback distributions remain separate.

The external observer includes Electron main, Bun controller and PTYs in the
application tree, while excluding the observer and HTTP asset server. CPU deltas
match process birth identities; RSS can double-count shared pages and short-lived
children can be missed. CPU/RSS time-quarter trends are descriptive, not plateau
or performance gates. Final-run sustained-phase observations:

| Runtime / DOM mode | CPU % of one core, quarters 1–4 | Tree RSS median MiB, quarters 1–4 |
| ------------------ | ------------------------------- | --------------------------------- |
| CEF / hidden       | 28.77, 29.69, 32.31, 31.83      | 755.61, 803.36, 790.84, 786.52    |
| CEF / visible      | 41.38, 39.79, 39.80, 38.27      | 839.72, 871.80, 875.39, 907.16    |
| Electron / hidden  | 23.85, 24.31, 22.40, 21.18      | 540.19, 538.48, 541.80, 538.64    |
| Electron / visible | 29.07, 28.52, 31.30, 32.53      | 601.23, 618.30, 650.69, 652.70    |

These single-launch unmatched observations cannot support ratios or calibrated
budgets. Repeated CEF failures and rising visible RSS remain blockers. Bootstrap
intervals in the retained profiles describe means of successful-launch summaries,
not independent population p95/p99 guarantees; failed trials are not discarded.

## Validation and remaining gates

Pinned Bun 1.4.3: `check:portable` passed 870 Bun tests (one Windows-only skip),
229 Python tests, formatting/lint, strict/browser/reference types, AST boundaries,
compiler-free builds and checker qualification. `check:foundation` passed 145
overlapping tests. `check:workflows`, `foundry:doctor`, normal hooks and complete
commit-diff Gitleaks/whitespace checks passed. Doctor retains its existing
unreleased-runtime-pin warning. Both evidence replays pass while preserving
failures. Native Rust checks/build were not rerun because native sources did not
change; this is not evidence for new native code or other platforms.

Remaining: actual workload-stall root cause/correction, independent CEF teardown
watchdog investigation, #119 accepted native state and combined foreground/
background/minimized load, coordinator current-head Windows/Linux/macOS gates,
byte-identical baseline eligibility, quiet repeated baseline calibration, measured
RSS/latency acceptance budgets, and independent descendant-supervision acceptance.
No issue, milestone or PR was closed or merged; #118 remains draft.

## Shared screen-verifier allocation correction

Review found that each xterm callback decoded, UTF-8-converted, JSON-parsed and
stringified every already observed record still present in scrollback. A finite
regression showed 202 base64 decodes for just two unchanged records across 101
observations. This was measurement overhead in the shared fixture, not required
terminal rendering or a native transport cost.

The common CEF/Electron verifier now retains each newly verified canonical wire
spelling beside its parsed record in the same bounded rolling window (at most
600 records). Every callback still scans the actual full xterm screen, reconstructs
wrapped lines, detects duplicate/reordered/gapped records, verifies Unicode and
rejects any changed old wire spelling. Only newly encountered records are decoded
and parsed. The canonical string is produced by btoa, not a cached slice of the
entire screen snapshot. Eviction removes both representations together; terminals
are not cleared/reset and no source byte, output record, checksum, callback or
workload cadence is removed. Same-JSON/different-wire changes now reject too.

This is a shared measurement implementation change, so new profiles must identify
it and cannot be relabeled as the older harness. It has not yet established a
causal fix for the retained hidden-renderer stalls or native shutdown watchdog,
a final memory plateau, or a comparative performance advantage.

## Guarded native load profile

Merged #117 is integrated and the CEF load fixture now selects the installed,
hash-verified native non-detaching driver through CefBackend. The byte-count and
hash observer still wraps the real driver callback; every stream, producer,
consumer, pacing, cancellation and shutdown assertion remains intact. Start,
final and native receipts explicitly bind this ownership profile, and the
maintained current qualifier requires it. Older direct-child reports can only
retain their historical receipt contract; they cannot pass as guarded results.
The extra native guardians are included in full-process-tree measurements.
Electron remains a disclosed Bun-controller/direct-child baseline, so different
ownership topology must be reported rather than hidden in a speed ratio.

The shared screen-cache checkpoint at 86986c3 completed ten CEF launches and ten
Electron launches (five visible/five hidden per engine), with exact output and
normal shutdown acceptance. They precede this guarded-profile integration and
are not relabeled current-source or native-owner measurements. Earlier hidden
stall and watchdog failures remain retained; the checkpoint does not establish a
causal cure, minimized/foreground qualification or a long-run memory plateau.

## Maintained long-horizon memory discriminator

`bun run qualify:terminal-soak cef PREPARED_APP --functional` and
`bun run qualify:terminal-soak electron --functional` select the same explicit
`graphical-pty-soak-v2` profile: unchanged warmup/ramp/recovery and two producers,
but a **120-second sustained phase** (2,400 batches at the existing 50-ms cadence).
This is 2,500 batches total, not a retry or a longer deadline for an incomplete
standard workload. Every source/controller/renderer bundle and receipt uses the
same fixed profile. Unknown selectors reject. The full-process observer bound
is 180 seconds for this longer workload; existing per-operation/readiness/RPC,
consumer and native shutdown deadlines do not change. The raw instrumentation
bound is explicitly 16 MiB; the screen still retains at most 600 records and the
native/stream/source byte budgets are unchanged.

The two pinned engines use the identical long profile but their disclosed native
ownership/engine differences remain. Recompiled Electron controller/child paths
are host-supplied private artifacts, not renderer-selected executable paths.
An individual soak is functional/trend evidence, not independent confidence
intervals, matched-engine superiority or an invented production RSS guarantee.
The shorter cached checkpoint's visible RSS growth remains unresolved until
actual longer traces establish whether it stabilizes; no plateau is presumed.
