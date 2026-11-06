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
