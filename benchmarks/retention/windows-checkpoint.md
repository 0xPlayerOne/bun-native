# Failure-only Windows retention metadata

[Issue #287](https://github.com/0xPlayerOne/bun-native/issues/287) remains unresolved.
The Windows protocol job in [run 41243736310](https://github.com/0xPlayerOne/bun-native/actions/runs/41243736310)
failed the existing Solid collectability assertion: one of ten disposed render
roots remained observable where the test requires zero. The job passed 418 of
419 tests. The failure took 41.48 ms and used the pinned Bun revision
`da867c60bf0bcbf9d6d36994f8ca0efa42075115`.

The exact tested merge was
[`788feca5b893390e7acfc9c3a83d01ba03f742af`](https://github.com/0xPlayerOne/bun-native/commit/788feca5b893390e7acfc9c3a83d01ba03f742af).
Its shared renderer, Solid adapter, failing test and shared test support are
byte-identical to the accepted Solid source at
[`59d921461075b839085823bdc6ef42377bf8d7d5`](https://github.com/0xPlayerOne/bun-native/commit/59d921461075b839085823bdc6ef42377bf8d7d5).
The original log identifies a retained count but not which root survived or its
state at that checkpoint. This increment adds those observations; it is not a
collection or ownership fix.

## Preserve the failed checkpoint

The test still mounts and disposes ten roots in the same loop, keeps the same
two `await Bun.sleep(0)` calls and two `Bun.gc(true)` calls, then evaluates the
exact same `WeakRef.deref()` filter and zero-length assertion. The assertion
runs before any diagnostic work. On failure only, its catch path calls
[`rethrowWithRetentionDiagnostic`](../../tests/solid/retention-diagnostic.ts).
That helper runs synchronously and rethrows the identical original failure,
including when reporting or diagnostic logging fails. It performs no extra
collection, heap snapshot, timer, await, retry or retained-count allowance.

When `BUN_NATIVE_RETENTION_DIAGNOSTICS_DIR` is set, the report records:

- Which zero-based indexes in the original ten-reference array remain visible
  immediately after the failed assertion.
- Each surviving root's public mutation, node, listener and pending-operation
  diagnostics, plus its ready/closed Promise states.
- The current application ownership/queue counts and window revision/completion
  state, before the surrounding test helper starts shutdown.
- Bun version/revision, executable path, OS/architecture/release, the declared
  GitHub checkout SHA and SHA-256 identities of twelve relevant source and
  configuration files.

The output is limited to ten probes and 32 KiB. Source files are bounded before
reading and only their paths, sizes and hashes are recorded. The report copies
specified diagnostic fields; it does not store element values, arbitrary error
contents, stack dumps or heap contents. Exclusive file creation preserves an
earlier report from the same process. No report or target inspection occurs
when the original assertion passes or the diagnostic option is unset.

The existing Windows protocol step enables the option under
`.bun-native/evidence/retention/`. The existing protocol artifact already
uploads that evidence directory after failure. No additional runner, altered
job condition, test exclusion or acceptance change is introduced. Other
platforms retain the default disabled option unless explicitly configured.

## Interpretation and focused checks

The helper tests exercise deterministic post-failure observations, source
identity, disabled behavior, exclusive-write failure and preservation of the
original exception even when the diagnostic logger throws. They do not run a
GC experiment or claim native rendering or target collectability.

The extra metadata can expose an unexpected pending or nonempty root after its
`dispose()` completed, and can distinguish a first, final or intermediate root.
It cannot by itself distinguish framework ownership from runtime retention.
The original predicate and subsequent diagnostic dereferences keep observed
targets alive for the current job. The report therefore explicitly identifies
itself as a post-assertion observation, not a trace of the roots that marked the
objects during the two preceding collections.

A future passing run does not resolve the original failure. Keep the
[fixed-checkpoint failures](README.md) and [root-tracing limitations](root-tracing.md)
alongside any new report. A framework-leak claim still needs a demonstrated
strong ownership path that outlives disposal; a runtime-retention claim needs
the actual marking source. Neither classification follows from a zero ownership
counter, a survivor index, or an absent snapshot edge.

## Framework-free Windows control plan

The manual `Benchmark comparison` dispatch with `paired-only`, `paired-macos`,
and `startup-only` enabled runs only the Windows retention control. It uses the
archived queue-v3 source with two explicit compatibility changes: the unavailable
static debugging import is obtained through `Reflect.get`, and hexadecimal
addresses accept uppercase digits emitted on Windows. The original archive hash
is checked before these changes, and the transformed source and AOT
executable hashes are recorded. The executable must pass compiled-program and
JIT-removal inspection before trials begin.

Five fresh processes run in each of four cells, with cell order reversed on odd
trials: development with default JSC, development with DFG disabled, AOT with
`Bun.gc(true)`, and AOT with `releaseWeakRefs` plus `gcAndSweep`. Each control
retains both original checkpoints and all result files. Process errors fail the
job; a reachable target is an observation, not a successful benchmark or a
classified leak. The control has no framework or native host, and its result
cannot on its own explain the actual Windows React failures. No benchmark
assertions or timed workload are changed.

The same dispatch also builds the actual Core, Solid and React workloads and
runs them against the headless public-core protocol peer: five development
trials per adapter with DFG disabled
(10 iterations, 10 rotations, two mounts) and five AOT trials per adapter (1,000 iterations,
1,000 rotations, 100 mounts). Adapters run in Core, Solid, React order; mode
order alternates within each adapter, and the unchanged workload
retention assertion is recorded, including failures. The headless peer replaces
GPUI and the run omits native paint calibration, so this tests the ownership and
IPC boundary without claiming native rendering or equivalent performance. The
control verifies the compiled-program flag and JIT omission, hashes the peer,
module and executable, and requires the exact workload and zero cleanup counters.
An unrelated process error makes the diagnostic fail rather than count as a
retention observation.

`headless-adapter-control.py` accepts an optional Bun executable path after the
trial count. It verifies the executable's `Bun.revision` against `toolchain.json`
before creating output and records its SHA-256 as `developmentRuntime` in the
plan. The AOT binary is a separate input and must be compiled and inspected for
the selected runtime; its hash alone does not prove its provenance.

The label-triggered `Windows runtime build control` builds an uninstrumented
`release-local` Bun from the pinned Bun and WebKit sources on an isolated
Windows runner. A recorded build-time codegen patch passes canonicalized source
paths relative to the source root and resolves those inputs against that root;
temporary drive mappings shorten other paths. The workflow verifies the source revision and patch hash
and checks generated Windows shell command lengths before compilation. This
is a custom build; the matching revision does not prove binary equivalence to
the distributed runtime. It compares that runtime with the pinned distribution using
three alternating sets of the unchanged headless React workload in development
and inspected AOT modes. The `diagnostic:windows-runtime` label is an explicit
trigger; ordinary PR events do not start the source build. Its 120-minute limit
and retained outcomes make build failures and missing coverage visible. This
control cannot identify a retaining root and does not qualify native paint.

The [fourth control run](https://github.com/0xPlayerOne/bun-native/actions/runs/43647428613)
passed source-byte verification and reached compilation, but failed at step
200 because a generated command exceeded the Windows shell limit. It produced
no runtime or retention observation. The path changes above remain unverified
until the control completes.

The [fifth control run](https://github.com/0xPlayerOne/bun-native/actions/runs/43649864896)
applied the patch and configured the build, but the preflight found a generated
command of 14,476 characters and stopped before compilation. The recorded
maximum does not identify which command remained oversized. A subsequent run
records bounded command metadata to distinguish the source before changing the
build again; no runtime or retention result was produced.

The [sixth run](https://github.com/0xPlayerOne/bun-native/actions/runs/43651579878)
identified two oversized commands: their working directory was on mapped `X:`
while the source glob returned physical `D:` paths. The first path patch could
not relativize across those drive names. The revised build-time patch resolves
both sides to their canonical paths before constructing the relative arguments
and resolves the table generator's input names against its own source root.
The [seventh run](https://github.com/0xPlayerOne/bun-native/actions/runs/43653418885)
showed that `realpathSync` preserves the mapped drive alias: the preflight
compared only paths reached through `X:` and the generated commands remained
unchanged. The next patch explicitly uses the physical checkout root for both
sides of the calculation. The path change and generated-output equivalence
remain unverified; workload controls do not prove equivalence.

The [eighth run](https://github.com/0xPlayerOne/bun-native/actions/runs/43654846922)
reduced the longest command to 7,920 characters and reached codegen at step
202, where the schema loader rejected exports. A mapped-versus-physical module
identity mismatch is a hypothesis, not an established cause. Before installing
the compiler, the next control loads one schema in fresh processes with mapped
and physical entry and input paths, records each exit code, and stops if the
current build's mapped-entry and relative-input case fails. No runtime or
retention observation resulted from the eighth run.

A separate paired React fixture control tests one ownership hypothesis. Both
variants use the same async disposal wrapper; after acknowledged disposal, the
`clear` variant additionally sets its two captured React state dispatchers to
`undefined`. Five pairs alternate variant order. Each variant runs the same
headless development and AOT workload checks described above, with all failures
retained and source, executable and peer hashes recorded. The variants change
fixture code and compiler liveness, so any difference is a diagnostic lead,
not proof of a root or a fix. The original workload assertions remain intact.

A separate paired shutdown control uses an instrumented copy of the workload.
Only after the original final checkpoint has already failed does it record an
additional timer/collection observation before shutdown and one after shutdown.
A pinned variant deliberately holds the latest root globally and must observe
that root both times; it is a positive control, not a benchmark. Original
assertions and failures remain unchanged. Extra collections, altered code shape
and timing make this a diagnostic lead rather than proof that shutdown caused
collection or that the production workload is leak-free.

A third control tests whether the benchmark's own async lifecycle local keeps a
view alive. Both variants change the helper from `const` to `let` and copy the
weak probes before returning; `clear` additionally assigns `undefined` to the
local after disposal. A third variant deliberately stores the measured view on
`globalThis` and must trigger the unchanged assertion in both modes. Five
alternating baseline/clear/pin triplets retain every report and exact source
hash, with the same headless workload, cleanup checks and fixed checkpoints.
This changes the fixture's code shape and compiler liveness, so a difference is
only a diagnostic lead; it does not identify an application retaining root or
establish that the original Windows assertion passed.

On [Windows run 43631326492](https://github.com/0xPlayerOne/bun-native/actions/runs/43631326492),
all five baseline and five clear trials in each mode observed survivors at the
unchanged final checkpoint. The deliberately pinned root was observed in all
five trials in each mode. The [retained plan](raw/windows-cycle-2026-11-14-plan.json.txt)
and [per-trial results](raw/windows-cycle-2026-11-14-results.json.txt) preserve
the source hashes, indexes and cleanup counts; the linked CI artifact contains
full reports and source variants. Clearing this local did not remove the symptom
in this cohort, and the result does not identify a retaining root or qualify the
original native benchmark.

A fourth control tests whether dereferencing the weak probes at the first
checkpoint affects the final observation. Its `omit-first` workload performs the
same first timer and collection but records an empty diagnostic first-observation
list instead of dereferencing those probes. The queue fence, second timer and
collection, final dereference and zero-survivor assertion remain unchanged.
Baseline and omitted-first variants each have a matching deliberately pinned
positive control, which must fail the final assertion. Five alternating sets
run in development and AOT. Omission changes the benchmark's observation and
compiler behavior; it is a diagnostic, not a passing original benchmark or a
justification to weaken its assertion.

On [Windows run 43636297439](https://github.com/0xPlayerOne/bun-native/actions/runs/43636297439),
both baseline and omitted-first variants observed the same final survivors in
all five trials per mode: `[3,4,5]` in development and `[298,299]` in AOT.
Both pinned positive controls were detected in every trial. The omitted first
list is empty by construction and is not a collection observation. The
[plan](raw/windows-first-observation-2026-11-14-plan.json.txt) and
[per-trial results](raw/windows-first-observation-2026-11-14-results.json.txt)
retain source identities, indices and cleanup counts. Omitting the first
observation did not remove the symptom in this cohort; it does not identify a
retaining root or qualify the original native benchmark.
