# Workspace long sessions on local Linux X11: 30 minutes per mode (#248, #250)

Four wall-clock long sessions of the workspace soak fixtures, one per framework
and mode, each 1,800 s, with real X11 typing, Return and wheel input every round.
All four fixtures exited 0 and all four checkers passed. These are software-rendered
sessions on a shared cloud VM, not a physical machine; they bound what was
observed in 30 minutes and are not a leak-freedom, latency or capacity claim.

## Source, host and environment

- Source: `0f6428833b7dd83e69fb2c400a0b1f6198abfca7` (branch
  `claude/project-thread-mvdsfp`). The package manifests record the tree as
  dirty only because of uncommitted documentation edits; no fixture, script or
  native file differed from that commit.
- Host: `bun-native-host` built from that source with
  `cargo build --locked --release -p bun-native-host --bin bun-native-host`
  (Rust 1.98.1; the native sources are identical to `bb8aff7`, which includes the
  Wayland display and modal accessibility host changes that are not on `main`).
  sha256 `414c7c08de947f9f0ee80c1dbb5d50348f100efcd3fc21f6ba056852bdb41932`.
- Packages: `bun experiments/aot-gpui/build-window.ts --entry
  <solid|react>-workspace-soak --host-profile release`. Inspected AOT executables:
  Solid sha256 `fea031eca2ebc89149d5c6971790eb56cd8b75700c7065b6e9fc88717a3b9499`,
  React sha256 `da54b3de25b9149bd0f3ce01dbb2f37b7b65a483350665bf4bdfc2a5e7f58c98`.
  Development mode ran `bun <package>/development/application.js`.
- Bun `1.4.4-canary.1+b1007f117`; Linux 6.18.44 (Firecracker VM), 4 vCPU Intel Xeon
  @ 2.30 GHz, 15 GiB RAM; Xvfb `1280x800x24` with openbox, a private DBus session
  and Mesa lavapipe (`VK_DRIVER_FILES` set to the `lvp_icd` file), exactly as
  [`native-workspace-long-session.sh`](../../../scripts/quality/native-workspace-long-session.sh)
  sets them up.
- Input: `BUN_NATIVE_SOAK_OS_INPUT=1`, so every round types one prompt (Solid) or
  task title (React) through XTest (`xdotool`), presses Return through the app's
  key handler and sends 24 wheel notches to the scroll viewport. The wheel effect
  is not asserted.
- Pacing: `BUN_NATIVE_SOAK_PACE_MS` unset (0), so rounds run as fast as the
  fixture's acknowledgements allow. No session was paced at the real 250 ms
  (Solid) or 300 ms (React) interval.
- Sampling: default `BUN_NATIVE_SOAK_SAMPLE_SECONDS=30`, so 61 samples per
  session (baseline, every 30 s and final).

Commands, from the worktree root with `BUN_NATIVE_HOST` set to the host above:

```sh
bash scripts/quality/native-workspace-long-session.sh solid development <solid-package> <new-dir> 1800
bash scripts/quality/native-workspace-long-session.sh react development <react-package> <new-dir> 1800
bash scripts/quality/native-workspace-long-session.sh solid aot <solid-package> <new-dir> 1800
bash scripts/quality/native-workspace-long-session.sh react aot <react-package> <new-dir> 1800
```

The two development sessions ran concurrently from 01:47:17 to 02:17:21 UTC, then
the two AOT sessions ran concurrently from 02:17:24 to 02:47:25 UTC. Running two
llvmpipe sessions at once kept the machine busy: the 10 s whole-machine trace averaged 73.5% CPU (development pair) and
74.8% (AOT pair), with a 1-minute load average up to 7.37. Latencies below
include that contention.

## Results

All four: fixture exit 0, checker
(`native-<framework>-workspace-soak.py --long-session 1800 --phases …`) exit 0,
zero acknowledgements or input-to-state times over 1 s, typed entries and Returns
equal to rounds, and wheel notches equal to 24 × rounds.

| Session           | Elapsed   | Rounds | Actions | Commits |   Round median / max | Typed chars | Wheel notches |
| ----------------- | --------- | -----: | ------: | ------: | -------------------: | ----------: | ------------: |
| Solid development | 1,800.3 s |  2,126 | 301,892 | 291,263 | 841.75 / 1,155.06 ms |      39,287 |        51,024 |
| Solid AOT         | 1,800.2 s |  2,170 | 308,140 | 297,291 | 828.02 / 1,118.29 ms |      40,123 |        52,080 |
| React development | 1,800.3 s |  3,190 | 271,150 | 261,581 |    560.2 / 979.07 ms |      46,743 |        76,560 |
| React AOT         | 1,800.5 s |  3,036 | 258,060 | 248,953 |   589.25 / 816.75 ms |      44,433 |        72,864 |

Solid sessions completed 34,016 (development) and 34,720 (AOT) streamed replies;
React sessions drafted 25,520 (development) and 24,288 (AOT) plans.

### Latency (whole session)

Native acknowledgement of each action, and OS input to observed app state
(two per round: the typed text read back, then the submission):

| Session           | Ack count | Ack p50 |  Ack p95 |  Ack p99 |  Ack max | Input count | Input p50 | Input p95 | Input max |
| ----------------- | --------: | ------: | -------: | -------: | -------: | ----------: | --------: | --------: | --------: |
| Solid development |   297,640 | 0.70 ms | 16.43 ms | 23.62 ms | 71.70 ms |       4,252 |  57.90 ms |  90.16 ms | 117.26 ms |
| Solid AOT         |   303,800 | 0.67 ms | 16.01 ms | 22.90 ms | 59.75 ms |       4,340 |  56.15 ms |  91.05 ms | 115.65 ms |
| React development |   264,770 | 0.36 ms | 13.80 ms | 18.74 ms | 46.14 ms |       6,380 |  45.76 ms |  71.47 ms | 146.27 ms |
| React AOT         |   251,988 | 0.41 ms | 14.21 ms | 18.78 ms | 43.96 ms |       6,072 |  49.04 ms |  89.96 ms | 131.30 ms |

Host frame phases from `BUN_NATIVE_PHASE_TRACE` cover only the first 16,384
frames of each session (the trace's buffer; 224–258 s), not the whole session:

| Session           | Renders | Frames recorded | Render p50 / p95 | Render to paint p50 / p95 / max |
| ----------------- | ------: | --------------: | ---------------: | ------------------------------: |
| Solid development | 120,750 |          16,384 | 0.118 / 0.286 ms |       1.135 / 2.508 / 16.341 ms |
| Solid AOT         | 124,379 |          16,384 | 0.109 / 0.241 ms |       1.085 / 2.243 / 12.919 ms |
| React development | 137,852 |          16,384 | 0.111 / 0.220 ms |        0.818 / 1.399 / 7.456 ms |
| React AOT         | 134,310 |          16,384 | 0.100 / 0.189 ms |       0.775 / 1.298 / 10.555 ms |

### Resources (samples every 30 s)

Each cell is first / first after warm-up / last / max. Warm-up is the first tenth
of the session (180 s), as the checker's summary defines it; the slope is the
least-squares trend per hour over the settled samples. RSS is `VmRSS` from
`/proc`; the heap and object count are taken after a forced collection.

| Session           | Host RSS KiB                                   | App RSS KiB                                  | JS heap bytes                                              | JS objects                                  |
| ----------------- | ---------------------------------------------- | -------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------- |
| Solid development | 153,192 / 157,588 / 157,740 / 157,952 (+495/h) | 35,636 / 73,620 / 71,756 / 74,096 (−2,302/h) | 3,712,005 / 7,518,111 / 7,394,105 / 7,538,700 (−88,724/h)  | 16,351 / 18,770 / 18,820 / 18,820 (+16/h)   |
| Solid AOT         | 149,148 / 158,816 / 159,272 / 159,328 (+482/h) | 29,912 / 38,000 / 38,252 / 39,268 (+1,511/h) | 1,769,635 / 1,907,481 / 1,906,791 / 1,963,559 (+63,030/h)  | 8,269 / 11,125 / 12,576 / 12,576 (+3,282/h) |
| React development | 150,852 / 153,112 / 153,452 / 153,452 (+366/h) | 39,724 / 77,904 / 75,136 / 78,416 (+5,206/h) | 4,340,625 / 8,469,201 / 8,515,773 / 8,544,090 (+58,123/h)  | 17,198 / 19,288 / 19,384 / 19,384 (+40/h)   |
| React AOT         | 149,140 / 154,448 / 154,684 / 154,708 (+430/h) | 30,732 / 36,804 / 37,676 / 37,736 (+1,256/h) | 1,769,900 / 1,880,443 / 1,929,421 / 1,952,508 (+141,387/h) | 8,161 / 9,762 / 13,032 / 13,032 (+6,506/h)  |

Threads and open files (first / last / max) in every sample:

| Session           | Host threads | App threads  | Host fds     | App fds      |
| ----------------- | ------------ | ------------ | ------------ | ------------ |
| Solid development | 36 / 36 / 36 | 13 / 13 / 14 | 24 / 24 / 24 | 12 / 12 / 12 |
| Solid AOT         | 36 / 36 / 36 | 6 / 10 / 10  | 24 / 24 / 24 | 13 / 13 / 13 |
| React development | 36 / 36 / 36 | 12 / 11 / 14 | 24 / 24 / 24 | 12 / 12 / 12 |
| React AOT         | 36 / 36 / 36 | 5 / 10 / 10  | 24 / 24 / 24 | 13 / 13 / 13 |

## Reading the results

- Host threads and open files and app open files did not change in any sample.
  After warm-up, app thread counts stayed within 9–10 (AOT) and 11–14
  (development).
- Host RSS rose by 152–456 KiB between the end of warm-up and the end of each
  session (settled slopes +366 to +495 KiB/h). Thirty minutes cannot distinguish
  that from allocator settling.
- App RSS in development varied by several MiB from sample to sample (after
  warm-up: Solid 60,316–74,096 KiB, React 65,128–78,416 KiB), so its settled
  slopes (−2,302 and +5,206 KiB/h) are noise-dominated and are not a trend claim.
- **Open observation:** in both AOT sessions the forced-collection JS object
  count kept rising after warm-up (Solid 11,125 → 12,576; React 9,762 → 13,032),
  more slowly later in the session, while the retained heap stayed under 2 MB
  (−1 KB and +49 KB) and app RSS moved by under 1 MiB. In development the object
  count was flat (+50 and +96). The fixture's per-round assertions that roots,
  listeners and application resources equal the baseline exactly held for every
  round, so the growth is not in those owned resources. It is not attributed
  here; a longer AOT session or a heap census would be needed to tell whether
  it levels off.
- The phase-trace rows describe only the first 224–258 s of each session.

Each `fixture.log` holds the expected Xvfb/DBus/portal start-up warnings. The
Solid development log ends with an `XIO: fatal IO error 11 … X connection to
:102 broken` line written by an X client during teardown after the fixture had
exited 0; no other session logged it.

## Files

Each session directory holds `environment.txt` (from the script), `summary.json`
(the checker's output, verbatim), `soak-result.json` (the fixture's report, the
checker's input), `samples.jsonl` (every sample as it was appended) and
`system-load.tsv` (the whole-machine 10 s trace). Re-check one with, for example:

```sh
python3 scripts/quality/native-solid-workspace-soak.py \
  benchmarks/results/workspace-long-session-2026-11-11/solid-aot/soak-result.json --long-session 1800
```

The phase traces (`phases.json`, 724–741 KB each), `rounds.txt` and
`fixture.log` were not committed. [`raw-sha256.txt`](raw-sha256.txt) has the
sha256 of every raw file as written by the run, including those. The committed
`soak-result.json` copies were reindented by `bun fmt` and parse to the same JSON
as the raw files; every other committed file is byte-identical to its raw file.

## Not covered

- A physical machine, a hardware GPU, physical input devices, Wayland, or any
  display other than Xvfb at 1280×800 scale 1.
- macOS and Windows: the hosted 120 s workflow steps are configured but no
  result from them is part of this record.
- Sessions paced at the real reply or plan interval, sessions longer than 30
  minutes, and repeated sessions (each configuration ran once).
