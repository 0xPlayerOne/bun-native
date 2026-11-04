# Selected native allocation diagnostic

This diagnostic supports the remaining allocation investigation in [#297](https://github.com/0xPlayerOne/bun-native/issues/297). The [paired benchmark](../BRIDGE_PAIRS.md) remains the timing experiment. This increment qualifies an independent Rust/Heaptrack gate and prepares source patches; it does **not** compile or profile either historical GPUI host, explain the measured cost, or claim an optimization.

## Fixed source and interval

Only the two recorded historical revisions are accepted:

| Variant       | Exact source                               | Native protocol |
| ------------- | ------------------------------------------ | --------------- |
| BN1           | `6ea507b58d0249b752ff62691ebc1879f3fcf6da` | 2               |
| Native events | `4549e75ca5463f136898a2f5fb49d22b58dffa11` | 4               |

Their original checkouts must remain clean. The unchanged bridge clients, dependency locks and workload are retained. The patch generator copies four native files to a new output directory and writes a unified patch plus an identity manifest. It never edits the supplied historical checkout.

| Selected phase      | Request IDs, inclusive | Operations per command | First base revision |
| ------------------- | ---------------------- | ---------------------- | ------------------- |
| Individual sets     | 48–1047                | 1                      | 33                  |
| Batches of 100 sets | 1048–1057              | 100                    | 1033                |

Both phases require window 1, root 1, exactly 1,001 retained nodes at entry, and the original text-node IDs 9–1008 with their exact canonical `single N` or `batch N` updates. Missing, duplicate, reordered, failed or differently shaped selected requests fail the diagnostic. It never searches the command stream for a replacement sample.

Capture starts immediately before `Tree::prepare` of the first selected batch, after the borrowed validation checks. It stops **inside** the update closure immediately after `NativeView.apply` of the last selected batch, before the closure returns or the final reply is enqueued. Intervening replies, rendering and scheduler work remain part of the selected interval.

Heaptrack records allocation calls from the **whole native process**, including other threads, during that interval. Separate atomic counters record entries into the root render function for window 1 and other windows. Those counters do not represent frames, presentation, allocations in the render function, or a causal link to any allocation stack. No source text payload enters the numeric diagnostic records.

## Private ABI and build boundary

`experiments/native-allocation-api` is a standalone, standard-library-only Rust crate. It adds no production Cargo dependency, does not change either historical lock graph, and exposes no framework/host protocol API. The patch adapter is private to explicitly instrumented copies.

The four FFI declarations come from the attributed [Heaptrack 1.5.0 header](https://invent.kde.org/sdk/heaptrack/-/blob/v1.5.0/src/track/libheaptrack.h), SHA-256 `fecf91761b2f785ce1f4d99a5311e5933fb1a425fabca23aed9ad66942d4d89b`. All callbacks are null; Rust never receives or accesses the C++ `LineWriter` reference. A thread-owned loader handle retains the library, and `dladdr` must attribute every required function to the exact canonical preloaded library. Missing symbols or a different owner fail closed.

The diagnostic is disabled unless `BUN_NATIVE_ALLOCATIONS=1`. The disabled path does not open files, resolve profiler symbols or re-execute. When explicitly enabled, the executable replaces only itself before native threads are created, retaining its PID, executable identity and arguments while adding the verified preload. The Bun application never receives that preload. Configuration requires a private new output directory, a nonce, one declared historical revision, the selected phase and the exact rlib build identity.

The qualifier compiles and hashes that separate rlib with Rust 1.98.1. The patch manifest supplies the same `--extern`, explicit cfg, cfg declaration, debug information and no-strip flags to host Clippy and the future host build. The patch must be applied only to another checkout. Before any historical trial is accepted, its controller must also bind the patched sources, flags, original source/lock identity, exact host/client/rlib bytes and the emitted armed/completed records. That collection controller and the historical native builds are a subsequent increment.

## Actual bounded control

Run on Linux GNU x64 with the repository-pinned Rust toolchain and the exact declared Heaptrack 1.5.0 library:

```sh
python3 benchmarks/native-allocation-control.py --output /absolute/new-control-output
```

The installed profiler library SHA-256 must be `134760dbba8d9a2cd1b45f639c119f5c0cd779674a496fb7ed2b6baacac15ca9`. The interpreter, printer, demangler, limit tool, compiler, generated rlib and executable are all fingerprinted. The official ABI header digest was freshly verified during recovery. This is a deliberately narrow qualified platform/build, not automatic support for other Heaptrack distributions.

The controller uses the existing paired runner's process supervisor and native driver's PID/start-time/executable/library identity checks. It has no second process-tree owner. Output is capped, descendant pipes are drained and joined, and incomplete cleanup fails the control. No failed case is retried within a run.

| Control                | Required outcome                                                                                                |
| ---------------------- | --------------------------------------------------------------------------------------------------------------- |
| Disabled               | Normal exit and no diagnostic files                                                                             |
| Individual             | Exactly 1,000 selected allocation stacks; zero outside-region stacks                                            |
| Batch                  | Exactly 10 selected allocation stacks; zero outside-region stacks                                               |
| Changed request ID     | Exact diagnostic rejection before capture                                                                       |
| Missing ABI            | Exact missing-symbol rejection                                                                                  |
| Existing output        | Rejection with the existing bytes preserved                                                                     |
| Active-region deadline | Explicit region-entry witness, fixed one-second timeout, owned child terminated and joined, no completed record |
| Trace overflow         | Exact 32 KiB trace limit and `SIGXFSZ` termination, no completed record                                         |

The positive controls allocate before and after capture as a negative selection oracle. Heaptrack is initialized while paused, resumed for the interval, and paused/stopped at its end. The selected-file stacks must exclude both outside calls. Rust v0 crate disambiguators are parsed as part of exact function frames, with malformed/count/lookalike negatives.

The [recovered control record](evidence/selection-control-linux.json) binds the passing source and tools. Fresh attempt 01 exposed a reader that omitted Rust v0 crate disambiguators. Attempt 02 exposed a timeout oracle that incorrectly expected a buffered trace to have flushed before termination. Both failed attempts are retained in raw task evidence; the corrected control adds an explicit active-region witness and preserves the original deadline and cleanup requirements. Fresh attempt 03 passed all eight cases. Earlier pre-recovery raw evidence was lost and is not used to qualify this source.

After a passing control, generate each source patch without executing a historical host:

```sh
python3 benchmarks/allocation-phases.py \
  --source /absolute/clean-bn1-checkout --variant bn1 \
  --qualification /absolute/new-control-output/result.json \
  --output /absolute/new-bn1-patch
```

Use `--variant events` with the exact event revision for the other patch. Both complete CLI paths were verified against clean historical checkouts. Any changed diagnostic source or rlib invalidates the qualification record and blocks patch preparation.

## Interpretation limits

Allocation gating, symbol resolution, debug information and the profiler itself can perturb scheduling. Instrumented elapsed times must not be compared to the optimized originals as a performance improvement. Selected allocation calls and stacks do not establish selected-interval peak/live memory or leaks: objects may cross either boundary, and unrelated native threads are included. Incidental whole-process or peak/leak labels emitted by the profiler's generic report are retained as raw output only; this diagnostic does not promote them to gated metrics. Bun allocations, physical input latency, display presentation and GPU memory are outside this control.

## Required current-source control

The Linux native job now executes `native-allocation-control.py` against its
actual pinned Rust compiler and the installed, hash-verified Heaptrack ABI before
starting GUI scenarios. All eight predeclared cases must pass: disabled,
individual, batch, mismatch, missing ABI, exclusive-output collision, deadline
and file cap. Source/compiler/library identities and every outcome are retained
in the `allocation-selection` CI artifact directory even after failure.

This complements the standalone crate tests and historical qualification; it
does not profile either historical GPUI application, attribute performance, or
turn a macOS metadata test into a Linux allocation observation. A controller
error or interruption always restores `status=failed` before writing its final
report. A deterministic test rejects the old successful-status failure path.
