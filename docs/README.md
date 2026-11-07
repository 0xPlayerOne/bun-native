# Bun Native documentation

This directory documents the **new native Bun + AOT desktop framework**, not the retired Bunly/CEF implementation.

**Current state:** BN0 and BN1 are complete within their documented Linux native scope. The [BN0 audit](bn0-audit.md) preserves the first native/AOT release baseline. The [BN1 audit](bn1-audit.md) records the merged shared native tree, [public TS/JS API](../packages/core/README.md), historical protocol-2 contract, bounded callbacks and passed release-host scheduling/fault/lifecycle/allocator verification. Its retained archive includes eight inspected AOT applications and the exact tested source. The merged Solid [#277](https://github.com/0xPlayerOne/bun-native/pull/277), React [#280](https://github.com/0xPlayerOne/bun-native/pull/280) and shared layout [#281](https://github.com/0xPlayerOne/bun-native/pull/281) increments, the checkout CLI, the initial native services and the experimental update, reproducible-build and crash-qualification tooling from [#483](https://github.com/0xPlayerOne/bun-native/pull/483) are separate later increments. The [native ABI](native-abi.md) records the current private protocol version; full adapter, component and platform support retain their own acceptance.

## Product and architecture

1. [Product vision](bun-native-vision.md) — user promise, differentiators and non-goals
2. [System architecture](architecture.md) — packages, native host, event lifecycle, renderers and security boundaries
3. [AOT and toolchain](toolchain.md) — Bun compilation, native artifacts and compatibility
4. [Compatibility](compatibility.md) — native UI features, Solid/React, web APIs and platform status
5. [Architecture decisions](decisions/README.md) — decisions, alternatives and recorded tradeoffs

The [current implementation handoff](bun-native-handoff.md) records source removal, current checks and next actions. The [BN0 audit](bn0-audit.md) maps foundation evidence to #227/#258/#226 and the [BN0 integration record](bn0-integration.md) keeps the first Bun-to-GPUI checks and failed probes; the [BN1 audit](bn1-audit.md) maps bridge, safety, security and public API evidence to #219 and its implementation tasks. [AOT executable inspection](aot-inspection.md) explains, with source references, how the compiled-program and JIT-removal records are read.

The initial [shared native layout contract](native-layout.md) extends this tree with bounded sizing, alignment, clipping and retained scroll state. Protocol 4 added the [shared interaction contract](native-events.md). Both documents separate implemented native verification from remaining milestone acceptance.

- [Native event subscription lifetime](event-subscription-lifetime.md) — what an unsubscribe handle owns and what revocation releases
- [React behavior qualification](react-behavior.md) — the BN3 React native scenario matrix and its development/AOT checks
- [BN2 initial Solid integration](bn2-solid-integration.md) — implementation-in-progress record for the Solid adapter route and its protocol-4 qualification

Later protocol versions, through the current protocol 11, added default-denied, owned [native services](native-services.md): window display snapshots, bounded clipboard text ([ADR 0007](decisions/0007-native-clipboard.md)), global shortcuts ([ADR 0008](decisions/0008-native-global-shortcuts.md)), desktop notifications ([ADR 0009](decisions/0009-native-notifications.md)), scoped filesystem grants ([ADR 0010](decisions/0010-filesystem-grants.md)), owned child processes ([ADR 0011](decisions/0011-owned-processes.md)) and file drop targets ([ADR 0012](decisions/0012-native-drag-drop.md)). OS file dialogs ([file-dialog ADR](decisions/0013-native-file-dialogs.md)), the macOS application menu bar ([ADR 0015](decisions/0015-application-menu-bar.md)), and macOS/Windows display work areas, identities and change events are optional capabilities on protocol 11; message and confirm dialogs ([ADR 0014](decisions/0014-message-dialogs.md)) are drawn by core on the modal overlay. Clipboard and global shortcuts are qualified only on Linux X11, notifications and file dialogs only on Linux, and filesystem grants and processes on Linux, with macOS and Windows runs in hosted CI only. Drag and drop is qualified on Linux X11, with macOS and Windows runs in hosted CI only. [Advertised capabilities by platform](native-platforms.md#advertised-capabilities-by-platform) lists what each host offers and which of those runs are unverified; missing services report unavailable.

[Streaming lists](native-lists.md) documents app-level windowing, theme/density tokens and the bounded Solid/React streaming soak. The [overlay contract](native-overlays.md) adds optional dialog/menu/popover layers, modal focus and end-anchored scrolling. Text editing, focus, Unicode, composition, accessibility and scaling have their own [support matrix](native-text.md).

## Build and operate

6. [Getting started](getting-started.md) — create, check, run and package a Solid/React app in a checkout with a supplied prebuilt host
7. [Development workflow](development.md) — current and intended edit loop; [checkout CLI](developer-tooling.md) — implemented create/check/format/doctor/dev/build commands and limitations; [standalone projects](standalone-projects.md) — `create --packages` projects outside the checkout from local package sets; [reproducible builds](reproducible-builds.md) — which outputs are byte-identical and how that is checked
8. [Testing and validation](testing.md) — hosted CI, native Linux/macOS/Windows checks and evidence; [native fixtures](../tests/native/README.md); [native platforms](native-platforms.md) — hosted macOS/Windows build, paint and OS-input qualification, the scheduled audit and the per-platform capability table
9. [Benchmark design](../benchmarks/README.md) — performance fixtures, comparators and raw measurements
10. [Releasing](releasing.md) — native AOT targets, signing policy, updates and rollback; [experimental updates](updates.md) — verified manifest, atomic install, rollback, unsigned launchers and uninstall; [key rotation, launcher contract and health rollback](update-lifecycle.md); [linting generated projects](consumer-linting.md)

### Diagnostics records

- [Native first-window startup diagnostics](native-startup-diagnostics.md) — opt-in startup trace for a stalled first open
- [Native OS-close diagnostics](native-close-diagnostics.md) — close-phase records for the #358 AOT close timeout
- [macOS input target verification](macos-hit-testing.md) — how the macOS controller authorizes the exact window under a click

### Executed plans

Each of these plans has run; its status note links the result, and the plan is kept as written.

- [Portable framework native qualification](platform-adapters-plan.md) — Solid/React adapters on the hosted macOS/Windows lane (#399)
- [Standalone local-package qualification](standalone-packages-plan.md) — local package sets and the consumer cohort (#388)
- [Standalone lock correction](standalone-lock-parser-plan.md) — three parser-only lock controls
- [Installed-consumer native qualification](standalone-native-plan.md) — the hosted `cli-standalone.py` Linux lane (#388)

Machine-readable [evidence records](evidence/) retain raw results cited by these documents.

## Code quality and project operations

- [Engineering quality and optimization](engineering-quality.md) — required audits every PR, every phase and before release
- [Provenance](provenance.md) — licensing, copied code and attribution
- [Security and crash qualification matrix](qualification-matrix.md) — native fault, malformed payload, version mismatch and offline cases with their deciding tests
- [Real-machine validation runbook](real-machine-validation.md) — setup, permissions, commands and pass conditions for the Windows and macOS cases that need a physical machine, with what has not run
- [Agent contract](../AGENTS.md) and [Contributing](../.github/CONTRIBUTING.md)
- [Roadmap issue #1](https://github.com/0xPlayerOne/bun-native/issues/1) and [BN0–BN7 epics](https://github.com/0xPlayerOne/bun-native/milestones)

## Historical Bunly material

The previous CEF/WebView architecture, benchmark reports, M1–M12 qualification records and experimental APIs are **superseded**. They are available in [Git history](https://github.com/0xPlayerOne/bun-native/commits/main/) and historical tags, but do not belong to the active Bun Native docs. Prior results do not qualify the new native runtime.

Please link new implementation evidence to its BN issue/PR with exact compiler version, OS/CPU, build mode, source SHA, commands, failures and unsupported paths. Never describe a planned capability as shipped.
