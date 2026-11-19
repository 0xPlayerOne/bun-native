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
- `paired.ts`: the ABBA driver for #677. Runs the comparison controller and the
  Electrobun reference in A, B, B, A order — two blocks each, so a session drift
  cancels instead of favouring whichever system ran later — then reports one
  comparison: peak process-tree RSS. Wall time, startup and input timing are
  recorded per block but never ratioed, because the WebView workload is
  vsync-locked and the two sides measure different endpoints. Artifact size, build
  time and CPU are recorded under `recorded` in `paired.json` and each carries an
  explicit reason for not being compared — a Bun Native entry is one AOT
  application per adapter and excludes the release host archive, the Electrobun
  entry is a whole `.app` including its Bun runtime, the Electrobun build runs
  outside the runner, and the two workloads do different amounts of work.
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

## Export a recorded run

Both paths must be absolute, and the destination must not exist yet:

```sh
bun benchmarks/comparison/export.ts "$out" \
  "$PWD/benchmarks/comparison/results/<platform>-<renderer>-<date>"
```

The export writes `comparison.json` and `launches.jsonl.gz` (every raw child
report plus the tail of its stderr log). Write the run's README by hand from the
printed table and the recorded environment.

## Paired comparison with the pinned Electrobun reference

```sh
bun benchmarks/comparison/paired.ts \
  --bun-native 'bun benchmarks/comparison/run.ts --host /abs/host --host-profile release --trials 5 --output {output}' \
  --electrobun 'bun benchmarks/electrobun/run.ts --app /abs/App.app --trials 5 --output {output}' \
  --output /abs/new-paired-run
```

Each command receives a fresh `{output}` directory per block; the driver reads
`comparison.json` or `electrobun.json` from it. It writes `paired.json`, and
`paired.md` when all four blocks produced a record. A missing block is an
incomplete run, never a median over survivors.

## Gate a run against the committed baseline

```sh
bun benchmarks/comparison/metrics.ts export "$PWD/benchmarks/comparison/results/<run>" \
  --output /tmp/metrics.json [--streaming RESULT.json ...]
bun benchmarks/comparison/metrics.ts gate /tmp/metrics.json benchmarks/comparison/baselines
```

`gate` exits 1 on a stable regression or a missing metric and 0 when no
baseline has the run's environment label.
