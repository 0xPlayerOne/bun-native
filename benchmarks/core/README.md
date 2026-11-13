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
