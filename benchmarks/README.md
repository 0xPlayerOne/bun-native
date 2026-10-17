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
pinned Electron 44.8.0 binary using its upstream installer and checksums. Fixture
packages are outside the consumer workspaces; Electron/xterm do not ship in Bunly.

The adapter uses an isolated temporary profile, independent browser windows,
context isolation, Node-disabled pages and renderer sandbox verification. It runs
startup-to-report, navigation, create/close, terminal parser/render opportunity,
and an actual requested renderer crash observed by the parent. Other scenarios
remain unsupported. No native crash is presented as successful ordinary operation.

The Python observer measures the known app process tree. The external local
fixture server and observer are measurement infrastructure, excluded consistently.
This is NOT a Node-versus-Bun backend-compute or desktop IPC benchmark.

Use a graphical Linux session or Xvfb with a working Chromium sandbox. Never add
`--no-sandbox` for a favorable comparison. Missing binaries, denied sandbox setup,
and scenario failures produce explicit failures. CI is diagnostic, not controlled
hardware evidence. The workflow's privileged sandbox-helper setup applies only
to its disposable runner, not the developer's computer.

## Measurement rules

Runs include exact plans, warmups, repetitions, seeds, versions, fixture hashes,
correctness and explicit trial status. Variant order is shuffled deterministically
per repetition. Every declared scenario has all trials, including unsupported work.
`--require-complete` returns nonzero for unsupported cases. Recording a partial
matrix successfully does not certify a benchmark or comparative result.

Quantiles use linear interpolation; mean intervals use 1000 seeded bootstrap
resamples. Small sample sets and noisy CI results cannot establish a speed claim.
`compare` refuses mismatched fixtures, browsers, security, environments or scenario
coverage and all smoke/CI runs. Controlled runs require explicit machine/GPU/
display/power metadata via BUNLY_BENCH_* variables, but those variables alone are
not evidence of experimental control.

Separate cold install, warm launch, edits, build, signing, compression, logical
installed bytes, first-run downloads, caches, and RAM. Inventory hashes can reveal
duplicate content; they do not prove a duplicate is unnecessary.

RSS sums may double-count shared pages. Sampling can miss brief descendants.
Context switches are NOT kernel wakeups; unavailable metrics remain null. The
observer cleans only known descendants with matching creation times, allows the
same bounded exit grace for every adapter, and reports surviving children as
failures even if cleanup succeeds. Raw reports preserve failed and negative cases.

## Remaining baseline work

`references.json` pins inspected Electrobun, Mirin, Butter and Electron sources.
Only the executable adapters actually run count as baselines. Full Electrobun
integration, Mirin/Butter supported subsets, packaged Bun/CEF inventory and the
install/build/edit/release matrix remain #10 work. Butter belongs to a separate
system-webview comparison class. Keep #9/#10 open while required measurements and
competitor coverage are incomplete; do not extrapolate Bunly results from the mock.
