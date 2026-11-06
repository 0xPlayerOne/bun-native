# AOT retention after an eden collection

**Status:** measured runtime limitation for the AOT-only positives in [#287](https://github.com/0xPlayerOne/bun-native/issues/287). No renderer or core retention was found, and none of the checks, checkpoints or assertions change. An upstream reproducer for oven-sh/bun is still to be written.

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
