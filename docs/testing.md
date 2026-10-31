# Testing and validation

Bun Native validates the implementation that exists at the tested revision. A passing protocol test is **headless evidence**. Compiling a Rust binary is **compile evidence**. A rendered, interactive native window and a machine-code AOT application require their own execution evidence.

## Reproduce the foundation checks

Install the exact Bun version in `.bun-version`. Rustup reads `rust-toolchain.toml`; no globally installed compiler version is assumed. From a clean checkout:

```sh
bun install --frozen-lockfile
bun run format:check
bun run lint
bun run typecheck
bun run check:boundaries
bun test tests --coverage
bun run build
cargo fmt --manifest-path Cargo.toml --all -- --check
cargo clippy --locked --manifest-path Cargo.toml -p bun-native-protocol --all-targets -- -D warnings
cargo test --locked --manifest-path Cargo.toml -p bun-native-protocol
```

`build` checks the TypeScript package build. It is not an AOT release build and must not silently compile Rust for ordinary application edits. The Rust commands explicitly select the portable protocol crate. GPUI compilation, GPU initialization, window interaction and production AOT acceptance have separate commands and evidence as those integration tasks land.

`bunfig.toml` retains the minimum line-coverage gate. Coverage is useful for the implemented source; it does not establish native UI or platform support.

## Hosted workflows

| Workflow/job                       | What it proves                                                                                                               | What it does not prove                   |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| `bun-native.yml` / Source quality  | Formatting, linting, type checking, package boundaries, dependency use, package build, Bun unit coverage and workflow syntax | Native rendering or production AOT       |
| `bun-native.yml` / Protocol matrix | TypeScript behavior and Rust protocol fmt/Clippy/tests on Ubuntu 24.04, macOS 15 and Windows Server 2022                     | GPU/window interaction or physical input |
| `security.yml`                     | Dependency review and Bun/Rust advisory audits against the committed lockfiles                                               | A complete threat model or sandbox       |
| `codeql.yml`                       | Source analysis through the pinned Code Foundry workflow                                                                     | Runtime correctness                      |
| `Validation / Gate`                | Every required source, protocol and dependency-audit job succeeded                                                           | Completion of BN0 native/AOT acceptance  |

The required check keeps its existing name so protected-main rules do not become stale. The aggregate fails if any required job fails, is cancelled or is skipped. No main-branch or administrator bypass is part of the workflow. Ordinary pull requests start as drafts; expensive validation runs after the explicit ready transition. The existing `CI_BILLING_PAUSED` control is preserved.

Workflow actions, Bun, Rust and lockfiles are pinned. Cache entries contain dependency downloads only and are keyed by OS, architecture and toolchain/lockfile hashes; build outputs, dependency installations and credentials are not cached. Main-branch runs queue rather than cancel a previous run. Source checks target five minutes; the three portable protocol jobs allow ten minutes for a clean compiler/dependency setup. GPU and long-running soak checks belong in distinct native lanes under [#256](https://github.com/0xPlayerOne/bun-native/issues/256).

Each protocol job records the source SHA, Bun revision, verbose Rust version, OS/architecture and explicit development/headless scope in a retained Actions artifact. Passing foundation CI must never be presented as a native-window or no-JIT release result.

The repository owns the native validation, dependency-security and CodeQL callers. Code Foundry still owns draft/release policy; its generated generic validation feature is disabled to prevent a later sync from replacing the native checks. `custom_workflows: preserve` retains these callers. The obsolete browser qualification workflows and their success contexts are removed.

## Architecture and negative checks

The current source dependency graph is deliberately small:

| Package                | Allowed runtime dependencies             | Platform modules |
| ---------------------- | ---------------------------------------- | ---------------- |
| `@bun-native/protocol` | None                                     | Forbidden        |
| `@bun-native/runtime`  | Public exports of `@bun-native/protocol` | Allowed          |

`scripts/quality/boundaries.ts` parses actual TypeScript/JavaScript syntax. It checks type-only imports, exports, dynamic imports, CommonJS loads and TypeScript import types, rather than matching code with regular expressions. Cross-package relative paths, undeclared dependencies, nonpublic subpaths, uninspectable dynamic imports and unused runtime dependencies fail. New packages need an explicit policy addition. This is a scoped dependency audit; it does not claim complete whole-program dead-code detection.

Run the deliberate failure fixtures with:

```sh
bun test tests/quality
```

The suite proves that reversed dependency edges, private imports, undeclared/unused dependencies and platform imports in portable contracts are rejected. Strings and comments containing import-like text remain valid. The CI gate consumes the same implementation used by those tests.

## Native and AOT acceptance

[Native window #230](https://github.com/0xPlayerOne/bun-native/issues/230) must demonstrate a real GPUI window driven by Bun TypeScript, OS mouse/keyboard input, visible state updates and clean teardown. [AOT executable #227](https://github.com/0xPlayerOne/bun-native/issues/227) must build and run that same fixture with the pinned Bun machine-code compiler and retain compiler/provenance evidence. `bun build --compile` packaging is not sufficient evidence for that requirement.

For every native experiment, record:

- Exact source commit, Bun compiler/revision, Rust compiler, GPUI revision and command.
- OS, CPU architecture, GPU/display backend and relevant runner limitations.
- Build mode: Bun development, conventional bundled executable, or verified machine-code AOT.
- Separate compile, host integration, visible window, OS input and teardown outcomes.
- Logs and screenshots or recordings when available, with actual process exit status.
- Explicit **passed**, **failed**, **skipped** or **unsupported** status and a linked issue for an unresolved gap.

A skipped test is never passed. A simulated event proves only the event-handling code it exercises. A screenshot alone does not prove keyboard or mouse input. No browser fallback qualifies as native rendering.

## Environments

1. Use GitHub-hosted Linux, Windows and macOS runners first for builds, tests and real native fixtures where available.
2. Use the connected Mac via Remote Desktop Commander for actual GUI, keyboard/focus, text/IME and OS-specific checks that hosted runners cannot establish. Discover the online device at runtime, use a bounded temporary directory and leave personal files/settings untouched.
3. Use containers only for a specific missing capability, preferably on hosted infrastructure. Missing physical hardware or assistive-technology coverage remains unsupported and has a follow-up issue.

Verification is agent-owned engineering work. It does not require an additional human approval checkpoint.

## Performance evidence

[#258](https://github.com/0xPlayerOne/bun-native/issues/258) remains open until a genuine native baseline exists. Do not populate native metrics with mocked or protocol-only measurements. Capture cold startup, startup-to-interactive, process-tree idle/peak RSS, executable/install size, build duration and real input latency after the corresponding native/AOT fixture works.

A baseline record includes source and toolchain revisions, complete commands, OS/CPU/GPU/power mode, fixture correctness assertions, sample count, warm-up procedure, cold/warm distinction, raw samples, units, medians and tail latency. Preserve original logs alongside summaries. Comparisons require matched fixture behavior and environment; unsupported metrics have a reason instead of a zero. A reproducible unexplained regression around ten percent triggers investigation, with absolute impact and noise considered. Budgets follow measured correct behavior, not an assumed performance advantage.

Every PR also reviews removed/stale exports, dependencies, duplicate implementations, lifecycle ownership, security boundaries and documentation accuracy. Follow [engineering-quality.md](engineering-quality.md); [#259](https://github.com/0xPlayerOne/bun-native/issues/259) expands regression and hygiene automation as the real application grows. A milestone closes only when its native acceptance and audit evidence are complete.
