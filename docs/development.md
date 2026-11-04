# Developer workflow

**Implemented:** the [checkout CLI](developer-tooling.md) creates Solid/React TypeScript or checked JavaScript projects, bundles and starts them against an explicitly supplied prebuilt host, and produces unsigned same-platform AOT artifacts. These projects use the surrounding repository's dependencies. Published installation, host acquisition, hot reload and standalone diagnostics remain open under [BN5 #220](https://github.com/0xPlayerOne/bun-native/issues/220).

## The expected workflow

1. **Create:** choose SolidJS or React, TypeScript by default or JavaScript, and supported target OS. Generate an app importing only public Bun Native modules.
2. **Develop:** launch normal Bun application logic plus prebuilt native host; edit TS/JS/TSX/JSX, update the UI without running Cargo per component change.
3. **Validate:** use Bun's checker, formatter, package manager and tests, plus native bridge/component tests; surface actionable errors for platform/API incompatibility.
4. **Package:** use Bun's experimental machine-code AOT `bun compile` and pinned native host artifacts. Do not silently substitute JIT `bun build --compile` in a claimed AOT release.
5. **Diagnose:** expose exact Bun/native host versions, renderer ABI, OS/arch, cache/asset state, logs, unsupported capabilities and reproducible failures.

The executable commands are `bun run native create`, `bun run native dev` and `bun run native build` from the repository root. See [their complete contract and tests](developer-tooling.md). The broader workflow above remains the target; there is no published `bun-native` executable yet.

## Reload and state

The current `dev` command starts once and does not watch source. Stop and rerun it after edits. Generated applications dispose their framework root and shut down the owned host on window close or SIGINT/SIGTERM. No state survives this restart. Fast reload remains [#243](https://github.com/0xPlayerOne/bun-native/issues/243).

A source-only TS/JS edit should not recompile Rust, replace a native binary or destroy the whole app unnecessarily. Host/version/config changes may require a full restart. Each reload must retire old owners/listeners safely and either preserve documented state or clearly remount. Test rapid saves, errors, partial source, cancellation and 100+ reload cycles with memory/resource tracking.

## Package and dependency boundaries

Application code depends on public host APIs and Solid/React adapters, not GPUI internals, Rust crates, browser globals or the CLI runtime. Keep packages small and dependency direction enforceable; no duplicated platform primitives or stale compatibility wrappers. [Architecture](architecture.md) and [quality](engineering-quality.md) contain the shared rules.

## Implementation order

- [#240](https://github.com/0xPlayerOne/bun-native/issues/240): Bun checker/formatter/tests and AOT release.
- [#242](https://github.com/0xPlayerOne/bun-native/issues/242): native CLI and project templates.
- [#243](https://github.com/0xPlayerOne/bun-native/issues/243): fast hot reload and lifetime management.
- [#256](https://github.com/0xPlayerOne/bun-native/issues/256): native CI across OSs.
- [#259](https://github.com/0xPlayerOne/bun-native/issues/259): code-health and performance regression automation.

CI must replace old M1–M6 CEF workflows, keep meaningful required status contexts, and prefer a fast PR lane plus deeper scheduled/hosted native tests. No human approval checkpoints are part of this framework development workflow.
