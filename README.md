# Bun Native

**Bun Native** is an experimental, TypeScript-first desktop framework for building **real native interfaces** with Bun. The first implementation runs a Bun-authored application against Rust GPUI, in development and through **Bun's machine-code ahead-of-time (AOT) compiler**. First-party **SolidJS** and **React** adapters will share the same native host.

> **Status — October 31, 2026:** BN0 and BN1 are complete. The legacy Bunly/CEF runtime is removed; the real GPUI/AOT integration and [experimental public TS/JS API](packages/core/README.md) are merged, with opaque handles, atomic updates and owned callbacks. The complete required release suite passed actual development/AOT native interaction, fault, scheduling and lifecycle checks on Linux X11 with a software GPU. Solid/React adapters and supported release packages remain under implementation. See [the BN0 integration record](docs/bn0-integration.md), [BN1 audit](docs/bn1-audit.md) and [current protocol](docs/native-abi.md) and the merged [shared layout contract](docs/native-layout.md) for exact scope.

## What we're building

- **Browserless desktop UI.** A native GPU/OS renderer draws windows, layout, text, inputs, menus and overlays. **Rust GPUI is the initial engine**, and the implementation agent may select another genuine native renderer if measured evidence supports it.
- **Bun-first application code.** TypeScript is preferred; JavaScript is supported. App developers should not need to write Rust or rebuild native code after normal TS/JS edits.
- **Ahead-of-time releases.** Development uses Bun's regular fast runtime. Production uses experimental `bun compile`, which compiles supported application logic to machine code without a shipped JIT. It still includes necessary Bun runtime functionality; AOT does not translate JSX or CSS into native widgets.
- **Two first-party UI adapters.** SolidJS is implemented first, React second. Both use the same typed native host, common components and platform capabilities.
- **Developer tooling and distribution.** A native CLI, fast hot reload, prebuilt native host binaries, macOS/Windows/Linux packaging, updates, rollback and reproducible tests.
- **Measured quality.** Low startup time, idle memory, CPU/GPU work, native bridge overhead and artifact size are engineering goals. No performance or component-compatibility advantage is claimed before measurements.

### Architecture at a glance

Applications use `@bun-native/core` for windows, native elements, atomic batches and events. The private runtime owns one prebuilt GPUI child process and exchanges bounded, validated commands and events over private pipes. GPUI owns its UI thread. The forthcoming Solid and React adapters will translate their tree changes through that common public core and native host. [The architecture](docs/architecture.md) separates implemented packages from planned capabilities.

In development, Bun runs the app code normally. For distribution, Bun's AOT compiler generates CPU-specific machine code for the application while the separately built native host renders the interface. **Native rendering and AOT solve different problems; Bun Native needs both.**

## Current implementation status

| Capability                                            | Status                                                                                                                                                                                                                                                                |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Repo rename and BN0–BN7 roadmap                       | Complete; implementation issues track each acceptance requirement                                                                                                                                                                                                     |
| New native codebase (replacement for Bunly/CEF)       | Merged native workspace, strict contracts and replacement CI — [#251](https://github.com/0xPlayerOne/bun-native/issues/251)                                                                                                                                           |
| Real Bun → native renderer window                     | Linux X11 click, typing, paint, close/relaunch and in-process lifecycle verified — [#230](https://github.com/0xPlayerOne/bun-native/issues/230)                                                                                                                       |
| Bun AOT + native renderer integration                 | Same application compiled, inspected and exercised; release-host baseline/audit merged in [#273](https://github.com/0xPlayerOne/bun-native/pull/273)                                                                                                                  |
| Shared native tree and public TS/JS API               | Merged and qualified by the complete required release suite; see the [BN1 audit](docs/bn1-audit.md) and [#271](https://github.com/0xPlayerOne/bun-native/pull/271)                                                                                                    |
| SolidJS, React, components and CLI                    | Solid [#277](https://github.com/0xPlayerOne/bun-native/pull/277), React [#280](https://github.com/0xPlayerOne/bun-native/pull/280) and native layout [#281](https://github.com/0xPlayerOne/bun-native/pull/281) are in progress; full BN2–BN5 acceptance remains open |
| Cross-platform native packaging and production audits | Planned — BN6–BN7                                                                                                                                                                                                                                                     |

The active packages contain the new core API, protocol, runtime and native host. Obsolete CEF runtime, browser fixtures, qualification scripts and benchmark evidence have been removed; Git history preserves them. See the [implementation handoff and removal inventory](docs/bun-native-handoff.md) for current checks and remaining acceptance.

## Start here

- [Product vision](docs/bun-native-vision.md) — scope, goals and non-goals
- [Architecture](docs/architecture.md) — native host, framework renderers and runtime boundaries
- [Getting started](docs/getting-started.md) — contributor setup, current limits and first implementation tasks
- [Developer workflow](docs/development.md) — intended CLI, hot reload, package boundaries
- [Toolchain and AOT](docs/toolchain.md) — Bun compilation, versioning and compatibility
- [Compatibility](docs/compatibility.md) — Solid/React, CSS/DOM and platform support boundaries
- [Testing](docs/testing.md) and [benchmarks](benchmarks/README.md) — automation, physical native checks and performance evidence
- [Release engineering](docs/releasing.md) — signed/unsigned packages, updates and rollback
- [Engineering-quality standard](docs/engineering-quality.md) — architecture hygiene, code audits and measured optimization
- [Complete documentation index](docs/README.md)

## Roadmap

| Phase                                                       | Deliverable                                                               |
| ----------------------------------------------------------- | ------------------------------------------------------------------------- |
| [BN0](https://github.com/0xPlayerOne/bun-native/issues/217) | Replace Bunly/CEF and build the first real Bun AOT native app             |
| [BN1](https://github.com/0xPlayerOne/bun-native/issues/219) | Shared typed Bun-to-native bridge, public APIs, lifecycle and security    |
| [BN2](https://github.com/0xPlayerOne/bun-native/issues/218) | SolidJS native renderer                                                   |
| [BN3](https://github.com/0xPlayerOne/bun-native/issues/221) | React native renderer                                                     |
| [BN4](https://github.com/0xPlayerOne/bun-native/issues/222) | Shared native components, OS services and accessibility                   |
| [BN5](https://github.com/0xPlayerOne/bun-native/issues/220) | CLI, Bun tooling, hot reload and native CI                                |
| [BN6](https://github.com/0xPlayerOne/bun-native/issues/223) | Native AOT packaging, installation, updates and recovery                  |
| [BN7](https://github.com/0xPlayerOne/bun-native/issues/224) | Real apps, equivalent-workload benchmarks, documentation and optimization |

The [master roadmap](https://github.com/0xPlayerOne/bun-native/issues/1) contains 8 self-contained milestone epics and linked implementation tasks. It is the current source of engineering work; milestones can progress in parallel when contracts allow.

## Product boundaries

Bun Native is **not** an Electron, Electrobun, Tauri or WebView wrapper. It does not promise arbitrary HTML/CSS, browser DOM APIs, Tailwind, shadcn, Radix or Kobalte components running unchanged. Their functionality must be represented through actual native host elements/adapters, and support is documented per feature.

The [experimental public core API](packages/core/README.md) is implemented and tested; its native element and lifecycle contract remains deliberately small. **Do not copy hypothetical CLI or advanced component examples as working commands.** The [BN5 CLI #242](https://github.com/0xPlayerOne/bun-native/issues/242) and framework/component tasks track the remaining developer-facing surface.

## Contributing

This is a fully experimental rewrite. Agents and contributors should follow [AGENTS.md](AGENTS.md), [.github/CONTRIBUTING.md](.github/CONTRIBUTING.md) and the [engineering-quality policy](docs/engineering-quality.md). Automated code/performance checkpoints are expected throughout the implementation, with no routine human design approval. GitHub-hosted Linux/Windows/macOS runners are preferred; the connected Mac can be used for native GUI tests through Remote Desktop Commander when needed.

See [LICENSE](LICENSE), [NOTICE](NOTICE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for project and dependency terms. Historical Bunly releases and evidence are preserved in Git tags/history, not maintained as Bun Native product documentation.
