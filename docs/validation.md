# Validation

One local and hosted validation contract, with explicit platform boundaries.

**Scope:** M1–M3 foundation, tooling and repository hygiene.
**Policy:** Use committed dependency pins; failures and unsupported cases are not passes.

## Contributor setup

Use Bun 1.4.3 and Python 3.11. On macOS/Linux:

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

`check:ci` executes the actual installed Code Foundry audit, then browser-only
checking, AST boundaries, checker equivalence and workflow syntax/ShellCheck.
It is not merely a dry-run plan. `format`, `lint`, `type_check`, `build` and
`unit` are required Foundry capabilities. Its discovered E2E tests are reported
separately; they are not proof of a native browser or controlled performance.
Unimplemented integration, smoke, eval and performance categories remain
explicitly inapplicable in Foundry. Dedicated native/benchmark workflows below
supply their own actual acceptance rather than no-op package scripts.

The application edit loop does not run Foundry, both compilers, or native builds
on every change. Commit hooks remain staged-file-aware. Repeated Foundry syncs
must leave no tracked changes and preserve the formatting gate.

## Native framework checks

Install the pinned Rust 1.85.1 (M1 probe) and 1.91.0 (CEF) toolchains with rustfmt
and Clippy. Configure the trusted CEF distribution as described in
[native acceptance](m3-runtime-acceptance.md), then run:

```sh
bun run check:ci:native
cargo +1.91.0 check --locked --manifest-path native/cef-host/Cargo.toml \
  --all-targets --features packaging,cef/dox --target-dir .bunly/cef-typecheck
bun run qualify:host
bun run qualify:lifecycle
bun run artifact:probe
BUNLY_KERNEL_COUNTERS=1 bun scripts/qualify-kernel.ts
```

The combined native command formats, lints with warnings denied, tests and builds
both real workspaces. The CEF documentation-feature check uses a separate target
directory and never substitutes for an actual CEF build or launch. The native
commit hook selects the correct compiler for each workspace, including changes
to shared Cargo configuration. Application consumers still use prebuilt binaries.

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
cargo +1.91.0 test --locked --offline --manifest-path native/cef-host/Cargo.toml --lib --features rpc-qualification
cargo +1.91.0 build --locked --offline --manifest-path native/cef-host/Cargo.toml --release --features packaging,rpc-qualification
native/cef-host/target/release/bunly-bundle /absolute/private/new-rpc-bundle
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
repeating until green. The automatic RPC lane retains the combined ephemeral
session/authority checks on every supported platform.

## Native transport qualification

Build the explicit contributor artifact with `packaging,rpc-qualification`.
`qualify:cef-transports -- PREPARED_APP --functional` executes both narrow CEF
candidates with identical structured/binary/cancellation work, actual fixed CPU
throttling, navigation revocation, service disconnect, native socket-owner proof,
and ordered teardown. The ordinary three-platform RPC workflow requires this
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
browser stores and native offline maintenance. The automatic three-platform RPC
lane includes it. Its controlled interruption is a negative control, while seed,
restart, lock-hold, fenced-open and post-reset verification launches require normal
backend exit and ordered teardown. It uses private marked test roots only; no
production accounts or user profiles are accessed. See
[storage reset](session-storage-reset.md) for full semantics and limits.
