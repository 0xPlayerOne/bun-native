# Bun Native documentation

Bun Native is a native Bun + AOT desktop framework. These docs cover the current
framework only; the retired Bunly/CEF implementation lives in
[Git history](https://github.com/0xPlayerOne/bun-native/commits/main/).

Platform and feature support is in one place: [compatibility](compatibility.md).
Per-platform capability details are in
[native platforms](native-platforms.md#advertised-capabilities-by-platform).

## Start here

1. [Product vision](bun-native-vision.md): the user promise, differentiators and non-goals.
2. [Getting started](getting-started.md): create, check, run, debug, upgrade and package a SolidJS or React app.
3. [Developer tooling](developer-tooling.md): the `bun run native` commands, and the [development workflow](development.md).
4. [Public API reference](api-reference.md): every export of core, Solid and React, linked to its contract.

## How it works

- [Architecture](architecture.md): packages, the native host, the event lifecycle, renderers and security boundaries.
- [AOT and toolchain](toolchain.md): Bun compilation, native artifacts and versioning. [AOT executable inspection](aot-inspection.md) explains how compiled programs are checked.
- [Native ABI](native-abi.md): the private host protocol. Versions 4 through the current protocol 11 added the interaction contract and the native services.
- [Layout](native-layout.md), [events](native-events.md) and [event subscription lifetime](event-subscription-lifetime.md).
- [Text, focus and accessibility](native-text.md), [streaming lists](native-lists.md) and [overlays](native-overlays.md).
- [Native services](native-services.md): display, clipboard, global shortcuts, notifications, filesystem grants, processes, dialogs, menus and drag and drop. Each is denied by default.
- [React behavior](react-behavior.md): the React scenario matrix and its development and AOT checks.
- [Standalone projects](standalone-projects.md): projects outside the checkout that use local package sets.

## Building, testing and releasing

- [Testing](testing.md): hosted CI, native Linux, macOS and Windows checks, and [native fixtures](../tests/native/README.md).
- [Native platforms](native-platforms.md): hosted macOS and Windows build, paint and OS-input checks.
- [Security and crash matrix](qualification-matrix.md): fault, malformed payload, version mismatch and offline cases.
- [Reproducible builds](reproducible-builds.md): which outputs are byte-identical.
- [Releasing](releasing.md): AOT targets, release hosts, npm packages, signing and rollback.
- [Updates](updates.md) and [update lifecycle](update-lifecycle.md): verified manifests, atomic install, rollback, launchers, key rotation and uninstall.
- [Linting generated projects](consumer-linting.md).
- [Benchmarks](../benchmarks/README.md): performance fixtures, comparators and raw results.

## Project

- [Architecture decisions](decisions/README.md).
- [Engineering quality](engineering-quality.md): the audits every PR, phase and release needs.
- [Provenance](provenance.md): licensing, copied code and attribution.
- [Agent contract](../AGENTS.md) and [contributing](../.github/CONTRIBUTING.md).
- [Roadmap issue #1](https://github.com/0xPlayerOne/bun-native/issues/1) and the [BN0 to BN7 milestones](https://github.com/0xPlayerOne/bun-native/milestones).

## Records

These are dated logs and executed plans. They are kept as written for
provenance and are not updated to match current code. Machine-readable
[evidence records](evidence/) hold the raw results they cite.

- Milestone records: [BN0 audit](bn0-audit.md), [BN0 integration](bn0-integration.md), [BN1 audit](bn1-audit.md), [BN2 Solid integration](bn2-solid-integration.md), [implementation handoff](bun-native-handoff.md) and the [framework audit](framework-audit.md).
- Executed plans: [portable framework qualification](platform-adapters-plan.md) (#399), [standalone local packages](standalone-packages-plan.md) (#388), [standalone lock correction](standalone-lock-parser-plan.md) and [installed-consumer qualification](standalone-native-plan.md) (#388).
- Diagnostics: [first-window startup](native-startup-diagnostics.md), [OS close](native-close-diagnostics.md), [macOS input targets](macos-hit-testing.md) and [macOS qualification](macos-qualification.md).
- [Real-machine validation runbook](real-machine-validation.md): the physical Windows and macOS cases and which have not run.

New evidence should link its BN issue or PR with the compiler version, OS and
CPU, build mode, source SHA, commands, failures and unsupported paths. Never
describe a planned capability as shipped.
