# Testing and validation strategy

**Purpose:** prove Bun Native is browserless, AOT-compiled for release, correct under native input, secure at OS boundaries and genuinely efficient. Every test must distinguish **passed, failed, skipped and unsupported**. Old Bunly CEF tests are historical and cannot qualify Bun Native.

## Environments, in priority order

1. **GitHub Actions hosted runners:** run macOS, Windows and Linux build/test/native smoke/packaging lanes whenever supported. Pin OS image, Bun/Rust/renderer, cache keys and source SHA. Fast PR checks should remain reasonably short; use deeper scheduled/release runs for expensive GPU/soak benchmarks.
2. **Connected macOS via Remote Desktop Commander:** discover available devices when needed and run real GUI, input/focus/IME, app lifecycle and OS-specific smoke tests where hosted runners are insufficient. Use task-scoped temp directories; don't touch the owner's personal files/settings or leave large Docker/VM caches.
3. **Other target hosts or containers:** only when required to validate an actual supported target. Do not claim missing physical hardware is tested.

A headless stub or successful `cargo build` is not proof of a visible interactive native window. If a target is unavailable, log the limitation and follow up without asking the owner for a manual checkpoint.

## Test pyramid

| Level              | Examples                                                                                        | Expected evidence                                        |
| ------------------ | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| Static/code health | Bun format/lint/check, Rust fmt/Clippy, dependency boundaries, unused/duplicate code            | Exact commands and failing negative fixtures             |
| Unit               | Lifecycle state, typed errors, tree diff, IDs, capability checks, serialization, event ordering | Deterministic assertions                                 |
| Host integration   | Bun TS/JS ↔ native ABI, AOT addon loading, batching, disposal, restart                          | Real native binary and trace                             |
| Framework adapters | Solid signals/effects/keyed updates; React hooks/refs/reconciler commits                        | Native tree and event behavior in dev + AOT              |
| UI interaction     | Window open, type/click/focus/scroll/dialog/IME, native accessibility                           | OS/GPU run evidence, screenshots/recordings if available |
| Soak/failure       | 1,000+ mount/unmount, 100+ hot reload, long stream, queue flood, crash/recovery                 | Resource trend and cleanup logs                          |
| Packaging/release  | Fresh host install, integrity, update/rollback, clean launch, failed update                     | Versioned artifact manifest and install logs             |
| Performance        | Cold startup, RSS, CPU/GPU, p95/p99 frame/input, compiler time, binary size                     | Raw samples, baseline, methodology                       |

## Quality cadence

- Every PR: focused code hygiene, type/format/lint, relevant unit/integration, and a targeted performance measurement for hot paths.
- Each BN milestone: deeper architecture review, native acceptance on available target, leak/stress and performance checkpoint.
- Scheduled or release: full hosted platform matrix, long-soak/IME/a11y tests where possible, package integrity and competitive workloads.
- BN7: final repository-wide cleanup and reproducible benchmark comparisons.

This is **automated agent-owned verification, not a human sign-off process**. Follow [engineering-quality.md](engineering-quality.md), [BN5 native CI #256](https://github.com/0xPlayerOne/bun-native/issues/256) and [automated regression #259](https://github.com/0xPlayerOne/bun-native/issues/259).

## Native AOT truth checks

- Compare `bun run`, `bun build --compile` and **`bun compile`** behavior accurately.
- Use the exact compiler output and native library linkage to verify AOT release expectations, no browser payload and real UI interactions.
- Inspect compiler slow paths with `bun compile --explain` if supported by the pinned version. Do not claim native rendering merely because app logic is AOT.
- Preserve failure output and incompatibility reproduction; do not silently fall back to CEF or JIT for a claimed AOT release.

## Performance reproducibility

Define a fixture and assert its output correctness _before_ measuring. Run repeated trials on the same hardware/OS/build with source hash, power mode, warm/cold distinction and measurement method. Report medians/tail latencies, variance and raw logs, not isolated wins. Establish budgets from correct native baselines. A credible, unexplained regression around 10% in critical metrics is an investigation trigger, not an arbitrary release claim. See [benchmarks](../benchmarks/README.md).

## Clean completion

A milestone closes when its linked issues and native quality evidence are true. If one capability cannot be tested on accessible hardware, state **unsupported**, file an issue and continue other work without owner intervention. Never skip a required security/correctness check and call it passed.
