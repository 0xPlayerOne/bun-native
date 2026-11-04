# Historical bridge comparison: November 4, 2026

This research archive preserves the complete optional
[Native bridge pairs run 41909084030, job 126851516911](https://github.com/0xPlayerOne/bun-native/actions/runs/41909084030/job/126851516911).
All 24 predeclared observations completed with exit 0 and unforced, joined
cleanup. This is a descriptive comparison of two complete historical source
revisions. It does not qualify the EGL/RenderDoc changes proposed by
[PR #374](https://github.com/0xPlayerOne/bun-native/pull/374).

The earlier collection in [archive #381](https://github.com/0xPlayerOne/bun-native/pull/381)
remains failed and its startup cause remains unresolved. The required
[Validation run 41909084088](https://github.com/0xPlayerOne/bun-native/actions/runs/41909084088)
for this PR source also remains failed by React collectability. This optional
historical collection cannot override either failure.

## Exact controller and historical sources

| Identity                    | Recorded value                             |
| --------------------------- | ------------------------------------------ |
| Triggering PR head          | `c4d4c2e74d561ce19621e3e3940469d33bf3f118` |
| Tested controller merge     | `b04503e5f9e741b32ac213e65b2af96715081263` |
| Controller tree             | `7ce2cfdb841f3c616a14a3d6a12a51a3b3c79a25` |
| Equivalent local controller | `38ad4806a4b401294adc7b5460e720739a4627ed` |
| Bun revision                | `da867c60bf0bcbf9d6d36994f8ca0efa42075115` |
| Rust version                | `1.98.1`                                   |
| GPUI revision               | `ba63a022c9a22ca66d68ef2a8f0bb9b5b0a9984d` |

The controller separately prepared the unchanged historical revisions and
compiled their release native hosts and AOT applications before any trial:

| Variant           | Historical source                          | Recorded host bytes | Recorded host SHA-256                                              |
| ----------------- | ------------------------------------------ | ------------------: | ------------------------------------------------------------------ |
| BN1               | `6ea507b58d0249b752ff62691ebc1879f3fcf6da` |          29,000,736 | `bd8ddd9e946b1bf871dd174f975c7f2de75496e55c08780cadf724a150251bdf` |
| Event integration | `4549e75ca5463f136898a2f5fb49d22b58dffa11` |          29,206,960 | `0da2b00aa3095f4dbe48f20cb048c49d99658adc585e2d99394aa3cf41c067d2` |

Neither historical source has the `native/vendor` HAL tree or the root HAL
patch dependency. Neither executed host contains the proposed EGL ownership
or RenderDoc null-pointer changes. The four controller source records and all
49 BN1 / 54 event-integration source records were verified against Git: **107
source records** in total. The source inventories and clean-state receipts are
retained in the original preparation and trial records.

The initial read-only source audit stopped when five public Git blobs were
absent locally. Only those blobs were fetched, and source verification then
passed. The independent audit found all required objects present and disabled
automatic Git fetching. This source-data recovery did not run a workload.
The receipt also records an initial independent audit assumption corrected
for the workload's additional repository-URL metadata; the source bytes and
original outcomes were unchanged.

## Declared sequence and actual outcomes

The fixed plan contains one external warmup for each of the four
variant/mode combinations, followed by five measured pairs per mode:
**four warmups and 20 measured observations**. AB/BA order alternates within
each mode, and the mode block order alternates by pair. Five pairs give one
extra AB pair. Every trial runs in a fresh process; no observation was retried
or selected out of this archive.

Each unchanged historical bridge workload performs its existing 20 request
warmups, 1,000 individual updates, ten batches of 100, and 1,000 native input
entity lifecycles. The retained data contain **24,240 raw timing samples**:
24,000 individual samples and 240 batch samples, including the four external
warmup observations. Paired summaries use only the 20 measured observations.

All 24 workload reports and matching process supervisors passed. Every
application and native host exited with status 0; no forced termination,
remaining observed process, unreaped observed process or discarded log bytes
were recorded. The 24 observed native PID/start-tick identities are distinct.
The recorded finish of each trial precedes the next trial's start. All six
preparation steps likewise passed with unforced exit 0 and joined cleanup.
These bounded lifecycle observations do not establish absence of memory leaks.

## Descriptive paired statistics

The table reports the median of five **within-pair** event-minus-BN1
differences and event/BN1 ratios for each mode. These are medians of paired
statistics, not ratios of pooled medians. Timings measure Bun send to native
UI-thread applied acknowledgement; they exclude display presentation and
physical input latency. Values below are rounded only for display. Every
unrounded sample, percentile, count, pair, difference and ratio remains in the
original ZIP; all 90 paired rows and all 18 metric summaries were independently
recomputed and are also retained in [audit-receipt.json.raw](audit-receipt.json.raw).

| Metric                            | Development median difference | Development median ratio | AOT median difference | AOT median ratio |
| --------------------------------- | ----------------------------: | -----------------------: | --------------------: | ---------------: |
| Individual p50 (ms)               |                      0.003745 |                 1.038486 |              0.004086 |         1.045301 |
| Individual p95 (ms)               |                      0.006210 |                 1.005638 |              0.008439 |         1.007735 |
| Individual p99 (ms)               |                      0.715054 |                 1.120924 |              0.895960 |         1.156395 |
| Individual total (ms)             |                     25.371353 |                 1.096320 |             31.051467 |         1.118250 |
| Individual samples >10 ms (count) |                      0.000000 |                undefined |              0.000000 |         0.000000 |
| Batch p50 (ms)                    |                     -0.000790 |                 0.997413 |              0.002124 |         1.007873 |
| Batch p95 (ms)                    |                     -5.868120 |                 0.159239 |             -0.807247 |         0.684389 |
| Batch p99 (ms)                    |                     -5.868120 |                 0.159239 |             -0.807247 |         0.684389 |
| Batch total (ms)                  |                     -6.483981 |                 0.385825 |             -0.789609 |         0.874507 |

A ratio is undefined when its BN1 denominator is zero. The collector's median
ratio uses only defined pair ratios; an undefined table cell means there were
none. The original pair rows preserve every omitted denominator. For each
10-sample batch group, p95 and p99 both select the maximum sample under the
recorded nearest-rank method.

This is a whole-revision observation on one GitHub-hosted Linux x64 runner
with an AMD EPYC 9V45 CPU and four available CPUs. Power policy, runner load
and OS caches were uncontrolled. Software rendering and a Mesa Vulkan ICD
were explicitly requested, but the uninstrumented historical workloads did
not record the adapter actually selected by GPUI. There is no statistical
significance, causal attribution, presentation/input latency or performance
improvement claim. In particular, the mixed descriptive tail/batch results
cannot be attributed to the proposed vendor patch, which was absent.

## Complete byte-exact archive and limits

[original-artifact.zip](original-artifact.zip) is the original GitHub artifact
`13362158488`, byte-for-byte: **399,025 bytes**, SHA-256
`7bc2f16440cafe00f6bc26382a7f688a014e7ef9172710bcefaaa78ec151be38`.
It contains all **147** original regular UTF-8 text files, totaling **1,611,256
uncompressed bytes**. Every path is safe, unique and relative. Every payload
matches the independently read original and extracted record.

The ZIP preserves all declared trial reports, raw samples, stdout/stderr,
process cleanup observations, exact plan and chronology, source/build
receipts, AOT compile and inspection records, environment information and the
full passed historical summary. No archive member was omitted. Native and
AOT executable bytes were excluded by the original workflow; recorded binary
hashes and inspections cannot be independently repeated from this archive.

[audit-receipt.json.raw](audit-receipt.json.raw) retains the complete original
read-only audit and member hash inventory, the independent review, exact
historical executable identities, source-data recovery details, and every
paired statistic. The original 29,766-byte audit has SHA-256
`deec5a495d721a8c0903527a2462751d42452ba13fab344d7ba0403a77574a25`.
Its parsed data are preserved without changing any field; the `.raw` suffix
protects the authored receipt from source formatting.

The earlier run `41901726297` in #381 had two failed development warmups
(native open request 3 timed out) and 22 subsequent successful observations.
That collection remains failed; the newer collection neither diagnoses nor
repairs those failures. Follow-up [#296](https://github.com/0xPlayerOne/bun-native/issues/296)
tracks startup, and [#297](https://github.com/0xPlayerOne/bun-native/issues/297)
tracks bridge tails and allocations. Neither is closed by this archive.

This research branch changes no runtime, workflow, dependency, deadline,
assertion, GC checkpoint or acceptance rule. Archive preparation only read
records/source and ran normal commit hooks; it executed no native workload,
application, GC experiment, failed job or new CI trial. Preserve the archive
as a draft PR closed without merging. Required current-source validation and
protected-merge gates remain applicable to #374 independently.
