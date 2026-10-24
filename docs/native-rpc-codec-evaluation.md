# Native hexadecimal codec evaluation

**Disposition:** Retain the existing codec. Do not ship this candidate as a
runtime optimization. Native-mediated transport selection is unchanged.

The approved post-M4 pass evaluated replacing the Bun-side byte-by-byte hex loops
with the pinned runtime's `Uint8Array.toHex` / `Uint8Array.fromHex`. The candidate
preserved lowercase-only grammar, 24-KiB packet limits, exact slice ownership and
native authorization. It also tested malformed views and transfer ownership.
No dependency, framing, native source or security-policy change was proposed.

## Actual native measurement

Use the maintained `qualify:cef-transports --native-only --samples 5 --warmups 1`
on each exact source. Four blocks ran in **baseline / candidate / candidate /
baseline** order, with one warmup and five measured launches per block. Baseline
source `69f25e0` has the same tree as merged `05ce81d`; candidate source `cff0c9e`
is retained in PR #106 history. All blocks used the same input native artifact,
pinned Bun 1.4.3 and exported CEF 156.0.7 / Chromium 156.0.8078.17 identity on
macOS arm64. The profiler rebuilt the application backend from the selected
source and verified unchanged source/input/prepared artifacts.

Every one of the **24 launches** passed the exact native transport workload,
ordered shutdown, queue/fragment bounds and verified macOS helper/clone cleanup.
There were 10 measured launches per revision; warmups are excluded below.
Numbers are milliseconds for the **entire workload**, not per-call latencies.
Intervals are the maintained deterministic percentile-bootstrap 95% intervals
for the mean. Raw per-trial metrics, source fingerprints and report hashes are in
[the sanitized record](../evidence/native-rpc-codec-local.json).

| Workload                                | Baseline mean [95% interval] | Candidate mean [95% interval] |
| --------------------------------------- | ---------------------------- | ----------------------------- |
| First authenticated roundtrip           | 4.01 [3.28, 4.86]            | 3.71 [3.22, 4.28]             |
| 100 structured calls, concurrency 16    | 20.41 [19.99, 20.90]         | 21.94 [20.99, 23.04]          |
| 50 binary roundtrips, 65,536 bytes each | 348.91 [341.28, 357.00]      | 339.60 [328.13, 352.67]       |
| 20 cancellations after admission        | 14.59 [14.20, 14.98]         | 14.21 [13.88, 14.58]          |
| Throttled-call workload                 | 11.03 [10.26, 11.89]         | 10.63 [10.20, 10.98]          |

The binary mean was about 2.7% lower, with overlapping intervals. The structured
mean was about 7.5% higher. These mixed whole-path results do not justify retaining
the change simply because an isolated codec microbenchmark was much faster.
The candidate was removed after measurement; no runtime speedup is claimed.

This is a descriptive development-machine experiment, not randomized per-launch
isolation or a quiet-hardware release benchmark. Block order reduces simple
monotonic drift but cannot eliminate machine-load effects. The results do not
establish application startup, graphical terminal latency, memory or power gains,
or an advantage over another framework. They do not erase historical shutdown
failures. Hexadecimal still expands payload bytes by two on either implementation.

## Retained preflight and test-authoring failures

The return-to-baseline wrapper initially selected Bun 1.4.4; the maintained
version guard rejected it **before any native launch**. That failed log remains
retained; the final block used the explicit pinned 1.4.3 executable. No rejected
native launch was replaced or reclassified. Initial codec test-authoring errors
used the wrong assertion matcher and an unnecessarily declared generator; those
were corrected without weakening the protocol tests before measurement.

M5 should prioritize native stream/control integration, actual consumer credit,
producer ownership and representative concurrent-load measurements. Revisit
serialization only when profiling that combined workload identifies it as a
material bottleneck; do not reopen the transport decision from this microbenchmark.
