# Prepared upstream investigation note

**Prepared for review; not submitted upstream.** Bun Native [#287](https://github.com/0xPlayerOne/bun-native/issues/287) tracks the unresolved original native AOT retention. The concrete, reduced reproduction below concerns a diagnostic visibility gap. It does not claim to reproduce the original AOT retained view.

## Environment and exact inputs

- Linux x86_64; Bun `1.4.4-canary.1+da867c60b`, revision `da867c60bf0bcbf9d6d36994f8ca0efa42075115`.
- Pinned WebKit revision `8c6c963e3c49fe39942d9625d1fc924128fad26e`.
- [`collection-edge.ts.txt`](source/collection-edge.ts.txt), SHA-256 `d574106a2d5153bdbe8530c400e1d6f14ead6feee16854943f9aaaac9edcd29a`.
- The program uses the pinned `bun:jsc` debugging export `generateHeapSnapshotForDebugging`. All targets remain intentionally strongly held. It contains no framework, native host, WeakRef, explicit GC or timer.
- The original development/AOT reports, graph paths, compile explanation and executable inspection are linked from [root-tracing-summary.json](root-tracing-summary.json).

The program holds one target in an ordinary object property and a Set. It takes one debugging snapshot, then asserts that both owners still contain the same target. All three cells are identified by the address strings produced by `jscDescribe`; no raw pointer is dereferenced by the program.

## Reproduction

Copy the archived source without reformatting it into a fresh working directory. Use the exact pinned Bun executable installed through this repository's toolchain recipe:

```sh
bn_trace_repo="$(pwd)"
bn_trace_bun="$(command -v bun)"
bn_trace_run="$(mktemp -d)"
cp "$bn_trace_repo/benchmarks/retention/source/collection-edge.ts.txt" \
  "$bn_trace_run/collection-edge.ts"
cp "$bn_trace_repo/benchmarks/retention/source/analyze-collection.py.txt" \
  "$bn_trace_run/analyze-collection.py"
cp "$bn_trace_repo/benchmarks/retention/raw/collection-edge-plan.json.txt" \
  "$bn_trace_run/collection-edge-plan.json"
cd "$bn_trace_run"
"$bn_trace_bun" --revision
sha256sum collection-edge.ts
"$bn_trace_bun" collection-edge.ts collection-edge-development.json development
"$bn_trace_bun" compile collection-edge.ts --outfile collection-edge-aot \
  --explain=json >compile.json 2>compile.stderr.log
./collection-edge-aot collection-edge-aot.json aot
python3 analyze-collection.py
```

Each invocation creates its report and heap snapshot exclusively, refusing to overwrite an earlier result. Preserve both outcomes. A new executable or process has a new identity and addresses; the archived artifact hash does not qualify a later build automatically.

In snapshot format 3, debugging nodes have seven fields per node; edges have four. The archived analyzer resolves the three report addresses to node IDs, then traverses **every recorded edge** from each holder. It records the source, plan, report and snapshot identities in `collection-edge-analysis.json`. The plan declares the expected source-derived distinction before execution; the analyzer records a contrary result as `hypothesisSupported: false`, rather than retrying or changing the expected result.

Expected from ordinary live ownership: both owners reach the target. Observed in the fixed original pair:

| Execution        | Object owner                 | Set owner                                                    | Membership after snapshot |
| ---------------- | ---------------------------- | ------------------------------------------------------------ | ------------------------- |
| Development      | Property edge reaches target | Set reaches its `Cell Butterfly`, but no path reaches target | Both true                 |
| Machine-code AOT | Internal edge reaches target | Set → CompactTable → target                                  | Both true                 |

The source distinction is explicit: development [`JSCellButterfly::visitFields`](https://github.com/oven-sh/WebKit/blob/8c6c963e3c49fe39942d9625d1fc924128fad26e/Source/JavaScriptCore/runtime/JSCellButterfly.h#L194-L204) uses hidden visitation; AOT [`CompactTable::visitEntries`](https://github.com/oven-sh/WebKit/blob/8c6c963e3c49fe39942d9625d1fc924128fad26e/Source/JavaScriptCore/aot/runtime/AOTCompactTable.h#L547-L592) uses ordinary visitation. The report does not assume this is an unintended public-API behavior. It asks how to obtain a complete diagnostic graph for ownership investigations.

## Root attribution needed for the separate retention case

The original native AOT benchmark sometimes retains a disposed view after two fixed collection checkpoints. A diagnostic snapshot reaches its root and label through the view's `dispose` and `update` closures, but records no incoming edge to that view. A separate framework-free development queue control retains an async operation closure with the same lack of ultimate root attribution. Their exact sources and every fixed trial remain in the [existing archive](README.md); the two shapes and execution modes must not be conflated.

Useful tracing support would record:

1. Conservative-root origins: owning VM/thread, scanned stack or register location, full-pointer versus narrow-reference match, and resulting cell identity. Record all origins, not only whichever marker reached the cell first.
2. Hidden edges: the current source cell and target cell when hidden visitation retains an object, including Set/Map backing storage. A root without an ordinary source cell should retain its explicit root category.
3. Any cross-heap references omitted by the ordinary analyzer, with enough VM/cell identity to join them correctly.
4. The collection/checkpoint identity and weak-reference execution version, so a later snapshot's own collection is not mistaken for the failed checkpoint.

The smallest instrumented change would emit diagnostic metadata at the existing conservative and hidden marking hooks without changing what is marked. A complete graph must distinguish known owner edges from conservatively discovered cell candidates. It must not keep JavaScript targets alive merely to collect the trace. Any runtime modification remains unimplemented and unqualified here.

No upstream action or runtime replacement is requested by this file alone. Within Bun Native, keep #287 open until the native AOT retaining root is explained or an appropriately measured runtime limitation is established. No additional sleeps, retries, retained-object tolerance or acceptance change is proposed.
