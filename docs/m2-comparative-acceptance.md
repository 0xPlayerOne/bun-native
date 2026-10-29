# M2 measured reference and installed-update acceptance

Actual reference workflows, bounded idle accounting, and trusted browser input.

**Scope:** #9 measurements and #10 pinned reference baselines, following merged #75.
**Profile:** macOS arm64, explicit local benchmark artifacts. Not production release approval.

## Reproduction

Use the repository's exact Bun (version redacted) executable and its frozen root lock. Set `PYTHON`
to the isolated environment installed from `requirements-dev.txt` and the optional
frontend requirements. Do not substitute the machine's default Bun after `cd`.

```sh
bun scripts/bootstrap-benchmark-dependencies.ts --electron
bun install --cwd benchmarks/adapters/electrobun --frozen-lockfile
bun scripts/prepare-electrobun.ts
bun scripts/bootstrap-reference-baselines.ts mirin .bunly/references/mirin
bun scripts/bootstrap-reference-baselines.ts butter .bunly/references/butter
BUNLY_BENCH_SANDBOX=1 BUNLY_KERNEL_COUNTERS=1 bun scripts/qualify-comparative-matrix.ts 3
bun scripts/qualify-mirin-installed.ts
python scripts/qualify-workbench-latency.py --bun /absolute/path/to/bun \
  --chromium /absolute/path/to/selected/chromium --output .bunly/latency.json
```

Bootstrap destinations must be new; existing installations are not overwritten.
Mirin uses its reviewed registry lock. Butter is deliberately the separate
source/helper-primed profile: the pinned registry version was unavailable, so its
unchanged exact Git commit is packed without lifecycle scripts, checked against
the previously observed archive digest, installed frozen, and its shipped helper
compiled. A differing archive fails instead of silently regenerating its lock.
No package is published, no global toolchain or certificate store is modified,
and these dependencies are never shipped as Bunly's runtime.

## Measurement boundaries

The balanced, seeded matrix executes one warmup and the selected independent
repetitions of every reference. It preserves raw commands, failures, exact
workbench revisions, runtime/browser identities, and pre/post CPU and power
observations. No unrelated applications are killed. AC and a one-second system
load below 10% are condition observations, not proof of dedicated hardware.

After initial rendered readiness the app receives an authenticated, bounded idle
request. It settles for one second, emits the idle phase, and stops benchmark
command polling for five seconds. Native process-tree sampling and optional
kernel counters continue. Startup-to-renderer is retained separately from this
intentional hold. A missing/short idle interval cannot pass as a zero-cost idle.

CPU is the sum of matched PID/creation-time deltas over observed wall time, with
one core equal to 100%. RSS is a process sum and may double-count shared pages.
Darwin package-idle and interrupt wakeups are separate kernel counters, not
context switches or portable power measurements. Only adjacent same-phase,
same-identity samples contribute. Source identities and missing coverage remain
visible.

The separate input driver delivers actual trusted browser input through Playwright,
then records DOM event/handler-to-animation-frame latency. The xterm interceptor
records actual parser-callback durations and verifies every stream's total bytes
and checksum. Sample arrays and independent context boundaries are retained;
within-context events are not treated as independent trials. This is neither
physical input-to-photon latency nor a cross-framework keyboard benchmark.
Instrumentation is served from the same origin under the unchanged CSP; no
`unsafe-eval`, sandbox, or browser-policy relaxation is used.

## Actual installed first-run and upstream updater

The Mirin installed qualifier builds two independent versions using the pinned
upstream release command and native codec. It downloads the full first bundle
through the existing length/hash-checked transfer, verifies the uncompressed tar,
extracts into a new private installation, verifies its native signature, and
requires the full rendered workbench to complete.

The first installed app calls Mirin's real `checkForUpdate`, `download`, and
`applyAndRelaunch`. Version two must register a new process/document, preserve the
fixture-owned state, and pass signature and version checks at the replaced install
path. Both the updater's received-byte progress and successful integrity validation
must agree with the independently built manifest. This is the full-update path,
not a delta patch, file-copy simulation, or production Bunly updater.

Launch Services reparents the new process. A separate read-only observer verifies
its exact executable, PID/creation identity, and exit. Outer supervisor tree
measurements do not include that reparented process and must not be reported as
complete updated-app memory. Original and replacement processes must finish;
leftover observed descendants fail the outer qualification.

Local ad-hoc signing is inseparable from upstream assembly in this profile.
Developer ID, timestamped certificate-backed signing, notarization, Gatekeeper,
and Windows Authenticode remain distinct acceptance paths. The private fixture
does not use the unrelated local application signing identity found on the Mac.

## Reference grouping and decision

Electron, Electrobun, and Mirin use their own pinned Chromium versions; Butter uses
the installed system WebKit build. Do not silently replace a competitor's browser
or weaken its sandbox to manufacture equivalent inputs. Keep native-webview and
bundled-Chromium groups separate, and then partition by exact engine and observed
security profile. Single-member groups are honest: they do not establish a
cross-framework speed ranking.

The existing strict comparison API is unchanged. These reference records support
per-profile baselines and regression targets; they do not establish a causal
Bun-versus-Node or Bunly-versus-Electrobun advantage. Electrobun remains the principal
M9 go/no-go reference. Re-run the same workflow with Bunly's actual implementation
and appropriately matched engine/security/workload before making those claims.

## Sources

- Mirin pinned updater and release APIs: `Netko-Labs/mirin` commit
  `c60fa09a7ae94368e22188cb8ff0b38a910a9f24`, `packages/mirin/src/updater` and
  `packages/mirin-cli/src/release.ts`.
- Butter pinned compile/extraction/polling behavior: `wess/butter` commit
  `a735ddf2eac8f4fe4a98370fc4ccf4373db797d9`, `src/cli/compile.ts` and
  `src/ipc/shmem/darwin.ts`.
- Chromium Seatbelt presence contract:
  https://chromium.googlesource.com/chromium/src/+/refs/heads/main/sandbox/mac/seatbelt.cc
- macOS distribution signing requirements:
  https://developer.apple.com/documentation/xcode/creating-distribution-signed-code-for-the-mac/

No Windows/Linux native qualification is inferred from the macOS results. Existing
CI billing guards remain in force; no hosted workflow dispatch is needed.

## October 19 acceptance results

All observations below were executed from clean commit `effe77bceea0b1cc9e96a21155da703d7b78c052`. The complete repeated reference matrix contains **16 successful sequences**, one warmup and three measured repetitions per reference. All 16 include valid five-second idle intervals and native wakeup counters.

### Descriptive per-profile medians

**These columns are not a matched-engine performance ranking.** Background CPU was above the declared 10% threshold in every pre/post pair; no run is promoted to controlled performance evidence. Electron bundles only its main program here, while the other build cells include an actual application build. Butter’s memory excludes launchd-owned WebKit XPC services and is not comparable to complete Chromium trees.

| Profile    | Main/app build (ms) | Launch to shared renderer (ms) | Stop/build/relaunch edit (ms) | Observed idle CPU (% of one core) | Observed descendant RSS (MiB) |
| ---------- | ------------------: | -----------------------------: | ----------------------------: | --------------------------------: | ----------------------------: |
| electron   |                87.8 |                          531.5 |                         848.2 |                             0.219 |                         543.5 |
| electrobun |              1622.0 |                          685.2 |                        2682.5 |                             3.255 |                         651.8 |
| mirin      |              4844.1 |                          610.3 |                        2567.1 |                             1.943 |                         848.2 |
| butter     |              8212.3 |                          740.7 |                        5849.0 |                             0.582 |                         120.5 |

### Engine and security cohorts

| Reference                | Actual runtime   | Actual browser build         | Treatment                                                                                                   |
| ------------------------ | ---------------- | ---------------------------- | ----------------------------------------------------------------------------------------------------------- |
| electron 44.8.0          | 24.22.0          | chromium 152.0.7977.167      | Node disabled, context isolation and renderer preload sandbox attestation; retain native sample transitions |
| electrobun 2.0.3-beta.26 | 1.4.0            | chromium 147.0.7727.118      | CEF plus RPC-disabled page profile; observed Seatbelt presence is not policy equivalence                    |
| mirin 0.1.0-alpha.26     | VERSION_REDACTED | chromium 148.0.7778.218      | CEF prebuilt + explicit ad-hoc signing; retain sampled native security state                                |
| butter 1.6.3             | VERSION_REDACTED | system-webkit 21624.5.1.11.3 | Separate source/helper-primed system-webview profile; do not claim full XPC process accounting              |

The three Chromium versions are different, and the security profiles are not interchangeable. The resulting equivalent-engine/security cohorts contain one reference each. The accepted output is a set of reproducible per-profile baselines, not invented cross-framework speedup percentages. The original strict comparison API and provisional performance budgets are unchanged.

### Installed updater and input/stream measurements

Four independent Mirin transactions passed (one warmup, three measured). Each built two versions, downloaded and installed version 1, required actual full-workbench readiness, exercised the real upstream check/download/verify/swap/relaunch, checked version 2 and retained fixture state, and confirmed the reparented replacement process exited.

Measured installed-first-run median: **5246.2 ms**; full-update-through-relaunch median: **8573.9 ms**. These include verification/orchestration and local HTTP, not internet/CDN performance. Raw version-specific byte counts are preserved separately from installed bytes.

The trusted-input driver passed four independent contexts: **480 actual trusted input events and 128 complete xterm streams**, with one context treated as warmup. Each context preserves its own event distributions. The three measured p95 DOM-event-to-animation-frame observations are 6.20 ms, 7.11 ms, 7.30 ms. These are not physical presentation latency and are not interchangeable with CEF/system-webview application measurements.

### Setup and implementation findings

- Both reference preparations reproduced in fresh directories with frozen locks. Butter’s source tarball also reproduced the exact reviewed hash; its helper compilation is retained as part of the source profile rather than omitted.

- Pinned Mirin `packages/mirin/src/native.ts` polls native events with `setInterval(drain, 8)`. Pinned Butter `src/cli/compile.ts` generates a `setTimeout(poll, 16)` IPC loop and embeds/extracts native/asset bytes. These are source observations, not proof that these timers alone caused any measured idle cost. Electrobun’s actual packaged Bun remains 1.4.0 although the controller is Bun (version redacted).

- The extra local collector found a pass-propagation gap: a successful nested adapter result could have hidden a later idle-reducer failure. Its final gate now also requires no collector failure and complete native idle observations. All 16 preserved trials independently pass the stricter gate, so none was retroactively relabeled.

- An initial latency run hit the existing strict CSP. The final driver uses same-origin external instrumentation and locator observations; CSP and sandbox settings were never weakened. The failed attempt is retained.

### Issue disposition

**#10 — pinned reference baselines:** acceptance supplied for the declared macOS subsets. Exact runtimes, engine cohorts, tested source/default/tuned profiles, setup failures, native/compiler/cache requirements, actual workloads, raw results, and fresh-environment reproduction are documented. Other platforms and unavailable matching engine/security combinations remain explicit limitations, not successful zero-cost measurements. #10 can close when this evidence lands. Electrobun remains the principal M9 decision reference.

**#9 — full measurement acceptance:** remains open. Installed first-run and full-updater integration now execute successfully, as do native idle accounting and trusted-input/stream measurements. Outstanding acceptance is certificate-backed signed-release execution, controlled calibration on a quiet machine, and complete per-platform process accounting where WebKit services are not descendants. The Mac has only an unrelated local signing identity; no Developer ID identity was selected. Neither ad-hoc signing nor failed quiet-condition gates satisfy those requirements.

### Verification

`python scripts/report_reference_acceptance.py` checks every compressed and expanded report hash, validates all matrix cells and idle intervals, and regenerates the descriptive summary. The execution-source hashes in the manifest match the exact committed Git blobs, not an inferred CI environment variable. Initial failures, all raw sampled process observations, and transient security states are retained in compressed form.

No Actions dispatch/retry, billing change, global toolchain change, production certificate use, publication, or Adea modification was performed.

### Final complete-checkout checks

- `bun run check`: 412 passing tests, zero failures, 6,401 assertions across 43 files; strict TypeScript, Oxlint, browser AST boundaries, and compiler-free SDK/CLI builds pass.
- `bun run typecheck:browser`: passes.
- `python -m unittest discover -s tests -p '*_test.py'`: 89 passing tests.
- `bun scripts/qualify-observed-commands.ts`: all seven actual process/failure/cleanup cases pass.
- Touched-source Ruff and Oxfmt checks, normal pre-commit gates, preserved evidence hashes, and the stricter collector gate over all 16 actual trials pass.

No new Bunly Rust/CEF build, Windows/Linux run, Developer ID signing, notarization,
physical-display latency measurement, or dedicated quiet-hardware calibration is
inferred from these checks.

### Fresh-environment replay

Both new frozen installations were also used to execute their complete five-step desktop edit sequences. Mirin and the explicitly source/helper-primed Butter profile passed again from clean commit `3d4f1bb862f16820897dc946a4154cb4c54cbca3`. Their raw command/application reports are retained as `reproduce-mirin-app` and `reproduce-butter-app`. This is a second isolated installation on the same physical Mac, not a claim of a second hardware/platform qualification.
