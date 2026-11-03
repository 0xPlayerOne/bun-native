# Root tracing and ownership visibility

**Issue [#287](https://github.com/0xPlayerOne/bun-native/issues/287) remains open.** The original direct-core AOT retention and the intermittent Solid WeakRef failure are not explained by this increment. No production implementation, collection checkpoint, timer, retained-object allowance or assertion changed. The original failures remain in the [fixed-checkpoint archive](README.md).

This investigation checked the exact pinned Bun/WebKit source before running one two-case observer experiment and one two-mode, framework-free visibility control. [root-tracing-summary.json](root-tracing-summary.json) binds every new source, plan, observation, selected graph and compiler report to its SHA-256. Full process snapshots remain external research artifacts; their hashes and the relevant paths are retained here.

## An ordinary JavaScript owner can disappear from the graph

The proposed independent disposal check followed every recorded edge from the real shared window-completion callback to deliberately live listener targets. It used the actual public core and a headless subprocess peer, with 25 register/release cycles and one still-active listener. It did not use WeakRef or ask whether a target had been collected. Every target was strongly held by the diagnostic before and after the snapshot.

The negative control deliberately retained the first listener in the single shared completion callback. It otherwise preserved subscription-count and revocation behavior: one completion subscription, no released callback invoked at actual window close, and exactly one active callback invoked. Both implementations ended with all six public ownership/queue counts at zero.

| Fixed case                        | Released listener paths from completion callback            | Required live-listener path | Behavioral count/revocation checks |
| --------------------------------- | ----------------------------------------------------------- | --------------------------- | ---------------------------------- |
| Actual `watchWindow`              | None recorded for all 25 listeners                          | **Missing**                 | Passed                             |
| Deliberate first-listener capture | First listener and its target have an explicit lexical path | **Missing**                 | Passed                             |

The negative control demonstrates why the existing count/revocation check cannot by itself detect one listener captured in an otherwise bounded completion callback. However, the missing **positive** control makes the proposed graph check inconclusive. It is not a new lifetime gate and does not qualify the actual implementation as leak-free. Both fixed process outcomes and the failed positive controls are preserved in [observer-analysis.json.txt](raw/observer-analysis.json.txt).

Source inspection explains the specific missing edge. [`JSSet`](https://github.com/oven-sh/WebKit/blob/8c6c963e3c49fe39942d9625d1fc924128fad26e/Source/JavaScriptCore/runtime/JSSet.h) inherits the ordered hash-table implementation. [`JSOrderedHashTable::visitFields`](https://github.com/oven-sh/WebKit/blob/8c6c963e3c49fe39942d9625d1fc924128fad26e/Source/JavaScriptCore/runtime/JSOrderedHashTable.h#L43-L48) visits its backing storage, but [`JSCellButterfly::visitFields`](https://github.com/oven-sh/WebKit/blob/8c6c963e3c49fe39942d9625d1fc924128fad26e/Source/JavaScriptCore/runtime/JSCellButterfly.h#L194-L204) marks its entries through `appendValuesHidden`. [`SlotVisitor`'s hidden visitor](https://github.com/oven-sh/WebKit/blob/8c6c963e3c49fe39942d9625d1fc924128fad26e/Source/JavaScriptCore/heap/SlotVisitor.cpp#L228-L247) marks cells without emitting the ordinary heap-analyzer edge.

The actual saved graph reaches the completion closure's environment, the lifetime object, its `listeners` Set and the Set's `Cell Butterfly`. It stops before the live listener. That listener is present elsewhere in the same snapshot and is subsequently invoked once on real window completion. This is a demonstrated graph omission for ordinary JavaScript ownership, rather than an inference based only on a missing root reason.

## The storage distinction is execution-mode specific

The pinned AOT [`CompactTable::visitEntries`](https://github.com/oven-sh/WebKit/blob/8c6c963e3c49fe39942d9625d1fc924128fad26e/Source/JavaScriptCore/aot/runtime/AOTCompactTable.h#L547-L592) uses ordinary, visible visitation for its entries. A small standalone control therefore compared the same deliberately live target held by an object property and by a Set in development and machine-code AOT. Each mode ran once according to a recorded plan. It has no framework/native imports, WeakRef, explicit GC call or timer; the snapshot itself performs a full collection.

| Same-source holder  | Development snapshot       | AOT snapshot                  | Membership after snapshot |
| ------------------- | -------------------------- | ----------------------------- | ------------------------- |
| `{ target }`        | Property path recorded     | Internal object path recorded | True in both              |
| `new Set([target])` | No recorded path to target | Set → CompactTable → target   | True in both              |

All recorded edges were traversed without depth, type, name or root filtering. The exact paths and absence results are in [collection-edge-analysis.json.txt](raw/collection-edge-analysis.json.txt). The AOT artifact is 70,204,456 bytes, SHA-256 `7178f02f32fdc71a782d55e8c7d6844b27e7a420e0518358d350cbf8abcaa82e`. Its [inspection](raw/collection-edge-aot-inspection.json.txt) finds the compiled-program flag, JIT state `unused` and 27 removed JIT ranges. The interpreter remains present. These are diagnostic builds and observations, not a performance comparison.

This confirms the source-derived storage distinction. It **does not** establish that a development Set omission caused the original native AOT failure. It does establish that an absent snapshot edge cannot generally distinguish runtime retention from ordinary JavaScript ownership. The [upstream investigation note](upstream-root-tracing.md) contains the small reproduction and the exact remaining tracing request; it has not been submitted upstream.

## Other source checks and their limits

The saved native AOT snapshot has 51 nodes with no recorded incoming edge, including the disposed view and unrelated strings/objects. It has no `ConservativeScan` root-reason entries. The full root-reason and class counts for that snapshot and the no-framework development failure are retained in the summary. Those counts are a census of the saved graph, not a count of actual conservative roots.

The pinned [`SlotVisitor::append(ConservativeRoots)`](https://github.com/oven-sh/WebKit/blob/8c6c963e3c49fe39942d9625d1fc924128fad26e/Source/JavaScriptCore/heap/SlotVisitor.cpp#L139-L177) also bypasses the ordinary analyzer-edge hook. In addition, `appendSlow` documents a cross-heap visibility limitation. Taking the [debugging snapshot](https://github.com/oven-sh/WebKit/blob/8c6c963e3c49fe39942d9625d1fc924128fad26e/Source/JavaScriptCore/heap/HeapSnapshotBuilder.cpp#L64-L88) performs another synchronous full collection. It cannot reconstruct the exact root set at an earlier failed WeakRef checkpoint.

The tempting microtask-cache explanation was checked against source rather than tested by changing GC timing. [`MicrotaskCall`](https://github.com/oven-sh/WebKit/blob/8c6c963e3c49fe39942d9625d1fc924128fad26e/Source/JavaScriptCore/interpreter/MicrotaskCall.h) stores a CodeBlock, executable and entry-point metadata; it does not directly cache the JavaScript callback object. Its stack-backed cache already clears storage before constructing entries to prevent stale padding from looking like cell pointers. The [`microtask queue`](https://github.com/oven-sh/WebKit/blob/8c6c963e3c49fe39942d9625d1fc924128fad26e/Source/JavaScriptCore/runtime/MicrotaskQueue.cpp#L159-L222) visits queued arguments explicitly, while local dequeued task/argument copies are ordinary stack data. This does not rule out a stack or code-related root, but it does not support a claim that the cache directly owns the retained callback.

Compiled conservative scanning also examines 32-bit halves of stack/register words as narrow cell references; see [`ConservativeRoots.cpp`](https://github.com/oven-sh/WebKit/blob/8c6c963e3c49fe39942d9625d1fc924128fad26e/Source/JavaScriptCore/heap/ConservativeRoots.cpp) and the pinned [`useNarrowReferenceScan` option](https://github.com/oven-sh/WebKit/blob/8c6c963e3c49fe39942d9625d1fc924128fad26e/Source/JavaScriptCore/runtime/OptionsList.h#L152-L155). No such option was changed here. A possible mechanism is not evidence that a particular stack word retained this view.

## Evidence needed for a classification

Call this a framework ownership defect only after identifying a strong path from a live application/window/renderer owner to the disposed target, demonstrating that the owner outlives the intended lifetime, and showing that removing that edge fixes the same workload. The regression should detect deliberately reintroducing that ownership, independently of whether an arbitrary full GC happens to collect the target immediately.

Call it conservative/runtime retention only after recording the actual marking source for the failing target: for example, a stack/register slot and matched cell, or a documented runtime holder that outlives its required work. Record whether the candidate was a full pointer or narrow reference and whether a visible JavaScript owner also exists. A missing incoming edge, a later passing run or a zero ownership counter alone is insufficient.

The pinned executable has no DWARF debug sections or named internal GC symbols in the inspected symbol table. The next useful step is a matching instrumented runtime or upstream tracing support, rather than another sleep/GC variant. Tracing must cover conservative roots **and** hidden ordinary ownership edges, preserve multiple marking origins, and associate the trace with the actual failing collection. The reproduction note specifies the required observations. Building or adopting a different runtime would require the existing toolchain/AOT qualification; this increment changes no toolchain pin.

The existing deterministic subscription/revocation test remains valid within its stated scope. The new failed positive control prevents extending that claim to a complete strong-reference disposal proof. All original WeakRef, native/core ownership, callback-revocation, mutation-count and process-cleanup requirements remain in force.
