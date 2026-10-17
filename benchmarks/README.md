# Reproducible comparison workbench

M2 infrastructure, not evidence of a Bunly desktop performance advantage.

## Commands

```sh
bun install --frozen-lockfile
bun scripts/benchmark.ts record mock .bunly/benchmarks/mock.json
bun scripts/benchmark.ts report .bunly/benchmarks/mock.json
bun scripts/benchmark.ts inventory path/to/installed/app
```

The mock executes lifecycle/navigation contracts, a real local HTTP byte fixture,
and deterministic fault contracts. Browser rendering, actual renderer crashes,
frontend/backend reload, native startup, cold installation, application packaging,
and signing are explicitly unsupported. They never receive fabricated zero timings.

## Interactive shared UI

```sh
bun install --cwd benchmarks/fixtures
bun scripts/workbench.ts
```

Open the printed loopback URL. The UI uses the pinned xterm.js renderer, numbered
ANSI output, a safe local form/browser fixture, cancellation, and an input-to-frame
probe. The web-only preview is a sandboxed iframe, not an independently embedded
native surface. Desktop adapters must supply native view evidence separately.
There is no PTY until M5 and no managed service reload until M6.

## Electron baseline

```sh
bun install --cwd benchmarks/adapters/electron
python -m pip install psutil==7.0.0
bun scripts/benchmark.ts record electron .bunly/benchmarks/electron.json --trials=3 --warmups=1
```

Install fixture dependencies first. The adapter pins Electron 44.8.0, uses an
isolated temporary profile, denies popups/permissions, enables renderer sandboxing
and context isolation, and never exposes its completion bridge in the independent
browser window. It runs native lifecycle/navigation, first usable frame reporting,
and actual xterm consumption/paint. Other scenarios stay unsupported.

The Python observer captures the entire observed application process tree. The
external deterministic fixture server and observer are measurement infrastructure,
not an application backend. Their cost is excluded consistently; this does NOT
benchmark Electron-versus-Bun main-process RPC or backend compute.

On Linux use a graphical session or Xvfb with an operational Chromium sandbox.
Never add `--no-sandbox` to make one variant pass. Missing dependencies/sandbox or
failed scenarios are recorded as failures, not silently omitted.

## Interpretation

Results contain exact scenario plans, repetitions, warmups, seeds, source/runtime/
engine metadata, fixture hashes, raw samples, units, correctness, and explicit
status. Shuffled variant order is seeded per repetition. Each variant has every
requested trial, including unsupported outcomes. `--require-complete` makes an
incomplete result matrix return a nonzero status. Ordinary `record` can save an
incomplete report successfully but cannot label it comparative evidence.

Quantiles use linear interpolation; mean intervals use 1000 seeded percentile
bootstrap resamples. Small sample sets and noisy CI runs are diagnostics, not
marketing benchmarks. A confidence interval does not correct environmental bias.

`compare` refuses mismatched fixtures, browsers, security, environments, failed or
unsupported scenarios, and smoke/CI runs. To run controlled measurements supply
BUNLY_BENCH_CONTROLLED=1 plus explicit BUNLY_BENCH_MACHINE, GPU, DISPLAY, and POWER
metadata. Merely setting those variables does not establish experimental control.
Report cold install, warm launch, edits, app assembly, signing, compression,
installed bytes, first-run downloads, cache bytes, and RAM independently.

RSS sums may double-count shared pages. Sampling can miss brief descendants.
Context switches are not kernel wakeups; unavailable metrics stay unavailable.
The observer is allowed to clean up only descendants it observed with matching
process creation times. A detected orphan remains a failed result after cleanup.

## Remaining baseline work

`references.json` pins inspected sources for Electrobun, Mirin, Butter, and
Electron. Source pins alone are NOT executed baselines. Full Electrobun adapter
qualification, packaged Bun/CEF inventory, and equivalent cold/build/edit/release
measurements remain #10 work. Butter's native-webview profile belongs in a separate
comparison class. Keep #9/#10 open until their required real measurements exist.
