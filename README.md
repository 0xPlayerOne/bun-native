# Bun Native

**Bun Native** is an experimental, TypeScript-first desktop framework for building **real native interfaces** with Bun. Applications can be authored in TypeScript or JavaScript, using first-party **SolidJS** and **React** renderers over one shared native host. Production application logic is intended to use **Bun's machine-code ahead-of-time (AOT) compiler**.

> **Status — October 31, 2026:** Bun Native is a **complete rewrite in progress**, not a released or working desktop framework yet. The repository still contains legacy Bunly/CEF source until [BN0 #251](https://github.com/0xPlayerOne/bun-native/issues/251) replaces it. Do not mistake the previous Bunly 0.6.x code or successful historical tests for Bun Native functionality.

## What we're building

- **Browserless desktop UI.** A native GPU/OS renderer draws windows, layout, text, inputs, menus and overlays. **Rust GPUI is the initial engine**, and the implementation agent may select another genuine native renderer if measured evidence supports it.
- **Bun-first application code.** TypeScript is preferred; JavaScript is supported. App developers should not need to write Rust or rebuild native code after normal TS/JS edits.
- **Ahead-of-time releases.** Development uses Bun's regular fast runtime. Production uses experimental `bun compile`, which compiles supported application logic to machine code without a shipped JIT. It still includes necessary Bun runtime functionality; AOT does not translate JSX or CSS into native widgets.
- **Two first-party UI adapters.** SolidJS is implemented first, React second. Both use the same typed native host, common components and platform capabilities.
- **Developer tooling and distribution.** A native CLI, fast hot reload, prebuilt native host binaries, macOS/Windows/Linux packaging, updates, rollback and reproducible tests.
- **Measured quality.** Low startup time, idle memory, CPU/GPU work, native bridge overhead and artifact size are engineering goals. No performance or component-compatibility advantage is claimed before measurements.

### Architecture at a glance

```text
TypeScript / JavaScript application
        │
   SolidJS or React renderer adapter
        │
  Shared typed native host API
        │
 Rust native rendering + OS capabilities
        │
  macOS / Windows / Linux windows
```

In development, Bun runs the app code normally. For distribution, Bun's AOT compiler generates CPU-specific machine code for the application while the separately built native host renders the interface. **Native rendering and AOT solve different problems; Bun Native needs both.**

## Current implementation status

| Capability | Status |
| --- | --- |
| Repo rename and BN0–BN7 roadmap | Planned and tracked |
| New native codebase (replacement for Bunly/CEF) | Not yet implemented — [#251](https://github.com/0xPlayerOne/bun-native/issues/251) |
| Real Bun → native renderer window | Not yet verified — [#230](https://github.com/0xPlayerOne/bun-native/issues/230) |
| Production Bun AOT + native renderer integration | Not yet verified — [#227](https://github.com/0xPlayerOne/bun-native/issues/227) |
| SolidJS, React, components and CLI | Planned — BN2–BN5 |
| Cross-platform native packaging, benchmarks | Planned — BN6–BN7 |

The current source code is **not** an endorsed implementation foundation. Legacy CEF, WebView, browser API and M1–M7 documentation has been removed from the active documentation; it remains available in Git history for archaeology. The code itself is removed by the first migration implementation issue.

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

| Phase | Deliverable |
| --- | --- |
| [BN0](https://github.com/0xPlayerOne/bun-native/issues/217) | Replace Bunly/CEF and build the first real Bun AOT native app |
| [BN1](https://github.com/0xPlayerOne/bun-native/issues/219) | Shared typed Bun-to-native bridge, public APIs, lifecycle and security |
| [BN2](https://github.com/0xPlayerOne/bun-native/issues/218) | SolidJS native renderer |
| [BN3](https://github.com/0xPlayerOne/bun-native/issues/221) | React native renderer |
| [BN4](https://github.com/0xPlayerOne/bun-native/issues/222) | Shared native components, OS services and accessibility |
| [BN5](https://github.com/0xPlayerOne/bun-native/issues/220) | CLI, Bun tooling, hot reload and native CI |
| [BN6](https://github.com/0xPlayerOne/bun-native/issues/223) | Native AOT packaging, installation, updates and recovery |
| [BN7](https://github.com/0xPlayerOne/bun-native/issues/224) | Real apps, equivalent-workload benchmarks, documentation and optimization |

The [master roadmap](https://github.com/0xPlayerOne/bun-native/issues/1) contains 8 self-contained milestone epics and linked implementation tasks. It is the current source of engineering work; milestones can progress in parallel when contracts allow.

## Product boundaries

Bun Native is **not** an Electron, Electrobun, Tauri or WebView wrapper. It does not promise arbitrary HTML/CSS, browser DOM APIs, Tailwind, shadcn, Radix or Kobalte components running unchanged. Their functionality must be represented through actual native host elements/adapters, and support is documented per feature.

The public app API is still being designed. **Do not copy hypothetical CLI or component examples as working commands.** See [BN1 public API #253](https://github.com/0xPlayerOne/bun-native/issues/253) and [BN5 CLI #242](https://github.com/0xPlayerOne/bun-native/issues/242) for implementation status.

## Contributing

This is a fully experimental rewrite. Agents and contributors should follow [AGENTS.md](AGENTS.md), [.github/CONTRIBUTING.md](.github/CONTRIBUTING.md) and the [engineering-quality policy](docs/engineering-quality.md). Automated code/performance checkpoints are expected throughout the implementation, with no routine human design approval. GitHub-hosted Linux/Windows/macOS runners are preferred; the connected Mac can be used for native GUI tests through Remote Desktop Commander when needed.

See [LICENSE](LICENSE), [NOTICE](NOTICE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for project and dependency terms. Historical Bunly releases and evidence are preserved in Git tags/history, not maintained as Bun Native product documentation.
