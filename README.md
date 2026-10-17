# Bunly

The Bun-native desktop framework.

**Status:** Experimental M1 foundation. No visible CEF desktop runtime yet.

Bunly is building a standalone TypeScript-first desktop framework around real Bun,
prebuilt native components, and managed backend reloads. The eventual objective is
better iteration without giving up competitive native/browser efficiency. These
are hypotheses, not measured product claims.

## Run the foundation

Use Bun **1.4.3**. Application-side checks and the contract workbench do not need
Rust, Zig, CMake, or a C++ compiler:

```sh
bun install --frozen-lockfile
bun run check
bun run typecheck:browser
bun run example
bun packages/cli/src/main.ts doctor
```

The current example uses an explicit **mock backend**. It exercises resource
lifetimes, navigation, capability discovery, cancellation, and cleanup without
opening a native window. Screenshot, evaluation, downloads, persistence, and input
are declared contracts but return unsupported-capability errors in the mock.

## Framework contributor probes

Framework contributors, unlike future application consumers, need the pinned
Rust toolchain to build the native qualification fixture:

```sh
bun run native:test
bun run native:build
bun run qualify:host
bun run artifact:probe
```

The probe tests a blocking native-main-thread/Bun-Worker arrangement through FFI
and Node-API, plus a native-owner/Bun-subprocess fallback. It is **not** a CEF,
AppKit, WebView2, or WebKitGTK implementation. Qualification reports identify
exactly what ran. Artifact tests use ephemeral CI keys, not a production trust root.

## Repository

| Location | Responsibility |
| --- | --- |
| `packages/contracts` | Browser-safe SDK contracts and capability/version rules |
| `packages/client` | Browser-side feature discovery; no native authority |
| `packages/runtime` | Application entry point, opaque resource registry, mock backend |
| `packages/artifacts` | Signed manifests, restricted archive verification, atomic cache |
| `packages/cli` | Foundation diagnostics and explicit artifact resolution |
| `native/host-probe` | Dependency-free Rust qualification fixture and Node-API/FFI ABI |
| `examples/workbench` | Executable contract-only consumer example |
| `tests` | Lifecycle, trust-contract, archive/cache, and import-boundary tests |
| `docs` | Architecture decisions, provenance, limits, and validation evidence |

## Roadmap

[Master roadmap](https://github.com/0xPlayerOne/bunly/issues/1) ·
[Milestones](https://github.com/0xPlayerOne/bunly/milestones) ·
[M1](https://github.com/0xPlayerOne/bunly/milestone/1)

M1 establishes the foundation. M2 measures equivalent competitor workloads. M3
implements the first visible CEF host. Later milestones add secure IPC, streams,
managed reload, packaging, and platform qualification. System webviews follow the
CEF MVP; browser-specific concepts must not leak into the portable API.

Start with [architecture](docs/architecture.md), [decisions](docs/decisions/0001-foundation.md),
[validation](docs/validation.md), and [contributing](CONTRIBUTING.md).

This is not a Tauri plugin, a Bun fork, a new package manager, or a claim of full
Electron compatibility. Private repository status and public publishing remain
separate decisions. No Adea production settings are changed here.
