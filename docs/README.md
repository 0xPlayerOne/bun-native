# Bun Native documentation

This directory documents the **new native Bun + AOT desktop framework**, not the retired Bunly/CEF implementation.

**Current state:** BN0 and BN1 are complete within their documented Linux native scope. The [BN0 audit](bn0-audit.md) preserves the first native/AOT release baseline. The [BN1 audit](bn1-audit.md) records the merged shared native tree, [public TS/JS API](../packages/core/README.md), historical protocol-2 contract, bounded callbacks and passed release-host scheduling/fault/lifecycle/allocator verification. Its retained archive includes eight inspected AOT applications and the exact tested source. Solid [#277](https://github.com/0xPlayerOne/bun-native/pull/277), React [#280](https://github.com/0xPlayerOne/bun-native/pull/280), and the merged shared layout [#281](https://github.com/0xPlayerOne/bun-native/pull/281) are separate implementation increments; the [current private protocol](native-abi.md) is version 3; full adapter, component and platform support retain their own acceptance.

## Product and architecture

1. [Product vision](bun-native-vision.md) — user promise, differentiators and non-goals
2. [System architecture](architecture.md) — packages, native host, event lifecycle, renderers and security boundaries
3. [AOT and toolchain](toolchain.md) — Bun compilation, native artifacts and compatibility
4. [Compatibility](compatibility.md) — native UI features, Solid/React, web APIs and platform status
5. [Architecture decisions](decisions/README.md) — decisions, alternatives and recorded tradeoffs

The [current implementation handoff](bun-native-handoff.md) records source removal, current checks and next actions. The [BN0 audit](bn0-audit.md) maps foundation evidence to #227/#258/#226; the [BN1 audit](bn1-audit.md) maps bridge, safety, security and public API evidence to #219 and its implementation tasks.

The initial [shared native layout contract](native-layout.md) extends this tree with bounded sizing, alignment, clipping and retained scroll state. The current protocol 4 also adds the [shared interaction contract](native-events.md). Both documents separate implemented native verification from remaining milestone acceptance.

## Build and operate

6. [Getting started](getting-started.md) — first contributor steps and what does not work yet
7. [Development workflow](development.md) — intended project CLI, edit loop and implementation responsibilities
8. [Testing and validation](testing.md) — hosted CI, connected Mac native checks and evidence
9. [Benchmark design](../benchmarks/README.md) — performance fixtures, comparators and raw measurements
10. [Releasing](releasing.md) — native AOT targets, installers, signing, updates and rollback

## Code quality and project operations

- [Engineering quality and optimization](engineering-quality.md) — required audits every PR, every phase and before release
- [Provenance](provenance.md) — licensing, copied code and attribution
- [Agent contract](../AGENTS.md) and [Contributing](../.github/CONTRIBUTING.md)
- [Roadmap issue #1](https://github.com/0xPlayerOne/bun-native/issues/1) and [BN0–BN7 epics](https://github.com/0xPlayerOne/bun-native/milestones)

## Historical Bunly material

The previous CEF/WebView architecture, benchmark reports, M1–M12 qualification records and experimental APIs are **superseded**. They are available in [Git history](https://github.com/0xPlayerOne/bun-native/commits/main/) and historical tags, but do not belong to the active Bun Native docs. Prior results do not qualify the new native runtime.

Please link new implementation evidence to its BN issue/PR with exact compiler version, OS/CPU, build mode, source SHA, commands, failures and unsupported paths. Never describe a planned capability as shipped.
