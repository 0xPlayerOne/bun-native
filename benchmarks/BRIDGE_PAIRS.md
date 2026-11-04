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

The workflow retains preparation manifests/logs, the predeclared plan, raw observations, failures, source/artifact hashes, controller logs and cleanup records. Routine upload omits the large executable files; their recorded inspection cannot later be independently repeated from that upload alone. A green job establishes correct collection and cleanup, not a speedup.

If the paired records reproduce a meaningful shift, #297 next requires separate bounded phase/render-count diagnostics and stack-based allocation/CPU profiling of the isolated update phase. Those instruments must not be mixed into these normal timings. The callback-boxing path is a source-supported hypothesis awaiting that evidence. No native optimization, event suppression, phase instrumentation or allocation attribution is introduced in this increment.

## First hosted collection

[Run 41245052954, attempt 1](https://github.com/0xPlayerOne/bun-native/actions/runs/41245052954) completed all four warmups and twenty measured launches once, with no forced cleanup, remaining child processes or truncated logs. The [compact record](evidence/bridge-pairs-41245052954.json) binds the original artifacts, exact sources, application/native hashes, every raw observation and all five pair comparisons per mode. Offline verification recomputes all 24,000 individual and 240 batch samples, validates the complete saved order and verifies the historical source blobs and AOT inspection records. It performs no new native execution or binary inspection.

The earlier unmatched roughly elevenfold p95 increase **did not recur under these matched conditions**. It must not be treated as an elevenfold source-regression claim. The smaller sum increase remains consistent across all five pairs in each mode, so #297 remains open for attribution:

| Metric                                   | Development median paired difference | Development median paired ratio | AOT median paired difference | AOT median paired ratio |
| ---------------------------------------- | -----------------------------------: | ------------------------------: | ---------------------------: | ----------------------: |
| Individual p95                           |                         +0.017581 ms |                          1.0155 |                 +0.008308 ms |                  1.0073 |
| Sum of 1,000 individual acknowledgements |                        +62.845186 ms |                          1.1745 |                +21.642333 ms |                  1.0609 |
| Sum of ten batches                       |                         +1.074448 ms |                          1.0667 |                 +9.453509 ms |                  3.5104 |

The batch results are variable; their ten-sample p95/p99 equal the maximum. They remain part of the evidence. This one four-CPU hosted Linux session used an explicit Mesa lavapipe ICD without logging the actual GPUI adapter. Power, load and page caches were uncontrolled. The results do not isolate event implementation changes from other source/dependency differences or establish a performance improvement.

The separate [required validation run 41245052851](https://github.com/0xPlayerOne/bun-native/actions/runs/41245052851) failed at first native open request 3 after the unchanged five-second deadline. Native build/lint/tests passed; later GUI scenarios were skipped. Its startup trace reached `open_window_enter` but not `root_constructor_enter`, narrowing [#296](https://github.com/0xPlayerOne/bun-native/issues/296) to GPUI's pre-root construction. No source cause is established. This failure is retained separately from the successful paired collection; neither attempt was rerun.

### Reproduce the offline audit

Download the original ZIPs from those two runs: artifact `13059517123` (`bridge-pairs-linux-X64`) and artifact `13058788896` (`native-linux-X64`). Keep their bytes unchanged. The audit validates their SHA-256 receipts before reading any member, rejects unsafe/duplicate paths and oversized/non-finite data, and never extracts or executes their contents.

The local repository must contain the exact historical commits and the four controller blobs from the tested merge. Fetching these public Git objects is separate from the offline audit:

```sh
git fetch --no-tags origin \
  6ea507b58d0249b752ff62691ebc1879f3fcf6da \
  4549e75ca5463f136898a2f5fb49d22b58dffa11 \
  010db65754ca9e54eca28e7701324e22b3c1f6c2 \
  d9098fee494e41e50cb5636fe256fecc316b7bde \
  0030eacc97ec7d25662af1c2ecd121104f0d4da0

python3 benchmarks/audit-bridge-pairs.py \
  --paired-artifact /absolute/path/bridge-pairs-linux-X64.zip \
  --validation-artifact /absolute/path/native-linux-X64.zip
```

This verifies recorded source/build/execution identities and recalculates statistics. Uploaded executables are absent by design, so it does not independently repeat binary metadata inspection. A failed audit does not retry or modify any workload, archive or original result.
