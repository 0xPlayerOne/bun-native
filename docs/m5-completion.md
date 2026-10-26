# M5 — streams, terminals and responsiveness

## Accepted scope

M5 implements the declared CEF MVP for bounded, lossless streams, native-owned
terminals and application services, notification-driven supervision, fair delivery,
and measured graphical load. It does **not** certify a production release,
unrestricted shell containment, physical-input/paint latency, or freedom from
future leaks and native teardown failures.

The implementation baseline is merged `14daa1114da7a88ad063ae852271d8a64c6aae01`
(PR #118), following the independent accepted increments below. PR #123 adds
maintained measurement review and retained-evidence replay, not a new desktop
runtime or a retrospective relabeling of earlier runs. Its final-head validation
and merge record are maintained on that PR.

| Issue | Implemented and qualified                                                                                                                                                                                            | Principal merged increments                |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| #23   | Independent native-authorized binary lane; ordered open/data/ack/cancel/close/error semantics; actual consumer credit; per-stream/view/global reservations; bounded failure and no implicit replay                   | #67, #105, #113                            |
| #24   | Opaque runtime terminal handles; validated executable/arguments/cwd/environment; input/resize/signal/close; graphical CEF/xterm consumption; explicit native non-detaching ownership                                 | #114, #115, #117                           |
| #25   | Readiness and exit notifications; unchanged graceful deadlines and escalation; native-owned process groups/jobs; bounded fresh-generation restart and stale-generation rejection; independent-child preservation     | #109, #111, #112, #117, #120, #122         |
| #26   | Reserved control admission, byte/count ownership through actual write completion, bounded per-turn work and cross-owner scheduling; actual native/window-state readback; reply-drained teardown                      | #107, #108, #110, #116, #119               |
| #27   | Equal graphical producer/consumer workloads, four actual window modes, current guarded soak, pinned Electron observations, complete output and process-tree metrics, retained failures and measured review envelopes | #118; measurement tooling/evidence in #123 |

The current public desktop path explicitly requests
`backend.createTerminalService({ profile: 'non-detaching' })`. Native artifact
identity and capability admission must succeed; there is no silent standalone
fallback. Restart is bounded fresh execution, not automatic request replay.
Managed replacement of the application backend remains M6.

## Platform execution baseline

PR #118's final reviewed head `449817d24d4e7cd505fc00c36a4cc3bdf3c38ca5` and
hosted source `6ae75faf5ab07337b5c7d9faf1586f93f79e2f2e` have identical Git trees.
Native workflow `40336366674` completed ten stages on **macOS arm64, Linux x64 and
Windows x64**: RPC/streams, browser policy, network, both functional transports,
offline reset, faults, native window modes, graphical terminals/guarded services,
four-mode sustained load, and protected credentials. The separate native-owner
matrix and standard-user PTY/service workflow remain independent checks, not
inferred from compilation. All 43 non-skipped checks passed for that head.

The four-mode stage requires actual native state and authenticated page visibility
for foreground, inactive-visible background, hidden and minimized windows.
Restoration and final zero-delivery assertions are mandatory. Chromium background
throttling stays enabled. No requested mode, successful build, or page timer alone
is accepted as proof of native state.

The guarded-service integration accepted in #122 exercised three separate exit-7
generations, actual readiness and exact consumer checksums, disposal before
replacement, no replay, stale-handle rejection, and an independent surviving child
on every target. The supported native-owner matrix accepted eight cases on each
Unix target and nine on Windows, including shell/server descendants and GUI/Bun
parent loss. Unsupported outcomes remain separate as described below.

## Reproducible measurement record

[The retained manifest](../evidence/m5-terminal-acceptance/manifest.json) binds seven
compressed archives to original report hashes, exact source commits, sanitized
process observations, batch rows and outcomes. Reproduce with:

```sh
bun run verify:terminal-acceptance
```

This is offline replay, **not new desktop execution**. Historical source commits
must be present locally. A missing commit, changed source hash, duplicate/missing
launch, modified batch/metric, absent archive or changed historical failure rejects
verification. The ordinary test suite checks the full retained archive inventory
and digests without needing historical Git objects.

| Recorded run                       | Accepted launches | Rejected launches | Scope                                                                |
| ---------------------------------- | ----------------- | ----------------- | -------------------------------------------------------------------- |
| Current native functional          | 4                 | 0                 | One launch per actual window mode                                    |
| Current native repeated            | 20                | 0                 | Five independent launches per mode                                   |
| Current native soak                | 2                 | 0                 | Visible and hidden, 120-second sustained phase each                  |
| Pinned Electron functional         | 4                 | 0                 | Same four-mode workload                                              |
| Pinned Electron repeated           | 20                | 0                 | Five independent launches per mode                                   |
| Earlier native reply-drain control | 3                 | 1                 | The minimized launch retained one 85-byte reply and remains rejected |
| Earlier stale baseline preflight   | 0                 | 4                 | Version/mode guard rejection; no application workload accepted       |

Every accepted native launch in this retained set had verified macOS helper/clone
completion. The older load and follow-up archives retain their original failures,
including watchdogs and profiles rejected as evidence of native ownership. They
are hash-bound by this manifest, not overwritten or merged into current success
counts. The current successful-profile subtotal is **50**, excluding the three
successful launches within the earlier failed control run.

### Descriptive results

These values summarize five launches per mode on one development machine. Control
is application RPC, not hardware keyboard latency. The timing column is the
**mean of each launch's sustained-phase p99**, not a pooled global p99. CPU is
summed process-tree usage expressed as a percentage of one logical core; peak RSS
is the mean of the per-launch summed process-tree peaks and can double-count
shared pages.

| Adapter / actual mode | Control p99 mean, ms | Tree CPU, % of one core | Tree peak RSS mean, MiB |
| --------------------- | -------------------- | ----------------------- | ----------------------- |
| CEF / foreground      | 2.52                 | 38.41                   | 922.39                  |
| CEF / background      | 2.76                 | 39.08                   | 926.21                  |
| CEF / hidden          | 2.68                 | 25.13                   | 865.74                  |
| CEF / minimized       | 2.70                 | 25.47                   | 867.45                  |
| Electron / foreground | 2.10                 | 32.12                   | 631.12                  |
| Electron / background | 2.00                 | 32.04                   | 636.87                  |
| Electron / hidden     | 1.30                 | 17.51                   | 585.74                  |
| Electron / minimized  | 1.34                 | 18.61                   | 585.29                  |

Native resource usage in these observations is higher, not a performance win.
CEF 156.0.7/Chromium 156.0.8078.17 and Electron 44.9.3/Chromium 152.0.7977.167 have
different engines, transports and owner-process topologies. Identical workload
parameters do not make those environments equivalent. No cross-engine ratio or
causal optimization claim is admitted. Raw per-launch values, uncertainty and
source boundaries remain available in the archives.

The longer native soak's sustained RSS quarter medians were **885.08, 935.06,
972.66, 974.67 MiB** for visible and **807.98, 815.05, 822.41, 824.26 MiB** for hidden.
Growth slowed substantially in the final quarter; it was not exactly zero. This
finite sampled observation is not a universal plateau or leak-free guarantee.
Framework queue/reservation convergence is checked separately and cannot certify
all Chromium/Bun allocations. Continued resource attribution and longer quiet
calibration remain explicit performance follow-up, not hidden by a larger limit.

### Maintained regression review

`profile:terminal:review` captures validated native evidence, creates a measured
reference envelope, and compares independent launches with unchanged workload,
engine, ownership, harness and observer context. At least five launches per mode
are required. The baseline is committed as
[native capture](../evidence/m5-terminal-acceptance/native-capture.json) and
[review envelope](../evidence/m5-terminal-acceptance/native-review-envelope.json).

The deterministic bootstrap resamples launches, not correlated batch rows.
Separated adverse intervals require review (exit 2); overlapping intervals do not
prove equivalence. Invalid evidence rejects (exit 1). Hard correctness, bounds and
cleanup gates are never replaced by a favorable metric. See
[the review contract](terminal-regression-review.md) for commands and limitations.

## Explicit support and release boundaries

- **Native teardown:** Historical intermittent CEF watchdog failures are retained.
  Passing current launches do not establish a causal fix. Draft #121 contains a
  separate ownership/capture investigation; its experimental source is not part of
  this accepted runtime. It remains a release-reliability concern.
- **Process containment:** The supported native policy is explicitly non-detaching.
  Unrestricted job-control/setsid/breakaway descendants are not contained. Unix
  guardian SIGKILL/crash can orphan its group and remains an observed unsupported
  outcome, not a cleanup pass. OS-denied termination does not become success or
  authorize a replacement generation. See [native ownership](terminal-owner.md).
- **Platform semantics:** Windows ConPTY can transform output; callback-to-consumer
  checksums do not imply original child-byte equivalence. Linux last-slave status
  remains separately recorded, not a blanket arbitrary-shell clean-EOF rule.
- **Qualification:** Quiet matched-engine calibration, physical input/paint,
  production signing, release security review and general long-running memory
  guarantees are not supplied by this functional milestone. M6 handles backend
  replacement, M7 remaining OS adapters, M8 distribution/release, and M9 broader
  controlled performance qualification.

No native deadline, sandbox, certificate policy, credential-provider guard, byte
limit or final-zero assertion was relaxed for this closeout. The rejected hex
optimization remains rejected; the runtime codec is unchanged by measurement
review. The existing immutable Foundry runtime-ref warning remains recorded.
