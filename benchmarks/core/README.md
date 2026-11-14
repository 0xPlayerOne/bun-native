# Core event delivery fan-out micro benchmark

`events.ts` drives a window's listener registry (`EventBindings.prepare`) and
`dispatchPlan` for one routed native event at a time, as an application window
does after it validated the event's ownership path. The path is eight nodes
deep. Scenarios:

- `no-listener`: a `pointer_down` with no binding on its path (no plan);
- `target`: one bubble `click` listener on the target;
- `ancestor-bubble`: one `key_down` listener on the second node;
- `every-level`: a capture and a bubble `click` listener on every node (16
  deliveries);
- `input-async`: one asynchronous `input` listener on the target (the
  cancellation race path).

```sh
bun benchmarks/core/events.ts [samples=5000]
```

Each sample prepares, dispatches, awaits and releases one event, checking the
delivery count. It excludes host I/O, protocol parsing, the path ownership
checks and the application callback queue.

## Linux x64 result

[Raw records](raw/): source `822086b`, pinned Bun `da867c60`, Linux 6.18 (4 vCPU
cloud container), three processes. Ranges are per-process p50s.

| Scenario          | Deliveries | p50 µs    |
| ----------------- | ---------- | --------- |
| `no-listener`     | 0          | 0.19–0.36 |
| `target`          | 1          | 2.34–2.50 |
| `ancestor-bubble` | 1          | 2.51–2.63 |
| `every-level`     | 16         | 6.94–11.7 |
| `input-async`     | 1          | 3.70–3.99 |

A delivery costs about 0.3–0.7 µs beyond the first, which is the frozen event
object, its two closures and the two awaited turns that keep synchronous and
asynchronous listeners interleaved alike. No outlier was found.

# Core and runtime commit path micro benchmark

`commit.ts` runs the application-side work of one acknowledged commit in
process, through the real core `Transaction` and the calls the runtime makes per
request. No current benchmark covered this path: the
[renderer benchmark](../renderer/README.md) fakes the window and the
[protocol benchmark](../protocol/README.md) skips core. Scenarios:

- `mount`: 42 `box > [text, button]` rows into an empty window (126 creates,
  126 inserts), split into the core build (element normalization), its
  `validate`, the runtime's `parseCommand` and `encodeFrame`;
- `keystroke`: one text `set` in a committed 1,000-row window whose labels each
  hold a click listener: the core build and validation, the runtime phase
  (`parseCommand` and `encodeFrame`), the commit and the listener bookkeeping
  that follows every acknowledged batch.

```sh
bun benchmarks/core/commit.ts [samples=3000]
```

Timings are wall-clock per sample in µs with nearest-rank percentiles after 300
warm-up samples. They exclude IPC, native work and renderer snapshots.

## Linux x64 result

[Raw records](raw/): pinned Bun `b1007f117`, Linux 6.18 (4 vCPU cloud container),
three processes each. `commit-base-*` is source `3518b3a`, whose bookkeeping
was `EventBindings.retain(window nodes)`; `commit-*` is the change that made
parsed elements frozen and trusted by identity, removed the core re-parse,
replaced `retain` with `forget(removed nodes)` and hoisted protocol key sets.
Ranges are per-process p50s.

| Scenario    | Phase          | `3518b3a` p50 µs | After p50 µs |
| ----------- | -------------- | ---------------- | ------------ |
| `mount`     | build          | 199–204          | 98–109       |
| `mount`     | validate       | 33.5–34.7        | 29.5–32.3    |
| `mount`     | `parseCommand` | 84.5–85.8        | 17.5–19.7    |
| `mount`     | `encodeFrame`  | 27.6–28.4        | 24.8–26.3    |
| `mount`     | total          | 363–366          | 180–196      |
| `keystroke` | core           | 1.54–2.34        | 1.53–1.66    |
| `keystroke` | runtime        | 1.05–1.52        | 0.65–0.66    |
| `keystroke` | listeners      | 8.98–13.6        | 0.058–0.060  |
| `keystroke` | total          | 12.2–18.3        | 2.60–2.72    |

Core validated every created element three times: `create`, `makeNode` and the
runtime's `parseCommand` each ran the full `parseElement`. Parsed elements are
now frozen with their style and recognized by identity, so only the first parse
does work; any other value, including a copy of a parsed element, is still
validated in full. Listener bookkeeping walked every bound node after each
commit and now visits only the nodes the commit removed. `encodeFrame` is the
largest remaining runtime phase.

Core now builds operations into a protocol `OperationList`, whose constructors
check each operation once, freeze it and keep it where no caller can replace
it, so `parseCommand` copies the list instead of parsing every operation again
(any plain operations array is still parsed in full). Interleaved, six
processes each against `97dd2c6`, p50 µs: `mount` `parseCommand` 14.9–17.7 →
0.64–0.78, build plus validate 108–130 → 121–133, `mount` total 149–181 →
148–164; `keystroke` total unchanged (1.9–2.5 both). The check moved into the
build rather than disappearing, so the gain is the second pass and the copy.

A node handle's identity lived in a module `WeakMap` that every `create` wrote
and every handle check read, and each text was encoded to count its UTF-8
bytes. Handles now carry the identity as a private class field (still frozen,
with `kind` as their only visible member) and texts are counted without
encoding. Six alternating processes each, [raw records](raw/)
`commit-handles-*`, per-process p50 µs: `mount` build 76.5–91.0 (median 80.2)
→ 68.9–88.9 (73.5), `mount` total 128–154 (134.8) → 119–156 (126.3);
`keystroke` total 1.9–2.5 → 2.0–2.2.

### Avoid duplicate append handle checks

`append` previously resolved both handles to calculate the final index, then
called `insert`, which resolved the same handles again. Both operations now
share the insertion logic after their own handle and lifecycle checks. Appends
still validate ownership, cycles and bounds before mutating the candidate.

On an Apple M2 Max, macOS 27.2, AC power, pinned Bun `b1007f117`, twelve
alternating fresh processes per version and mode each ran 5,000 samples after
warm-up. Values are medians of the twelve per-process p50s, in µs; paired raw
records, source hashes and compiler diagnostics are in [raw/](raw/).

| Scenario and phase | Development before | Development after | AOT before | AOT after |
| ------------------ | -----------------: | ----------------: | ---------: | --------: |
| Mount build        |             51.812 |            49.584 |     33.021 |    31.479 |
| Mount total        |             91.167 |            88.626 |     68.834 |    67.166 |
| Keystroke total    |              1.125 |             1.125 |      0.708 |     0.708 |

Mount build improved in 11 of 12 pairs in each mode. This isolates the core
transaction and serialization path; it measures neither native work nor
application startup, input-to-paint latency or competitive performance.

### Combine changed-node text checks

Validation now totals text and checks per-text limits in the same pass over
changed nodes. Either failure still invokes the same full-tree walk, preserving
its error order. On Apple M2 Max, macOS 27.2, AC power, pinned Bun `b1007f117`,
12 fresh-process pairs per mode alternated baseline and candidate. Each process
ran 300 warmups and 5,000 samples. AOT executables were produced by `bun compile`;
both were inspected for the compiled-program flag and omitted JIT. Other load
was uncontrolled. The table shows medians of per-process p50s, in µs; ratios
are medians of the within-pair candidate/baseline ratios.

| Scenario and phase | Dev before | Dev after | Dev ratio | AOT before | AOT after | AOT ratio |
| ------------------ | ---------: | --------: | --------: | ---------: | --------: | --------: |
| Mount validation   |     48.645 |    39.396 |     0.862 |     31.562 |    27.812 |     0.857 |
| Mount total        |    219.562 |   204.312 |     0.963 |    160.500 |   159.396 |     0.968 |
| Keystroke total    |      2.917 |     2.812 |     0.973 |      1.896 |     1.812 |     0.960 |

Mount validation improved in all 12 pairs in each mode; total mount improved
in 8 development and 9 AOT pairs. Unchanged phases varied as well, so these
figures do not establish an end-to-end UI gain. [Raw paired records](raw/)
include the per-process measurements and source and executable hashes.

## Reordering siblings in a full window

`moves.ts` measures 2,047 same-parent moves and transaction validation in a
4,096-node graph: moving tail children to the front, front children to the
tail, swapping adjacent pairs, and repeatedly appending the current tail. It
checks the final order and operation count. It excludes renderer work, IPC,
native model updates and paint. The repeated no-op case is a stress case,
not a claim about typical application traffic.

```sh
bun benchmarks/core/moves.ts [samples=30]
```

On Apple M2 Max, macOS 27.2, AC power and pinned Bun `b1007f117`, twelve
alternating fresh-process pairs per mode each ran five warmups and 30 measured
transactions per pattern. The table gives medians of per-process p50s in ms;
the ratio is the median of paired candidate/baseline ratios. Other load was
uncontrolled. Both AOT binaries had the compiled-program flag and omitted JIT.

| Pattern       | Dev before | Dev after | Dev ratio | AOT before | AOT after | AOT ratio |
| ------------- | ---------: | --------: | --------: | ---------: | --------: | --------: |
| Tail to front |     14.985 |     4.646 |     0.309 |      2.773 |     0.953 |     0.350 |
| Front to tail |      2.977 |     1.249 |     0.416 |      2.734 |     0.710 |     0.267 |
| Adjacent      |      9.087 |     6.257 |     0.706 |      4.597 |     1.686 |     0.373 |
| Tail no-op    |     10.753 |     0.474 |     0.045 |      2.018 |     0.196 |     0.098 |

All 12 pairs favored the candidate except development adjacent moves (9 of 12).
Longer moves still use splice; adjacent moves swap, a front-to-tail rotation
uses shift/push, and a tail match avoids a linear search. Every no-op still
emits an insert. An independent 12-pair `commit.ts` guard found median paired
ratios of 1.014 development and 1.003 AOT for mount total, and 1.050 and 1.048
for keystroke total; exploratory bootstrap intervals include 1 for all four.
These guard results are inconclusive, not proof of no regression. [Raw records](raw/)
hold every sample and executable and source hashes. None of these results
establishes end-to-end UI or competitive performance.

## Bulk removal from a full window

`removals.ts` builds a 4,096-node committed graph and removes 2,048 text
children in one transaction, then validates the candidate. It checks the
remaining order and operation count. `front`, `tail` (last to first), and
`alternate` exercise different sibling positions. It excludes renderer work,
IPC, native model updates and paint.

```sh
bun benchmarks/core/removals.ts [samples=30]
```

Removing the last child used to search the entire sibling array for its ID.
It now checks that position first and pops it; other positions still use the
existing search and splice. Twelve alternating fresh processes per version on
Apple M2 Max, macOS 27.2, AC power, pinned Bun `b1007f117`, each measured 30
batches after five warm-ups. The table shows medians of per-process p50s in
milliseconds; [raw records](raw/) retain all samples, source hashes and AOT
compiler diagnostics. Both AOT binaries had the compiled-program flag.

| Pattern   | Development before | Development after | AOT before | AOT after |
| --------- | -----------------: | ----------------: | ---------: | --------: |
| Front     |              1.039 |             1.022 |      0.920 |     0.914 |
| Tail      |              6.898 |             0.296 |      0.834 |     0.194 |
| Alternate |              3.084 |             2.048 |      0.934 |     0.935 |

Tail improved in all 12 process pairs in both modes. Front and AOT alternate
results overlap; the development alternate gain may depend on Bun's JIT and is
not extrapolated to other environments. These are core-only timings, not
end-to-end UI latency or a competitive comparison.

The native protocol model also searched each sibling list from the front.
`native/protocol/examples/removal_perf.rs` measures its `Tree::prepare`
preflight for the same removal patterns and verifies the remaining order. In
12 alternating release-build process pairs on the same machine, median
per-process p50 preflight times in milliseconds were:

| Pattern   | Before | After |
| --------- | -----: | ----: |
| Front     |  0.918 | 0.917 |
| Tail      |  2.241 | 0.182 |
| Alternate |  1.372 | 1.386 |

The tail case improved in all 12 pairs. This measures the Rust model, not the
full host or paint. [Raw records](raw/) retain the individual preflight samples
and source and binary hashes. Reproduce with:

```sh
cargo run --locked --release -p bun-native-protocol --example removal_perf
```
