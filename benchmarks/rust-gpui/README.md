# Direct Rust GPUI baseline (#244)

[`native/gpui-host/examples/workload-baseline.rs`](../../native/gpui-host/examples/workload-baseline.rs)
is the matched renderer workload (`benchmarks/solid/workload.ts`) written as an
ordinary GPUI application: no Bun, no protocol, no IPC and no retained native tree.
It answers "what would this cost if it were written directly in Rust GPUI", next to
the Bun Native core, Solid and React adapters in
[`benchmarks/comparison`](../comparison/README.md).

**Equivalent:** window title and 640×720 size; the element tree the host paints for
the core adapter (box > box with column, gap 8, padding 16 > text label, button,
column list > keyed text rows at font size 12), with the host's default button look
and AccessKit roles; 20 warmup updates; 1,000 label updates, 100 coalesced groups of
10, 1,000 keyed rotations and 100 mount/update/dispose cycles. The runner rejects a
report whose mutation counts, phase sample counts, final painted label or row count
differ from the requested workload.

**Not equivalent:** there is no host acknowledgement. Each operation mutates view
state and calls `notify` (`apply`), then yields one foreground turn so input and
frames can run (`turn`), which is what the host does between commands. `apply` is the
nearest analogue of the Bun Native acknowledgement, but the acknowledgement also
includes IPC, JavaScript and tree preparation, so the two measure different things.
`--paint-samples N` adds a separate phase that waits for the GPUI paint of each
revision (`toPaint`); it is frame-paced, adds wall time, and is 0 by default so
process wall and CPU time stay comparable. `viewMounted` is the state applied;
`firstPaint` is the first GPUI paint of the mounted view.

## Build and run

```sh
cargo build --locked --release -p bun-native-host --example workload-baseline
out=$(mktemp -d)/rust-gpui   # must not exist yet
xvfb-run --auto-servernum --server-args='-screen 0 1280x800x24 -nolisten tcp' \
  dbus-run-session -- bash scripts/quality/native-linux-session.sh \
  "$(mktemp -d)/session" -- \
  bun benchmarks/rust-gpui/run.ts \
  --binary "$PWD/target/release/examples/workload-baseline" --output "$out" --trials 5
```

On macOS run it without the display session. Options: `--trials 3..30`,
`--iterations`, `--rotations`, `--mounts`, `--rows` (same bounds as the shared
workload), `--rss-interval-ms` and `--paint-samples 0..1000`. The runner launches one
`first` process, reported separately, then `--trials` measured processes, never
retrying a failure. It records spawn to window opened, view mounted and first paint;
process wall time; CPU time (`wait4` user plus system) and CPU per wall second; and
sampled peak process-tree RSS. `rust-gpui.json` holds every launch, the summary with
bootstrap median intervals (as in the comparison), the binary hash and the
environment. The Linux benchmark workflow runs it after the Bun Native comparison on
the same runner.

## Recorded result

Linux x64 container (4 vCPU Xeon @ 2.10 GHz, 16 GB), Xvfb + llvmpipe, rustc 1.98.1,
default workload, `--trials 5`, run on 2026-11-07. The Bun Native column is a matched
`benchmarks/comparison` run on the same machine the same day (pinned Bun
`1.4.4-canary.1+b1007f117`, release host `51208bf9…`, default workload, `--trials 5`).
Both runs used the same display session script, but not the same minute, so treat small
differences as noise. Medians of the measured launches; the records are in
[`results/linux-x64-xvfb-2026-11-07`](results/linux-x64-xvfb-2026-11-07)
(`rust-gpui.json.gz`; `rust-gpui-paint.json.gz` is the `--paint-samples 100` run).

| Metric                      | Rust GPUI | Bun Native core AOT |    Solid AOT |    React AOT |
| --------------------------- | --------: | ------------------: | -----------: | -----------: |
| Spawn to window opened (ms) |       109 |                 111 |          109 |          112 |
| Spawn to view mounted (ms)  |       109 |                 114 |          111 |          127 |
| Spawn to first paint (ms)   |       139 |        not recorded | not recorded | not recorded |
| Process wall (ms)           |       189 |                 872 |        1,073 |        1,284 |
| CPU time (ms)               |       212 |                 921 |        1,189 |        1,451 |
| CPU per wall second         |      1.10 |                1.06 |         1.11 |         1.12 |
| Peak process-tree RSS (MB)  |       125 |                 159 |          161 |          162 |
| Signal update (ms, median)  |  0.0003 † |              0.10 ‡ |       0.11 ‡ |       0.19 ‡ |
| Mount/update/dispose (ms)   |   0.013 † |              1.07 ‡ |       1.61 ‡ |       1.80 ‡ |

† `apply`: state mutation plus `notify`, no acknowledgement. One yielded foreground
turn adds about 0.003 ms. ‡ Host acknowledgement, which also includes IPC,
JavaScript and tree preparation. The two columns measure different things; see
"Not equivalent" above.

Executable: 28.3 MB for the Rust example (`98299a44…`), against a 72.0 MB core AOT
application plus the 32.1 MB host for Bun Native. Mutation to GPUI paint
(`--paint-samples 100`) has a median of 16.0 ms, the 60 Hz frame interval, so it is
bounded by frame pacing rather than by the update.

Reading: startup to a mounted view is about the same, because both are dominated by
GPUI and the display connection. The Bun Native cost is in the workload: about 0.7 s
more wall time and CPU for 2,100 acknowledged updates and 100 lifecycles, which is
the per-update IPC and JavaScript cost, plus about 35 MB of RSS for the Bun runtime.
This is one llvmpipe container, not a hardware GPU; macOS and Windows have not been
measured.
