# Fixed-checkpoint retention research

**Status: unresolved.** A failed direct-core AOT benchmark and a later Solid unit-test failure remain recorded. The no-framework controls establish that two explicit full collections can leave short-lived objects observable without importing Bun Native, Solid, React, a native host or a DOM. Those positive controls occurred in development mode; they do **not** explain the original native AOT failure. No renderer assertion, benchmark oracle, mutation limit or ownership check was relaxed by this research increment.

This directory preserves the exact experimental source, every fixed-trial summary, the original failed comparison, the inspected executable identities and the visible retaining graphs. These are Linux x86_64 diagnostics on Bun revision `da867c60bf0bcbf9d6d36994f8ca0efa42075115`, not a successful matched performance comparison or cross-platform qualification. [summary.json](summary.json) contains the full SHA-256 identities and source references.

## Observations

All matrices were fixed before execution and retained every result. A positive checkpoint means at least one `WeakRef.deref()` returned an object after collection. It does not, on its own, identify an application leak.

| Experiment                                                                              | Fixed processes | Development result at second checkpoint                                           | AOT result at second checkpoint       |
| --------------------------------------------------------------------------------------- | --------------: | --------------------------------------------------------------------------------- | ------------------------------------- |
| Plain Promise queue, v1; 100 or 1,000 mount/dispose cycles                              |              20 | 0/10 positive; all five 100-cycle runs were positive only at the first checkpoint | 0/10 positive                         |
| Timer-completed queue and exercised view methods, v2; 100 cycles                        |              10 | 5/5 positive: final root and label, indexes 297 and 298                           | 0/5 positive                          |
| Same v2 shape, v3; choose `Bun.gc(true)` or `releaseWeakRefs()` plus `gcAndSweep()`     |              20 | 10/10 positive with both collection entry points                                  | 0/10 positive with either entry point |
| Timer/Promise status control; `sleep(0)`, `sleep(1)`, `setTimeout(0)`, resolved Promise |              40 | All targets were already collected by the first synchronous `Bun.gc(true)`        | Same result                           |
| Instrumented original native bundle; original failure assertion retained                |     10 AOT only | Not run in this matrix                                                            | Trial 4 failed; other nine passed     |

The v2/v3 controls disposed all 3,200 row objects and reported an empty operation queue in every process. They contain no Bun Native or framework imports. Their controls report the retained indexes and return normally so the fixed experiment can record all outcomes; the production renderer test and benchmark still fail on a positive final checkpoint. The complete records are in the four `raw/*-summary.json.txt` archives.

The original failed comparison used source commit `657ac295077b381120ec8340d958b596da785b3b`. Its first direct-core AOT measured trial retained the root and label at zero-based mount index 61, not the listener. All six public ownership/queue counters were zero during teardown. The comparison stopped at its unchanged failure assertion and is incomplete. Its raw measurements remain in [the failed comparison](raw/failed-native-comparison.json.txt) and [the failed application report](raw/failed-native-core-aot.json.txt); they are excluded from accepted comparative timings.

The instrumented follow-up used the exact original bundled module plus address strings from `jscDescribe()` and a snapshot after a positive final checkpoint. It retained the original assertion. Trial 4 retained the root and label at index 76. [The source delta](raw/native-instrumentation.json.txt), [all ten outcomes](raw/native-instrumented-summary.json.txt) and [that failed report](raw/failed-native-instrumented-aot.json.txt) are preserved. Instrumentation changes executable layout and adds work, so these are diagnostic results rather than timings comparable with the original executable.

A later canonical coverage run, after adding shared-renderer behavioral tests without changing production source, also observed one disposed `RenderRoot` in the existing Solid collection test. Its [original failure log](raw/shared-renderer-coverage-failure.log.txt) is retained. A later passing full run does not resolve that failure.

## What the retaining graphs show

[retaining-graphs.json](retaining-graphs.json) includes **all visible incoming ancestors** for each identified target, the source snapshot hashes and each node's recorded root reasons. It is not a selected successful path through a larger graph.

In the instrumented native AOT snapshot, both handles are captured by methods of the same disposed view object: the root through `dispose`, the label through `update`. That view object has no incoming edge and no root-reason entry in the snapshot. The graph does not expose an `Application`, native window, listener registry or shared render-root ownership path to it.

In the no-framework v2 development snapshot, the handles are captured by a lexical environment reached through an `operation` function and an async-function object. That async-function object also has no incoming edge or root-reason entry. This is a concrete view/queue retention shape without Bun Native, but its graph and execution mode differ from the native AOT observation.

Neither graph identifies the ultimate retaining root. The pinned WebKit [`SlotVisitor.cpp`](https://github.com/oven-sh/WebKit/blob/8c6c963e3c49fe39942d9625d1fc924128fad26e/Source/JavaScriptCore/heap/SlotVisitor.cpp#L139-L247) sends conservative roots through a path that does not emit the regular heap-analyzer edge; hidden edges also bypass that hook. Consequently, no incoming edge is compatible with an omitted conservative or other hidden root, but is **not proof** that such a root caused this observation. The diagnostic snapshot performs another collection after an additional timer turn, so it also does not describe precisely the same instant as the failed checkpoint. Full process snapshots remain research artifacts; this repository contains the target subgraphs and original snapshot hashes rather than unrelated process objects.

## Hypotheses checked against the pinned source

### `sleep(0)` was not already fulfilled

Every immediate `Bun.peek.status()` for `Bun.sleep(0)`, `Bun.sleep(1)` and `setTimeout(0)` was `pending` in all 40 control processes. `Promise.resolve()` was `fulfilled`. This agrees with the pinned [`functionBunSleep`](https://github.com/oven-sh/bun/blob/da867c60bf0bcbf9d6d36994f8ca0efa42075115/src/jsc/bindings/BunObject.cpp#L715-L738), which creates a new promise and calls the timer implementation, and [`Timer::sleep`](https://github.com/oven-sh/bun/blob/da867c60bf0bcbf9d6d36994f8ca0efa42075115/src/runtime/timer/Timer.rs#L170-L197), which initializes a timeout object.

The timer control's targets were already gone before any boundary was awaited. It therefore does not measure the minimum task boundary needed for collection. It does reject the proposed explanation that the pinned `sleep(0)` simply returns an already fulfilled Promise. Changing the existing test to a longer timer would not constitute a demonstrated fix.

### Changing the collection entry point did not remove the positive control

Pinned Bun [`JSC__VM__runGC`](https://github.com/oven-sh/bun/blob/da867c60bf0bcbf9d6d36994f8ca0efa42075115/src/jsc/bindings/bindings.cpp#L5152-L5181) calls `finalizeSynchronousJSExecution()` before and after collection. That same operation is exposed by [`releaseWeakRefs`](https://github.com/oven-sh/bun/blob/da867c60bf0bcbf9d6d36994f8ca0efa42075115/src/jsc/modules/BunJSCModule.h#L611-L622). The alternate [`gcAndSweep`](https://github.com/oven-sh/bun/blob/da867c60bf0bcbf9d6d36994f8ca0efa42075115/src/jsc/modules/BunJSCModule.h#L173-L181) calls a synchronous full collection directly. Both alternatives left the same final targets observable in all development v3 trials; neither did so in AOT trials.

The pinned Bun source also documents a [conservative-stack/free-list-sentinel problem and a bounded stack-clearing mitigation](https://github.com/oven-sh/bun/blob/da867c60bf0bcbf9d6d36994f8ca0efa42075115/src/jsc/bindings/bindings.cpp#L5125-L5150). That comment describes a previously observed ASAN case and explicitly says the mitigation is not an exact fix. It establishes a relevant mechanism to investigate; it does not establish that this release-build or AOT result has the same cause. The alternate collector experiment did not isolate that mechanism.

## Exact reproduction source

`source/*.txt` and the control/report archives preserve their original bytes. The coverage-log archive uses a lossless JSON array of UTF-8 lines, including line endings and trailing spaces; joining its `lines` reproduces the recorded original hash without violating the repository whitespace gate. The suffix is intentional: formatting an old source file would silently change the source identity attached to a recorded executable. These small controls use pinned `bun:jsc` debugging exports, including a snapshot export absent from the released `bun-types` declarations; they are experimental inputs, not public packages or a claimed strict TypeScript interface. Repository production code and the new deterministic regression still pass the ordinary strict gate.

The v3 control is the smallest archived program that tests both full-collection entry points with the same source and executable. From the repository root, use the pinned `bun` installed by the normal toolchain recipe:

```sh
bn_retention_repo="$(pwd)"
bn_retention_bun="$(command -v bun)"
bn_retention_dir="$(mktemp -d)"
cp "$bn_retention_repo/benchmarks/retention/source/queue-v3.ts.txt" \
  "$bn_retention_dir/retention-control-v3.ts"
cd "$bn_retention_dir"
"$bn_retention_bun" --revision
sha256sum retention-control-v3.ts
"$bn_retention_bun" compile retention-control-v3.ts \
  --outfile retention-control-v3-aot --explain=json >compile.log 2>compile.stderr.log
for trial in 1 2 3 4 5; do
  for method in bun jsc; do
    "$bn_retention_bun" retention-control-v3.ts "development-$method-$trial.json" "$method"
    ./retention-control-v3-aot "aot-$method-$trial.json" "$method"
  done
done
```

The source SHA-256 must be `d4efd3fabbf3021eff9ae3185d38138f64f8540b3ebdf6029d0ff979af8825b0`. Use a fresh output directory: the controls create reports/snapshots with exclusive creation and refuse to overwrite an earlier result. Run all fixed trials; keep positive and negative observations. A new build needs its own executable identity, because path/toolchain/build changes can alter the binary and collection behavior.

The other archived controls run as follows after copying their exact source into that isolated directory:

| Source                  | Arguments after the source/executable                                     | Original fixed matrix                |
| ----------------------- | ------------------------------------------------------------------------- | ------------------------------------ |
| `queue-v1.ts.txt`       | `--output REPORT --mounts 100` or `1000`                                  | Five per count and execution mode    |
| `queue-v2.ts.txt`       | `REPORT`                                                                  | Five per execution mode              |
| `sleep-boundary.js.txt` | `sleep0 REPORT`, `sleep1 REPORT`, `timeout0 REPORT`, or `resolved REPORT` | Five per boundary and execution mode |

All four original control executables and the instrumented native executable were inspected with the repository's ELF runtime and compiled-program decoders. Each has the compiled-program flag, `jit: "unused"`, and 27 removed JIT ranges. The interpreter remains present; this evidence does not assert that all runtime interpretation is impossible. [The complete inspection](raw/aot-artifact-inspection.json.txt) binds those findings to each executable's SHA-256 and size. The compiler explanations are preserved beside it.

## Deterministic ownership regression

[`tests/renderers/window-lifetime.test.ts`](../../tests/renderers/window-lifetime.test.ts) exercises the actual shared `watchWindow` implementation against a real public-core window connected to the headless subprocess peer. It observes calls to the real completion Promise's `then` method, not garbage collection. Twenty-five register/release cycles and two overlapping live registrations must use one completion subscription. Released callbacks must remain inert on actual window close; only the still-live observer runs, and registering after completion fails.

Two deliberately broken controls must fail the same assertions: one permanent completion callback for every root, and one shared callback set whose unsubscribe function does nothing. They verify that the oracle detects both unbounded completion reactions and forgotten revocation. This directly protects the earlier per-window observer defect independently of conservative GC. It does not detect a root accidentally captured in an otherwise bounded completion callback's lexical environment. The existing forced-GC regression therefore remains unchanged and unresolved alongside this deterministic check.

## Remaining investigation

The [scoped follow-up proposal](follow-up.md) defines the missing evidence. Accepted comparative timings remain pending. Resolve the original AOT retaining root or establish a measured runtime limitation with an appropriate diagnostic before treating this checkpoint as satisfied. Continue to require exact mutation counts, owner disposal, zero native/core ownership counters, callback revocation and clean process shutdown throughout that investigation.
