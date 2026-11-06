# DFG retention in collectability checks

**Status:** root identified for the development-mode positives in [#287](https://github.com/0xPlayerOne/bun-native/issues/287). The AOT-only positives recorded in [README.md](README.md) have no DFG tier and are covered by [aot-eden-collection.md](aot-eden-collection.md).

## Finding

On the pinned Bun (`da867c60bf0bcbf9d6d36994f8ca0efa42075115`, Linux x64), JSC's **DFG tier** can keep a disposed object reachable after every application edge is gone. Extra collections and timer turns do not clear it. Disabling DFG (`BUN_JSC_useDFGJIT=0`) removes every positive, in both a framework-free control and real Solid roots over headless public-core IPC. Disabling only FTL, or only OSR entry, does not remove them. The compiler tier does not create or remove application ownership edges, so the strict checks still detect a real leak with DFG disabled (see the negative controls below).

A second, smaller effect is stale stack or register residue. It most often holds the final object of a loop for one turn, and it clears on the next collection after a fresh timer turn.

## Measurements

These are local runs of [solid-collection-control.ts](solid-collection-control.ts). Each trial mounts, acknowledges and disposes ten Solid roots, then observes their `WeakRef`s. `fixed` is the previous oracle, two `sleep(0)`/`gc(true)` checkpoints. `settled` is the research helper [`settled-observation.ts`](settled-observation.ts): up to five rounds of timer turn, stack overwrite and full collection.

| Oracle  | DFG      | Trials | Failed trials | Survivor indexes   | Settled rounds used |
| ------- | -------- | -----: | ------------: | ------------------ | ------------------- |
| fixed   | enabled  |    500 |             7 | 1, 5, 6, 7, 8, 9×3 | n/a                 |
| settled | enabled  |    500 |             7 | 0×2, 2, 5, 9×3     | 1: 492, 5: 8        |
| fixed   | disabled |    500 |             0 | none               | n/a                 |
| settled | disabled |    500 |             0 | none               | 1: 500              |

The same split appeared in a framework-free control: an async allocation loop with ten `WeakRef`s per trial and 500 trials. With DFG enabled, one target from the same trial survived every one of 60 settled rounds in three separate processes. With DFG disabled, or with all JIT disabled, no target survived past the second round. The framework-free script is not committed. Its shape matches the v2/v3 controls in [README.md](README.md).

This explains why CI failures only appeared after hot shared code had been compiled, such as late in a full test suite or after warmups. It also explains why an unchanged source could pass on one run and fail on the next.

## What the required checks do

- The Solid root and window-callback collectability tests keep their original two fixed `sleep(0)`/`gc(true)` checkpoints and their zero-survivor assertions. They now run in a child process with `BUN_JSC_useDFGJIT=0` ([collectability-scenarios.ts](../../tests/renderers/collectability-scenarios.ts)), because the table above shows the DFG tier is the only source of positives with those checkpoints.
- A new negative control in that child releases nine of ten real window subscriptions and must report exactly the unreleased one, so the DFG-disabled child still detects a real ownership edge.
- The settled rounds above are research only. No required test, workload or benchmark uses them, since they did not change the DFG-enabled failure rate.
- The React workload's development calibration run (two mounts, ten iterations) asserts zero surviving view/callback `WeakRef` targets and runs with `BUN_JSC_useDFGJIT=0`. On the pinned Bun under Xvfb, 54 of 100 calibration trials with DFG enabled kept the last mount's render root and listener (probe indexes 3 and 5); 0 of 100 did with DFG disabled. The 1,000-mount timed runs and the AOT calibration keep the default JIT tiers and the same assertion.
- The native workload, deadlines, ownership counters and mutation contracts are unchanged.
