# Bun Native

**Bun Native** is an experimental, TypeScript-first desktop framework for building **real native interfaces** with Bun. The first implementation runs a Bun-authored application against Rust GPUI, in development and through **Bun's machine-code ahead-of-time (AOT) compiler**. Experimental first-party **SolidJS** and **React** adapters share the same native host.

## Status

Bun Native is an experimental developer preview (version in [package.json](package.json)).

- **Linux x64 (X11):** supported. Wayland works where the pinned GPUI allows; clipboard, global shortcuts, drag and drop and popup windows are X11-only.
- **macOS 15 ARM64:** supported as a preview. Builds are not notarized yet.
- **Linux ARM64 and macOS x64:** observed. CI builds and runs them, and releases include their hosts, but the full suites don't run there yet.
- **Windows:** deferred ([#629](https://github.com/0xPlayerOne/bun-native/issues/629)).

[Compatibility](docs/compatibility.md) has the feature-by-feature support table, and the [platform release decision](docs/decisions/0021-platform-release-readiness.md) explains each platform's state. No release is signed with a production identity yet.

## What we're building

- **Browserless desktop UI.** A native GPU/OS renderer draws windows, layout, text, inputs, menus and overlays. **Rust GPUI is the first engine**; another native renderer could replace it if measurements justify the switch.
- **Bun-first application code.** TypeScript is preferred; JavaScript is supported. App developers should not need to write Rust or rebuild native code after normal TS/JS edits.
- **Ahead-of-time releases.** Development uses Bun's regular fast runtime. Production uses experimental `bun compile`, which compiles supported application logic to machine code without a shipped JIT. It still includes necessary Bun runtime functionality; AOT does not translate JSX or CSS into native widgets.
- **Two first-party UI adapters.** SolidJS is implemented first, React second. Both use the same typed native host, common components and platform capabilities.
- **Developer tooling and distribution.** A native CLI, fast hot reload, prebuilt native host binaries, macOS/Windows/Linux packaging, updates, rollback and reproducible tests.
- **Measured quality.** Low startup time, idle memory, CPU/GPU work, native bridge overhead and artifact size are engineering goals. No performance or component-compatibility advantage is claimed before measurements.

### Architecture at a glance

Applications use `@bun-native/core` for windows, native elements, atomic batches and events. The private runtime owns one prebuilt GPUI child process and exchanges bounded, validated commands and events over private pipes. GPUI owns its UI thread. The experimental Solid and React adapters translate their tree changes through that common public core and native host. [The architecture](docs/architecture.md) separates implemented packages from planned capabilities.

In development, Bun runs the app code normally. For distribution, Bun's AOT compiler generates CPU-specific machine code for the application while the separately built native host renders the interface. **Native rendering and AOT solve different problems; Bun Native needs both.**

## What works today

- The public TypeScript/JavaScript API in [`@bun-native/core`](packages/core/README.md): windows, native elements, atomic updates and events, with opaque handles and owned callbacks.
- Experimental [SolidJS](packages/solid/README.md) and [React](packages/react/README.md) adapters on the same host.
- Shared [layout](docs/native-layout.md), [events](docs/native-events.md), [text input](docs/native-text.md), [lists](docs/native-lists.md) and [overlays](docs/native-overlays.md).
- Default-denied [native services](docs/native-services.md): display, clipboard, global shortcuts, notifications, filesystem grants, owned processes, file and message dialogs, and drag and drop.
- The `bun run native` CLI in a checkout ([developer tooling](docs/developer-tooling.md)) and experimental [updates, rollback and uninstall](docs/updates.md).
- The same app runs in development and as an inspected AOT build. Release checks cover native interaction, faults, scheduling and lifecycle.

## Start here

- [Product vision](docs/bun-native-vision.md): scope, goals and non-goals
- [Architecture](docs/architecture.md): native host, framework renderers and runtime boundaries
- [Getting started](docs/getting-started.md): SolidJS and React walkthroughs: create, check, debug, upgrade and package an app with the pinned Bun and a prebuilt host
- [Developer workflow](docs/development.md) and [CLI reference](docs/developer-tooling.md): implemented checkout CLI, full-remount watch, package boundaries
- [Toolchain and AOT](docs/toolchain.md): Bun compilation, versioning and compatibility
- [Compatibility](docs/compatibility.md): Solid/React, CSS/DOM and platform support boundaries
- [Native services](docs/native-services.md): permission-gated display, clipboard, global shortcut, notification, filesystem, process, file dialog and drag-and-drop services
- [Testing](docs/testing.md) and [benchmarks](benchmarks/README.md): automation, physical native checks and performance evidence
- [Release engineering](docs/releasing.md): signed/unsigned packages, updates and rollback
- [Engineering-quality standard](docs/engineering-quality.md): architecture hygiene, code audits and measured optimization
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

The [public core API](packages/core/README.md) keeps its native element and lifecycle contract deliberately small. The working commands are `bun run native create|dev|build|check|format|lint|doctor|host install` in a checkout, documented in [developer tooling](docs/developer-tooling.md). The same CLI is published to npm as `@bun-native/cli`, but it can't create a project outside a checkout yet. BN5 [#220](https://github.com/0xPlayerOne/bun-native/issues/220) tracks the rest of the developer-facing surface.

## Contributing

This is a fully experimental rewrite. Agents and contributors should follow [AGENTS.md](AGENTS.md), [.github/CONTRIBUTING.md](.github/CONTRIBUTING.md) and the [engineering-quality policy](docs/engineering-quality.md). Automated code/performance checkpoints are expected throughout the implementation, with no routine human design approval. GitHub-hosted Linux/Windows/macOS runners are preferred; the connected Mac can be used for native GUI tests through Remote Desktop Commander when needed.

See [LICENSE](LICENSE), [NOTICE](NOTICE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for project and dependency terms. Historical Bunly releases and evidence are preserved in Git tags/history, not maintained as Bun Native product documentation.
