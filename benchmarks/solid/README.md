# Matched Solid and public-core workload

This runner compares two separate applications against one explicit prebuilt GPUI host. `reactive.tsx` uses the real Solid universal renderer, signals and keyed `<For>` rows. `direct.ts` performs the same native work through `@bun-native/core` and does not bundle Solid. Both create the same native tree, including an owned container, label, button registration and keyed rows. The default 32 rows produce 38 native nodes including the window root.

This tooling was reconstructed after a workspace recycle. Previous repeated-run raw evidence was lost and is not recreated here. Only fresh reports from this source can establish its measurements. The historical native correctness record elsewhere in the repository does not qualify this benchmark or the later renderer fixes.

## Workload and verification

Each default trial mounts the tree, warms up 20 acknowledged updates, then measures:

1. 1,000 individual label values, requiring exactly 1,000 native sets.
2. The same number of application values in 100 groups of ten. Solid batches its signal writes; direct core applies the final value of each group. Both require exactly 100 native sets.
3. 1,000 left rotations of the 32 retained keyed rows. Each rotation requires one move with no creates or deletes, preserving every row owner.
4. Disposal of the measured view, followed by 100 complete mount/dispose cycles in the same window. Every row owner must be disposed; only the window's own root may remain between cycles, with zero callbacks or pending work.
5. A bounded weak-target observation and native shutdown. All six public ownership/queue counters must finish at zero.

The controller builds the two entries with the official Solid JSX/Bun route, then separately compiles each generated JavaScript module with `bun compile --no-script --production --explain=json`. It inspects the actual executable's compiled-program flag and, on Linux, validated JIT omission records. The interpreter may remain present. The controller hashes each exact artifact before launch and verifies the child-reported executable path, Bun revision and independent nonce. A declared mode alone never establishes AOT.

Four short instrumented calibration launches verify exact initial/final native paint trees and record the actual GPUI GPU adapter. They are excluded from timing comparisons. Timed launches disable native evidence serialization. Each adapter/mode pair has one complete unmeasured warmup followed by five measured trials, with pair order reversed on alternating trials. Source/configuration and host hashes must remain unchanged through the comparison.

## Timing and retention boundaries

The outer operation sample starts before the application setter/batch call and ends after public-core acknowledgement. It includes deferred reactive planning, validation, serialization, pipes, native model work and response processing. The separate synchronous-submission sample includes only the initial call. Neither metric is input-to-paint or display-presentation latency. Every raw sample is retained; each trial's p50/p95/p99 uses nearest rank. Compare repeated matched trials rather than one favorable percentile.

Three sparse JSC heap snapshots run outside mutation timing samples: a mounted view after warmup; the measured view disposed with timing arrays retained; and all repeated views disposed with timing arrays and weak probes retained. These are live-heap observations, not cumulative JavaScript allocations or native/GPU allocation totals. Their different retained state prevents interpreting subtraction as per-update allocation cost. Reported RSS belongs only to the Bun application process.

The default lifetime check deliberately retains 300 WeakRef objects, three per repeated view. Core probes observe its container handle, label handle and listener; Solid probes observe its render root, content node and listener. The retained observation objects are not retained targets.

The collection procedure is fixed: complete all acknowledged disposals, cross a one-millisecond timer boundary, collect and observe; advance exactly one empty core transaction, cross another timer boundary, collect and observe again. The empty batch is a JS/core queue fence and sends no native command. Both observations and target indices are retained. The runner never repeats collection until it obtains a favorable answer. Completed timings and lifecycle/heap data are recorded before the final assertion.

The bounded contract requires zero final observed targets. A positive result requires investigation and remains failed; it does not by itself identify a retaining path or prove a framework leak. Zero targets at this checkpoint does not establish long-term leak freedom. The earlier investigation observed runtime/scheduling-sensitive positives even in a control without framework imports, but its missing raw artifacts cannot be used as newly verified evidence here.

## Run and preserve evidence

Use the checksum-pinned Bun and a prebuilt host with known build provenance. The runner does not invoke Cargo or copy the host. The host-profile argument records a supplied provenance label; retain the actual native build logs/manifests before claiming release results.

On Linux, use the existing private display/session supervisor:

```sh
xvfb-run --auto-servernum --server-args='-screen 0 1280x800x24 -nolisten tcp' \
  dbus-run-session -- bash scripts/quality/native-linux-session.sh \
  /absolute/new-session-directory -- \
  bun benchmarks/solid/run.ts \
  --host /absolute/path/to/prebuilt/bun-native-host --host-profile release \
  --output /absolute/new-result-directory
```

Use fresh output/session directories outside the repository, preferably under the task workspace so environment recycling does not silently discard the only measurements. Native binaries remain build artifacts; publish source and raw measurement evidence separately.

`--trials` accepts 1–10 measured trials per pair. `--iterations` must be a multiple of ten in 10–10,000; `--rotations` accepts 1–10,000; `--mounts` accepts 1–1,000; `--rows` accepts 1–128. Defaults are the workload above. The child workload has a 120-second deadline and bounded transport requests; the controller imposes a separate 180-second child limit and a 1 MiB captured-output limit. The session supervisor remains responsible for descendant cleanup if a process is forcibly stopped.

`comparison.json` records source/host/compiler provenance, executable inspection, actual calibration GPU metadata and report digests. Per-trial JSON retains raw timings, mutations, component reuse/disposal, weak-target and heap observations, and cleanup. CPU models, logical count, OS and memory are recorded; power state, other machine load and OS cache state remain uncontrolled. A development-profile host is explicitly diagnostic and does not establish release performance.

Actual pointer/text qualification uses the separate `tests/native/solid-window.py` scenarios. Input-to-paint, display presentation, cumulative allocations, native RSS, hardware-GPU behavior, macOS/Windows GUI, physical input, IME/accessibility, cold-cache startup and long-term leak freedom remain separate acceptance work.
