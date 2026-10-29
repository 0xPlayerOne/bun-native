# Reproducible comparison workbench

M2 infrastructure and explicitly scoped observations, not a Bunly performance win.

## Commands

```sh
bun install --frozen-lockfile
bun run benchmark:smoke
bun scripts/benchmark.ts report .bunly/benchmarks/mock.json
bun scripts/benchmark.ts inventory path/to/installed/app
bun scripts/bootstrap-benchmark-dependencies.ts
bun run workbench
```

The mock runs real Bunly lifecycle/navigation contracts, a local HTTP byte fixture,
and deterministic fault contracts. Rendering, renderer crashes, HMR, backend
replacement, native startup, installation, app packaging and signing remain
unsupported by that adapter. Missing work is never assigned zero-cost timings.

The interactive workbench uses pinned xterm.js, numbered ANSI output, a safe local
form/preview, cancellation, and handler-to-frame timing. The iframe preview is not
a native child view. There is no PTY before M5 or managed service reload before M6.
After parser consumption the terminal scenario waits for two animation callbacks.
This is a render opportunity, not measured physical input-to-photon latency.

## Real Electron adapter

```sh
bun scripts/bootstrap-benchmark-dependencies.ts --electron
python -m pip install psutil==7.0.0
PYTHON=python bun scripts/benchmark.ts record electron .bunly/benchmarks/electron.json --trials=3 --warmups=1
```

On Windows set the `PYTHON` environment variable using the shell's normal syntax.
The bootstrap uses the checked-in nested Bun locks and explicitly installs the
pinned Electron 44.9.3 binary using its upstream installer and checksums. Fixture
packages are outside the consumer workspaces; Electron/xterm do not ship in Bunly.

The adapter uses an isolated temporary profile, independent browser windows,
context isolation, Node-disabled pages and renderer sandbox verification. It runs
startup-to-report, navigation, create/close, terminal parser/render opportunity,
and an actual requested renderer crash observed by the parent. The crash request
waits for both renderer readiness and initial navigation completion. Other
scenarios remain unsupported. No native crash is presented as successful ordinary
operation. Failed warmups are reported alongside failed measured trials.

Use a graphical Linux session or Xvfb with a working Chromium sandbox. Never add
`--no-sandbox` for a favorable comparison. Missing binaries, denied sandbox setup,
and scenario failures produce explicit failures. The workflow's privileged
sandbox-helper setup applies only to its disposable runner.

## Real Electrobun CEF adapter (macOS arm64 qualification)

```sh
bun install --cwd benchmarks/fixtures --frozen-lockfile
bun install --cwd benchmarks/adapters/electrobun --frozen-lockfile
python -m pip install psutil==7.0.0
bun scripts/prepare-electrobun.ts
PYTHON=python bun scripts/qualify-electrobun.ts
```

Failed Electrobun trials keep a bounded reason in the result matrix and write
full error text to a separate `electrobun-failure-*.json` file alongside the
observer evidence. The hosted artifact includes these files; any failed trial,
including a warmup, still fails qualification. A surviving cleanup helper remains
a failure unless an independently qualified cleanup policy proves its ownership.

This uses the published `electrobun@2.0.3-beta.26` bootstrap, pinned Hutch
0.28.0-canary.10 and its prebuilt devkit. Preparation, configuration and application
assembly are timed separately. Tool caches and the generated application live in
`.bunly/benchmarks`. The framework downloads its own Bun; developer Bun does not
select the runtime inside that application. The qualified artifact reports Bun
1.4.0, even though the benchmark driver uses Bun (version redacted).

The configuration explicitly chooses a Bun main process, CEF and no WGPU module.
This is a recorded tuned profile. It does not involve compiling native framework
source, implementing a Bunly CEF backend, or vendoring competitor code.

The adapter finds the built `.app`, reads its declared executable from Info.plist,
and runs the packaged native launcher directly. It executes launch and the same
xterm byte-checked terminal fixture, once for warmup and three measured repetitions.
Other declared scenarios remain unsupported. The CEF view disables framework RPC;
this is **not proof that the Chromium process sandbox is enabled**. The recorded
security profile remains unverified, and comparisons refuse it.

The completion-only loopback route uses a per-trial token, exact POST origin,
matching scenario, bounded body and deadline, and one accepted result. It exposes
no native operation. It is suitable for our trusted synthetic fixture, not a
renderer authorization implementation. Neither this channel nor Electron's
completion IPC establishes a benchmark of native RPC throughput.

Actual Bun version and the observed browser user agent are retained separately.
A reduced `Chrome/147.0.0.0` user agent is **not** an exact CEF/Chromium version;
`engineVersion` remains null until the full binary identity is qualified.
Installed-file inventory records individual hashes and symlinks without traversal.
This minimal app serves the shared frontend externally from the local fixture
server, so its inventory is not a self-contained product installer comparison.
The framework-default app profile is reused between trials; cold-profile semantics
are not claimed. Linux/Windows Electrobun launch adapters remain unqualified.

## Executable development and reconnection fixtures

```sh
bun scripts/qualify-development.ts
```

This separate `bun-watch` variant runs **bare Bun**, not Bunly, Electron, or
Electrobun. It actually launches a local TypeScript service, rewrites an imported
module, verifies a changed response, introduces a syntax failure, waits for its
diagnostic, repairs it, bundles the service, and runs the bundle. It also cancels
a bounded long-running numbered command and starts a new command at a verified
cursor. A JSON state file persists across service restarts. This is fixture-owned
disk state, not preservation of arbitrary memory or a still-running shell.

The generated projects are private, disposable directories under
`.bunly/edit-fixtures`, on the checkout volume. Earlier Windows runs under the
system temp directory failed with Bun (version redacted) reporting that project files were
outside the watch root, even with explicit cwd. The workspace-local path passes;
this is a harness setup workaround, not an upstream Bun fix. Those failed runs
remain linked in `docs/validation-m1-m2-wave2.md`.

The child controller bounds output, pending-event waits and shutdown. Qualification
wraps the whole workload in the external process-tree observer and fails on known
surviving descendants. No unrelated developer process is targeted for cleanup.
The fixture has five scenarios with one warmup and three measured repetitions on
each OS. Frontend HMR and desktop-specific edit/relaunch drivers are still pending.

## Optional kernel counters

```sh
python -m pip install psutil==7.0.0
bun run native:build
BUNLY_KERNEL_COUNTERS=1 PYTHON=python bun scripts/qualify-kernel.ts
```

Set environment variables using platform-appropriate shell syntax on Windows.
Native compilation is a framework-contributor experiment, not an application build.
Kernel-instrumented runs are separate from ordinary timing runs because collection
adds overhead. The collector never elevates privileges or changes system settings.
Only the disposable Linux CI runner temporarily enables schedstats and restores it.

Linux reads per-task `nr_wakeups` and `nr_wakeups_idle` counters from `/proc`, with
creation-time identities and explicit availability. macOS reads `proc_pid_rusage`
package-idle/interrupt counters. These kernel metrics have different semantics and
must not be compared across providers. They are not context switches, generic
power estimates, or physical input-to-photon measurements. Windows ETW collection
is not implemented and is explicitly unavailable, not zero.

Deltas include adjacent observations of the same process/task and phase only.
New/exited tasks, counter resets and phase boundaries are omitted. Reports describe
lower-bound sampled coverage. A healthy collector can correctly report zero;
an unavailable collector cannot. Standalone provider checks and negative tests
are in `tests/kernel_counters_test.py`.

## Measurement rules

Runs include exact plans, warmups, repetitions, versions, fixture hashes,
correctness and explicit trial status. The multi-adapter runner shuffles variant
order deterministically per repetition. The single-adapter qualification scripts
use a fixed scenario order; these are smoke diagnostics, not controlled experiments.
Every declared scenario has all trials, including unsupported work.
`--require-complete` returns nonzero for unsupported cases. Recording a partial
matrix successfully does not certify a comparative result.

Quantiles use linear interpolation; mean intervals use 1000 seeded bootstrap
resamples. Small sample sets and noisy CI results cannot establish a speed claim.
Warmups are excluded from timing summaries but **not from validity**. A failed or
unsupported warmup prevents comparison eligibility. Unknown runtime/browser or
compound unverified security metadata also prevent performance claims. A
`controlled` label alone is insufficient.

`compare` refuses mismatched fixtures, browsers, security, environments or scenario
coverage and all smoke/CI runs. Controlled runs require explicit machine/GPU/
display/power metadata via BUNLY_BENCH_* variables, but those variables alone are
not evidence of experimental control. Current Electron/Linux and Electrobun/macOS
observations are not directly comparable.

Separate cold install, warm launch, edits, build, signing, compression, logical
installed bytes, first-run downloads, caches, and RAM. Inventory hashes can reveal
duplicate content; they do not prove a duplicate is unnecessary. RSS sums may
double-count shared pages. Sampling can miss brief descendants. The observer and
external local fixture server are excluded consistently from the app-process tree.
This is NOT a Node-versus-Bun backend-compute benchmark.

## Remaining baseline work

Full Electrobun scenario/platform coverage, exact CEF binary identification,
Chromium sandbox verification, Mirin/Butter supported subsets, controlled hardware
runs and full install/edit/release/byte-accounting matrices remain #8/#9/#10 work.
Butter belongs to a separate system-webview comparison class. Windows kernel
instrumentation and final host-risk acceptance remain #5 work. None of these
qualification scripts implements Bunly's actual CEF host or managed backend reload.

## Measured macOS references and installed updater

See [the measured acceptance report](../docs/m2-comparative-acceptance.md) for the pinned four-framework matrix, native idle counters, trusted-input/terminal measurements, and actual Mirin installed-update transactions. Run `python scripts/report_reference_acceptance.py` to verify preserved evidence and regenerate its descriptive summaries. These observations do not establish matched-engine speedups or a controlled calibration; #9 retains explicit signing and measurement limitations.
