# M2 macOS workbench acceptance

Executed browser and desktop workflows on the connected Apple-silicon machine.

**Date:** October 19, 2026.
**Base:** `2204937da2875984976d49fb5730a3181b257206`, merged PR #74.
**Scope:** Complete #8 workbench acceptance; advance #9 measurements and #10 reference baselines.
**Classification:** Local smoke and integration evidence, not controlled performance or release approval.

## Results

The complete checkout was installed with its frozen root lock, rather than the
partial retained source used in earlier increments. The initial full TypeScript
suite passed 401 tests. The final suite additionally covers the source-fault
attribution, explicit ad-hoc identity and actual backend failure/restart changes.

| Executed path               | Result and boundary                                                                                                                                                     |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Frontend HMR                | One warmup plus three repetitions: real source edit, parser failure, repair, retained input/counter/document and no duplicate click handler. Chromium sandbox enabled.  |
| Electron desktop edits      | One warmup plus three repetitions of all five build/launch/edit/failure/repair steps. Full shared terminal byte count and checksum required.                            |
| Electrobun desktop edits    | One warmup plus three repetitions of the same sequence and workload. Actual packaged Bun/CEF executable, not a mock.                                                    |
| Mirin desktop edits         | All five steps executed successfully using the pinned registry packages and native prebuild. Local ad-hoc signing, not Developer ID signing.                            |
| Butter source desktop edits | All five steps passed after the explicit source-package and native-helper preparation described below. The default registry setup did not pass.                         |
| Bare-Bun development        | Six scenarios, each with one warmup plus three repetitions: warm launch, edit, failed edit/repair, service build, long-command resume and real backend failure/restart. |
| Electron baseline           | Twenty executed cases covering launch, independent-window lifecycle/navigation, terminal rendering and intentional renderer crash. Unsupported cells retained.          |
| Electrobun baseline         | Eight executed launch/terminal cases. Unsupported cells retained.                                                                                                       |
| Mirin release profile       | Real cold frozen dependency installation, app assembly and independently verified portable archive compression. Other stages remain unsupported.                        |

The frontend qualifier is a bare-Bun frontend fixture. Desktop edits are explicit
stop/build/relaunch operations, not a framework's default watcher or Bunly M6
managed replacement. State retention is a fixture-owned disk record, not arbitrary
in-memory state or a running PTY. The nested workbench preview is an iframe; the
Electron baseline separately exercises actual independent native windows.

The backend-failure hook requires an explicit private-fixture flag and the correct
token before scheduling exit 86. Its driver observes that real nonzero exit,
reaps the owner, starts a new instance and checks the persisted counter. The hook
is absent without the flag. It is not a production failure-recovery policy.

## Complete-checkout validation

| Check                                                 | Result                                                                                                                                             |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bun install --frozen-lockfile`                       | Passed initially and again after the developer-tool compatibility update.                                                                          |
| `bun run check`                                       | 404 tests passed, zero failed, 6,366 assertions across 41 files; strict TypeScript, Oxlint, browser AST boundaries and compiler-free build passed. |
| `bun run typecheck:browser`                           | Passed.                                                                                                                                            |
| `python -m unittest discover -s tests -p '*_test.py'` | All 80 tests passed. Includes native-signing policy tests, not a certificate-backed signing run.                                                   |
| Touched-file Oxfmt 0.68.0 and Ruff 0.15.22            | Formatting and lint checks passed.                                                                                                                 |
| Actual process qualification                          | All seven stdout/compiler-failure/timeout/cancellation/orphan/overflow/redaction scenarios passed.                                                 |
| Git diff whitespace check                             | Passed.                                                                                                                                            |

No fresh Bunly CEF/Rust build or cross-platform native release qualification is
inferred from these checks. Competitor CEF applications and Butter's native helper
were actually executed/built as described above. The previous partial-snapshot
validation limitation no longer applies to this complete-checkout test run.

## Environment and runtime identities

Apple M2 Max, 64 GB, macOS 26.7.1 (25G241), arm64. The observed display was a
Screen Sharing Virtual Display at 1920 x 1080 / 60 Hz. AC power was observed at
setup; it was not monitored continuously. Other user workloads were not stopped.

The controller and project toolchain use the explicit Bun 1.4.3 executable
(`c6da4a4d3`), not the machine's different default Bun. Python 3.11.15, psutil
7.0.0 and Playwright 1.57.0 are installed in the private `.bunly` environment.

| Reference                | Observed runtime/browser                                                 |
| ------------------------ | ------------------------------------------------------------------------ |
| Frontend fixture         | Bun 1.4.3; Chrome for Testing 143.0.7499.4                               |
| Electron 44.8.0          | Node 24.22.0; Chromium 152.0.7977.167                                    |
| Electrobun 2.0.3-beta.26 | Packaged Bun 1.4.0; CEF 147.0.10 / Chromium 147.0.7727.118               |
| Mirin 0.1.0-alpha.26     | Bun 1.4.3; CEF 148.0.10 / Chromium 148.0.7778.218                        |
| Butter source 1.6.3      | Bun 1.4.3; WKWebView. Exact WebKit runtime identity remains unqualified. |

CEF identities come from the hash-checked native library exports, not a reduced
user-agent string. Different browser versions, security profiles and packaging
boundaries prevent treating these as an equivalent performance comparison.

## Defects found by actual execution

1. Bun 1.4.3 printed the intentional parser rejection but did not deliver the
   expected `bun:error` callback in this fixture. The collector now requires a
   fresh, bounded, source-attributed server diagnostic and still checks that the
   last usable document survives. The unused callback registration was removed.
2. Pinned Electrobun's build wrapper omitted source locations. Its malformed source
   now includes a fresh per-trial marker, which must occur in the actual parser
   diagnostic. A generic build failure or a previous marker cannot pass. The
   normal filename requirement remains for other adapters.
3. Passing an empty `MIRIN_SIGN_IDENTITY` bypassed upstream's nullish ad-hoc default
   and attempted to select an empty certificate. The reference profiles now
   explicitly select `-`, never a production identity. The strict installation
   check also requires a contained hoisted/copyfile profile instead of the local
   machine's globally linked package cache.
4. The archive verifier compared a canonical symlink destination to a noncanonical
   root under macOS's `/var` alias. It now canonicalizes ancestor aliases while
   rejecting a directly linked artifact root, escaping members and archive output
   placed inside its own artifact through an alias.

5. The first real pre-commit run rejected Code Foundry's
   `--no-error-on-unmatched-pattern` argument because Bunly pinned Oxlint 1.18.0.
   Oxlint is now pinned to 1.83.0, the installed Code Foundry release's supported
   development baseline, and Oxfmt is explicitly pinned to 0.68.0. Frozen install
   and the complete suite passed again. The actual hook was retained, not skipped.
   These are developer dependencies, not application payloads.

All touched TypeScript and Python implementation files were formatted with the
repository's Oxfmt and Ruff conventions. Formatting accounts for part of the diff.

## Butter's explicit non-default setup

The pinned `butterframework@1.6.3` registry lookup returned 404. Instead, a clean
checkout of `wess/butter` at `a735ddf2eac8f4fe4a98370fc4ccf4373db797d9`
was packed with Bun 1.4.3 and `--ignore-scripts`. No competitor source was patched.
The private installation selected that local tarball and retained its exact lock.

The first compile failed because `semhelper.dylib` was absent. Running the pinned
upstream `src/ipc/shmem/darwin.ts` module built that helper from its shipped C source;
that setup was separately observed and checked for cleanup. Only then did the
compiled-app edit sequence pass. This is a source/helper-primed profile with a
compiler prerequisite, not successful default npm installation or a prebuild claim.

The two locks are retained under `benchmarks/adapters/references/locks`. The Butter
lock intentionally names `file:butterframework-1.6.3.tgz`; recreate the archive from
the exact source commit before installing. No tarball is added to Bunly's runtime.

| Input                          | SHA-256                                                            |
| ------------------------------ | ------------------------------------------------------------------ |
| Mirin lock                     | `2a0271a07b6c0b45f16cfadae1089883295eae7aa91798152ba2c98fb9cd17dc` |
| Butter source lock             | `0f53bcfba440af6cac2bb2d5e5dfdd7008f54f867aecb663c17ce7480bc03be9` |
| Observed Butter source tarball | `e9c3aa991391867647348c7b2220cc3143ee664591980591aba798b0c9bdaafa` |

Use the exact Bun executable for installations, including nested directories.
The first Mirin resolution inherited Bun 1.4.2 from a directory-changing shell;
its unchanged lock was then successfully installed frozen with Bun 1.4.3. The
recorded desktop/release controller runs use Bun 1.4.3. Neither global Bun nor
machine-wide package-manager settings were changed.

## Read-only sandbox observations

Setting `BUNLY_BENCH_SANDBOX=1` adds optional Seatbelt presence observations for
owned, identity-checked processes on macOS. `sandbox_check(pid, NULL, 0)` returns
presence, not a description or equivalence proof of the policy. Other platforms,
missing providers, failed queries and unrecognized results stay unknown.

The eight instrumented Electrobun baseline runs had last-observed renderer/GPU/
utility states reporting no Seatbelt presence. Electron's twenty runs had positive
last-observed states for 45 renderer identities, and two renderer identities with
negative last observations; these short-lived/partial observations are retained,
not erased or promoted to a continuous guarantee. GPU and utility identities in
those Electron runs reported positive last observations. All counts are per PID
and creation-time identity, not per application or user-visible view.

Do not collapse these results into `sandbox: true`, claim equal security, or disable
a competitor's sandbox to improve timings. The existing Electron preload checks
and the separate native samples provide different evidence. No system policy,
trust store, certificate selection or browser protection was changed.

## Evidence and acceptance disposition

`evidence/m2-macos/manifest.json` identifies the preserved reports, their original
private hashes, the redacted/stored hashes, and the changed source content hashes.
Reports consistently pseudonymize ephemeral fixture values and replace private
home/checkout paths. Outcomes, timings and stable content identities remain.
The sandbox file retains selected raw process-presence samples with the original
report hash for each run. Full private process logs remain in `.bunly/acceptance`
and `.bunly/benchmarks` on the execution machine.

Source was being edited during these local acceptance runs. Original dirty/source
fields remain unchanged; these results are not relabeled clean or controlled.
Initial failures are preserved beside successful results. Successful configured
release tasks do not imply complete stage coverage.

**#8:** Workbench acceptance is satisfied by the actual frontend, desktop, local
fixture, backend-failure, command/state-reconnect and renderer-failure executions.
This does not imply every adapter implements every scenario, native PTYs, or M6
managed reload. The issue may close when this implementation and evidence land.

**#9:** Still requires complete installed-first-run/updater transactions, actual
certificate-backed signed-release measurement, full stage/byte coverage, and
controlled hardware/input/stream/power calibration. The Mirin app assembly includes
upstream ad-hoc signing; no separate Developer ID timing is invented.

**#10:** Actual pinned reference subsets and exact CEF identities are now observed.
Equivalent comparison groups, remaining scenario/platform coverage, source-package
versus published-package distinctions and browser/security qualification remain
explicit. The measured references do not establish a Bunly performance advantage.

No Actions runs were manually dispatched or retried. `CI_BILLING_PAUSED` was read
and remains true. Only the Oxlint/Oxfmt developer pins and their root lock entries changed. The native Bunly runtime, publishing settings,
repository visibility and Adea are unchanged. No macOS Developer ID, Windows
SignTool, notarization or production signing certificate was used.
