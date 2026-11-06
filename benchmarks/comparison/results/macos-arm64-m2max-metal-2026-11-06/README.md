# macOS arm64 / Apple M2 Max (Metal) comparison, 2026-11-06

One run of `benchmarks/comparison/run.ts --trials 5` with the default workload
(1,000 individual updates, 100 coalesced groups, 1,000 keyed rotations of 32
rows, 100 mount/update/dispose cycles). Status `passed`: 6 first launches, 6
calibrations and 30 measured launches, none failed, none retried. All six
calibrations painted the same trees on the same renderer.

- Hardware: Apple M2 Max (12 logical CPUs), macOS 27.2 (26B123), Xcode 27.2, on AC
  power. The renderer is the real Metal device (`CAMetalLayer.device`
  `Apple M2 Max`, registry id 4294968434). The display was a Screen Sharing
  virtual display (3840x2160, 1920x1080 logical).
- Bun `1.4.4-canary.1+da867c60b` (pinned), rustc and cargo 1.98.1. Host built with
  `cargo build --locked --release -p bun-native-host`: 9,238,912 bytes, SHA-256
  `c9b44a3e5e307b19254cf9c654a42e7f28086feda7dc04790cfc2ed43fbbf22a`.
- Source: `main` at `59cc47a` plus the macOS RSS/load changes to `run.ts` in this
  change, so `comparison.json` records `dirty: true` and the exact file digests.
- Other load was uncontrolled; nothing else heavy ran during the launches. Page
  cache and power state were not controlled.

These numbers describe this Mac only. RSS is sampled with `ps` every 20 ms (peaks
can be missed; shared pages count per process). The host RSS is the Metal window
and GPUI host; it is not comparable with the llvmpipe Linux record.

`tables.md` has the full per-launch and pooled tables. `comparison.json` and
`launches.jsonl.gz` hold the raw reports. The Electrobun WebView baseline for the
same workload is in [`benchmarks/electrobun`](../../../electrobun/README.md).

## Per-launch medians (95% bootstrap interval)

| Metric (median [95% CI])         | core/development           | core/aot                   | solid/development          | solid/aot                  | react/development          | react/aot                  |
| -------------------------------- | -------------------------- | -------------------------- | -------------------------- | -------------------------- | -------------------------- | -------------------------- |
| spawn to view mounted (ms)       | 542.48 [451.04, 612.27]    | 528.71 [426.37, 537.28]    | 574.93 [533.99, 664.40]    | 530.36 [484.10, 592.57]    | 511.81 [403.96, 720.56]    | 500.29 [395.87, 542.88]    |
| process wall (ms)                | 1837.57 [1667.25, 1997.44] | 1827.36 [1445.26, 2005.82] | 2097.26 [1956.45, 2832.98] | 2093.11 [1657.69, 2254.58] | 2199.46 [1837.96, 3162.70] | 1836.11 [1575.00, 1955.06] |
| peak tree RSS (MB)               | 154.0 [152.7, 154.7]       | 128.6 [126.1, 129.9]       | 161.2 [159.9, 162.5]       | 129.9 [129.6, 131.9]       | 200.7 [196.2, 203.1]       | 132.8 [132.6, 133.1]       |
| peak app RSS (MB)                | 55.3 [54.4, 55.5]          | 29.9 [27.3, 31.1]          | 62.5 [61.2, 63.5]          | 31.5 [30.8, 33.3]          | 102.1 [96.6, 104.2]        | 34.2 [33.8, 34.4]          |
| peak host RSS (MB)               | 98.7 [98.5, 99.4]          | 98.7 [98.5, 98.8]          | 98.6 [98.6, 99.0]          | 98.6 [98.6, 98.8]          | 98.7 [98.7, 99.5]          | 98.7 [98.4, 98.8]          |
| update ack median (ms)           | 0.15 [0.14, 0.20]          | 0.16 [0.11, 0.18]          | 0.21 [0.17, 0.26]          | 0.18 [0.12, 0.21]          | 0.23 [0.18, 0.42]          | 0.19 [0.15, 0.22]          |
| rotation ack median (ms)         | 0.10 [0.09, 0.13]          | 0.09 [0.08, 0.13]          | 0.15 [0.13, 0.20]          | 0.14 [0.11, 0.19]          | 0.16 [0.12, 0.21]          | 0.14 [0.11, 0.14]          |
| mount/update/dispose median (ms) | 0.95 [0.91, 1.05]          | 0.72 [0.64, 1.04]          | 1.42 [1.12, 1.60]          | 0.95 [0.72, 1.61]          | 1.60 [1.47, 2.12]          | 0.90 [0.70, 0.97]          |
| measured / failed launches       | 5 / 0                      | 5 / 0                      | 5 / 0                      | 5 / 0                      | 5 / 0                      | 5 / 0                      |

| Pooled operation samples (ms)  | core/development    | core/aot            | solid/development   | solid/aot           | react/development   | react/aot           |
| ------------------------------ | ------------------- | ------------------- | ------------------- | ------------------- | ------------------- | ------------------- |
| signals p50 / p95 / p99        | 0.16 / 2.11 / 4.11  | 0.14 / 2.15 / 4.42  | 0.20 / 2.57 / 7.43  | 0.16 / 2.17 / 4.82  | 0.24 / 2.51 / 7.17  | 0.18 / 2.10 / 4.43  |
| coalesced p50 / p95 / p99      | 0.11 / 2.07 / 5.30  | 0.14 / 2.12 / 4.67  | 0.17 / 2.28 / 4.34  | 0.12 / 2.12 / 4.61  | 0.18 / 2.21 / 4.55  | 0.13 / 2.07 / 4.72  |
| keyedRotations p50 / p95 / p99 | 0.10 / 2.06 / 3.15  | 0.10 / 2.05 / 3.07  | 0.16 / 2.08 / 3.42  | 0.14 / 2.07 / 3.40  | 0.16 / 2.07 / 3.20  | 0.13 / 2.05 / 3.12  |
| lifecycles p50 / p95 / p99     | 0.97 / 6.20 / 19.56 | 0.76 / 5.66 / 18.96 | 1.38 / 8.40 / 29.83 | 0.96 / 5.79 / 10.80 | 1.69 / 8.71 / 24.96 | 0.87 / 5.89 / 19.21 |

| Build | module fresh / rebuild (ms) | AOT compile (ms) | module bytes | AOT bytes |
| ----- | --------------------------- | ---------------- | ------------ | --------- |
| core  | 8 / 4                       | 1193             | 209678       | 55456994  |
| solid | 57 / 11                     | 3523             | 279746       | 56414690  |
| react | 83 / 70                     | 5010             | 289268       | 57421922  |
