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
- the generated module rebuilds byte-identically, and the source snapshot,
  artifacts and host hash are unchanged before every launch and after all trials.

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
`--rotations`, `--mounts`, `--rows` (same bounds as the shared workload) and
`--rss-interval-ms`. `comparison.json` holds provenance, builds, calibrations,
per-launch process observations with child-report digests, load averages and
the summary; `launches/` holds every raw child report and log.

To keep a run in the repository, copy it into a compact record with
`bun benchmarks/comparison/export.ts ABSOLUTE_RUN_OUTPUT ABSOLUTE_DEST`. The
destination must not exist yet. The export writes `comparison.json` and
`launches.jsonl.gz` (every child report plus its stderr tail) and prints a
Markdown summary table.

## Not measured here

- A direct Rust GPUI baseline: no Rust application performing this workload
  exists, and adding one is separate work.
- Electrobun/WebView baselines, display presentation, input-to-paint latency,
  CPU/GPU utilization, hardware GPUs, macOS and Windows.

## Recorded results

- [Linux x64, Xvfb + llvmpipe, release host](comparison/results/linux-x64-llvmpipe-2026-11-05/README.md)
