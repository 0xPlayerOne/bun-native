# Equivalent-workload comparison harness

`benchmarks/comparison/run.ts` runs the **identical** shared renderer workload
(`benchmarks/solid/workload.ts`) through three applications and two execution
modes against one explicit prebuilt GPUI host:

| Adapter | Entry                           | Renderer path                                  |
| ------- | ------------------------------- | ---------------------------------------------- |
| `core`  | `benchmarks/solid/direct.ts`    | public `@bun-native/core` calls, no framework  |
| `solid` | `benchmarks/solid/reactive.tsx` | Solid universal renderer, signals, keyed `For` |
| `react` | `benchmarks/solid/react.tsx`    | React reconciler, production build             |

Each adapter is bundled once into a generated module (`development` mode runs it
with `bun`) and that exact module is compiled with
`bun compile --no-script --production --explain=json` (`aot` mode). The
controller inspects the compiled-program flag and Linux JIT-omission records of
the executable it launches. Development vs AOT therefore separates the
execution-mode effect for one framework; adapters within one mode separate the
renderer/framework effect on the same host.

## Equivalence rejection

A comparison is rejected, not summarized, unless:

- every passed launch reports identical workload parameters, per-phase operation
  counts and native mutation counts, lifecycle row ownership, retention
  observation counts and cleanup diagnostics (`workloadSignature` in
  `stats.ts`);
- the instrumented calibration of every artifact paints the same initial and
  final native trees and reports the same renderer identity;
- the generated module rebuilds byte-identically; every artifact's hash is
  unchanged before each of its launches; the source snapshot is unchanged after
  compilation and after all trials; and the host hash is unchanged after all
  trials.

Timed launches disable native evidence serialization. Development calibration
uses `BUN_JSC_useDFGJIT=0`, matching native CI's handling of the known DFG
retention sensitivity (#287); timed launches keep default tiers.

## Recorded metrics

Per launch (one fresh application and host process each): spawn-to-runtime
origin, workload entry, application ready, window opened and view mounted
(acknowledged native states, not display presentation); process wall time;
sampled peak RSS of the application, its native-host descendants and the tree;
total workload time; and per-phase operation medians. Every child report keeps
its raw per-operation samples (individual updates, coalesced updates, keyed
rotations, mount/update/dispose cycles).

Per build: fresh and unchanged-rebuild module build wall time, AOT compile wall
time, module/executable/host bytes and SHA-256. Environment: OS release, kernel,
CPU models, logical CPUs, memory, Bun revision, pinned toolchain, `rustc` and
`cargo` versions, Mesa/Xvfb package versions, display variables, and
`/proc/loadavg` before every launch.

## Input-to-paint latency

With `--input-trials N` (0 by default, otherwise 3..30) the controller runs N
further fresh launches of every artifact after the timed trials, in the same
rotated order. Each launch runs under the existing Linux XTest driver
(`scripts/quality/native-input-linux.py`) with the child's `--input-latency`
scenario: the same mounted tree, with the fixture button's click handler
updating the label to `Clicked` through that adapter (core batch, Solid signal
or React state). The driver waits for the complete expected initial native
paint, clicks the button once with `xdotool`, and its concurrent inotify reader
validates the complete expected `Clicked` native tree
([NATIVE_PAINT.md](NATIVE_PAINT.md)). It then closes the window through the OS
and requires unforced cleanup of every owned process.

The recorded metric is `command_start_to_paint_observed_ms`: from immediately
before the XTest click command to the validated native paint record. It
includes `xdotool` process startup, X server delivery, GPUI event dispatch, the
adapter update and acknowledgement path, native paint instrumentation and log
I/O. It is not display presentation. Native paint evidence is enabled only for
these launches, the controller does not poll RSS during them, and each launch
contributes exactly one sample, summarized as in the statistics below under
`inputLatency` in `comparison.json`. A launch passes only if the driver reports
`passed` (window, OS input, the application click record, initial and final
native paint, OS close, cleanup) and the child report passes the same identity
and cleanup checks as timed launches. Raw driver reports, screenshots and native
evidence are kept under `input/`.

## Statistics

Trial 0 launches every freshly built artifact once and is reported separately as
**first launch after build**. It is not a controlled cold-cache start: no page
cache is flushed. Measured trials then run every adapter/mode pair, rotating the
start offset each trial and reversing odd trials. Failed launches are retained
with their logs, excluded from distributions, and never retried.

Each fresh process is the independent unit. For each per-launch metric the
summary reports count, min, median, mean, sample standard deviation, nearest-rank
p95/p99 and max, plus a 95% percentile-bootstrap interval of the median (2,000
resamples, fixed seed 244). Pooled per-operation samples are described
(median/p95/p99) but not bootstrapped, because operations within one process
are not independent. Comparisons report bootstrap intervals for median ratios:
AOT vs development per adapter, and Solid/React vs direct core per mode. With
five trials p95/p99 of per-launch metrics equal the maximum; treat intervals as
descriptive of this runner, not as population estimates.

## Run

```sh
cargo build --locked --release -p bun-native-host
out=$(mktemp -d)/comparison   # must not exist yet
xvfb-run --auto-servernum --server-args='-screen 0 1280x800x24 -nolisten tcp' \
  dbus-run-session -- bash scripts/quality/native-linux-session.sh \
  "$(mktemp -d)/session" -- \
  bun benchmarks/comparison/run.ts \
  --host "$PWD/target/release/bun-native-host" --host-profile release \
  --output "$out" --trials 5
```

Options: `--adapters core,solid,react`, `--trials 3..30`, `--iterations`,
`--rotations`, `--mounts`, `--rows` (same bounds as the shared workload),
`--rss-interval-ms` and `--input-trials`. `comparison.json` holds provenance, builds, calibrations,
per-launch process observations with child-report digests, load averages and
the summary; `launches/` holds every raw child report and log, and `input/`
every input-latency launch.

## CI

`.github/workflows/benchmark-comparison.yml` runs the comparison on hosted
`ubuntu-24.04` (Xvfb, Mesa lavapipe) weekly, on manual dispatch (`trials` and
`input-trials` are inputs) and on non-draft pull requests to `main` that change
the workflow, `benchmarks/comparison/`, `benchmarks/solid/` or the XTest
input/paint-observer scripts. The job is skipped unless the repository variable
`CI_BILLING_PAUSED` is `false`. Scheduled and pull request runs use 5 timed
trials and 5 input-latency trials. It is not a required check and never gates
a merge. Every run uploads the raw output directory (except the AOT
executables and the session runtime directory), the host build log and
SHA-256, and the exported record as the `benchmark-comparison-linux-X64`
artifact, kept for 30 days, and writes the summary table to the job summary.
Hosted runners are shared, so treat those numbers as descriptive of that run. macOS and Windows are not wired into CI.
On macOS the controller samples RSS through `ps` and load through `sysctl vm.loadavg`
and runs locally without a display server; `--input-trials` stays Linux-only because
the XTest driver is. Windows is not supported.

To keep a run in the repository, copy it into a compact record with
`bun benchmarks/comparison/export.ts ABSOLUTE_RUN_OUTPUT ABSOLUTE_DEST`. The
destination must not exist yet. The export writes `comparison.json`,
`launches.jsonl.gz` (every child report plus its last 4,000 stderr characters)
and, when the run has input-latency launches, `input-launches.jsonl.gz` (each
child report plus its driver `result.json`). It prints Markdown summary tables
for per-launch metrics (with input latency when present), pooled operation
samples and builds.

## Not measured here

- A direct Rust GPUI baseline: no Rust application performing this workload
  exists, and adding one is separate work.
- Display presentation, per-keystroke or text input latency, CPU/GPU
  utilization and Windows. The Electrobun WebView baseline
  ([`benchmarks/electrobun`](electrobun/README.md)) covers process-level metrics
  only; its operation timings are not comparable.

## Recorded results

- [Linux x64, Xvfb + llvmpipe, release host](comparison/results/linux-x64-llvmpipe-2026-11-05/README.md)
- [macOS arm64, Apple M2 Max (Metal), release host](comparison/results/macos-arm64-m2max-metal-2026-11-06/README.md)
