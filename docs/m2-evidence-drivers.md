# M2 evidence and edit-driver increment

This increment adds executable correctness and accounting machinery. It does not
close M2, establish a performance win, or qualify the entire current repository.
No CEF, Electron or other browser executable is added to the Bunly runtime.

## Edit correctness

`benchmarks/lib/revision.ts` validates the expected revision and fresh sequence,
document identity, backend instance, module generation and retained fixture state.
Frontend HMR, desktop backend relaunch, and future resource-preserving replacement
have different invariants. A matching text label after a full reload cannot pass
as HMR. Failed-edit records require a new compiler diagnostic and preservation of
the last usable revision before repair.

The optional bare-Bun frontend fixture imports HTML into `Bun.serve`, explicitly
enables HMR, and accepts module replacement through `import.meta.hot`. It checks
input retention and listener cleanup as well as revision changes. The browser
collector requires an actual installed executable and the process sandbox. It
never adds `--no-sandbox`, modifies administrator policies, or substitutes a
browser engine after a denial.

```sh
python -m pip install -r benchmarks/adapters/frontend/requirements.txt
BUNLY_BENCH_CHROMIUM=/absolute/path/to/chromium bun scripts/qualify-frontend.ts
```

Set environment variables using the shell's native syntax on Windows. This is an
optional benchmark contributor dependency, not a consumer runtime dependency.
The collector writes a report and exits nonzero on failed or incomplete work.
The existing `qualify-development.ts` remains the bare-Bun backend edit/build and
command-reconnect reference. Neither fixture implements Bunly managed reload.

Reference API contracts:
- https://bun.com/docs/bundler/fullstack
- https://bun.com/docs/bundler/hot-reloading

## Stages and bytes

`stages.ts` records cold install, warm dev launch, frontend/backend edits,
assembly, signing, installer compression, first run and updates separately.
Execution and output validation are inside the timed stage. Deadline expiry,
cancellation, output failure and unsupported operations remain distinguishable.
A cancelled action that ignores its signal still needs adapter-owned process
cleanup; a returned failed record is not evidence that the action was reaped.

`accounting.ts` measures installed directories, actual installer files, received
first-run body bytes, caches, and updates independently. Unavailable measurements
are null, never zero. Directory inventories do not traverse links. Categories are
not summed: installed files and installer downloads overlap and are not memory.

```sh
bun scripts/benchmark-ledger.ts path/to/ledger.json
```

The ledger contains `schema: 1`, the complete `stages` array, and the complete
`bytes` array. Exit 0 means complete accounting coverage, 1 indicates a failed
stage, and 2 indicates unavailable coverage. It does not certify comparability.
The stage helpers are reusable adapter infrastructure; adapters still need to
wire and execute their full install/build/sign/update paths. No unavailable
signed-release result is fabricated.

## Regression goals

```sh
bun scripts/benchmark.ts compare before.json after.json --budgets=policy.json
```

Budgets select scenario, metric, unit, statistic, direction, percentage ceiling,
minimum independent trials and optional absolute ceiling. Zero baselines require
an explicit absolute ceiling. Missing metrics, insufficient samples, failed
warmups, unpinned harness source and incompatible environments remain ineligible.
The example `budgets.proposed.json` is explicitly an uncalibrated goal, not a
performance result or a default release gate.

Equivalent parameter/metadata objects are compared independently of JSON key
insertion order. Metric coverage must match in both directions. Runtime-only
experiments may use `engine: none` and `engineVersion: null`; they cannot be
compared with browser workloads. Source commits do not make uncontrolled runs
controlled, and these checks cannot authenticate a caller's claimed hardware.

## Historical evidence

`evidence/m2-baselines` preserves the exact report members from the two recorded
GitHub artifact ZIPs. Archive hashes were checked against the connector metadata.
Each record distinguishes the workflow head from the PR merge commit actually
reported by the harness. The merge parents were verified through GitHub's Git API.
`verify-m2-baselines.ts` checks saved member hashes, source/runtime scope and the
continued ineligibility of the two different CI-smoke environments.

```sh
bun scripts/verify-m2-baselines.ts
```

These are 8 historical Electrobun executions and 20 historical Electron executions,
not fresh runs. All unsupported cells are preserved. The Electrobun exact browser
identity/process sandbox remains unverified. The saved reports are not the full
process-observer traces and cannot establish comparable performance.

## Validation boundary

Bun 1.4.3 from the previously authenticated offline toolchain was used locally.
The saved increment was based on `5a7be9162c039bd8ec512eadd5eafe788def4496`. Its touched M2 modules were reconciled with merged main `1f22cff6d9be40a08b38a3012e61df5f051da9e0`.
The surrounding local baseline is an older retained source snapshot; its 68 tests
plus the new tests are not the complete latest-main test suite.

The frontend collector was actually attempted with Chromium 144.0.7559.96 and
Playwright 1.57.0 under a non-root account with sandboxing enabled. Navigation was
blocked by the environment's administrator URL policy. The failure is retained;
no successful browser HMR, CEF, Electron, macOS or Windows result is inferred.
Portable revision fixtures test the acceptance logic, not browser HMR itself.

M2 still needs successful frontend/desktop edit qualification, production adapter
stage integration, comparable competitor coverage including useful Mirin/Butter
subsets, and controlled hardware evidence. GitHub Actions was not dispatched or
retried. Nothing here changes the billing pause, production Adea, or publishing.

## Desktop continuation and PR #70 reconciliation

See [desktop edit qualification](m2-desktop-edits.md) for the explicit Electron and
Electrobun source-edit/build/relaunch drivers, ownership rules and current execution
boundaries. The richer comparative-budget API is `regression-budgets.ts`; the
original `budgets.ts` public exports and unchanged tests from merged PR #70 are retained.
Its runtime input validation is hardened without replacing the delivered API with
the separately saved richer implementation.

This continuation preserves the earlier HMR fixture and historical reports. Local
validation combines the retained source snapshot and verified M2 changes, not the
complete current-main native/RPC/Foundry tree. No result is relabeled as a whole-repo
or actual desktop qualification.

## Retained evidence storage

The two historical report members are stored as deterministic `.json.gz` files
so repeated trials do not add unnecessary textual bulk. `inputs.json` records
both the original uncompressed member hash and the stored compressed-byte hash.
`verify-m2-baselines.ts` verifies both, limits decompression to 4 MiB, and uses
the same result validator and comparison rejection. This storage choice is not
an application package-size or installer-compression measurement.

The original PR #70 `budgets.ts` API remains present. This continuation also
rejects forged outcome values, non-object ledgers, array byte objects and
unknown fields; richer tail/sample-count policies remain separately exported
from `regression-budgets.ts`. Neither validator makes a smoke run controlled.

## Committed source identity

The record command now checks the actual Git HEAD and worktree, including staged
and untracked changes, before emitting a commit as the tested source. A dirty,
missing, or concurrently changed checkout remains `local-uncommitted` and is
ineligible for a controlled comparison. A CI environment variable alone is not
accepted as evidence of what executed. These checks are read-only; they neither
reset changes nor hide untracked source. They are a point-in-time observation,
not a filesystem lock preventing another process from editing after collection.
