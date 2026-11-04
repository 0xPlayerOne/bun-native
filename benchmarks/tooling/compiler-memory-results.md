# Compiler memory control: one declared Linux run

All four cases in the [predeclared plan](compiler-memory.md) completed their
exact bundle counts and cleanup checks. This is a successful functional control,
with observed memory growth; it does not close the resource investigation in
[#372](https://github.com/0xPlayerOne/bun-native/issues/372) or the watcher
acceptance in [#243](https://github.com/0xPlayerOne/bun-native/issues/243).

The bundling and validation loop increased RSS without executing an application
or native host. In the 1,001-call processes, most of the increase occurred early;
the final 500 observations had much smaller fitted slopes than the early
quarters. Those finite samples establish neither a lasting plateau nor
unbounded growth. They also do not identify which compiler, runtime, allocator
or measurement allocation contributed to the earlier native observations.

## Exact execution and integrity

The plan was published as draft [#378](https://github.com/0xPlayerOne/bun-native/pull/378)
before execution. The clean execution checkout was
[`ed89bb7660085ded2641ed2884f6535dcc20e8c1`](https://github.com/0xPlayerOne/bun-native/commit/ed89bb7660085ded2641ed2884f6535dcc20e8c1),
tree `a791b8ae6dd37cd4796a6d40cf4a8d1968ffab4c`. Its compiler inputs remain the
declared 8acd baseline. The supervisor verified all 494 tracked file hashes and
the compiler hash before and after the run. Result files were added only after
all four children had exited and that comparison passed.

The pinned Bun executable was 138,468,432 bytes, full revision
`da867c60bf0bcbf9d6d36994f8ca0efa42075115`, SHA-256
`fe406996b9915f388e3fad9e6e29ece9c7cb81e06257bbcb4c50f91691b46810`.
The environment reported Linux 6.18.57, x86_64, nine logical CPUs and Python
3.12.14. Cache state, other system load and CPU scheduling were uncontrolled.
The exact command, paths, timestamps and platform fields are in the
[portable receipt](evidence/compiler-memory-ed89-linux.json).

The single sequence ran from 20:08:58.120514 to 20:09:35.323101 UTC on
November 4, 2026, taking 37.203 seconds overall. It contained exactly 2,204
successful bundle calls across four fresh Bun processes, in the declared order.
Each child exited with status 0 and was joined before the next case. No child
required termination. Each validated output had exactly two current source
tokens, a unique source and module hash, the expected module and source map, and
one settled generation directory. The supervisor exited 0 after both owned
temporary roots were removed. All four worker stderr files were empty.

There were no retries, extra cases, application executions, native windows,
watch callbacks, malformed edits, explicit GC calls, heap walks or collector
setting changes. The existing 180-second case bounds and 900-second overall
budget were unchanged. These functional checks introduce no memory threshold.

## RSS observations

All memory values below are bytes. “First” and “last” are observations after the
first and final validated bundle; the maximum is across those bundle
checkpoints, not an asynchronously sampled peak. Final cleanup left the last
reported RSS unchanged in three cases. Solid's 1,001-call process reported
192,389,120 bytes after cleanup, a decrease of 143,360 from its last bundle.
That separate final checkpoint is retained in the receipt and is not included
in the bundle-window statistics below.

| Case               | Before compiler imports | First bundle | Last bundle |     Maximum | Worker elapsed |
| ------------------ | ----------------------: | -----------: | ----------: | ----------: | -------------: |
| Solid, 101 calls   |              22,257,664 |   88,817,664 | 166,232,064 | 167,559,168 |        1.773 s |
| React, 101 calls   |              21,733,376 |   79,806,464 | 178,339,840 | 179,257,344 |        2.281 s |
| Solid, 1,001 calls |              21,733,376 |   83,234,816 | 192,532,480 | 196,468,736 |       12.407 s |
| React, 1,001 calls |              22,142,976 |   79,519,744 | 229,953,536 | 237,023,232 |       20.414 s |

The 101-call Solid and React processes ended 77,414,400 and 98,533,376 bytes
above their first bundle observations. Their final 50 fitted slopes remained
positive: about 286,602 bytes/call for Solid (R² 0.846) and 175,557 for React
(R² 0.534). The separate longer processes are needed to describe what happened
beyond that short window; they are not continuations of the 101-call processes.

For the 1,001-call cases, the four chronological quarters contain 250, 250, 250
and 251 samples:

| Framework | Quarter         |  Median RSS | Fitted bytes/call |
| --------- | --------------- | ----------: | ----------------: |
| Solid     | Calls 1–250     | 169,021,440 |        +192,715.8 |
| Solid     | Calls 251–500   | 179,656,704 |         +70,507.5 |
| Solid     | Calls 501–750   | 192,077,824 |         −24,472.5 |
| Solid     | Calls 751–1,001 | 192,380,928 |         +17,849.5 |
| React     | Calls 1–250     | 180,711,424 |        +242,288.9 |
| React     | Calls 251–500   | 208,633,856 |         +65,859.1 |
| React     | Calls 501–750   | 228,093,952 |          +8,633.2 |
| React     | Calls 751–1,001 | 224,866,304 |          −6,764.6 |

The final 500 samples (calls 502–1,001) give a different description from the
short final 50 samples:

| Case and interval     | Minimum RSS | Maximum RSS | Endpoint change | Fitted bytes/call |       R² |
| --------------------- | ----------: | ----------: | --------------: | ----------------: | -------: |
| Solid 1,001, last 500 | 185,237,504 | 196,468,736 |      −1,675,264 |            −346.8 | 0.000577 |
| Solid 1,001, last 50  | 191,889,408 | 194,514,944 |      −1,982,464 |         −18,281.6 | 0.325209 |
| React 1,001, last 500 | 206,401,536 | 237,023,232 |     +10,825,728 |          −5,323.8 | 0.018760 |
| React 1,001, last 50  | 216,752,128 | 229,998,592 |      +5,300,224 |        +148,244.9 | 0.493846 |

React's last-500 endpoint rose even though the fitted slope was slightly
negative: the intervening samples are not a straight line. Reporting both
preserves that distinction. These are descriptive least-squares fits with no
statistical acceptance threshold or extrapolation beyond the retained run.

## Other counters and interpretation limits

The raw rows and receipt retain all five `process.memoryUsage()` fields:
`rss`, `heapTotal`, `heapUsed`, `external` and `arrayBuffers`. They include
observations before compiler imports, after initialization, after each bundle
and after final cleanup. Every field has start/end/minimum/maximum, quarter and
late-window summaries in the receipt.

The runtime reported `heapUsed` greater than `heapTotal` in some rows. Those
values are preserved unchanged under their original field names; this report
does not assume an accounting relationship between them or infer a retaining
object from their difference. For example, in the longer Solid case the
reported `heapUsed` ranged from 7,192,061 to 35,287,804 bytes and ended at
30,547,665; React ranged from 7,194,781 to 17,563,898 and ended at 12,667,035.
Counter drops were observed without instrumenting collection events, so they
are not labeled as particular GC activity.

Both framework processes load the shared Solid/Babel dependency path. Only the
Solid branch invokes the Babel transform. Source editing, output validation,
hashing and synchronous JSONL logging also allocate within the measured
process. The result therefore narrows the investigation to a loop that needs
no app or native host; it does not isolate Bun bundling from Babel or the
measurement work, rank the frameworks' production memory use, or explain a
native retaining root.

The [earlier native RSS projection](evidence/native-controller-a39-ca3.json)
remains a separate hosted outcome with different process cadence,
instrumentation and workload. This local control cannot be subtracted from
that run to estimate a native or watcher contribution. It includes neither the
malformed-edit control nor the full DevSession/watch lifecycle. No product
change or resource acceptance closure follows from these measurements alone.

## Raw evidence

[The portable archive](evidence/compiler-memory-ed89-linux.tar.gz) preserves
every byte of the original `started.json`, final `result.json`, and all four
worker JSONL/stderr/result files: 14 regular-file members in total. The 2,216
JSONL records occupy 1,747,257 uncompressed bytes. The archive is 478,450 bytes,
SHA-256 `bc412436bf19d5431bfb48e4e5e11fc4e8de98148cee60b03a23b138c28a9693`.
Its member lengths and hashes were verified against the original files after
compression and are listed in the receipt. The complete 494-file measured
source inventory is in the archived final result.

The archive uses relative member names and contains no executables or emitted
application modules. Output hashes prove what the live validator inspected;
removed module bytes cannot be reinspected from this archive. The unmodified
declared harness, complete raw rows, original statuses and explicit limitations
are retained together for subsequent analysis without rerunning the workload.
