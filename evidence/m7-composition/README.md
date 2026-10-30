# M7 windowed composition resource observations

One designated warmup and three subsequent independent trials passed on
2026-10-29 using the fixed [composition protocol](../../docs/composition-measurement.md).
All four attempts are retained; there were no failed attempts in this cohort.
The warmup attempt is excluded from the recorded-trial tables below. Each
recorded attempt still contains the protocol's own two-second warmup phase.

This is a **descriptive windowed-CEF baseline** with `performanceEligible: false`.
It does not establish a performance improvement, an RSS bound, GPU utilization,
a renderer comparison, physical input or hardware qualification. The static
pages do not measure the separate interactive workbench overlay change in PR #170.

## Source, artifact and equipment identity

| Identity | Recorded value |
| --- | --- |
| Application/measurement source | `6349e7527220a44fc75356090210fa9eebd656e9` |
| Application source tree | `d9c4501b957564173ae4b865fc1f973f561aeb93` |
| Declared native build source | `9200034a2e7232a3f2f49ea1f61e8b7e8cdb85bf` |
| Matching native tree | `287b418ed4e7dba5df106276baa2f1da3e71c596` |
| Original native host SHA-256 | `e71a3157936346d385c39aedcdfd480301da3e862aa97c113a237b587c5456f4` |
| Prepared native host SHA-256 | `44b2e6fd08e11112368f74dbcff8e04a34712d07295c42309f8a04f8f46f4e56` |
| Packaged Bun | `1.4.4`; SHA-256 `0d5af21485ade43e49366435d7010ab9cea7a162d5a0d3db3afe31e39d68717d` |
| Exported runtime | CEF 156.0.7 / Chromium 156.0.8078.17 |
| CEF binary SHA-256 | `d639aafd8cb6dbe7b1aedb7da575d71ce9195c22254345f9ebf54a6260ca9902` |
| Equipment | Mac14,5; Apple M2 Max; 64 GiB memory; arm64; AC power |
| OS | macOS 26.7.1, build 25G241 |
| Display | Screen Sharing Virtual Display; 3840 × 2160 backing pixels; 1920 × 1080 logical pixels at 60 Hz; no physical panel observed |
| Conditions | Thermal state unobserved; no quiet-machine/thermal gate; unrelated machine activity uncontrolled |

The native build source is an operator declaration checked against the local
Git tree, not embedded binary build attestation. Complete file inventories
are retained in each export. Runtime sandbox identity remains `unverified`.
Each attempt used a fresh private prepared app/cache; OS disk caches were not
cleared, so this is not a cold-start cohort. Equipment was recorded at
`2026-10-29T16:19:16Z`; the four attempts ran from approximately 16:26:08 to
16:27:56 UTC. No concurrent Bunly build/test was intentionally scheduled,
but the observed load averages below demonstrate that a quiet machine was
not established.

## Recorded trials

Observer duration covers the observed app lifetime; driver duration also
includes preparation and surrounding verification. Load averages are the
machine-wide one-, five- and fifteen-minute values, not Bunly CPU percentages.

| Trial | Observer duration (s) | Driver duration (s) | Load before (1 / 5 / 15 min) | Load after (1 / 5 / 15 min) |
| --- | ---: | ---: | --- | --- |
| recorded-1 | 23.240 | 26.995 | 10.94 / 10.90 / 9.21 | 12.25 / 11.27 / 9.40 |
| recorded-2 | 23.185 | 26.781 | 12.25 / 11.27 / 9.40 | 10.62 / 10.96 / 9.35 |
| recorded-3 | 23.124 | 26.830 | 10.62 / 10.96 / 9.35 | 8.68 / 10.50 / 9.22 |

### Process resources by phase

CPU is the sum of adjacent sample deltas for the same PID **and creation
time** within a phase. It excludes setup, cleanup, boundary-crossing intervals
and unmatched birth/exit intervals. The unmatched column counts those
process intervals, not whole runs. Their CPU is unobserved, not zero.
RSS is summed process RSS in MiB (1,048,576 bytes), can count shared pages
more than once, and is not GPU memory. The manifest retains exact values,
sampled spans, matched interval counts and peak observed process counts.

#### recorded-1

| Phase | Samples | Sampled CPU (s) | RSS median / p95 / max (MiB) | Sampled span (ms) | Largest sample gap (ms) | Unmatched intervals |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| warmup | 46 | 0.182244 | 756.9 / 882.2 / 882.2 | 1953.3 | 47.4 | 0 |
| idle | 84 | 0.104098 | 881.5 / 886.0 / 886.0 | 3969.3 | 51.9 | 0 |
| resize | 83 | 0.355801 | 892.2 / 895.2 / 896.0 | 3930.1 | 50.6 | 0 |
| overlay | 93 | 0.151664 | 900.4 / 901.2 / 901.4 | 3971.5 | 50.0 | 0 |
| recreate | 90 | 0.803163 | 898.0 / 900.3 / 900.3 | 3973.8 | 50.8 | 29 |
| recovery | 82 | 0.030078 | 895.9 / 900.4 / 900.4 | 3943.1 | 87.4 | 0 |

#### recorded-2

| Phase | Samples | Sampled CPU (s) | RSS median / p95 / max (MiB) | Sampled span (ms) | Largest sample gap (ms) | Unmatched intervals |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| warmup | 47 | 0.189174 | 758.3 / 882.2 / 882.2 | 1976.9 | 48.6 | 0 |
| idle | 83 | 0.129541 | 881.6 / 886.0 / 908.8 | 3957.0 | 64.7 | 2 |
| resize | 84 | 0.378249 | 892.2 / 895.4 / 896.0 | 3939.3 | 50.8 | 0 |
| overlay | 93 | 0.156640 | 894.5 / 895.8 / 895.8 | 3961.5 | 49.2 | 0 |
| recreate | 91 | 0.790939 | 892.0 / 893.2 / 893.3 | 3952.8 | 49.7 | 29 |
| recovery | 84 | 0.053687 | 888.3 / 892.7 / 892.7 | 3984.9 | 54.4 | 0 |

#### recorded-3

| Phase | Samples | Sampled CPU (s) | RSS median / p95 / max (MiB) | Sampled span (ms) | Largest sample gap (ms) | Unmatched intervals |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| warmup | 46 | 0.195416 | 759.8 / 883.7 / 883.7 | 1975.1 | 48.2 | 0 |
| idle | 83 | 0.136660 | 883.4 / 887.7 / 944.7 | 3959.3 | 109.6 | 4 |
| resize | 82 | 0.421207 | 893.8 / 897.4 / 898.2 | 3944.1 | 74.0 | 0 |
| overlay | 94 | 0.163259 | 896.1 / 897.1 / 897.1 | 3958.9 | 49.3 | 0 |
| recreate | 89 | 0.866172 | 893.7 / 895.1 / 895.1 | 3942.8 | 73.3 | 30 |
| recovery | 84 | 0.061302 | 889.6 / 894.1 / 894.1 | 3982.7 | 53.0 | 0 |

Process churn during recreation leaves unmatched intervals in every recorded
trial. The idle phase also has unmatched intervals in recorded-2 and recorded-3.
Do not interpret the CPU column as complete phase CPU or pool these
correlated samples into a larger independent trial count. No confidence
interval, CPU percentage, process-memory limit or before/after gain is inferred.

### API operation and native readback durations

These durations are API round trips including native readback. Recreation
also includes disposal, document readiness and rebuilding the view hierarchy.
They are not frame presentation, paint, pointer-to-pixel or keyboard latency.
The p95 values below summarize only the fixed operation count in each phase;
in particular, recreation has four operations per trial.

| Trial | Phase | Operations | Median (ms) | p95 (ms) | Maximum (ms) |
| --- | --- | ---: | ---: | ---: | ---: |
| recorded-1 | resize | 40 | 4.634 | 11.218 | 12.003 |
| recorded-1 | overlay | 16 | 8.454 | 21.780 | 23.459 |
| recorded-1 | recreate | 4 | 195.129 | 206.739 | 208.747 |
| recorded-2 | resize | 40 | 1.542 | 4.827 | 5.615 |
| recorded-2 | overlay | 16 | 9.501 | 22.836 | 23.374 |
| recorded-2 | recreate | 4 | 195.657 | 197.602 | 197.837 |
| recorded-3 | resize | 40 | 2.730 | 5.586 | 24.559 |
| recorded-3 | overlay | 16 | 4.500 | 17.383 | 17.700 |
| recorded-3 | recreate | 4 | 195.732 | 263.935 | 274.630 |

All attempts passed the unchanged observer/native deadlines, ordered phase
and operation receipts, source/artifact integrity, native shutdown, output
drain and process/helper cleanup gates. Logical native view/session retirement
does not establish GPU-memory release or RSS returning to an earlier value.

## Separate instrumented GPU observation

A fifth native attempt passed on the same application/native source and equipment
under **xctrace 27.0 (27A266a), Metal System Trace, Deferred mode**. It is excluded
from the four ordinary CPU/RSS attempts: discovery/tracing overhead is
unquantified, and this is one instrumented observation rather than another
independent ordinary trial.

The [allowlisted GPU summary](gpu-summary.json) records target GPU-process PID
40485 with creation time 1793291331.618769, matched to 507 native observer samples
by PID, birth and role. The retained trace records identify that exact target
PID. Capture ran from `2026-10-29T12:28:53.998-04:00` to
`2026-10-29T12:29:10.079-04:00`, with reported duration 16.080359 seconds
(requested limit: 15 seconds). It covers only part of the workload and is not
aligned with the application's phase clock; no per-phase GPU result is inferred.

Of 50,883 inspected GPU interval records, 504 target records were retained and
50,379 other records were excluded. The selected records report `Active` state
on the following channels. Values are unions of overlapping intervals **within
each channel**, not GPU utilization or a sum of all renderer/device work:

| GPU channel | Attributed records | Observed active interval union (ns) |
| --- | ---: | ---: |
| Compute | 28 | 543875 |
| Fragment | 240 | 5693048 |
| Vertex | 236 | 3943084 |

The same capture contains 238 target `MTLDevice.currentAllocatedSize` records,
ranging from 8,830,976 to 40,714,240 bytes. This is reported allocated Metal
device memory for the app, not resident GPU memory, complete process/device
footprint or proof of final GPU-memory release. Nested events and concurrent
channels overlap; do not sum them into a device utilization percentage.
No hardware counter set or shader timeline was enabled. Full display-pipeline
cost, frame/presentation latency, physical-display behavior and a matched OSR
comparison remain unqualified.

Only the allowlisted target-event JSON, summary and sanitized native report are
retained here. Raw trace/XML/TOC files contain environment/device and other-process
metadata and remain private. Their digests and the private trace inventory digest
are recorded in the summary; those hashes do not independently reproduce the
selection from a publicly available raw trace. The target-event archive supports
checking record counts, interval unions and allocation extrema. It does not
establish exhaustive capture or independent provenance of omitted raw records.

## Retention and replay

The [manifest](manifest.json) separately records original report, expanded
export and compressed archive sizes and SHA-256 digests. Exports use the
maintained `scripts/export_native_evidence.py` nonce/correlation sanitizer,
then replace composition-worktree, native-build-worktree, developer-checkout
and home prefixes with explicit markers. Outcomes, sample counters, receipts,
durations, source hashes and artifact inventories remain unchanged. Gzip
archives use an mtime of zero. Raw reports and the driver manifest remain
private; no raw command arguments or machine-local prefixes are published.

From the repository root with the historical source/native Git objects
already present, verify hashes and extract the four ordinary native exports,
the separate instrumented native export and the allowlisted target events:

```sh
python - <<'PY'
from pathlib import Path
import gzip, hashlib, json
root = Path('evidence/m7-composition')
manifest = json.loads((root / 'manifest.json').read_text())
output = Path('.bunly/composition-retained')
output.mkdir(parents=True, exist_ok=True)
supplement = manifest['supplementalGpu']
rows = manifest['runs'] + [supplement['nativeReport'], supplement['targetEvents']]
for row in rows:
    archive = (root / row['archive']).read_bytes()
    assert len(archive) == row['archiveBytes']
    assert hashlib.sha256(archive).hexdigest() == row['archiveSha256']
    expanded = gzip.decompress(archive)
    assert len(expanded) == row['expandedBytes']
    assert hashlib.sha256(expanded).hexdigest() == row['expandedSha256']
    (output / (row['id'] + '.json')).write_bytes(expanded)
PY
for trial in warmup recorded-1 recorded-2 recorded-3 gpu-instrumented-native; do
  bun run qualify:desktop --verify ".bunly/composition-retained/$trial.json" || exit
done
```

Replay launches no native app, downloads no artifact and reconstructs no
private correlation nonce. It checks the historical source/native tree,
runtime and artifact identities, workload/resource acceptance and ordinary
cleanup. The retained exported reports are accepted independently.

## Remaining qualification

GPU utilization and resident GPU memory remain unqualified. The separate partial
trace supplies attributed GPU intervals and allocated Metal device memory only;
it does not fill the hardware-counter, full-workload or physical-display gaps.
It remains outside the ordinary CPU/RSS cohort and does not make any result
performance-eligible.

Physical keyboard/pointer/Tab routing, IME, screen-reader semantics, hardware
DPI/multi-monitor behavior and overlay/menu/dialog interaction remain open.
No OSR implementation or matched renderer comparison was run. Keep #35 open;
an OSR prototype should follow a concrete limitation or measured resource
problem, followed by a matched comparison and the applicable physical records.
