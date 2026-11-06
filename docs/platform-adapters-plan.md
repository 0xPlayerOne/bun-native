# Portable framework native qualification

> **Status (2026-11-05):** executed and merged in
> [#399](https://github.com/0xPlayerOne/bun-native/pull/399). The shared fixture is
> [`tests/native/platform-adapter.ts`](../tests/native/platform-adapter.ts) with
> [Solid](../tests/native/solid-platform.tsx) and [React](../tests/native/react-platform.tsx)
> adapters in the [`Native Platforms` workflow](../.github/workflows/native-platforms.yml).
> Per its merge record, all eight hosted framework/mode/platform cases passed. The
> plan below is kept as written.

This slice advances BN2/BN3 and #256 without replacing the existing public-core
platform cases or claiming that their success qualifies Solid or React. It adds
one shared lifecycle and two thin public JSX adapters to the existing macOS and
Windows actual-host lane. It does not close the milestones or #287.

## Fixed first qualification

Publish this change as a draft before native execution. Preparation includes strict
source checks, portable expectation/cleanup controls, actual Solid/React bundling,
and one Linux compile-only AOT build per framework using the existing verified
prebuilt host. The latter is not a Rust rebuild, native execution, or target-platform
qualification. Preserve all outcomes. Do not repeat a failed unchanged-source
workload to obtain a passing result.

After reasonable preparation, use one exact-head required PR matrix. Each hosted
macOS ARM64/Windows x64 target retains every original core case and then builds
one genuine AOT package per framework. Run each generated development module and
each inspected AOT executable once through the existing portable OS controller:
four new cases per target, eight across the two targets. Later independent cases
may execute after an earlier failure, but the step fails if any case/build fails.

Each case opens three successive native windows. Require all eight nodes, their
properties, ordering and stable identities in the complete initial/update paints;
one owned native button activation and all 32 nonce edits per window; native
pointer/Tab/focus routing through JSX handlers; acknowledged versioned input
replacement; one actual framework cleanup per window; revoked callback signals;
zero renderer owners; joined native shutdown; and all seven public owners zero.
The existing 5-second native request, 10-second observation and 40-second overall
controller deadlines remain unchanged. Core expectations remain six nodes.

The shared fixture is included in both AOT source inventories and in each live
controller snapshot. Retain build/compile logs, generated development modules,
source and host hashes, raw native/application records and every original result.
A wrong/missing owner box, stale prior-window paint, missing cleanup, wrong
framework identity or remaining listener must not qualify. The original core
negative-paint experiment remains in place and unmodified.

## Boundaries

These fixtures do not exercise a browser, claim physical input/GPU qualification,
assert screenshot/presentation coverage, or prove complete descendant enumeration.
The same macOS assigned-Metal-device requirement and explicit unsupported OS-input
errors apply. Programmatic native close is not an OS close-button test. Three
cycles and zero public owners do not prove heap collectability, leak freedom or
long-soak stability. The unresolved Windows Solid WeakRef checkpoint and Linux
React/startup/close failures retain their original identities and required gates.

Local compile-only results and hosted actual results must be reported separately.
Required Validation / Gate and all applicable CodeQL analyses must pass at the
exact current head, with blocking threads resolved, before an expected-head
protected squash merge. No required context, guard, production source, dependency,
compiler pin, GC checkpoint, assertion or branch protection is relaxed.
