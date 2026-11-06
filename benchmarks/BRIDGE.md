# Native bridge benchmark

For the source-pinned, alternating BN1/native-events comparison in #297, see
[Historical bridge pairs](BRIDGE_PAIRS.md). It reuses each recorded revision's
unchanged workload and retains every failed attempt; it adds no performance
claim before hosted collection.

`bridge.ts` exercises the real Bun process, bounded native pipes, Rust transaction
model and GPUI host. It requires an explicit **prebuilt** native executable and
a working native display. It never builds Rust or substitutes a protocol peer.

The measured interval starts immediately before `NativeHost.send` and ends when
the host's UI-thread `applied` response reaches Bun. It includes command
validation/serialization, pipe transport, native preflight, synchronous model
and entity updates, output transport and response validation. Rendering can
delay the main thread between requests. An acknowledgement is not a frame
presentation timestamp or a guarantee that the user has seen the new pixels.

## Workload

Each invocation performs a bounded sequence:

1. Create three real windows over one session. Check cross-window handles,
   rejected cycles/orphans, failed transaction revision and ID rollback, stale
   input revisions, subtree disposal, closed-window ID reuse and ordered native
   close events. The current protocol's focus/blur observations are continuously
   drained and included in the complete global sequence check; they are not
   mistaken for input callbacks or close-only sequence numbers. A remaining window must keep accepting updates after another
   closes.
2. Create 1,000 text nodes, keep all of them alive, and warm up 20 requests.
3. Measure 1,000 individual property updates, then the same number of updates in
   ten batches of 100. Build each operation payload before starting its timer.
4. Delete all 1,000 text nodes. Create, explicitly update and delete 1,000 native
   input entities in separate acknowledged transactions, exercising real GPUI
   entity and focus cleanup.
5. Close the remaining native window, flush shutdown and require native exit 0.

The runner keeps raw per-request durations and reports nearest-rank p50/p95/p99.
The ten batch samples have limited statistical value; their p95/p99 are the
maximum sample. Compare total time for the same 1,000 updates and repeat matched
trials before claiming a speedup or setting a budget. The workload has a
120-second deadline in addition to the transport's bounded request timeout.

The input lifecycle loop creates real entities; it does not inject OS keyboard
events or wait for every intermediate entity to be painted. Use the native
OS-input harness for click, typing, focus, stale-input races and visual evidence.
This benchmark also does not establish leak freedom, cold startup, CPU/GPU
utilization, native RSS or physical-GPU frame latency. Those need their own
measurement tools and controlled workloads.

## Development execution

Build the host deliberately as a contributor, or use a native artifact whose
build provenance and hash are already recorded:

```sh
cargo build --locked -p bun-native-host --release
bun benchmarks/bridge.ts \
  --mode development \
  --host "$PWD/target/release/bun-native-host" \
  --host-profile release \
  --source "$PWD" \
  --output /tmp/bun-native-bridge-development-01
```

The output directory must not already exist. On a Linux hosted runner with the
documented native dependencies, run that Bun command inside an isolated
`dbus-run-session -- xvfb-run -a -s '-screen 0 1024x768x24'` session. Select the
installed Mesa lavapipe ICD explicitly through `VK_DRIVER_FILES` when a software
comparison is intended. `LIBGL_ALWAYS_SOFTWARE=1` and
`GPUI_X11_SCALE_FACTOR=1` make that test environment reproducible. An environment
request alone does not establish which GPU adapter GPUI actually used.

`--host-profile dev` records an unoptimized contributor build. A development
profile result must not be presented as a production host baseline. Normal
application edits rerun Bun and reuse the host; this runner never invokes Cargo.

## AOT execution

Use the shared artifact recipe to compile this exact entry, inspect it and write
its manifest:

```sh
bun experiments/aot-gpui/build-window.ts \
  --entry bridge \
  --host "$PWD/target/release/bun-native-host" \
  --host-profile release \
  --source "$PWD" \
  --outdir /tmp/bun-native-bridge-aot
```

The recipe invokes `bun compile --no-script --production --explain=json` and
uses the pinned `inspectBunExecutable` and `inspectBunRuntime` helpers. The bridge
entry references the existing host rather than copying another native binary.
Do not reuse a native-window manifest or infer AOT from an ELF section name,
filename or mode flag. Custom build jobs must produce the same artifact-bound
manifest, with these fields:

- `application.bytes`, `application.sha256` and
  `application.inspection.hasCompiledProgram: true` for the benchmark executable.
- On Linux, `application.runtimeFeatures` with a non-present JIT feature and
  positive validated JIT removed-code ranges. `trimmedProgramFeatures` describes
  optional program-feature trimming and is not used as proof of JIT omission.
- `host.bytes`, `host.sha256` and `host.profile` for the supplied prebuilt host.
- `source.files` containing byte counts and SHA-256 values for every source and
  configuration file enumerated by `bridge.ts`, captured consistently with the
  build. Changes to package exports, dependency locks or compiler configuration
  are source changes too.

Then run the resulting executable with the same native display environment:

```sh
/tmp/bun-native-bridge-aot/bridge \
  --mode aot \
  --aot-manifest /tmp/bun-native-bridge-aot/manifest.json \
  --host "$PWD/target/release/bun-native-host" \
  --host-profile release \
  --source "$PWD" \
  --output /tmp/bun-native-bridge-aot-01
```

Before starting the workload, the runner streams hashes of `process.execPath`
and the host, verifies them against the build manifest, checks source hashes,
and exercises the pinned AOT runtime's read-only built-in behavior as a
corroborating witness. These checks are excluded from acknowledgement samples.
The inspection metadata is external build evidence bound to the exact executable
hash; the runner does not scan a full executable buffer during measurement.
No result claims that the interpreter is physically absent.

## Instrumentation and artifacts

Add `--instrument` for a separate diagnostic run. The runner supplies a fresh
nonce and `native-events.jsonl` path to its own child. The host records actual
window GPU specs and `batch_applied` records containing `preflight_nanos`,
operation count, node count and retained text bytes. Preflight includes schema
semantics, candidate graph cloning and graph validation; it excludes GPUI apply,
layout, painting and display presentation.

Paint snapshots are bounded. A tree snapshot exceeding the record limit emits
`status: "omitted"` and a reason rather than partial assertion state. Model
preflight metrics remain available for large trees. The host performs this
opt-in serialization/file I/O on the UI thread, so instrumentation can materially
change throughput. Compare it separately from normal runs.

`result.json` contains the pinned runtime/toolchain, exact source and binary
hashes, source commit and dirty flag, declared native profile, display request,
execution mode evidence, semantic check results, every acknowledgement timing,
and native exit status. `totalWorkloadMs` includes setup, stabilization waits and
teardown; the per-request distributions do not. A failed workload writes a
failed result where possible and still attempts bounded shutdown. Preflight
argument/provenance errors occur before a host is launched.

Keep the raw results with the build artifacts. A performance comparison needs
the same source, host artifact/profile, target, adapter, window size, workload,
instrumentation setting and environment, with repeated trials and controlled
power/load conditions. Hosted software rendering and a physical GPU are separate
baselines.

## Initial diagnostic findings

The [small diagnostic record](bn1/initial-bridge-diagnostic-linux-x64.json) retains
the original summary measurements and hashes of the source reports and native
instrumentation log.

The first Linux x64 diagnostic used Bun
`1.4.4-canary.1+da867c60b`, the development-profile native host with SHA-256
`8a221ff318aa0a3ee0bfff95bc243dc0091d3c0a2af97347ab3bc550cc3ad40e`,
and GPUI on X11/Xvfb. Separate native-input runs reported the actual adapter as
Mesa llvmpipe 25.2.8 with LLVM 20.1.2. The prototype benchmark used the same host
and explicit lavapipe environment. These are single diagnostic runs, not
controlled release comparisons.

| Diagnostic               | Individual updates: p50 / p95 / p99 | Total for 1,000 individual updates | Total for ten 100-operation batches |
| ------------------------ | ----------------------------------- | ---------------------------------: | ----------------------------------: |
| Instrumentation disabled | 0.999 / 58.047 / 64.994 ms          |                       8,360.759 ms |                          230.318 ms |
| Instrumentation enabled  | 1.068 / 68.198 / 84.072 ms          |                      10,609.382 ms |                          298.388 ms |

With 1,001 retained nodes, 1,020 instrumented single-operation preflights measured
p50 0.624 ms, p95 0.929 ms and p99 1.390 ms. The roughly 60–80 ms acknowledgement
tail was therefore outside most model preflight samples. Renderer/main-thread
profiling with an optimized host is needed before attributing that tail more
precisely or replacing the graph-clone strategy.

Both runs passed all three window lifecycles, 1,000 text-node disposal operations
and 1,000 native input-entity lifecycles with native exit 0. Optional evidence
produced 4,223 records totaling 765,396 bytes; 149 large paint snapshots were
explicitly omitted. The prototype kept summary latency statistics rather than
every individual duration; the committed runner now retains raw timings. These
observations motivate batching and the BN1 performance audit; they do not define
a production latency budget.

## Phase and render attribution (#297)

`BUN_NATIVE_PHASE_TRACE=/new/file.json` enables a separate, bounded UI-thread
phase trace in the host. It is off by default; disabled hooks perform one
thread-local check and no clock read, allocation or I/O. When enabled, each
acknowledged batch records its prepare (validation and candidate graph clone),
apply (`NativeView.apply`) and reply-enqueue durations plus the number of root
renders so far. Each root render records its element-construction time (which
also includes the trace's own node count, microseconds at 1,001 nodes) and the
time from render start to the final native canvas paint callback (GPUI layout,
prepaint and paint; GPU submit and presentation excluded). Records stay in fixed
memory (4,096 batches, 16,384 frames; overflow is counted and rejected by the
analyzer) and are written once after the command loop ends, never between
measured requests. A path that already exists disables the trace.

Run the unchanged bridge workload with the variable set, then join the two
outputs:

```sh
BUN_NATIVE_PHASE_TRACE=/tmp/bridge-01.phases.json bun benchmarks/bridge.ts ... --output /tmp/bridge-01
python3 benchmarks/bridge-phases.py --result /tmp/bridge-01/result.json --trace /tmp/bridge-01.phases.json
```

The analyzer selects exactly the 20 warmups, 1,000 measured single-operation
requests and ten 100-operation batches on window 1, requires contiguous request
IDs, and fails on dropped records or incomplete samples. `requestAndReplyTransportMs`
is the acknowledgement minus the native UI-thread time; it includes pipe
transport, reader/scheduler queueing and any render that ran between requests.
Phase-traced runs are instrumented diagnostics and must not be merged with the
uninstrumented baseline.

### Local measurement, November 5, 2026

[Raw record](results/bridge-phases-local-2026-11-05.json): shared 4-CPU cloud
container (Intel Xeon 2.80 GHz, Ubuntu 24.04.5, Linux 6.18), Xvfb with lavapipe
requested, pinned Bun canary, release host, ordinary Bun development mode only.
Other agents were compiling concurrently (load average 10–27), so absolute
values are noisier and slower than hosted CI; trial `p1-A` is visibly contended
(78 frames instead of about 20). No trial was rerun or removed. AOT was not
collected in this diagnostic.

| Current host trial | Ack total, 1,000 updates | Native UI-thread total | Renders between requests | Acks after a render: count / total | Other acks: total / p99 |
| ------------------ | -----------------------: | ---------------------: | -----------------------: | ---------------------------------: | ----------------------: |
| t-phase-1          |                 985.7 ms |               200.5 ms |                       21 |                      21 / 486.9 ms |         498.0 / 1.67 ms |
| p2-A               |               1,096.5 ms |               247.8 ms |                       23 |                      23 / 748.8 ms |         347.5 / 2.27 ms |
| p3-A               |                 998.5 ms |               238.2 ms |                       21 |                      21 / 622.6 ms |         375.4 / 2.93 ms |

The tail is render interleaving, not bridge or apply cost. Native prepare, apply
and reply together are p50 0.18–0.19 ms and p99 0.60–1.22 ms. The roughly 2% of
requests that follow a full 1,001-node render on the shared UI thread carry
49–68% of the summed acknowledgement time and the p99; acknowledgements without
an intervening render have p99 1.7–2.9 ms and a maximum of 2.6–6.8 ms. A render's element construction is about 1.9–2.0 ms;
render-to-paint is about 13.5–14.5 ms under lavapipe.

**Callback-allocation hypothesis.** Heaptrack 1.5.0 around the host attributes,
per rendered node, 6.0 allocation calls under `render_node` and 4.0 under GPUI
`Interactivity::paint_mouse_listeners` (111,549 node renders; 3,677,675 calls in
the whole run). A measurement-only counterfactual that removes
`PointerFrame.target` (it breaks pointer events and is not committed) leaves 2.0
per node under `render_node` and none in `paint_mouse_listeners`. The two capture
callbacks therefore cost **8 allocation calls per node per rendered frame**,
about 8,000 per 1,001-node frame: two boxed listeners and two listener-vector
allocations at build time, plus two boxed window listeners and their storage at
paint time. Taffy layout and text layout/shaping remain larger allocation
sources per frame.

| Paired phase trial | Variant                  | Render construction p50 |          Render-to-paint p50 |
| ------------------ | ------------------------ | ----------------------: | ---------------------------: |
| p1                 | current / counterfactual |          2.03 / 1.22 ms | 30.94 (contended) / 12.29 ms |
| p2                 | counterfactual / current |          1.05 / 1.92 ms |             11.20 / 13.54 ms |
| p3                 | current / counterfactual |          1.96 / 1.13 ms |             14.26 / 12.03 ms |

Removing the callbacks entirely is an **upper bound** of about 0.8 ms of element
construction and about 2.2–2.3 ms (15%) of render-to-paint per 1,001-node frame
in the two uncontended pairs. It does not remove the tail: frames still take
about 12 ms and still delay the following acknowledgement.

**Tradeoff and decision.** No optimization is applied in this change. The
callbacks are the per-node GPUI hitbox registration that gives the deepest
visible native hit in paint order, including clipping and scroll offsets, and
the measured saving is bounded at about 15% of frame time. A same-semantics
replacement would need a custom wrapper element that inserts an identical
`Normal` hitbox per node in the same order and resolves the target in the one
existing window capture observer. It must be qualified with the native pointer,
scroll-clipping, focus, route-ordering and macOS hit-testing scenarios on both
ordinary Bun and AOT before it replaces the current path. The acknowledgement
tail itself is governed by frame cost (layout, text and software paint) and
scheduling, so a callback change alone cannot be presented as a tail fix.
