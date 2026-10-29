# M2 workbench integration validation

**Record type:** Historical checkpoint. Current status and commands are in [the documentation index](../README.md).

Repository delivery of the saved M2 implementation and shared-renderer integration.

**Base:** `1f22cff6d9be40a08b38a3012e61df5f051da9e0` (merged PR #70).
**Scope:** #8/#9; Electron/Electrobun edit-driver portion of #10.
**Status:** Implemented and locally checked; M2 remains open pending the execution and measurement requirements below.

## Delivered behavior

The accumulated revision validators, stage/byte accounting, percentile regression
budgets, real-process observer, frontend HMR fixture, and desktop edit drivers
are delivered together rather than as an archive for a consumer to apply. The
original PR #70 budget API and its tests are retained. Unknown outcomes and malformed
runtime shapes now fail that validator instead of masquerading as unsupported work.

Desktop readiness additionally requires the full shared xterm/browser workbench
and exact terminal byte/checksum completion. It cannot succeed from the small
revision page alone. The composition owns two separately originated fixture servers,
separate role credentials, finite deadlines, and joint teardown. Both runtimes receive
the same assets. The workbench's preview is still an iframe, not a native child view.

The Electron fixture's navigation policy admits only the generated workbench origin
as a subframe. Top-level navigation to that origin, other ports, remote hosts and
unsafe schemes are rejected. Both navigation-start and redirect hooks use the policy.
The existing Electron baseline retains its separate native-window lifecycle scenario.

Reports preserve unsupported stages and missing bytes, reject asymmetric comparisons,
and do not label a dirty Git worktree as a committed benchmark build. Historical
Electron/Electrobun reports are preserved with exact compressed and original-member
hashes; their different platform and security configurations remain non-comparable.

## Executed checks

Environment: Linux x64, actual Bun (version redacted), retained authenticated dependency
snapshot, local Python/psutil 7.2.2. No new frozen dependency installation is claimed.

| Check                                                                       | Result                                                                                                                                        |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `bun run check`                                                             | 170 passed, 0 failed, 381 assertions across 25 files; strict TypeScript, Oxlint, browser-boundary AST checks and compiler-free builds passed. |
| `bun run typecheck:browser`                                                 | Passed.                                                                                                                                       |
| `bun test tests/desktop-navigation.test.ts tests/workbench-desktop.test.ts` | 12 passed, 56 assertions. HTTP and exact-template policy tests, not browser rendering.                                                        |
| `bun test tests/source-identity.test.ts`                                    | Three passed using isolated real Git fixtures.                                                                                                |
| `bun scripts/qualify-observed-commands.ts`                                  | Seven actual process cases passed: output, Bun compile rejection, timeout, cancellation, orphan cleanup, overflow and credential redaction.   |
| `python tests/process_observer_test.py`                                     | Six passed.                                                                                                                                   |
| `bun scripts/qualify-development.ts`                                        | 20 actual bare-Bun executions passed (one warmup plus three trials for five scenarios). Not desktop HMR.                                      |
| `bun scripts/verify-m2-baselines.ts`                                        | Both exact historical reports verified; comparison rejected. These are not new competitor executions.                                         |

The portable source set consists of the retained 68-test baseline, four unchanged
PR #70 tests, and 98 M2 test cases. Nineteen of those M2 cases were added during
this integration pass. This is **not** the complete current-main native/RPC/artifact/
Code Foundry suite. Those remote files are preserved through the base Git tree,
not overwritten by the older local snapshot.

## Failed and unavailable execution paths

The sandbox-enabled frontend driver was attempted as a non-root user with installed
Chromium 144.0.7559.96 and Playwright 1.57.0. Initial loopback navigation returned
`ERR_BLOCKED_BY_ADMINISTRATOR`. No browser policy was modified, no sandbox was
disabled, and no alternate engine was selected to evade the restriction. This is
an actual failed environment qualification, not a successful frontend-HMR result.

The exact Electron 44.8.0 benchmark package is absent in this environment. The
implemented Electrobun 2.0.3-beta.26 layout requires macOS arm64 while this host is
Linux x64. These prerequisites prevent actual desktop edit execution here. No
zero-cost scenario or substitute runtime is recorded as a success.

Ruff/Oxfmt, fresh macOS/Windows runs, CEF execution, installed full-framework
runtime checks and controlled hardware measurements were not performed. Existing
CI billing guards remain unchanged; no Actions run was dispatched or retried.

## Remaining acceptance

- #8: execute the frontend HMR fixture and integrated desktop edit/relaunch sequence
  on supported machines; retain failures and exact workload observations.
- #9: finish adapter-level cold-install, warm-dev, signing, compression, first-run,
  update and byte collection; calibrate budgets with controlled, comparable data.
- #10: qualify broader Electrobun scenarios and exact browser/process-sandbox
  identities; implement and execute useful Mirin/Butter subsets rather than
  treating pinned source inspection as a runtime benchmark.

No issue is closed solely because unit tests pass. This increment makes no Bunly
speedup, memory-reduction, native-security, or release-readiness claim. M3/M4 and
Adea implementation, repository visibility, public publishing and billing settings
are unchanged.
