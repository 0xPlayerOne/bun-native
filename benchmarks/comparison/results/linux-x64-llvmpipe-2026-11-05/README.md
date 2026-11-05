# Linux x64 / Xvfb + llvmpipe comparison, 2026-11-05

This is one local run of `benchmarks/comparison/run.ts --trials 5` with the
default workload parameters: 1,000 individual updates, 100 coalesced groups,
1,000 keyed rotations of 32 rows and 100 mount/update/dispose cycles. Status
`passed`. All 6 first launches, 6 calibrations and 30 measured launches passed.
None failed and none were retried. Every launch did the same native work, and
all six calibrations painted the same initial and final native trees on the
same renderer.

## Environment (as recorded in `comparison.json`)

- Source: harness commit `cbe1473073629dc5bc3e064117b83ce5435a325c` (clean tree),
  branch `feat/bench-comparison` (the PR head before squash).
- Bun `1.4.4-canary.1+da867c60b` (the pinned toolchain), rustc and cargo 1.98.1.
- Native host: built with `cargo build --locked --release -p bun-native-host`.
  It is 30,714,016 bytes, SHA-256 `9f43bfe52ade99e9a5365da01d417c3e66bae5e8c4301f4ba9bd4912d32281ec`.
- Ubuntu 24.04.5 LTS, kernel 6.18.44, 4 logical CPUs (Intel Xeon @ 2.80GHz,
  cloud VM), 16 GB memory.
- Display: Xvfb 21.1.12 in the private `native-linux-session.sh` session. The
  renderer is `llvmpipe (LLVM 20.1.2, 256 bits)` with Mesa 25.2.8 software Vulkan.
- Other load was not controlled. Other agents shared the VM, and the 1-minute
  load average before each launch ranged from 2.41 to 3.69 on 4 CPUs. Page cache
  and power state were not controlled either.

These numbers describe this software-rendered VM only. They are **not**
hardware-GPU, macOS or Windows results. The host RSS mostly reflects llvmpipe.

## Results

Each per-launch metric is the median over 5 fresh processes, with a 95%
percentile-bootstrap interval. The pooled rows describe all operations from the
5 launches together; those operations are not independent samples.

| Metric (median [95% CI])         | core/development           | core/aot                   | solid/development          | solid/aot                  | react/development          | react/aot                  |
| -------------------------------- | -------------------------- | -------------------------- | -------------------------- | -------------------------- | -------------------------- | -------------------------- |
| spawn to view mounted (ms)       | 166.49 [146.70, 183.01]    | 150.93 [139.78, 207.62]    | 197.90 [169.69, 227.84]    | 151.68 [139.68, 171.37]    | 188.64 [180.75, 237.50]    | 145.86 [144.51, 218.65]    |
| process wall (ms)                | 1760.94 [1455.97, 2424.08] | 1441.38 [1304.47, 1606.23] | 2869.56 [2722.11, 2982.24] | 2312.70 [1823.15, 2755.28] | 3777.04 [3172.59, 3863.69] | 2495.86 [2388.33, 3205.98] |
| peak tree RSS (MB)               | 195.1 [194.7, 195.6]       | 182.7 [181.8, 183.2]       | 205.3 [204.1, 206.3]       | 183.2 [182.8, 183.6]       | 238.3 [237.6, 240.6]       | 185.5 [185.2, 185.9]       |
| peak app RSS (MB)                | 44.0 [43.6, 44.4]          | 31.4 [30.9, 31.6]          | 54.0 [53.1, 54.7]          | 32.1 [31.8, 32.5]          | 87.0 [86.3, 89.6]          | 34.5 [34.2, 34.7]          |
| peak host RSS (MB)               | 151.2 [151.0, 151.2]       | 151.0 [151.0, 151.7]       | 151.4 [151.1, 151.8]       | 151.2 [150.6, 151.5]       | 151.4 [151.0, 151.6]       | 151.2 [150.7, 151.6]       |
| update ack median (ms)           | 0.27 [0.20, 0.35]          | 0.17 [0.15, 0.19]          | 0.44 [0.40, 0.46]          | 0.35 [0.27, 0.47]          | 0.63 [0.53, 0.67]          | 0.46 [0.41, 0.54]          |
| rotation ack median (ms)         | 0.20 [0.18, 0.25]          | 0.19 [0.16, 0.20]          | 0.48 [0.43, 0.52]          | 0.41 [0.32, 0.51]          | 0.58 [0.51, 0.59]          | 0.45 [0.43, 0.58]          |
| mount/update/dispose median (ms) | 1.45 [1.10, 2.11]          | 1.24 [1.19, 1.60]          | 2.26 [2.05, 3.09]          | 1.97 [1.73, 2.06]          | 3.27 [2.42, 3.59]          | 2.24 [1.84, 2.57]          |
| measured / failed launches       | 5 / 0                      | 5 / 0                      | 5 / 0                      | 5 / 0                      | 5 / 0                      | 5 / 0                      |

| Pooled operation samples (ms)  | core/development    | core/aot            | solid/development   | solid/aot           | react/development    | react/aot           |
| ------------------------------ | ------------------- | ------------------- | ------------------- | ------------------- | -------------------- | ------------------- |
| signals p50 / p95 / p99        | 0.25 / 1.68 / 8.04  | 0.17 / 1.32 / 6.80  | 0.43 / 5.89 / 8.57  | 0.36 / 2.42 / 7.69  | 0.60 / 7.06 / 9.95   | 0.46 / 5.58 / 7.72  |
| coalesced p50 / p95 / p99      | 0.22 / 1.46 / 7.09  | 0.16 / 1.34 / 6.37  | 0.37 / 5.49 / 7.70  | 0.38 / 1.89 / 7.06  | 0.61 / 6.91 / 8.55   | 0.49 / 5.73 / 7.35  |
| keyedRotations p50 / p95 / p99 | 0.21 / 1.56 / 7.57  | 0.18 / 1.35 / 7.09  | 0.47 / 6.27 / 8.48  | 0.41 / 5.39 / 7.60  | 0.56 / 6.61 / 9.09   | 0.48 / 5.53 / 7.69  |
| lifecycles p50 / p95 / p99     | 1.58 / 8.80 / 11.52 | 1.40 / 8.34 / 10.21 | 2.45 / 9.91 / 11.81 | 1.89 / 8.51 / 10.04 | 3.14 / 11.55 / 14.17 | 2.28 / 8.74 / 10.16 |

| Build | module fresh / rebuild (ms) | AOT compile (ms) | module bytes | AOT bytes |
| ----- | --------------------------- | ---------------- | ------------ | --------- |
| core  | 12 / 15                     | 4134             | 104482       | 71351336  |
| solid | 111 / 28                    | 4060             | 162144       | 71924776  |
| react | 34 / 32                     | 6766             | 220170       | 72940584  |

First launch after build (trial 0, one sample each, warm page cache), spawn to
view mounted, development / AOT: core 207.9 / 140.6 ms, Solid 227.2 / 149.7 ms,
React 212.3 / 212.4 ms.

Selected median ratios with 95% bootstrap intervals (from `summary.comparisons`):

| Candidate vs reference | spawn to mounted  | total workload    | peak app RSS      |
| ---------------------- | ----------------- | ----------------- | ----------------- |
| core AOT vs dev        | 0.91 [0.79, 1.25] | 0.82 [0.59, 1.02] | 0.71 [0.70, 0.72] |
| Solid AOT vs dev       | 0.77 [0.67, 0.90] | 0.81 [0.64, 0.97] | 0.59 [0.59, 0.61] |
| React AOT vs dev       | 0.77 [0.61, 1.16] | 0.66 [0.63, 0.85] | 0.40 [0.38, 0.40] |
| Solid vs core (AOT)    | 1.01 [0.73, 1.20] | 1.61 [1.27, 1.92] | 1.02 [1.01, 1.04] |
| React vs core (AOT)    | 0.97 [0.70, 1.48] | 1.74 [1.54, 2.23] | 1.10 [1.08, 1.12] |

An interval that includes 1.0 means this sample size shows no clear difference.
"Development" runs the bundled module with `bun`. Its artifact does not include
the Bun runtime, while the AOT executable embeds it, so the byte columns do not
compare install sizes.

## Files

- `comparison.json`: provenance, source and artifact hashes, builds,
  calibrations (native trees and renderer), per-launch process observations,
  load averages and the computed summary.
- `launches.jsonl.gz`: every child report verbatim, with all raw per-operation
  samples, heap checkpoints and retention observations, plus the tail of each
  stderr log. Read it with `zcat launches.jsonl.gz | head -1 | jq .report.workload`.
