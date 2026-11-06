# Shared renderer commit micro benchmark

`commit.ts` mounts a shared `@bun-native/renderer` root in rows of
`box > [text > text-node, button(onClick)]` and measures one acknowledged commit
per sample in two scenarios:

- `text`: a single `replaceText`; exactly one native `set`, nothing else.
- `row`: one keyed row replaced in place (insert a new row before it, remove
  it); exactly one `remove`, three `create`s and three `insert`s.

Each run also checks that the committed node count does not drift.

```sh
bun benchmarks/renderer/commit.ts          # 1,000 and 5,002 staged nodes
bun benchmarks/renderer/commit.ts 333 1667 5000  # rows; three nodes per row
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

## Dirty-path walk

Linux x64 container, Bun `1.4.4-canary.1+da867c60b`, five processes each;
2,000 samples for 1,000 nodes and 1,000 samples otherwise. "reused captures" is
`9e1546d` (above); "dirty walk" is this change. Ranges are per-process means /
p50s.

| Scenario | Tree         | reused captures mean ms | dirty walk mean ms | reused captures p50 ms | dirty walk p50 ms |
| -------- | ------------ | ----------------------- | ------------------ | ---------------------- | ----------------- |
| `text`   | 1,000 nodes  | 0.268–0.382             | 0.0100–0.0119      | 0.143–0.177            | 0.0059–0.0069     |
| `text`   | 5,002 nodes  | 1.56–2.13               | 0.0133–0.0169      | 1.09–1.38              | 0.0118–0.0135     |
| `text`   | 15,001 nodes | 4.01–5.22               | 0.0413–0.0554      | 3.43–4.44              | 0.0378–0.0464     |
| `row`    | 1,000 nodes  | 0.473–0.597             | 0.182–0.221        | 0.300–0.414            | 0.111–0.139       |
| `row`    | 5,002 nodes  | 2.50–3.51               | 0.572–0.623        | 1.76–2.59              | 0.394–0.424       |
| `row`    | 15,001 nodes | 5.97–7.68               | 1.71–1.84          | 5.74–6.78              | 1.21–1.32         |

Every mutation that clears a node's capture now also marks its ancestors
dirty, and `snapshot()` descends only dirty paths, returning just the nodes it
recaptured. The diff finds removals from the old and new child lists of those
recaptured parents, and the root publishes acknowledged records into one
persistent committed map in place, reconciling listeners only for changed and
removed nodes. Lost children leave a working sibling list in one filter pass
and stable anchors are located by a backwards scan that only moves left, so a
keyed region cleared from the end is no longer quadratic in the diff.

What remains proportional to the tree: a dirty ancestor scans the dirty flags
of its direct children (the `text` row's cost at 15,001 nodes is the root's
5,000-child scan), and a parent whose child list changes copies and diffs that
whole list (the `row` scenario's root). Staged `insertNode`/`removeNode`
sibling lookups are separate work.
