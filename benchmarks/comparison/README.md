# Equivalent-workload comparison

The methodology, equivalence rules and statistics are in
[`COMPARISON.md`](../COMPARISON.md). This directory holds:

- `run.ts`: the controller. It builds the `core`, `solid` and `react` adapters of
  `benchmarks/solid/workload.ts`, compiles each one with Bun AOT and launches every
  adapter/mode pair against one explicit prebuilt host.
- `stats.ts`: the equivalence checks and descriptive statistics, covered by
  `tests/quality/benchmark-comparison.test.ts`.
- `export.ts`: copies a finished run into a compact, committable record and
  prints a Markdown summary table.
- `metrics.ts`: converts an exported run into the regression gate's metrics file
  (`export`) and gates it against the matching committed baseline (`gate`),
  covered by `tests/quality/benchmark-metrics.test.ts`.
- `baselines/`: committed regression baselines, one per hosted runner CPU.
- `results/`: recorded runs, each with its own README.

## Run

The controller requires the checksum-pinned Bun, absolute `--host` and `--output`
paths, `--host-profile dev` or `release`, and an output directory that does not
exist yet. On Linux, run it inside the private display session:

```sh
cargo build --locked --release -p bun-native-host
out=$(mktemp -d)/comparison
xvfb-run --auto-servernum --server-args='-screen 0 1280x800x24 -nolisten tcp' \
  dbus-run-session -- bash scripts/quality/native-linux-session.sh \
  "$(mktemp -d)/session" -- \
  bun benchmarks/comparison/run.ts \
  --host "$PWD/target/release/bun-native-host" --host-profile release \
  --output "$out" --trials 5
```

Other options, with their defaults: `--adapters core,solid,react`, `--trials 5`
(3–30), `--iterations 1000` (a multiple of ten up to 10,000), `--rotations 1000`
(up to 10,000), `--mounts 100` (up to 1,000), `--rows 32` (up to 128) and
`--rss-interval-ms 20` (up to 1,000).

For the macOS acknowledgement investigation (#666), `--phase-trials 3` through
`10` adds that many alternating core/AOT trace and uninstrumented control
pairs after the normal timed launches. It requires the core adapter. Each
traced launch writes its own bounded host phase trace and an analysis under
`launches/`; the extra launches do not enter the normal summary or regression
gate. The analysis rejects missing or truncated traces and unexpected batch
sequences. Read-to-foreground timing starts after the worker decodes and validates
the command; it includes channel enqueue, backpressure and foreground scheduling.
Previous-yield overlap counts only time after that read and before the preceding
explicit timer resumed; overlap is correlation, not proof of causation.
Host preflight-to-reply-enqueue duration is only one part of the
application's acknowledgement interval: the remainder combines scheduling,
transport and application work, and neither interval measures presentation.
The gap from the previous host reply to the next host batch and the intervening
render count provide correlation only: the gap starts before the application
submits the next request, so it is not an acknowledgement-time breakdown.
Compare trace and control results to assess instrumentation overhead before
interpreting a trace. The compact export omits diagnostic launch files; retain
the raw run directory or workflow artifact.

The `Benchmark comparison` workflow exposes `phase-trials` for dispatch on
macOS only. Its default is zero, so scheduled and ordinary PR comparisons do
not add diagnostic launches. For an isolated diagnostic dispatch, `macos-only`
skips the Linux and Windows jobs; their results are not implied.

## Export a recorded run

Both paths must be absolute, and the destination must not exist yet:

```sh
bun benchmarks/comparison/export.ts "$out" \
  "$PWD/benchmarks/comparison/results/<platform>-<renderer>-<date>"
```

The export writes `comparison.json` and `launches.jsonl.gz` (every raw child
report plus the tail of its stderr log). Write the run's README by hand from the
printed table and the recorded environment.

## Gate a run against the committed baseline

```sh
bun benchmarks/comparison/metrics.ts export "$PWD/benchmarks/comparison/results/<run>" \
  --output /tmp/metrics.json [--streaming RESULT.json ...]
bun benchmarks/comparison/metrics.ts gate /tmp/metrics.json benchmarks/comparison/baselines
```

`gate` exits 1 on a stable regression or a missing metric and 0 when no
baseline has the run's environment label.
