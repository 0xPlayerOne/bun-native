# M2 measured reference and installed-update acceptance

Actual reference workflows, bounded idle accounting, and trusted browser input.

**Scope:** #9 measurements and #10 pinned reference baselines, following merged #75.
**Profile:** macOS arm64, explicit local benchmark artifacts. Not production release approval.

## Reproduction

Use the repository's exact Bun 1.4.3 executable and its frozen root lock. Set `PYTHON`
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
