# Follow-up proposal: identify fixed-checkpoint retention in pinned Bun and native AOT

**Proposed Bun Native issue; not an upstream report.** Related work: BN2 #231 and PR #277. No renderer or benchmark assertion is relaxed by filing this follow-up.

## Concrete problem

The matched core/Solid benchmark stopped on its unchanged lifetime assertion when a direct-core AOT run retained two handles from zero-based mount index 61 after two fixed collection checkpoints. All six public ownership/queue counters were zero. A separate fixed ten-run diagnostic of the original instrumented bundle reproduced two retained handles at index 76 in trial 4. The full comparison therefore has no accepted timing result.

Independent controls on the same exact Bun revision reproduce positive checkpoints in development without Bun Native or any UI framework: the final root and label remain observable in all five v2 trials and all ten v3 trials. The corresponding AOT controls clear their targets. Thus the development control proves that a positive checkpoint is not sufficient to identify a framework ownership leak, but it does not reproduce or explain the native AOT failure. A later existing Solid collection test also failed once after adding behavioral tests without modifying production code; its failure is preserved.

## Evidence already available

- Exact Bun revision, source and executable hashes, ELF compiled-program/runtime inspection and compiler explanations in [summary.json](summary.json) and its linked raw records.
- Exact four no-framework source controls and all 90 predeclared process outcomes, with no adaptive retries or selected passing subset.
- Original native comparison failure, all ten instrumented-native outcomes and complete visible incoming subgraphs for the identified targets.
- Source-checked timer and collector controls: `sleep(0)` is initially pending; switching between `Bun.gc(true)` and explicit weak-reference release plus `gcAndSweep()` preserves the development-only positives.
- Deterministic completion-subscription/revocation regression with two deliberately broken negative controls. Existing weak-reference assertions remain intact.

The native snapshot reaches both handles through a disposed view object with no recorded incoming edge. The development control reaches its targets through an async operation/lexical environment whose outer object likewise has no recorded incoming edge. The pinned snapshot implementation omits some conservative and hidden edges, and taking the snapshot performs another collection. These observations cannot classify the ultimate root as either an application leak or a conservative stack word.

## Work required

1. Identify the retaining root for the exact failing native AOT shape with runtime-level root tracing or a reduced AOT control. Preserve a fixed experiment matrix, each executable identity and every outcome. Do not infer a root solely from a missing snapshot edge.
2. Separate explicit application ownership, async-runtime reachability and conservative stack/register marking using controls that change one mechanism at a time. Record the observer's own allocations and collection effects.
3. If an application-owned edge is found, fix that edge and add a deterministic ownership/lifecycle regression with a deliberately broken negative control. Re-run the unchanged GC diagnostic and actual native development/AOT workload against the same source set.
4. If a runtime limitation is established, document its measured root, scope and reproducibility. Design any different diagnostic openly, with positive and negative controls; do not silently replace the existing failing assertion with extra collections, larger sleeps, a tolerated retained count or retry-until-zero behavior.
5. Qualify any proposed Bun toolchain change through the existing AOT inspection, cross-platform process contracts and actual native fixture gates before adopting it.
6. Run the complete matched benchmark only after its lifetime interpretation and gates are defensible. Keep historical failures and label incomparable or instrumented timing samples accordingly.

## Completion criteria

The issue can close when the native AOT observation has a concrete explained retaining path or a measured runtime limitation, the chosen regression detects a deliberately reintroduced ownership defect, and the full intended native development/AOT workload satisfies its documented lifetime and mutation contract. Required ownership counters, callback revocation and process cleanup remain strict throughout. This follow-up does not claim release-platform GUI, physical input latency or a matched performance improvement.
