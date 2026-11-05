# Shared renderer commit micro benchmark

`commit.ts` mounts a shared `@bun-native/renderer` root in rows of
`box > [text > text-node, button(onClick)]` and measures one acknowledged commit
after a single `replaceText`. Each commit must send exactly one native `set`
and no creates or inserts.

```sh
bun benchmarks/renderer/commit.ts          # 1,000 and 5,002 staged nodes
bun benchmarks/renderer/commit.ts 1000 5000  # rows; three nodes per row
```

The window is an in-process stand-in that counts operations and acknowledges
immediately. Samples therefore cover only the renderer's snapshot, diff,
publish and listener reconciliation work. They exclude core validation,
serialization, IPC, native model work and paint, and are not input-to-paint
latency. Timings are wall-clock per commit with nearest-rank percentiles; run
several processes and compare distributions rather than one result.

## Recorded comparison

Linux x64 container, Bun `1.4.4-canary.1+da867c60b`, five processes each,
2,000 (1,000 nodes) and 1,000 (5,002 nodes) samples per process. Ranges are
the per-process results.

| Tree        | Revision                      | mean ms     | p50 ms      | p95 ms      |
| ----------- | ----------------------------- | ----------- | ----------- | ----------- |
| 1,000 nodes | before (`15344d5`)            | 1.65–1.88   | 1.39–1.47   | 3.12–4.79   |
| 1,000 nodes | reused captures (this change) | 0.279–0.319 | 0.146–0.172 | 0.833–0.922 |
| 5,002 nodes | before (`15344d5`)            | 8.60–9.28   | 7.82–8.82   | 13.6–15.3   |
| 5,002 nodes | reused captures (this change) | 1.49–1.62   | 1.08–1.37   | 3.05–3.42   |

Before this change every commit rebuilt each node's element, re-serialized both
the committed and the desired element for comparison, copied every committed
handle, parent and child list into three working maps and allocated a new
committed record per node. Unchanged nodes now reuse their immutable capture,
so the diff skips them by identity and the working state records only what the
batch changes. The walk over the tree and the two node maps remain O(N).
