## Bun Native outcome

Describe the native framework behavior changed and link the specific BN issue. Use `Closes #...` only when all acceptance criteria are genuinely met; otherwise use `Refs #...`.

## Architecture and code hygiene

- Package/native boundary affected:
- Obsolete code, dependencies, exports, docs, configs or tests removed:
- Duplication, layering, implicit coupling, unsafe handles and lifecycle changes:
- ADR/justified implementation tradeoff, if needed:

## Validation (passed / failed / skipped / unsupported)

- Bun TS/JS checks and tests:
- Rust native/ABI tests:
- Real native window and input behavior:
- Development Bun versus production `bun compile` AOT:
- Platforms/CPU/GPU actually exercised:
- Crash, cleanup, capability denial and accessibility/input coverage:
- Exact unrun/unsupported checks with linked follow-up:

## Performance and size

- Baseline source/versions/hardware/fixture:
- Startup, RSS, CPU/GPU, event/frame/input latency, build/reload and artifact bytes impacted:
- Raw samples and before/after result, or why no performance metric applies:
- Significant regression investigated or documented with measured tradeoff:

## PR lifecycle

Open draft on first commit, iterate, run focused checks, mark ready and enable auto-merge when protected checks permit. **No routine human design checkpoint.** Never bypass a required check or claim an untested native feature works.

See [engineering quality](../docs/engineering-quality.md) and [roadmap](https://github.com/0xPlayerOne/bun-native/issues/1).
