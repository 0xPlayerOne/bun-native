# Shared renderer commit micro benchmark

`commit.ts` mounts a shared `@bun-native/renderer` root in rows of
`box > [text > text-node, button(onClick)]` and measures one acknowledged commit
per sample in two scenarios:

- `text`: a single `replaceText`; exactly one native `set`, nothing else.
- `row`: one keyed row replaced in place (insert a new row before it, remove
  it); exactly one `remove`, three `create`s and three `insert`s.
- `move`: one box holding every row moves to the other of two sibling boxes
  under the root; exactly one `insert`.
- `swap`: the second and second-to-last keyed rows under the root trade
  places; exactly two `insert`s.

`stageP50Ms` is the median time of the staging calls alone, before the commit.

Each run also checks that the committed node count does not drift.

```sh
bun benchmarks/renderer/commit.ts          # 1,000 and 5,002 staged nodes
bun benchmarks/renderer/commit.ts 333 1667 5000  # rows; three nodes per row
```

`clear.ts` mounts 20,000 `text` rows under the root and removes half of them in
one batch (`front`, `alternate`, `middle`, `random` or `tail` rows), reporting
the median staging time of the `removeNode` calls and of the following commit
over five runs after a warm-up run.

```sh
bun benchmarks/renderer/clear.ts [rows] [runs]
```

`append.ts` separately measures an acknowledged append to a stable wide list
and removal of the appended node. It checks the native-operation counts and
committed node count for every sample. Staging the append and removal is outside
their respective commit timings.

```sh
bun benchmarks/renderer/append.ts [rows=4000] [samples=200]
```

The window is an in-process stand-in that counts operations and acknowledges
immediately. Samples therefore cover only the renderer's snapshot, diff,
publish and listener reconciliation work. They exclude core validation,
serialization, IPC, native model work and paint, and are not input-to-paint
latency. Timings are wall-clock per commit with nearest-rank percentiles; run
several processes and compare distributions rather than one result.

### Rejected tail-removal candidate

A development CPU profile of 10,000 append/remove cycles at 4,000 rows
identified sibling filtering on removal as a significant sampled cost; it
includes both halves of each cycle and instrumentation. A guarded slice for a
fully removed, unchanged suffix reduced the median paired removal ratio to
0.608 in development and 0.677 in AOT, winning all 20 local pairs. However,
the same candidate increased the AOT append median ratio to 1.096 and lost all
20 append pairs. Moving the guard into a helper yielded removal ratios of
0.612/0.676 in development/AOT but an AOT append ratio of 1.083, again losing
all 20. An A/A control using byte-identical input modules and separately compiled
AOT executables had ratios of 0.998 for append and 1.002 for removal. These
results are local to an Apple M2 Max with pinned Bun `b1007f117`, and do not
measure core, native IPC or paint. The candidate was rejected; no production
removal path changed. [Raw samples, fixture, path-normalized CPU profile and reconstructed candidate patches](raw/tail-removal-rejected-macos-2026-11-15.json.gz)
include the executable and source hashes and all 200 samples in each of 20
alternating pairs per mode.

## Appending to a stable prefix

When a nonempty current child list matches the start of a longer desired list,
the renderer attaches the suffix in order without constructing and walking a
longest-subsequence bitmap for the existing prefix. A last-element check avoids
the full prefix scan when a changed list plainly differs. Moved and newly
created nodes still use the same native attach operation; a protocol-peer test
checks their resulting order.

[Raw samples](raw/append-prefix-macos-2026-11-15.json.gz) compare baseline
`717e4c975f5aac79675e1c57ba4bb704cf44cd15` and the candidate on macOS 27.2,
Apple M2 Max, pinned Bun `b1007f117`, with other load and power uncontrolled.
For a 4,000-row list, 20 alternating fresh-process pairs each measured 200
appends after 20 warmups. Both AOT executables were inspected for a compiled
program and unused JIT. The window acknowledges in process; no core
validation, IPC, native host, or paint is measured.

| Mode        | Baseline p50 | Candidate p50 | Median paired ratio |  Wins |
| ----------- | -----------: | ------------: | ------------------: | ----: |
| Development |     0.072 ms |      0.057 ms |               0.813 | 20/20 |
| AOT         |     0.057 ms |      0.037 ms |               0.655 | 20/20 |

A 20-pair guard using the `commit.ts` text, row, move and swap scenarios at
1,667 rows found median paired ratios of 0.984–1.014 in development and
1.000–1.011 in AOT; these guards do not prove the absence of small regressions.
The original broader prefix check was rejected after row and development-move
regressions. The measurements above do not establish end-to-end or native-paint
latency; actual-window confirmation is still needed.

[Hosted run 43786037588](https://github.com/0xPlayerOne/bun-native/actions/runs/43786037588)
compared baseline `717e4c97` with candidate `155c8592`, using the same fixture,
pinned Bun and 12 alternating pairs on each runner. Both AOT executables were
inspected for a compiled program and unused JIT. [Raw records](raw/append-prefix-hosted-2026-11-15.json.gz)
retain every append sample, guard result and source/executable identity. Values
are median paired candidate/baseline ratios, with candidate wins out of 12.

| Mode        | Linux x64  | macOS ARM64 | Windows x64 |
| ----------- | ---------- | ----------- | ----------- |
| Development | 0.977 (6)  | 0.811 (10)  | 0.836 (11)  |
| AOT         | 0.805 (12) | 0.626 (12)  | 0.762 (11)  |

Linux development is inconclusive. The development text guard ratios were
1.036, 1.035 and 1.059 on Linux, macOS and Windows respectively, corresponding
to median per-process increases of about 0.28–0.30 µs; this is a possible cost.
Other guard results and variability are retained in the raw records. This
still excludes the native host, IPC and paint; it is not an end-to-end result.

A [repeat on `e48a05d6`](https://github.com/0xPlayerOne/bun-native/actions/runs/43787619557)
used the tracked guard fixture at the same six-decimal precision. In 12 pairs,
append ratios in development/AOT were 0.867/0.788 on Linux, 0.824/0.617 on
macOS, and 0.875/0.744 on Windows; AOT won 12, 12 and 11 pairs respectively.
The Windows AOT text guard ratio was 1.079 (a 0.20 µs median paired increase),
and the macOS AOT row guard ratio was 1.054 (a 2.17 µs increase). The first
hosted run's corresponding ratios were 1.000 and 0.994, so these remain
possible small costs with run-to-run variability, not established zero cost.
[Raw repeat records](raw/append-prefix-hosted-repeat-2026-11-15.json.gz)
retain all samples and source and executable identities.

The opt-in `diagnostic:native-append-pairs` PR label runs a separate Linux X11
probe with a real release host and 384 rows, small enough for complete native
paint records. It compares the same fixture against `717e4c97`, verifies the
shared host and core sources, inspects both AOT clients, and retains one warmup
plus five alternating process pairs per mode. Each launch checks every full
append and removal paint tree and owned-process cleanup. Its acknowledgement
and observed-paint intervals include host/IPC work; the latter also includes
paint instrumentation, file I/O and polling. Neither measures presentation.

Two runs on Linux x64 hosted VMs with Intel Xeon 6975P-C and llvmpipe compared
baseline `717e4c97` with candidate `085254c5` using pinned Bun `b1007f117`.
Both completed every native tree and process-cleanup check. Values below are
median paired candidate/baseline ratios, with candidate wins out of five; each
pair contains eight samples after two per-process warmups.

| Run                                                                          | Development ack |   AOT ack | Development paint observed | AOT paint observed |
| ---------------------------------------------------------------------------- | --------------: | --------: | -------------------------: | -----------------: |
| [First](https://github.com/0xPlayerOne/bun-native/actions/runs/43790911829)  |       0.755 (3) | 0.879 (4) |                  0.963 (5) |          0.970 (5) |
| [Repeat](https://github.com/0xPlayerOne/bun-native/actions/runs/43791763023) |       0.755 (5) | 1.083 (1) |                  0.990 (3) |          1.001 (2) |

The AOT acknowledgement ratio ranged from 0.223 to 2.542 in the first run;
the repeat's paired median increased by 0.027 ms. These small samples and
opposite AOT results do not establish a real-host gain. The paint observation
includes polling and full-tree evidence generation, which can dominate the
renderer change. The [first](raw/native-append-linux-first-2026-11-15.json.gz)
and [repeat](raw/native-append-linux-repeat-2026-11-15.json.gz) compact records
retain all timings, cleanup results, the initial tree and hashes of each raw
evidence file. The linked Actions artifacts retain the complete original
paint and process records for their retention period.

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

## Dirty children and deferred removal

Linux x64 container, Bun `1.4.4-canary.1+da867c60b`, five processes each.
"dirty walk" is `6ce6b55`; "dirty children" is this change. Ranges are
per-process results. The Solid rows filter a 20,000-row `<For>` to half
through `solid-js/universal` (median of five runs, staging only); they were
measured with a scratch script that is not checked in.

| Scenario | Tree         | dirty walk mean ms | dirty children mean ms | dirty walk p50 ms | dirty children p50 ms |
| -------- | ------------ | ------------------ | ---------------------- | ----------------- | --------------------- |
| `text`   | 1,000 nodes  | 0.0098–0.0149      | 0.0088–0.0127          | 0.0059–0.0096     | 0.0048–0.0054         |
| `text`   | 5,002 nodes  | 0.0127–0.0166      | 0.0050–0.0070          | 0.0101–0.0144     | 0.0041–0.0059         |
| `text`   | 15,001 nodes | 0.0364–0.0609      | 0.0048–0.0074          | 0.0333–0.0482     | 0.0040–0.0055         |
| `row`    | 1,000 nodes  | 0.178–0.209        | 0.171–0.203            | 0.109–0.121       | 0.105–0.129           |
| `row`    | 5,002 nodes  | 0.524–0.600        | 0.528–0.636            | 0.379–0.420       | 0.376–0.425           |
| `row`    | 15,001 nodes | 1.59–1.76          | 1.69–1.84              | 1.20–1.29         | 1.22–1.32             |

| Clear half of 20,000 | dirty walk stage ms | dirty children stage ms | dirty walk commit ms | dirty children commit ms |
| -------------------- | ------------------- | ----------------------- | -------------------- | ------------------------ |
| `front`              | 23.7–25.9           | 1.54–2.59               | 5.54–7.39            | 4.96–8.20                |
| `alternate`          | 25.9–32.0           | 1.81–2.72               | 4.59–5.32            | 4.97–7.89                |
| `middle`             | 23.9–29.8           | 1.56–1.74               | 4.69–5.77            | 4.65–5.49                |
| `random`             | 28.3–31.8           | 4.66–6.08               | 5.43–6.87            | 6.14–7.07                |
| `tail`               | 1.02–1.73           | 1.43–1.88               | 4.54–5.40            | 4.51–5.97                |
| Solid `<For>` front  | 24.7–25.3           | 1.85–4.12               |                      |                          |
| Solid `<For>` alt.   | 29.5–32.6           | 3.83–4.93               |                      |                          |
| Solid `<For>` middle | 24.5–25.5           | 1.67–4.57               |                      |                          |
| Solid `<For>` tail   | 23.2–24.5           | 1.58–4.43               |                      |                          |

A node that becomes dirty now registers itself with its parent, so a parent
whose own capture is current visits only its registered dirty children, sorted
into child order because the diff emits native operations in snapshot order;
the `text` commit no longer grows with the root's width. A recaptured parent
still scans all of its children, which covers a child inserted already dirty.

Staged sibling bookkeeping no longer searches or shifts the list on removal.
Each child keeps a verified position hint, and a removal leaves an `undefined`
hole in the parent's staged list instead of splicing it; the list is compacted
in one pass (or one splice when the holes are adjacent) the next time its
`children` are read, which a commit does once per recaptured parent, or when
holes reach half the list. Solid's `getNextSibling` and `getFirstChild` use
the same hints and skip a leading run of holes, so `cleanChildren` and keyed
reconciliation stop scanning from the front. The old `tail` staging path was
already O(1); Solid's tail case was not, because `getNextSibling` searched.

What remains proportional to the tree: a parent whose child list changes still
copies and diffs that whole list in the commit (the `row` scenario's root and
the clear commits above), and an anchored insertion into a wide list still
shifts it natively. Reading `children` of a list with scattered holes compacts
it with a JavaScript pass, so a caller that alternates removals with full
`children` reads (React's `clearContainer` reads `children[0]` each time) pays
what the splice used to cost, not less.

## Single-walk moves

Linux x64 container, Bun `1.4.4-canary.1+da867c60b`, three processes each.
"before" is `b5c2576`; "after" is this change. Ranges are per-process results;
Solid and React rows are medians in µs of 200 samples over 1,000 rows
(`sync` is staging only), React with `NODE_ENV=production`.

| Scenario | Tree         | before stage p50 ms | after stage p50 ms | before p50 ms | after p50 ms |
| -------- | ------------ | ------------------- | ------------------ | ------------- | ------------ |
| `move`   | 1,003 nodes  | 0.0796–0.0816       | 0.0231–0.0246      | 1.69–1.80     | 1.22–1.49    |
| `move`   | 5,005 nodes  | 0.388–0.398         | 0.0984–0.120       | 6.46–7.21     | 5.12–6.26    |
| `move`   | 15,004 nodes | 1.34–1.47           | 0.369–0.416        | 20.7–23.9     | 19.6–20.5    |
| `row`    | 15,001 nodes | 0.0116–0.0121       | 0.0103–0.0105      | 1.20–1.23     | 1.16–1.22    |

| Clear half of 20,000 | before stage ms | after stage ms | before commit ms | after commit ms |
| -------------------- | --------------- | -------------- | ---------------- | --------------- |
| `front`              | 1.55–1.67       | 0.58–0.74      | 4.71–5.61        | 5.00–5.65       |
| `alternate`          | 1.66–1.88       | 0.82–1.05      | 4.71–5.21        | 4.63–5.32       |
| `middle`             | 1.47–1.49       | 0.59–0.66      | 4.58–7.34        | 4.38–4.73       |
| `random`             | 4.25–5.07       | 2.36–2.72      | 5.81–6.36        | 5.64–6.19       |
| `tail`               | 1.51–1.69       | 0.53–0.67      | 4.72–4.82        | 4.24–4.92       |

| Keyed, 1,000 rows | before sync µs | after sync µs | before total µs | after total µs |
| ----------------- | -------------- | ------------- | --------------- | -------------- |
| Solid `swap`      | 112–138        | 105–135       | 418–486         | 447–464        |
| Solid `clear`     | 438–566        | 285–335       |                 |                |
| React `swap`      | 3,110–3,527    | 2,739–2,841   | 6,719–7,014     | 5,249–5,440    |
| React `replace`   | 5,282–5,773    | 4,404–5,046   |                 |                |

`insertNode` walked a moved subtree twice: once to reject nodes scoped to
another render root, once to invalidate it and hand it to the new owner, each
through a callback that also registered every node with its parent's
`dirtyChildren`. A node only gains an owner together with that owner's scope,
for its whole subtree, so a subtree its destination root already owns skips
the scope walk. The remaining walk (shared with `removeNode`) clears captures
directly and no longer fills `dirtyChildren`: each parent in the subtree has
just lost its capture, so `snapshot()` scans all of its children anyway.

The scope walk still runs for a subtree entering a root from outside it. The
`move` commit is still dominated by recapturing the whole moved subtree, which
the renderer keeps doing because an adapter may have cleared a detached
subtree's lists directly.

## Live-root moves and list diffs

Linux x64 container, Bun `1.4.4-canary.1+da867c60b`, three processes each.
"before" is `35a1fce`; "after" is this change. Ranges are per-process p50s in
ms. Solid rows are medians in µs of 200 samples over 5,000 rows, React rows
medians of 100 samples over 1,000 rows with `NODE_ENV=production`; their
`sync` (adapter staging) did not change.

| Scenario | Tree         | before p50 ms | after p50 ms  |
| -------- | ------------ | ------------- | ------------- |
| `text`   | 15,001 nodes | 0.0060–0.0082 | 0.0067–0.0084 |
| `row`    | 1,000 nodes  | 0.133–0.184   | 0.0243–0.0250 |
| `row`    | 15,001 nodes | 1.56–1.67     | 0.221–0.232   |
| `move`   | 1,003 nodes  | 1.50–1.74     | 0.0095–0.0109 |
| `move`   | 5,005 nodes  | 9.07–9.83     | 0.0194–0.0330 |
| `move`   | 15,004 nodes | 29.3–32.5     | 0.0633–0.126  |
| `swap`   | 1,000 nodes  | 0.0899–0.0948 | 0.056–0.0988  |
| `swap`   | 15,001 nodes | 1.56–2.13     | 0.504–0.730   |

| Keyed           | before total µs | after total µs |
| --------------- | --------------- | -------------- |
| Solid `append`  | 3,049–3,339     | 1,457–1,792    |
| Solid `swap`    | 2,849–3,169     | 1,617–1,681    |
| Solid `remove`  | 2,056–2,215     | 998–1,186      |
| Solid `prepend` | 3,033–3,299     | 1,393–1,654    |
| React `swap`    | 6,263–7,737     | 4,354–4,682    |

A subtree moved by `insertNode` while it stays attached to the same live root
is no longer invalidated and recaptured whole. A node an owner holds is always
attached under that owner's root, because removal and disposal clear the
owner, so the subtree's captures and dirty paths stay current: the moved node
alone is recaptured (its capture names its old parent) and shares its previous
child list when that list is unchanged, so the diff skips it by identity.
Subtrees entering from another root or from outside the tree, including a
detached subtree reinserted later, are still recaptured whole, because an
adapter may have edited them directly.

A recaptured parent's committed and captured child lists are compared only
between their common prefix and suffix, and the lost-child set is built only
when the middles' counts of clean children differ. `stableChildren` likewise
trims the common ends and runs its longest-subsequence search over typed
arrays, returning flags by desired index instead of a set.

What remains proportional to the tree: a recaptured wide parent still copies
its child list, and a reorder whose middle spans the list (the `swap` rows)
still builds one position map over that middle. Solid's own `<For>` mapping
and react-reconciler's `getHostSibling` dominate the adapters' `sync` time.

## Clearing a suffix through core

`clear-core.ts` removes half of a full 4,096-node window through the shared
renderer and real in-process core transactions. It checks native operation
counts, surviving order and final disposal. It excludes IPC, native preflight
and paint. A pure removed suffix now emits deletes last-first; other edits keep
their previous order. This lets each core and native tree removal use its tail
fast path, while rescued descendants are still moved before their ancestor is
deleted.

```sh
bun benchmarks/renderer/clear-core.ts [samples=12]
```

Apple M2 Max, macOS 27.2, AC power, pinned Bun `b1007f117`, uncontrolled
other load: 12 alternating fresh processes per version and mode, each with
three warm-ups and 12 measured clears. Values are medians of the per-process
commit p50s in milliseconds. [Raw samples and AOT compiler diagnostics](raw/)
include the exact source and binary hashes; both AOT binaries have the
compiled-program flag.

| Pattern | Development before | Development after | AOT before | AOT after |
| ------- | -----------------: | ----------------: | ---------: | --------: |
| Tail    |              6.799 |             1.523 |      2.353 |     0.988 |
| Front   |              2.911 |             3.016 |      2.293 |     2.300 |

Tail improved in all 12 pairs in each mode. The front median increased by
about 3.6% in development and 0.3% in AOT; these measurements do not establish
an end-to-end latency or competitive result.
