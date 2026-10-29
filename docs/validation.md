# Validation

One local and hosted validation contract, with explicit platform boundaries.

**Scope:** Portable and native framework checks, tooling, and repository hygiene.
**Policy:** Use committed dependency pins; failures and unsupported cases are not passes.

## Contributor setup

Use Bun 1.4.4 for repository tooling and Python 3.11. The qualified packaged
desktop runtime remains pinned to Bun 1.4.4. On macOS/Linux:

```sh
bun install --frozen-lockfile
python3 -m venv .venv
. .venv/bin/activate
python -m pip install -r requirements.txt
export PYTHON="$(command -v python)"
```

On Windows, activate `.venv\Scripts\Activate.ps1` and set
`$env:PYTHON = (Get-Command python).Source` after creating the environment.
The complete requirements file includes the existing observer, Ruff, and
frontend manifests plus pytest for Code Foundry. None ships in the desktop app.
pytest runs the existing unittest suite; it does not replace its assertions.
Discovery is restricted to `tests/*_test.py`, not downloaded repositories or caches.

## Fast edits and complete portable checks

```sh
bun run format:check
bun run typecheck
bun run lint
bun run build
bun run check:portable
```

The first four commands need only Bun and installed JavaScript dependencies.
`check:portable` includes `check` (format, native typecheck, lint, AST boundaries,
Bun tests and SDK builds), browser-only checking, Python format/lint/tests, and
the independent 23-case TypeScript checker qualification. Process-based tests
need the selected Python environment. No systems compiler is invoked.

Foundation CI and the manual hosted portable lane use this same command. Their
Python prerequisites are installed before testing, not after. Formatting and
lint failures are fatal; optional test tools are not silently skipped.

## Foundry and workflow validation

Install `actionlint` as a contributor tool, then run:

```sh
bun run foundry:sync
bun run foundry:doctor
bun run check:ci
```

The pull-request Code Foundry gate uses the `fast` tier: format, lint,
type-check, build and unit checks run before the `Validation / Gate` status is
reported. Release Please pull requests still validate the generated release diff
in the required `Mode` check. The scheduled/manual Code Foundry Audit continues to
run the full audit tier, and default-branch CodeQL remains enabled for public code
scanning. Local `check:ci` executes the actual installed audit, then browser-only
checking, AST boundaries, checker equivalence and workflow syntax/ShellCheck; it
is not merely a dry-run plan. Foundry integration, E2E, smoke, eval and performance
coverage remains separate from the PR's five-minute required gate.

The application edit loop does not run Foundry, both compilers, or native builds
on every change. Commit hooks remain staged-file-aware. Repeated Foundry syncs
must leave no tracked changes and preserve the formatting gate.

### Generated release PRs with skipped validation

If a generated version PR is ready but has only skipped validation for its
current commit, inspect the commit and workflow runs before retrying. Investigate
any actual failed check separately. The existing
`Release / Version` job in `Code Foundry Release` owns recovery: rerunning that
job lets its generated-PR normalization recheck the stable head and issue the
required `ready_for_review` transition for missing, cancelled or skipped validation.
It preserves an active or successful validation owner and refuses to erase a
failed validation result. Release PR draft state remains workflow-owned;
normal required checks and branch protection still gate the merge.

This recovery was exercised for PR #167 after its first readiness transition
left only skipped checks. The maintained normalization is in the
[pinned release workflow](https://github.com/0xPlayerOne/code-foundry/blob/945e548d1a1de5f6ca6195d245e9d82fc8e4ca63/.github/workflows/release.yml).

## Native framework checks

Install the pinned Rust 1.85.1 (M1 probe) and 1.91.0 (CEF) toolchains with rustfmt
and Clippy. Configure the trusted CEF distribution as described in
[native acceptance](m3-runtime-acceptance.md), then run:

```sh
bun run check:ci:native
bun scripts/cargo.ts +1.91.0 check --locked --manifest-path native/cef-host/Cargo.toml \
  --all-targets --features packaging,cef/dox
bun run qualify:host
bun run qualify:lifecycle
bun run artifact:probe
BUNLY_KERNEL_COUNTERS=1 bun scripts/qualify-kernel.ts
```

The combined native command formats, lints with warnings denied, tests and builds
both real workspaces. The CEF documentation-feature check uses a distinct Cargo
feature fingerprint and never substitutes for an actual CEF build or launch. The native
commit hook selects the correct compiler for each workspace, including changes
to shared Cargo configuration. Application consumers still use prebuilt binaries.

Local Cargo commands run through `bun scripts/cargo.ts`, which keeps Rust build
outputs in `<shared-cache>/cargo-target/workspaces/<identity>`. The identity is
the SHA-256 of the canonical manifest directory, or the command's canonical
working directory when no manifest is selected. This is the selected manifest
directory, not a discovered Cargo workspace root: a workspace member manifest
or a different working directory can select a different namespace from the root
manifest. Use the same manifest for builds and artifact lookup. Different
checkouts and native workspaces receive separate outputs; symlink aliases of the
same directory share them. The identity is a location key, not a source commit or build attestation.
Ordinary source edits keep the same directory and its compiled dependencies.
Cargo home, registry/Git downloads and the versioned CEF distribution remain
shared. Existing unpartitioned outputs are left untouched and are not selected by
the new default; the first build in each namespace compiles its own outputs.

Set `CARGO_TARGET_DIR` to select an exact target directory, or
`BUNLY_SHARED_CACHE_DIR` to choose the parent cache directory. Explicit target
overrides retain Cargo's normal meaning and require exclusive checkout ownership.
Commands for `native/cef-host` also default `CEF_PATH`
to `<shared-cache>/cef/<locked-version>`; put the matching contributor CEF
distribution there or set `CEF_PATH` to override it. Keep run evidence and
qualification output under each checkout's `.bunly` directory so concurrent
worktrees cannot overwrite one another. Without an explicit cache or target
override, CI keeps Cargo's ordinary workspace-local target directory and does not
inject a per-user CEF path.

`bun scripts/cargo.ts --print-target-dir` queries Cargo metadata for the M1
workspace's active target directory. Add
`--manifest-path native/cef-host/Cargo.toml` to query the CEF workspace. The M1
qualifiers, packaged probe and hosted terminal fixture use this same lookup;
they do not compile missing artifacts or fall back to an older checkout binary.
The hosted CEF lookup defaults to the pinned Rust 1.91.0 toolchain and preserves
an explicit `RUSTUP_TOOLCHAIN` override. A native-only runner does not need to
install M1's older toolchain merely to locate the CEF artifacts.
On Windows, the disposable build account resolves this directory before starting
the standard-user acceptance worker. It passes the exact result explicitly to
`hosted_cef.py run --native-target-directory`; the worker needs no compiler or
access to the build account's Cargo home. Unicode and meaningful trailing spaces
survive the encoded command-line handoff. An invalid handoff fails without
probing a default or stale target directory.

The CEF bundler selects regular nonempty native siblings beside its own running
executable, including when a custom Cargo target directory is used.

The M1 probes require ordinary host release builds without `--target`,
`CARGO_BUILD_TARGET`, or `build.target` in Cargo configuration. These target
selections add a target-specific output directory even when they name the host
triple. An explicitly defined `CARGO_BUILD_TARGET` is rejected before artifact
lookup; the probes do not query unstable Cargo configuration or infer prior
build arguments. `CARGO_TARGET_DIR` and `BUNLY_SHARED_CACHE_DIR` remain supported
directory overrides. This M1 limitation does not apply to the CEF bundler's
selection of siblings beside its running executable.

### Concurrent builds and qualification

A Cargo target is a mutable build cache, not a cross-checkout content-addressed
artifact store. A Rust 1.91.0 reproduction with two copies of the same package
compiled checkout A's single `alpha_marker` test, then executed that binary for
checkout B even though B defined two `beta_marker` tests. B's run compiled
nothing. Sequential leases therefore do not make sharing local-package outputs
between checkouts valid. The default namespace prevents that reuse; an explicit
`CARGO_TARGET_DIR` must not be reused by another checkout. Do not treat an old run
from a shared target as current-source validation without rebuilding and checking
the actual tests executed.

Within one checkout, later builds can still replace stable `release` executable
names or select different features. Use an exclusive target for each native
source/feature qualification and keep that override for its build, assembly and
qualifier commands. Build and assemble sequentially before admitting another
writer. A path beside the bundler does not establish source provenance, feature
identity or a consistent snapshot. Existing source, artifact identity and
input-unchanged qualification checks still apply; keep the actual native build
commit rather than relabeling old bytes after a source edit.

The portable target-policy regression checks distinct checkouts, canonical
aliases and build/metadata agreement without invoking a compiler. With Rust
1.91.0 installed, run the real offline regression in a newly created, isolated
temporary cache:

```sh
BUNLY_CARGO_ISOLATION_NATIVE=1 bun test tests/cargo-worktree-isolation.test.ts
```

It runs A's single test and B's two different tests, then edits A and verifies its
new test executes while the unchanged local dependency stays cached. It does not
use the contributor CEF target or launch a browser. The compiler-free portable
gate explicitly skips this opt-in native case.

For an explicitly prepared, locally ad-hoc-signed macOS fixture application:

```sh
bun scripts/qualify-cef-prebuilt.ts /path/to/bunly_host.app
bun scripts/qualify-cef-development.ts /path/to/bunly_host.app
python scripts/qualify-cef-faults.py /path/to/bunly_host.app --bun "$(command -v bun)"
bun run qualify:cef-rpc -- /path/to/bunly_host.app
```

For the issue #19 contributor fixture, set `CEF_PATH` to the exact retained,
validated platform distribution (including `archive.json`, `include`, `libcef_dll`
and `cmake`), then prepare without launching a GUI:

```sh
bun scripts/build-cef-fixture.ts
bun scripts/cargo.ts +1.91.0 test --locked --offline --manifest-path native/cef-host/Cargo.toml --lib --features rpc-qualification
bun scripts/cargo.ts +1.91.0 build --locked --offline --manifest-path native/cef-host/Cargo.toml --release --features packaging,rpc-qualification
bun scripts/cargo.ts +1.91.0 run --locked --offline --manifest-path native/cef-host/Cargo.toml --release --features packaging,rpc-qualification --bin bunly-bundle -- /absolute/private/new-rpc-bundle
```

On macOS, copy resources into **only the newly assembled private fixture**, then
use the maintained inside-out target validation and bounded ad-hoc signing helper:

```sh
cp -R native/cef-host/resources/. /absolute/private/new-rpc-bundle/bunly_host.app/Contents/Resources/
python -c 'import sys; from pathlib import Path; sys.path.insert(0,"scripts"); from qualify_adhoc_signing import targets, sign_command; from native_signing import native_command; app=Path(sys.argv[1]).resolve(); [native_command(sign_command(target)) for target in targets(app)]; native_command(["/usr/bin/codesign","--verify","--deep","--strict",str(app)])' /absolute/private/new-rpc-bundle/bunly_host.app
```

These commands assemble and verify; they do not launch the application. No production
identity, trust-store change, or distribution approval is involved. The supervisor then runs
`bun run qualify:cef-rpc -- <prepared-app>` through the maintained process observer.
The ordinary prebuilt smoke remains a prerequisite. Schema-2 RPC evidence and
every native protocol probe must pass; `rpcQualified: true` alone is insufficient.
Retain exact source and artifact identities with the report. CEF teardown issue
#92 remains a separate known failure and must not be hidden by changing deadlines,
shutdown expectations, sandbox flags, or artifact verification.

Use the underlying local entrypoints; do not spoof `GITHUB_ACTIONS` to run the
hosted-only wrapper. Windows/Linux sandbox and GUI results cannot be inferred
from a Mac run or cross-compilation. No production signing account is needed
for the local macOS functional fixture, and no distribution approval is implied.

## Maintained foundation regression and profiling

```sh
bun run check:foundation
bun run profile:foundation
bun run profile:foundation:cpu
bun run profile:foundation:native --app /path/to/bunly_host.app --samples 5 --warmups 1
```

The deterministic foundation tests also run in the ordinary Bun/Python/native
validation suites. The explicit profiling commands retain raw samples, source
identities, distributions and uncertainty without a machine-dependent timing
gate. The native command uses an already prepared app and a private fixture;
it does not compile a host. See [foundation performance](foundation-performance.md)
for workloads, cache conditions and the limits of synthetic input measurements.

On macOS, qualify the exact Chromium post-exit cleanup against both a retained
baseline and a current prepared application:

```sh
python scripts/qualify-macos-clone-cleanup.py \
  --baseline /path/to/baseline.app --current /path/to/current.app \
  --output .bunly/profiles/clone-cleanup-qualification.json
```

The report requires actual prompt and deliberately delayed helper completion,
verified ownership and clone removal. Unobserved sampling attempts cannot count
as qualification; failed attempts remain failures. See
[macOS clone cleanup](macos-clone-cleanup.md) and [native assets](native-assets.md)
for identity, cancellation, resource bounds and shutdown behavior.

## Benchmark and development jobs

Managed backend development adds focused executable tests for the actual
Worker/process broker, native-resource adapters and cached development sessions:

```sh
bun test tests/service-reload.test.ts tests/managed-desktop.test.ts tests/dev-host.test.ts tests/dev-host-runtime.test.ts tests/runtime-bundle.test.ts
bun run qualify:managed-development /absolute/path/to/prebuilt-app --native-source=COMMIT
bun scripts/qualify-managed-development.ts --verify .bunly/m6/managed-development/run-EXAMPLE/report.json
```

The native qualifier requires clean committed source, pinned Bun, the contributor
Python environment, and the full immutable source commit for the already built
host. It uses one desktop launch for the fixed 500-replacement plan and a separate
controlled relaunch after successful shutdown. It keeps
raw workload rows, process observations, exact artifact inventories, failures and
cleanup receipts. The replay command verifies retained evidence; it does not
launch another desktop or claim a fresh result. The manually dispatched hosted `full` suite
runs this stage before the credential-provider stage on every selected platform.
No systems compiler is invoked by an ordinary warmed backend edit.

The separately locked reference dependencies are not installed by root Bun install:

```sh
bun scripts/bootstrap-benchmark-dependencies.ts
bun run benchmark:smoke
bun scripts/qualify-development.ts
bun scripts/benchmark.ts record electron .bunly/benchmarks/electron-local.json --trials=3 --warmups=1
```

On the declared macOS arm64 Electrobun profile, install its separate frozen lock,
then run `bun scripts/prepare-electrobun.ts` and `bun scripts/qualify-electrobun.ts`.
Preserve rejected and unsupported scenarios. A passing functional fixture is not
a controlled performance comparison. No sandbox or managed browser policy may
be disabled to make a reference pass.

## Security and historical evidence

Run `bun audit` for the root and each separately locked benchmark project,
`cargo audit --file native/Cargo.lock`,
`cargo audit --file native/cef-host/Cargo.lock`, and
`pip-audit -r requirements.txt` with the contributor audit tools installed.
Run `gitleaks git . --redact`; its exclusions are exact reviewed historical
report-digest fingerprints, never a whole credential category.

Use `scripts/report_reference_acceptance.py`, `scripts/report_m3_acceptance.py`
and `scripts/report_m3_platform.py evidence/m3-{linux,windows}` to replay preserved
evidence. Replays validate recorded hashes/results; they are not fresh executions.
Historical evidence and lockfiles are never reformatted to hide drift.

## CI administration and non-local checks

Automatic jobs remain paused until the owner enables `CI_BILLING_PAUSED=false`.
Local checks do not set that variable or dispatch workflows. The existing
[manual platform workflow](manual-native-qualification.md) remains independently
available for explicit Windows/Linux/macOS execution.

Draft qualification jobs do not allocate runners; readiness triggers validation.
Manual runs are not cancelled by another dispatch through a PR cancellation rule.
Release integrity, production signing, GitHub draft automation, optional hosted
security services and server-side protections require their actual environments
and authorization. A local green result does not claim those actions ran.

## Combined native RPC and session acceptance

For the M4 adversarial fixture, build the host with `packaging,rpc-qualification`
and application resources with `bun scripts/build-cef-fixture.ts`. Copy those
generated resources into the assembled application's platform resource directory
before local ad-hoc signing; a native-only bundle is not a complete fixture.
Run `bun run qualify:cef-rpc -- PREPARED_APP`. Its explicit fixture requirement
waits for native probe receipts; the wrapper's final `native-rpc` success and zero
exit status are required in addition to the inner prebuilt report.

Use a separate immutable bundle with `--application=sessions` resources for
`bun scripts/qualify-cef-sessions.ts PREPARED_APP`. It covers persistent restart,
root collisions, controlled interrupted shutdown/restart and invalid paths.
Do not overwrite previously executed fixtures, share their profiles or count
expected interruption as a clean shutdown. Neither suite enables production
credentials, disables sandboxing or resolves an intermittent teardown failure by
repeating until green. The manually dispatched full RPC qualification retains the combined ephemeral
session/authority checks on each selected platform.

## Native transport qualification

Build the explicit contributor artifact with `packaging,rpc-qualification`.
`qualify:cef-transports -- PREPARED_APP --functional` executes both narrow CEF
candidates with identical structured/binary/cancellation work, actual fixed CPU
throttling, navigation revocation, service disconnect, native socket-owner proof,
and ordered teardown. The manually dispatched three-platform RPC qualification requires this
pair alongside RPC/session, browser-policy and network qualification. A functional
pair is not a performance distribution.

For paired descriptive distributions, run `--samples 5 --warmups 1` from a clean
committed tree. Candidate order alternates, all attempts remain recorded, and no
comparison is accepted until both candidates complete at least five independent
measured launches. `--native-only` is a separate baseline-only diagnostic and is
never reported comparable. Input/prepared artifacts and harness identities are
checked across execution. Kernel providers and unavailable counters retain their
actual semantics; an absent Windows provider is not numeric zero.

Loopback reachability is a contributor-only top-origin fixture decision, not a
frame permission or shipping transport. It requires the exact packaged fixture,
a current native binding, a local-only ephemeral session and the selected numeric
CSP endpoint; every socket still needs the separate native-owner challenge proof.
Ordinary builds exclude the decision and reject loopback setup. No public debugging
port, browser-security override, global content setting or automatic fallback is
introduced. See ADR 0003 and the retained evidence for the final selection.

## Offline session-reset qualification

`bun run qualify:cef-session-reset -- PREPARED_APP` exercises actual persistent
browser stores and native offline maintenance. The manually dispatched three-platform RPC
qualification includes it. Its controlled interruption is a negative control, while seed,
restart, lock-hold, fenced-open and post-reset verification launches require normal
backend exit and ordered teardown. It uses private marked test roots only; no
production accounts or user profiles are accessed. See
[storage reset](session-storage-reset.md) for full semantics and limits.
