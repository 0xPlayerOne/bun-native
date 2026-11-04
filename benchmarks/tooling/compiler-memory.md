# Compiler-only memory control for #372

This plan is committed **before execution**. Its four cases investigate whether
the existing compiler path contributes to the controller memory observations in
[#372](https://github.com/0xPlayerOne/bun-native/issues/372). They do not resolve
the native watcher resource acceptance in
[#243](https://github.com/0xPlayerOne/bun-native/issues/243).

## Source and earlier observation

The control starts from
[`8acd854ec7ad6c49551ebe2c2ca1b19b756fc5ce`](https://github.com/0xPlayerOne/bun-native/commit/8acd854ec7ad6c49551ebe2c2ca1b19b756fc5ce).
The harness and this plan are additional committed files. Each execution must
use a clean checkout and retain its actual complete commit/tree and tracked-file
hashes. The baseline is not silently advanced to a later CLI/watch revision.

The native comparison is the separately executed
[`ca3c70772edabba52fca5327dec7997fac8d9ad0`](https://github.com/0xPlayerOne/bun-native/commit/ca3c70772edabba52fca5327dec7997fac8d9ad0)
merge of the earlier a39 PR head. Its `packages/`, CLI bundler and project
generator, Solid build/transform helpers, `package.json`, `bun.lock` and
`toolchain.json` are byte-identical to the selected 8acd control baseline. The
later watcher input-scanning correction is outside this compiler control.

[Native observation metadata](evidence/native-controller-a39-ca3.json) identifies
the original job, source, compiler, release host, archive and raw result hashes.
[The TSV](evidence/native-controller-a39-ca3.tsv) is a lossless projection of the
selected scalar process fields from all 102 post-input snapshots per framework.
It includes both controller identities/RSS, app and host identities/RSS, original
observation timestamps and tree RSS. It is not a replacement for the full native
artifact or its input/paint evidence.

In that native run, the Solid inner controller rose from 84,414,464 to
114,167,808 bytes RSS, with a maximum of 121,466,880. React rose from 70,832,128 to
73,228,288, with a maximum of 74,125,312. Both outer controllers stayed at
17,629,184 bytes. Solid's final 50-sample fitted slope was about 26,840 bytes per
edit with R² 0.0142; the late curve did not establish continued early linear
growth or a proven plateau. These are finite RSS observations, not heap
collectability evidence or a demonstrated cause.

## Fixed matrix and bounds

Run these cases once, in this order, each in a **fresh Bun process**:

| Order | Framework        | Total successful bundle calls | Source edits after first bundle |
| ----- | ---------------- | ----------------------------: | ------------------------------: |
| 1     | Solid TypeScript |                           101 |                             100 |
| 2     | React TypeScript |                           101 |                             100 |
| 3     | Solid TypeScript |                          1001 |                            1000 |
| 4     | React TypeScript |                          1001 |                            1000 |

The counts are total calls, distinct from the native experiment's 102 successful
generations plus one malformed-edit control. There are no adaptive stopping
rules, retries, additional variants or discarded failures. Each worker has a
180-second bound; the supervisor has a 900-second overall budget and reserves
seven seconds for bounded termination/join when needed. Forced termination is a
failed case. Remaining declared cases may proceed only after their directly
owned predecessor is joined. An interruption ends the remaining sequence.

Only functional integrity, the fixed count, bounded completion and cleanup
determine pass/fail. No guessed memory or performance threshold is introduced.

## What runs

The worker creates the ordinary TypeScript template with `createProject`, then
calls the actual CLI `bundleProject` helper repeatedly. Solid uses the existing
Babel universal transform and Bun bundler; React uses the existing Bun JSX
bundler. The shared `build.ts` import loads the Solid/Babel dependency path in
both processes; only the Solid branch invokes that transform. React is not a
control with Babel absent. The emitted app module is **never imported or executed**. There is no
application process, native host, window, filesystem watcher, native input,
malformed-source control or AOT application compilation.

Every call replaces exactly the generated window title and heading with a
unique safe ASCII source token. A bounded streaming inspection of the emitted
module requires exactly two occurrences of the current token and rejects stale
or incomplete tokens. The worker records source/module/source-map hashes and
byte counts, checks the expected two output files and removes the prior output
only after validating its replacement. At each sample there must be exactly one
live generation directory. Bundles use a fresh owned OS temporary root, avoiding
the separately observed scratch-workspace directory revival behavior. The
generated source project remains inside the checkout for workspace imports.

Rows stream synchronously to the supervisor's JSONL file; the compiler worker
keeps no generation/sample history. It records `process.memoryUsage()` scalars
(`rss`, `heapTotal`, `heapUsed`, `external`, `arrayBuffers`), process identity,
elapsed time, bundling time and validation/cleanup time before compiler imports,
after initialization, after every successful call and after final cleanup. No
explicit GC, heap walk, heap snapshot, collector tuning or intentional delay is
used. Nonempty inherited Bun/JSC/Node runtime-option overrides are rejected.
These checkpoints do not measure transient peaks during a bundle call.

The supervisor hashes the pinned compiler and all tracked source files before
execution, requires the full Bun revision in every worker, then checks compiler
and source invariance afterward. It validates every streamed count, identity,
token, finite scalar, artifact digest and cleanup receipt after the worker
exits. Its own retained rows and analysis are outside the measured compiler
process. Existing lockfiles identify dependencies; this harness does not add a
second independent byte audit of every installed package.

## Execution and retained evidence

Install the repository's frozen dependencies first, then use its pinned Bun:

```sh
python3 benchmarks/tooling/compiler-memory.py \
  --bun /absolute/path/to/pinned/bun \
  --output /absolute/path/outside-the-checkout/new-compiler-memory-result
```

The output directory must be new. `started.json` records source, compiler,
platform and the fixed matrix before any case starts. Each case retains every
raw `rows.jsonl` byte, stderr, actual exit status, timing and `result.json`.
The final result retains all case outcomes and owned-directory cleanup. A
failure or incomplete stream is preserved and is never replaced by a retry.
Only the directly owned compiler subprocess may be terminated. No process-tree
discovery, native build or Cargo/Rust invocation is part of this control.

After workers exit, report start/end/min/max and quartile medians/slopes for all
five memory counters, plus the last 50 builds and, for 1001-call cases, the last 500. Linear fits and R² describe these finite samples; they do not assume a
linear process. Raw scalar rows remain authoritative. The emitted modules are
validated before removal; their bytes are not retained for later reinspection.

The record has one trial per case, fixed order and uncontrolled OS/dependency
caches. The first build is cold only within its process. Validation and logging
also allocate memory and perform IO. Local compiler timings/RSS cannot be
subtracted from hosted native measurements or interpreted as presentation
latency. A compiler-only increase may narrow the investigation but cannot by
itself attribute all native growth, establish a leak, explain a retaining root,
prove long-term stability or close #243/#372.
