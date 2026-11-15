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
plan. The AOT binary is a separate input: record its compiler and inspect it
independently. Its hash alone does not prove its provenance, and selecting a
development runtime does not change the runtime embedded in that binary.

The label-triggered `Windows runtime build control` builds an uninstrumented
`release-local` Bun from the pinned Bun and WebKit sources on an isolated
Windows runner. A recorded build-time codegen patch passes canonicalized source
paths relative to the source root, resolves those inputs against that root,
and uses the physical source root for unified-source exclusions, per-file
flags and object paths;
temporary drive mappings shorten other paths. A separate recorded WebKit script
patch fixes a PowerShell variable parse error and selects physical paths for
Windows system tar.
The workflow verifies source
revisions and patch hashes and checks generated Windows shell command lengths
before compilation. This is a custom build; the matching revision does not
prove binary equivalence to the distributed runtime. It compares that runtime
with the pinned distribution using three alternating sets of the unchanged
headless React development workload. Both sides also run the same inspected
distribution AOT binary as a reference, not as a local-build AOT comparison.
The pinned source disables its trimmable link on a Windows host, and the local
compiled workload failed the strict AOT inspection in [run 43672900369](https://github.com/0xPlayerOne/bun-native/actions/runs/43672900369).
That run did not save the failing field or produce retention observations;
subsequent runs retain both inspections without treating the local executable
as a qualified AOT control. An exploratory step also runs the source-built
compiled workload only when inspection confirms both a compiled program and a
present JIT. These observations are labelled untrimmed and cannot qualify
production AOT or replace the reference binary's checks.
[Run 43680391158](https://github.com/0xPlayerOne/bun-native/actions/runs/43680391158)
recorded three development failures with the distribution and three passes
with the custom source build; all six common distribution AOT references failed.
The local compiled executable retained its JIT. These differing builds do not
identify the cause. A later diagnostic also runs the deliberately pinned cycle
control against each development runtime, while compiling its AOT variants
with the distribution. Each child report records its runtime and executable
hashes; a pinned target must remain observable for the control to be valid. The
`diagnostic:windows-runtime` label is an explicit
trigger; ordinary PR events do not start the source build. Its 120-minute limit
and retained outcomes make build failures and missing coverage visible. This
control cannot identify a retaining root and does not qualify native paint.

The separate `diagnostic:windows-candidate` label compares the pinned runtime
with the integrity-checked November 14 Bun canary on a Windows runner. It
compiles the same React bundle with each compiler, checks both executables for
machine-code AOT and JIT removal, and records five alternating development/AOT
pairs against one headless peer. A deliberately pinned cycle target must remain
observable with each runtime. The runner temporarily changes only the revision
used by the diagnostic's runtime guard and restores `toolchain.json` afterward;
the repository pin is unchanged. Passing the diagnostic means its observations
and positive controls were valid, not that the original benchmark passed or a
toolchain upgrade is qualified. Runtime and compiler layout differences prevent
attributing a changed outcome to a specific fix.

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

In the [ninth run](https://github.com/0xPlayerOne/bun-native/actions/runs/43657641103),
matching mapped entry and relative input passed, as did matching physical entry
and physical input. Both mixed-drive cases rejected the schema export, matching
the full generator's error. The build still failed at that generator. The next
build-time patch resolves relative schema inputs against the loader's own root;
the early control requires both relative-input variants to pass and retains a
mixed-drive negative control. The full generator and output equivalence remain
unverified.

The [tenth run](https://github.com/0xPlayerOne/bun-native/actions/runs/43659427328)
passed both relative schema-path controls and the mixed-path negative control,
then advanced beyond the earlier generator failure. It stopped at build step
228 when PowerShell could not parse `$ICU_VERSION:` in WebKit's ICU script.
The next control braces that variable and checks the script with PowerShell's
parser before compiler installation. No runtime or retention result was made.

The [eleventh run](https://github.com/0xPlayerOne/bun-native/actions/runs/43661301694)
passed the script parser, but ICU extraction invoked Git's GNU `tar.exe`, which
interpreted the mapped `X:` archive as a remote host. The revised script patch
uses Windows system tar. The [twelfth run](https://github.com/0xPlayerOne/bun-native/actions/runs/43663157693)
failed its early tar check while creating an archive through the mapped drive.
The next patch converts the ICU paths to the physical source root; an early
control extracts through physical paths and verifies the mapped view. The full
ICU build and runtime remain unverified.

The [thirteenth run](https://github.com/0xPlayerOne/bun-native/actions/runs/43664363779)
completed ICU and reached step 2,130/2,353. Its unified compilation combined two
certificate files even though the pinned Bun source explicitly excludes the
Windows file from unity builds. The exclusion used the mapped build root and
physical source paths, so it did not match. The next build-only patch uses the
physical source root for matching; an early three-file control checks that the
Windows certificate file stays separate while eligible peers remain bundled.
No runtime or retention observation resulted.

The same mapped-root mismatch can affect per-file compiler-flag matching and
object paths in the pinned Bun build generator. The next diagnostic patch
normalizes physical repository sources for those lookups. After configuration,
the control requires the Windows resource command to retain its `/EHsc`
override and checks that both its object and the physical certificate source's
object are under the build directory. The resource source is constructed from
the mapped root, so that override check alone does not exercise the mismatch.
These checks do not establish generated-output equivalence.

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
and [per-trial results](raw/windows-cycle-2026-11-14-results.json.gz) preserve
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
[per-trial results](raw/windows-first-observation-2026-11-14-results.json.gz)
retain source identities, indices and cleanup counts. Omitting the first
observation did not remove the symptom in this cohort; it does not identify a
retaining root or qualify the original native benchmark.

The result files use deterministic gzip. Read them with `gzip -dc <file>`;
the decompressed SHA-256 values are
`2970b0087d768a127709788e790056a305cf93d5888b4192e2c8558fe8edccd8`
(cycle) and `32d750fa079a0773c4ffeab6d649d923d7ebd49646dc753c98840d27355cbaf4`
(first observation).
