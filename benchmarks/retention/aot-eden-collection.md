# AOT retention after an eden collection

**Status:** measured runtime defect for the AOT-only positives in [#287](https://github.com/0xPlayerOne/bun-native/issues/287), **absent on the current pinned Bun** `1.4.4-canary.1+b1007f117` (see [Pin comparison](#pin-comparison-november-10)). No renderer or core retention was found, and none of the checks, checkpoints or assertions change.

Measured on main `3863459`, pinned Bun `1.4.4-canary.1+da867c60b`, the release host, Linux x64. Each trial ran in its own Xvfb, dbus and openbox session through `scripts/quality/native-linux-session.sh` with the CI arguments. The core adapter records three probes per mount (root, label, listener), so a survivor pair (3k, 3k+1) is mount k's root and label.

## Not the DFG tier

The AOT executables have no JIT tiers. `experiments/aot-gpui/compile.ts` and `benchmarks/solid/run.ts` verify `runtimeFeatures.jit = unused` with 27 JIT ranges removed. A hot-function probe reports one DFG compile in a JIT standalone (`bun build --compile`) and zero in an AOT build, even with `BUN_JSC_useJIT=1`. AOT executables do read `BUN_JSC_*` options (`maxPerThreadStackUsage` changes their recursion limit), so `BUN_JSC_useDFGJIT=0` has nothing to disable there. The [DFG result](settled-collection.md) explains only the development-mode positives.

## Positive rates

| Run                                          | Failed trials | Survivors                                                                                              |
| -------------------------------------------- | ------------: | ------------------------------------------------------------------------------------------------------ |
| React AOT calibration (CI arguments)         |         0/320 | none                                                                                                   |
| React AOT timed, 1,000 mounts                |         0/100 | none                                                                                                   |
| React development calibration, DFG enabled   |        31/100 | always probes 3 and 5                                                                                  |
| Solid AOT timed, 100 mounts                  |         0/300 | none                                                                                                   |
| Core (`direct.ts`) AOT timed, 100 mounts     |        15/299 | one random mid-run mount's root and label, never the listener; includes (60, 61), the historical mount |
| Core AOT, `BUN_JSC_useNarrowReferenceScan=0` |        15/299 | same shape                                                                                             |
| Core AOT built with `--aot-huge-heap`        |         5/300 | same shape                                                                                             |
| Core AOT, 10 iterations and rotations        |         0/299 | none                                                                                                   |
| Core development, DFG enabled                |         2/197 | last mount only (297, 298)                                                                             |
| Core development, DFG disabled               |         0/197 | none                                                                                                   |

The AOT surfaces the required checks run, React calibration and React timed, were clean in 420 trials.

## What holds the core mount

These diagnostics ran only after the unchanged checkpoints had already found a survivor.

- Three more `sleep(0)`/`gc(true)` rounds, three deep-recursion stack scrubs, five empty batches, three more mount cycles and `window.close()` left it reachable (19/19 and 10/10 processes). The extra cycles' own probes were collected.
- It was collected only after `application.shutdown()` and `closed` (10/10), so something tied to the live application holds it, not stack or register residue.
- A failing process's heap has exactly one more mount than a passing one: +1 Environment, +1 Map, +1 CompactTable, +1 Array, +5 Function and +6 Object (the view object, its four closures, its environment and the rows Map). Protected-object counts are identical, and all ownership counters are zero.

## Trigger

Starting from the 10-iteration setup that never fails (0/299), one `setTimeout(() => Bun.gc(false), 0)` was injected at mount 40:

| Eden collection during mount 40                |                             Failed trials |
| ---------------------------------------------- | ----------------------------------------: |
| update                                         | 14/59 and 13/60 (mount 40 or 41 retained) |
| create batch, before the view object exists    |                                      6/60 |
| dispose                                        |                                     12/60 |
| after dispose                                  |                 19/60 (mount 41 retained) |
| Control: full collection at the same point     |                                      0/60 |
| Control: same bundle under the development JIT |                                      0/60 |
| Control: Solid AOT bundle, during update       |                                      0/60 |

In the AOT runtime, an eden collection while `direct.ts`'s `mount`/`cycle` async functions are suspended leaves that mount reachable through every later full collection until shutdown. The holder exists before the view object does, most likely the suspended function's saved frame or result promise (`--explain=allocations` reports `AwaitBySavingFrame` there). With 1,000 timed iterations, eden collections land at random points during the 100 mounts, which matches the random index, the roughly 5% rate, the clean 10-iteration runs and the lower huge-heap rate. When an eden collection runs cannot create an application reference, and the same source is clean in development with DFG disabled.

## Consequences

- No change to the required checks. Reshaping `direct.ts` to avoid the async/closure pattern, or adding collections or settle rounds, would hide a runtime defect rather than fix a cause.
- A core AOT comparison added to CI would fail about 5% of the time until the runtime is fixed.
- A framework-free reducer (0/40) did not reproduce, because its AOT build allocates no heap Environment. The next step is to copy the `direct.ts` mount verbatim against a fake window doing real awaited IPC, reduce it, and report it upstream.

## Pin comparison (November 10)

The trigger above was re-run with [`eden-injection.ts`](eden-injection.ts): `direct.ts` with one `setTimeout(() => Bun.gc(false), 0)` queued during the update of mount 40 (`EDEN_AT=40`), or a full collection at the same point (`EDEN_FULL=1`). Every trial ran the AOT executable with `--iterations 10 --rotations 10 --mounts 100 --rows 32` in its own `xvfb-run`, `dbus-run-session` and `scripts/quality/native-linux-session.sh`, against the release host built from main `2de2d2a` (SHA-256 `ac894d24…5d28`), Linux x64, two trials at a time, interleaved by cell. Every outcome is counted; nothing was retried or dropped. A failure is the unchanged two-checkpoint assertion.

| Workload source | Bun AOT compiler | Eden at mount 40 | No injection | Full collection at mount 40 |
| --------------- | ---------------- | ---------------: | -----------: | --------------------------: |
| `3863459`       | old `da867c60b`  |        **19/60** |         0/60 |                           — |
| `3863459`       | new `b1007f117`  |             0/60 |         0/60 |                           — |
| `2de2d2a`       | old `da867c60b`  |             0/60 |         0/60 |                           — |
| `2de2d2a`       | new `b1007f117`  |             0/60 |         0/60 |                        0/60 |

- The `3863459` rows build this same injection file against that commit's workload and packages. On that source and the old Bun, the trigger still reproduces: 19 of 60 trials kept one mount's root and label (probe pairs 117–118, 120–121, 123–124 or 126–127, mounts 39 to 42) through both checkpoints.
- The **same development module** (`build-src-old/application.js`, SHA-256 `f1a1438e…bdca`) compiled with the current pinned Bun was clean in 60 of 60 (two-sided Fisher p ≈ 7×10⁻⁷ against 19/60). Only the AOT compiler and runtime differ between those two rows, so the retention is a property of the `da867c60b` AOT runtime, and it is absent from `b1007f117`.
- Current source on the old Bun was also clean. The core, runtime and renderer packages changed between the two sources, so the trigger no longer lands while the same frame is suspended. That alone would not show a fix; the same-module row above does.
- Executable SHA-256s: old Bun `fe406996…6810`, new Bun `8f55345e…e9ab` (both as in [bun-b1007f117-trial.md](bun-b1007f117-trial.md)); AOT applications `a5db8c9b…2f69` (old source, old Bun), `db172539…a2d7` (old source, new Bun), `bfd9ca2b…70c8` (current, old Bun), `4f68e4e1…6958` (current, new Bun).

No upstream report is needed for a defect the current runtime no longer shows. The required checks keep their two fixed checkpoints and zero-survivor assertions, and the DFG-disabled development checks in [settled-collection.md](settled-collection.md) are unchanged.
