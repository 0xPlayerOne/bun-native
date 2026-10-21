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
bun scripts/qualify-kernel.ts
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
```

Use the underlying local entrypoints; do not spoof `GITHUB_ACTIONS` to run the
hosted-only wrapper. Windows/Linux sandbox and GUI results cannot be inferred
from a Mac run or cross-compilation. No production signing account is needed
for the local macOS functional fixture, and no distribution approval is implied.

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
