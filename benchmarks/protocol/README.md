# Protocol encode/decode micro benchmark

`roundtrip.ts` runs the calls `@bun-native/runtime` makes per message, in
process and without IPC, and times each phase separately:

- commands out: `parseCommand` (the runtime revalidates every command) and
  `encodeFrame`, for a full 256-operation `mount` batch (rows of styled
  `box > [text, button]` creates and inserts), a two-`set` `keystroke` batch
  (input value plus a dependent label) and one `large-text` set of a
  12,000 character log;
- events in: one 9,262-byte pipe chunk of 56 frames (pointer down/up, click,
  key down/up and input per keystroke, plus `applied` acknowledgements) through
  a fresh `FrameDecoder.push`, then `parseEvent` over the decoded frames.

```sh
bun benchmarks/protocol/roundtrip.ts [samples=2000]
```

Timings are wall-clock per call in µs with nearest-rank percentiles after 200
warm-up calls. They exclude pipe I/O, native work and core/renderer work.

## Linux x64 result

[Raw records](raw/): source `822086b`, pinned Bun `da867c60`, Linux 6.18 (4 vCPU
cloud container), three processes. Ranges are per-process p50s; means and
p95s are dominated by collections of the large batch's garbage.

| Scenario     | Phase               | p50 µs    |
| ------------ | ------------------- | --------- |
| `mount`      | `parseCommand`      | 33.4–53.8 |
| `mount`      | `encodeFrame`       | 26.1–26.5 |
| `keystroke`  | `parseCommand`      | 0.79–1.10 |
| `keystroke`  | `encodeFrame`       | 0.47–0.85 |
| `large-text` | `parseCommand`      | 1.11–1.50 |
| `large-text` | `encodeFrame`       | 3.83–5.90 |
| 56 events    | `FrameDecoder.push` | 27.9–29.2 |
| 56 events    | `parseEvent`        | 27.1–75.1 |

Nothing here is an outlier against the renderer commit it accompanies: a full
mount batch costs about 0.24 µs per operation to validate and encode, and an
event about 1 µs to frame and validate. `JSON.parse` dominates
`FrameDecoder.push`: decoding the whole chunk with one `TextDecoder` call and
splitting it was measured at the same cost as decoding each frame and was not
adopted. Accepted property names are module-level sets since the
[commit path change](../core/README.md#core-and-runtime-commit-path-micro-benchmark):
on that source the same three processes measured `mount` `parseCommand` at
53.2–65.6 µs (from 76.5–86.5 at `3518b3a`) and 56 `parseEvent` calls at
16.6–17.0 µs (from 23.5–37.6). These inputs are plain objects, so they show the
full validation that foreign values still receive ([`roundtrip-base-*`](raw/) and
[`roundtrip-keysets-*`](raw/), pinned Bun `b1007f117`).

## Native command-frame newline scan

`native/protocol/examples/frame_scan_perf.rs` measures the release Rust
`CommandReader` with valid text-update batches and a reused reader over an
in-memory, bounded `BufRead`. It checks that each frame is consumed completely.
The `small`, `medium`, and `large` cases expose up to 8,192 bytes per refill;
`fragmented` exposes 128. Each process times nine rounds of 5,000 parses per
case, discards the first two rounds, and reports all seven remaining per-parse
round times. This is reader/decoder wall time, including validation and copying;
it excludes real pipe I/O, native UI, Bun, input and presentation.

```sh
cargo run --locked --release -p bun-native-protocol --example frame_scan_perf -- 5000
```

[Raw paired records](raw/native-frame-scan-macos-2026-11-14.json) compare
baseline `1ae30f12007bddcb7d1439aa36eef43b49457c7e` with the `memchr` newline
scan on macOS 27.2, Apple M2 Max, Rust 1.98.1, release with thin LTO. Eight
fresh-process pairs alternated baseline/candidate order; other load and power
were uncontrolled. Values below are medians of per-process medians; the ratio
is the median of within-pair candidate/baseline ratios.

| Case       | Frame bytes | Baseline ns | Candidate ns | Paired ratio |
| ---------- | ----------: | ----------: | -----------: | -----------: |
| small      |         150 |         953 |          802 |        0.821 |
| medium     |       2,182 |       3,229 |        1,808 |        0.554 |
| large      |      12,134 |      14,265 |        6,457 |        0.452 |
| fragmented |      12,134 |      16,513 |        7,177 |        0.436 |

Every measured pair favored the candidate in these cases. `memchr` 2.8.3 was
already in the lockfile and its `std` feature was already enabled by
`serde_json`; it is now a direct protocol dependency. These measurements do
not quantify whole-application speed or justify comparisons with other desktop
shells. Repeated release-host tests on the supported platforms remain useful.

## Borrowed complete command frames

The reader can decode a complete frame directly from the `BufRead` buffer;
fragmented frames still use the bounded accumulation buffer. The command owns
its decoded data before the reader consumes the input. Invalid frames retain
the same consumption and poisoning behavior.

[Raw paired records](raw/native-frame-direct-macos-2026-11-15.json) compare
baseline `8ca85c34492cf48463bab164937d7d2e2da8e038` with the candidate on macOS
27.2, Apple M2 Max, Rust 1.98.1, in release mode. A first 12-pair run used
5,000 parses per round; a second 20-pair run used 10,000. Each pair alternated
process order; other load and power were uncontrolled. The table reports the
second run's median per-process medians, median paired ratio, and candidate
wins. The 8,192-byte reader chunk contains the complete small and medium frames;
large and fragmented frames require accumulation.

| Case       | Baseline ns | Candidate ns | Paired ratio |  Wins |
| ---------- | ----------: | -----------: | -----------: | ----: |
| small      |      347.10 |       343.44 |        0.986 | 15/20 |
| medium     |      782.20 |       750.86 |        0.956 | 20/20 |
| large      |    2,877.59 |     2,851.80 |        0.990 | 17/20 |
| fragmented |    3,118.27 |     3,131.38 |        1.005 |  7/20 |

The first run's paired ratios were 1.008, 0.961, 0.997 and 1.009 respectively.
The medium-frame improvement is consistent in these local reader samples; the
small and fragmented differences are close to noise and include a possible
fragmented-frame cost. This does not measure IPC, native UI, end-to-end latency,
or other platforms. Hosted release-host confirmation remains necessary.

[Hosted paired run 43779313132](https://github.com/AndrewM-F/bun-native/actions/runs/43779313132)
compared baseline `8ca85c34` and candidate `7c3b1729` on the same runner for
each platform, with 20 alternating pairs of 10,000 parses per round. The
[complete raw records](raw/native-frame-direct-hosted-2026-11-15.json.gz)
include each round, compiler, runner image, CPU and executable hashes. Entries
below are median paired candidate/baseline ratios (candidate wins out of 20).

| Case       | Linux x64  | macOS ARM64 | Windows x64 |
| ---------- | ---------- | ----------- | ----------- |
| small      | 0.959 (16) | 0.941 (15)  | 0.980 (18)  |
| medium     | 0.973 (18) | 0.961 (12)  | 0.944 (20)  |
| large      | 1.001 (7)  | 0.975 (13)  | 0.969 (20)  |
| fragmented | 1.007 (4)  | 1.021 (6)   | 0.972 (20)  |

Complete small and medium frames favored the candidate on each hosted runner.
The macOS fragmented case had a 2.1% median increase and Linux a 0.7% increase;
these samples are retained as possible regressions, not treated as proof of no
cost. The measurements remain an in-memory reader comparison rather than native
window or end-to-end evidence.

To investigate the fragmented cost, a separate local 20-pair control reversed
the order of the two fast-path conditions. Its median candidate/baseline ratios
were 0.995 small, 1.000 medium, 1.004 large and 1.002 fragmented. That change
did not establish an improvement and was discarded. [Raw records](raw/native-frame-branch-order-macos-2026-11-15.json.gz).

A second local candidate split the first buffer read from the fragmented loop.
Two 20-pair runs gave fragmented candidate/baseline ratios of 0.996 and 0.989,
with 12 and 13 wins respectively. Those small and variable gains did not
justify the duplicated control flow, so it was discarded. The [raw records](raw/native-frame-split-macos-2026-11-15.json.gz)
retain both executable hashes and all rounds; the candidate patch was
reconstructed after the experiment rather than captured before its revert.

A third local candidate used one newline branch per read, decoding from the
source buffer or accumulated buffer in that branch. In 20 alternating pairs
its median candidate/baseline ratios were 1.004 small, 1.030 medium, 0.999
large and 0.996 fragmented. Medium frames were slower in all 20 pairs, so this
alternative was discarded. The [raw record](raw/native-frame-one-branch-macos-2026-11-15.json.gz)
includes the exact candidate patch and executable identities.

## Leaf insertion ancestor check

A leaf with a different ID from its destination parent cannot be an ancestor
of that parent in the transaction's consistent tree. The native preflight now
skips the ancestor walk for that case, while self-insertion and non-leaf
subtrees retain cycle checks. Root, invalid-handle and parent validation keep
their previous ordering.

`native/protocol/examples/leaf_ancestor_perf.rs` times a 512-leaf mount under
parents at depths 1, 8 and 32, and a guard with 2,048 moves of a non-leaf subtree.
Each process checks the resulting node count, ordered children and subtree
parent. These are preflight measurements; they do not include IPC or painting.
[Raw local samples](raw/native-leaf-ancestor-macos-2026-11-15.json.gz) compare
baseline `80a5267b` and this candidate in 25 alternating fresh-process pairs
on an Apple M2 Max, macOS 27.2, Rust 1.98.1 release mode; other load was not
controlled. Each process records 30 trials after five warmups. Values are median
paired candidate/baseline ratios with candidate wins out of 25.

| Parent depth / case | Paired ratio | Wins |
| ------------------- | -----------: | ---: |
| 1                   |        0.987 |   17 |
| 8                   |        0.899 |   25 |
| 32                  |        0.681 |   25 |
| Non-leaf moves      |        1.006 |   10 |

The depth-8 baseline and candidate medians were 127.1 and 113.5 µs per batch;
at depth 32 they were 364.7 and 247.3 µs. A repeat with the same binaries gave
ratios of 0.987, 0.898, 0.680 and 1.001 in table order. The non-leaf guard may
have a small cost; its first run's paired ratios ranged from 0.936 to 1.087.
Earlier 256-move guards were noisier and are included in the raw record. These
results do not establish end-to-end application or market performance; hosted
cross-platform comparisons are required before generalizing them.

[Hosted run 43795568047](https://github.com/AndrewM-F/bun-native/actions/runs/43795568047)
compared baseline `80a5267b` with candidate `d6f295fb` using the same fixture,
locked dependencies and Rust release build on each runner. Its
[raw records](raw/native-leaf-ancestor-hosted-2026-11-15.json.gz) retain all
30 measured trials in each of 25 alternating pairs, source and binary hashes,
compiler version and runner information. Entries are median paired ratios with
candidate wins out of 25.

| Case           | Linux x64  | macOS ARM64 | Windows x64 |
| -------------- | ---------- | ----------- | ----------- |
| Depth 1        | 0.982 (17) | 0.974 (19)  | 0.981 (16)  |
| Depth 8        | 0.907 (25) | 0.812 (25)  | 0.928 (22)  |
| Depth 32       | 0.758 (25) | 0.695 (25)  | 0.770 (25)  |
| Non-leaf moves | 1.005 (9)  | 1.001 (11)  | 1.006 (5)   |

The non-leaf results show a possible small regression, especially on Windows;
their ranges and individual samples are retained. They do not establish a
whole-application gain, physical GPU result or absence of regressions in other
workloads.

[Repeat run 43796010394](https://github.com/AndrewM-F/bun-native/actions/runs/43796010394)
used the same source revisions and fixture on fresh runners. Its
[raw records](raw/native-leaf-ancestor-hosted-repeat-2026-11-15.json.gz)
retain all pairs. Median ratios and candidate wins out of 25 were:

| Case           | Linux x64  | macOS ARM64 | Windows x64 |
| -------------- | ---------- | ----------- | ----------- |
| Depth 1        | 0.963 (25) | 0.987 (17)  | 1.026 (10)  |
| Depth 8        | 0.873 (25) | 0.812 (25)  | 0.952 (22)  |
| Depth 32       | 0.750 (25) | 0.694 (25)  | 0.809 (25)  |
| Non-leaf moves | 1.005 (5)  | 0.998 (14)  | 1.026 (0)   |

On that Windows runner the median paired non-leaf increase was 2.4 µs per
2,048-move batch, while the depth-32 leaf batch decreased by 102.7 µs. The
repeat's shallow Windows result was also slower at the paired median, but had
10 candidate wins; the first run favored the candidate. This is a measured
tradeoff rather than evidence of no regressions, and
[#691](https://github.com/AndrewM-F/bun-native/issues/691) tracks further
investigation. A local candidate that limited the shortcut to detached leaves
showed no non-leaf benefit against the broader shortcut and was discarded;
[its samples and reconstructed patch](raw/native-leaf-ancestor-detached-macos-2026-11-15.json.gz)
are retained. Neither run measures IPC, actual native rendering or presentation.

[Post-rewrite run 43800699999](https://github.com/AndrewM-F/bun-native/actions/runs/43800699999)
verified the original baseline remained fetchable and compared it with the
published candidate `044c4465`. Its [raw records](raw/native-leaf-ancestor-hosted-rewritten-2026-11-16.json.gz)
retain all 25 pairs per platform. Median paired ratios and candidate wins were:

| Case           | Linux x64  | macOS ARM64 | Windows x64 |
| -------------- | ---------- | ----------- | ----------- |
| Depth 1        | 0.988 (18) | 0.974 (21)  | 0.997 (14)  |
| Depth 8        | 0.913 (25) | 0.805 (25)  | 0.945 (22)  |
| Depth 32       | 0.754 (25) | 0.685 (25)  | 0.826 (25)  |
| Non-leaf moves | 1.004 (4)  | 0.995 (13)  | 1.026 (2)   |

The repeated Windows non-leaf cost remains a measured tradeoff; this preflight
does not measure a visible window or end-to-end desktop performance.

A local condition-order control checked whether testing nonempty children
before equality reduced the move cost. Against the broad implementation in 25
alternating pairs, its non-leaf ratio was 1.011 (7 candidate wins), so the
alternative was discarded. The [raw local record](raw/native-leaf-ancestor-order-macos-2026-11-15.json.gz)
contains every trial and the reconstructed patch; it does not establish the
cause of the hosted Windows guard cost.

## Same-parent subtree reorder

A subtree already attached to its destination parent cannot acquire a cycle
when it is reordered in that parent's children. The preflight handles that case
before the ancestor walk; self-insertion and moves between parents still pass
through the existing cycle checks. Invalid indices and transactional rejection
are covered by a non-leaf reorder regression.

The release preflight fixture now also alternates 2,048 moves of a non-leaf
subtree within one parent and checks its final ownership and order. Two local
25-pair runs compared baseline `6a6b7f8d` and this candidate with identical
fixture bytes on macOS 27.2, Apple M2 Max, Rust 1.98.1. The reorder's median
paired ratios were 0.944 and 0.929, with 22 and 21 candidate wins; median
batch times were 139.9 versus 132.2 µs and 138.6 versus 129.9 µs respectively.
The depth-1, depth-8, depth-32 and cross-parent guard ratios ranged from 0.997
to 1.014. A same-binary A/A run ranged from 0.982 to 1.010 across the five
cases; it checks run variability, not independent-build code layout. Other
machine load and power were uncontrolled. [Raw samples and source identities](raw/native-reorder-macos-2026-11-16.json.gz)
retain all pairs. These preflight measurements do not include IPC or native
paint, and hosted platform confirmation is still needed. The cross-parent cost
tracked in [#691](https://github.com/AndrewM-F/bun-native/issues/691) remains.
