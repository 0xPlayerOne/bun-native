# Validation

Current contributor checks and the limits of their evidence.

**Scope:** M1–M3 foundation, runtime and repository hygiene.
**Policy:** Use exact lockfiles; failed or unsupported checks are not passes.

## Application and repository checks

```sh
bun install --frozen-lockfile
bun run foundry:doctor
bun run check
bun run typecheck:browser
python -m unittest discover -s tests -p '*_test.py'
```

Use Bun 1.4.3 and a Python environment installed from `requirements-dev.txt` and
`benchmarks/adapters/frontend/requirements.txt`. Set `PYTHON` to that interpreter
for subprocess-based fixtures. `bun run check` includes strict types, lint,
browser AST boundaries, unit tests and compiler-free SDK builds. Repository
hygiene tests also verify canonical GitHub paths and reviewed workflow pins.

Native compilation is deliberately separate. Framework contributors can run:

```sh
bun run native:test
bun run native:build
cargo +1.91.0 test --locked --manifest-path native/cef-host/Cargo.toml --lib
cargo +1.91.0 clippy --locked --manifest-path native/cef-host/Cargo.toml --all-targets --features packaging -- -D warnings
cargo +1.91.0 fmt --manifest-path native/cef-host/Cargo.toml --check
```

The first two commands use the M1 probe workspace and its root Rust 1.85.1 pin;
the CEF workspace uses the explicit Rust 1.91.0 contributor toolchain. CEF tests
need a matching native CEF distribution; follow
[native acceptance](m3-runtime-acceptance.md) for setup. Application developers
must not be forced to install these compilers to run prebuilt apps.

## Hosted platform qualification

```sh
gh workflow run cef-runtime.yml --repo 0xPlayerOne/bunly --ref main \
  -f platform=all -f suite=full
```

The [manual workflow guide](manual-native-qualification.md) covers platform
selection, portable/smoke/full suites, timeouts, diagnostic artifacts and the
standard-user Windows worker. Full runs execute native prebuilt, origin-policy
and process-fault scenarios. They are functional CI evidence, not controlled
performance, production signing or physical input/DPI certification.

The ordinary CEF PR lane uses the same hosted smoke implementation, rather than
the retired weaker standalone smoke script. Its existing billing/draft guards
remain in force. The obsolete offline Rust/Cargo snapshot-export job is removed;
no current job consumed those archives.

## Reproduce preserved acceptance

```sh
python scripts/summarize_m1.py --help
python scripts/report_reference_acceptance.py
python scripts/report_m3_acceptance.py
python scripts/report_m3_platform.py evidence/m3-linux
python scripts/report_m3_platform.py evidence/m3-windows
```

Replays validate historical observations and hashes; they do not launch a new
browser or establish acceptance for later runtime changes. Failed/noisy trials
and exact engine/security profiles remain in the evidence. See the M1, M2 and M3
completion reports for accepted scope and deferred work.

## Security and workflow review

When the contributor tools are installed, also run:

```sh
bun audit
cargo audit --file native/Cargo.lock
cargo audit --file native/cef-host/Cargo.lock
gitleaks git . --redact
actionlint .github/workflows/cef-runtime.yml .github/workflows/cef-typecheck.yml
```

The benchmark projects have independent Bun locks and require separate audits.
Do not automatically rewrite their historical version pins while preserving a
baseline. `.gitleaksignore` contains only reviewed exact historical fingerprints
for SHA-256 report digests; no credential category or entire evidence directory
is excluded. An audit with no known findings is not a proof of security.

Run Oxfmt and Ruff on edited files and retain the normal commit checks. Changes
to native code, runtime dependencies or qualification orchestration require the
relevant fresh hosted runs in addition to local checks. M4's renderer authority,
persistent sessions and permission boundaries remain separate acceptance work.
