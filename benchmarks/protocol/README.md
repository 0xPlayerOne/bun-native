# Protocol encode/decode micro benchmark

`roundtrip.ts` runs the calls `@bun-native/runtime` makes per message, in
process and without IPC, and times each phase separately:

- commands out: `parseCommand` (the runtime revalidates every command) and
  `encodeFrame`, for a full 256-operation `mount` batch (rows of styled
  `box > [text, button]` creates and inserts), a two-`set` `keystroke` batch
  (input value plus a dependent label) and one `large-text` set of a
  12,000 character log;
- events in: one 9,262-byte pipe chunk of 56 frames (pointer down/up, click,
  key down/up and input per keystroke, plus `applied` acknowledgements) through
  a fresh `FrameDecoder.push`, then `parseEvent` over the decoded frames.

```sh
bun benchmarks/protocol/roundtrip.ts [samples=2000]
```

Timings are wall-clock per call in µs with nearest-rank percentiles after 200
warm-up calls. They exclude pipe I/O, native work and core/renderer work.

## Linux x64 result

[Raw records](raw/): source `822086b`, pinned Bun `da867c60`, Linux 6.18 (4 vCPU
cloud container), three processes. Ranges are per-process p50s; means and
p95s are dominated by collections of the large batch's garbage.

| Scenario     | Phase               | p50 µs    |
| ------------ | ------------------- | --------- |
| `mount`      | `parseCommand`      | 33.4–53.8 |
| `mount`      | `encodeFrame`       | 26.1–26.5 |
| `keystroke`  | `parseCommand`      | 0.79–1.10 |
| `keystroke`  | `encodeFrame`       | 0.47–0.85 |
| `large-text` | `parseCommand`      | 1.11–1.50 |
| `large-text` | `encodeFrame`       | 3.83–5.90 |
| 56 events    | `FrameDecoder.push` | 27.9–29.2 |
| 56 events    | `parseEvent`        | 27.1–75.1 |

Nothing here is an outlier against the renderer commit it accompanies: a full
mount batch costs about 0.24 µs per operation to validate and encode, and an
event about 1 µs to frame and validate. `JSON.parse` dominates
`FrameDecoder.push`: decoding the whole chunk with one `TextDecoder` call and
splitting it was measured at the same cost as decoding each frame and was not
adopted. Remaining per-event allocations (`[...ROUTE_KEYS, ...]` key lists and
spread route objects in `parseEvent`) live in `messages.ts`.
