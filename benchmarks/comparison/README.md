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

## Paired Linux development input investigation

The manual `paired-only` dispatch builds the fixed main and PR revisions named
in the workflow, then runs 20 alternating fresh-process Core development
clicks per variant in one X11 session. Each source gets its own release host and
bundled development module; the controller hashes both hosts, both modules and
the shared Bun runtime before and after launches. It requires matching native
paint trees and renderer, OS-injected input and clean shutdown. It reports every
launch and within-pair differences; a failed launch fails the comparison.

```sh
gh workflow run benchmark-comparison.yml --ref <candidate-branch> -f paired-only=true
```

The pinned pair tests the PR against its `main` base, not the older separately
measured gate baseline. Update the revisions deliberately before assessing
another candidate; the result alone cannot explain the historical gate failure.
It measures XTest command start to observed native paint, including driver and
observation overhead, not physical input or display latency. Runner load and
cache are uncontrolled. The reusable paired driver still supports AOT mode;
development and AOT timings must not be combined.
