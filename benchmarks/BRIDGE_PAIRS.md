# Historical bridge pairs

This is the first controlled collection step for [#297](https://github.com/0xPlayerOne/bun-native/issues/297). It compares the two **complete source revisions** that produced the historical acknowledgement-tail signal. It does not attribute that signal to a particular change or establish a performance improvement.

| Variant          | Exact tested merge                         | Client and native protocol |
| ---------------- | ------------------------------------------ | -------------------------- |
| A: BN1           | `6ea507b58d0249b752ff62691ebc1879f3fcf6da` | 2                          |
| B: native events | `4549e75ca5463f136898a2f5fb49d22b58dffa11` | 4                          |

The original runs used separate hosted machines. The new job builds both revisions on one Linux runner, preserves their individual dependency locks and uses each revision's matching client. Bun, Rust and GPUI pins must be equal. Native dependency versions and protocol behavior still differ: this first comparison does not isolate the event implementation from those other revision changes.

## Unchanged workload and timing boundary

Each revision's existing `benchmarks/bridge.ts` remains unchanged. It verifies three real window lifecycles and invalid ownership/revision operations, retains 1,000 text nodes, warms 20 requests, measures 1,000 individual property updates and ten batches of 100, then creates, updates and disposes 1,000 input entities. Shutdown must finish with native exit zero. The event revision continuously drains its focus/blur events and checks the complete native sequence; no production event switch is added or disabled.

The timer starts at Bun's send call and ends when the native UI-thread `applied` response reaches Bun. It includes validation, pipes, preflight, model/entity updates and scheduling delay. It is **not display presentation, OS-input latency or isolated model-preflight time**. The twenty request warmups remain in every invocation, in addition to the full-process warmups described below.

## Build once, then collect

The dedicated [workflow](../.github/workflows/native-bridge-pairs.yml) checks out both exact commits under the ignored `.bun-native/performance-sources` directory. Its read-only token is scoped to the existing checksum-pinned Bun installer. Bootstrap/environment evidence exists before downloads. Cargo builds each host with its own lockfile, `--locked --release`, two build jobs and incremental compilation disabled; a common build target can reuse identical dependencies. Each completed host is copied to a separate, immutable-by-convention artifact path before the next build. AOT compilation uses that revision's own helper and inspectors, with `--entry bridge --host-profile release`.

The preparation record retains commands, exit status, bounded logs, source commit and source/configuration hashes, compiler/helper sources, native-host and application hashes, compiler metadata and tool versions. AOT must have the compiled-program record and positive JIT removed-code ranges. Interpreter presence is not reported as absence. External hosts must match the explicit supplied path and hash; a debug host, changed source, another entry or another manifest fails preflight.

Both hosts and both AOT clients finish compilation before the first warmup. The controller never invokes Cargo or compilation in its `run` phase. Every observation creates a fresh Bun application and native process, on one isolated Xvfb/DBus/Openbox session with the same explicit lavapipe ICD, geometry and scale. The host's uninstrumented benchmark does not report its selected GPU adapter; the record distinguishes the exact requested ICD and installed Mesa version from actual adapter telemetry. Caches are neither cleared nor controlled, and runner load and power state are uncontrolled.

For a contributor with the two exact checkouts and documented Linux native prerequisites:

```sh
python3 benchmarks/bridge-pairs.py prepare \
  --sources "$PWD/.bun-native/performance-sources" \
  --target /absolute/path/to/paired-cargo-target \
  --bun /absolute/path/to/pinned-bun \
  --output /absolute/path/to/new-prepared-directory

xvfb-run --auto-servernum --server-args='-screen 0 1280x800x24 -nolisten tcp' \
  dbus-run-session -- bash scripts/quality/native-linux-session.sh \
  /absolute/path/to/new-session-directory -- \
  python3 benchmarks/bridge-pairs.py run \
  --prepared /absolute/path/to/new-prepared-directory \
  --bun /absolute/path/to/pinned-bun \
  --output /absolute/path/to/new-observations-directory \
  --pairs 5 --warmups 1
```

The output directories must be new. The runner refuses another commit or a dirty historical checkout. Preparation, collection and their manifests are bound to the controller source; changing that source requires a new preparation record.

## Predeclared sequence and failure policy

`plan.json` is written before any workload starts. The default plan has 24 invocations:

- One full warmup for each variant in each mode, all excluded from paired summaries.
- Five measured pairs in ordinary Bun and five measured pairs in inspected machine-code AOT.
- Within each mode, variant order is **AB, BA, AB, BA, AB**. The mode block order also alternates by pair. Five is an odd number, so this has three AB pairs and two BA pairs; it is not described as randomized or perfectly balanced.

The CLI allows only 5–10 measured pairs and 1–2 equal warmups. No failed attempt is retried. After a clean failed attempt the runner continues the saved sequence, preserving its result and logs; incomplete process cleanup or cancellation stops further trials. Any failed warmup, measurement or final source/artifact check makes the overall collection fail. A partial summary may show complete-pair descriptive data, but it is not an accepted comparison.

The benchmark retains its own 120-second workload deadline and bounded transport requests. The controller adds a 140-second outer deadline including preflight and exit, samples process ownership every 100 ms, and caps each captured stdout/stderr stream at 4 MiB. It observes the exact native child executable in the owned process tree. Process ownership, identity-safe termination and orphan reaping come from the existing native input driver. Forced termination fails a normal observation; cancellation still runs bounded cleanup and writes a failure record. Linux `/proc` and process IDs must agree. The source tests use inert metadata and ordinary Python child processes, and do not count as native GUI or AOT acceptance.

## Reports and interpretation

Every raw `result.json` retains all 1,000 individual durations and ten batch durations. The controller recomputes nearest-rank p50/p95/p99 and sums from those arrays, rejects incomplete/non-finite samples and binds every result to the matching application, release host, exact source and AOT manifest. It also retains the count of individual samples over 10 ms. This threshold describes the historical tail; it is not a pass/fail budget.

`summary.json` contains per-pair values, B-minus-A differences and B/A ratios, plus medians of the paired differences and ratios. A zero denominator produces `null`, not infinity. Samples from separate invocations are not pooled to claim a larger independent sample count. With five pairs and only ten batch samples per invocation, tails and ratios are descriptive. There is no significance or causal claim.

The workflow retains preparation manifests/logs, the predeclared plan, raw observations, failures, source/artifact hashes, controller logs and cleanup records. Routine upload omits the large executable files; their recorded inspection cannot later be independently repeated from that upload alone. No passing performance result exists until this hosted collection actually completes. A green job establishes correct collection and cleanup, not a speedup.

If the paired records reproduce a meaningful shift, #297 next requires separate bounded phase/render-count diagnostics and stack-based allocation/CPU profiling of the isolated update phase. Those instruments must not be mixed into these normal timings. The callback-boxing path is a source-supported hypothesis awaiting that evidence. No native optimization, event suppression, phase instrumentation or allocation attribution is introduced in this increment.
