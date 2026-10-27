# Bunly

The Bun-native desktop framework.

**Status:** Experimental. M1 foundations and M2 local benchmark acceptance are complete. M3 initial macOS/Windows/Linux functional acceptance is complete. [M4 delivery and final acceptance](docs/m4-completion.md) cover native IPC authority, session isolation, protected cookies and transport selection. [M5 completion](docs/m5-completion.md) records bounded native streams, terminals, service supervision and measured graphical load. [M6 implementation and local qualification](docs/m6-completion.md) records 500 actual managed replacements, a distinct controlled relaunch and pinned workflow comparison; final validation and merge are tracked in [PR #130](https://github.com/0xPlayerOne/bunly/pull/130). This is not a release-qualified desktop runtime. [M2 closeout](docs/m2-completion.md) records the skipped Apple signing and pending final performance qualification.

Bunly is building a standalone TypeScript-first desktop framework around real Bun,
prebuilt native components, and managed backend reloads. Better iteration and
competitive runtime efficiency are hypotheses to validate, not current performance claims.

## Run the foundation

Use Bun **1.4.3**. These application-side commands do not invoke a systems compiler:

```sh
bun install --frozen-lockfile
bun run check
bun run typecheck:browser
bun run example
bun packages/cli/src/main.ts doctor
bun run benchmark:smoke
```

Type checks use Bun's native TypeScript checker; editor/reference TypeScript stays pinned.
See [Bun-native tooling](docs/bun-tooling.md) for qualification, measurements and API choices.

`example` exercises the explicit mock backend: resource lifetime, navigation,
capabilities, cancellation, and cleanup. It does not open a native window.
`benchmark:smoke` writes a complete scenario matrix with unsupported operations
identified rather than assigned invented zero-cost timings.

## Formatting

Run `bun run format` to apply Oxfmt and `bun run format:check` to verify it.
`bun run check` enforces formatting before the other checks. See
[formatting](docs/formatting.md) for Python/Rust commands and preserved evidence.

## Managed development

The opt-in development APIs keep the native desktop owner alive while replacing
supported backend code. `ServiceReloadHost` runs one application generation in a
fresh Bun Worker; `ManagedDesktopResources` reattaches authorized windows, browser
sessions and terminals. `DevelopmentSession` bundles changed dependencies and
serializes reloads independently from the application's frontend tooling.

Use [service reload](docs/service-reload.md) for the application contract,
[managed desktop resources](docs/managed-desktop.md) for retained resource APIs,
and [development hosts](docs/development-host.md) for cache and watcher setup.
The executable `examples/managed-desktop` fixture combines these APIs with a real
CEF window and numbered-output native PTY. Its explicit native qualification
entrypoint accepts an already prepared host and its immutable source commit:

```sh
bun run qualify:managed-development /absolute/path/to/prebuilt-app --native-source=COMMIT
```

Replace `COMMIT` with the full 40-character source commit used to build that host.
The qualifier checks matching native source and records the actual artifact bytes.
It creates a private fixture, runs the fixed 500-replacement plan and preserves
its report under `.bunly/m6/managed-development`. A separate observed relaunch
checks changed configuration and the full-restart boundary. The
[qualification guide](docs/managed-development-qualification.md) defines the
workload, resource gates and retained evidence; the
[edit outcome comparison](docs/managed-comparison.md) covers pinned reference
frameworks. The qualifier does not compile a native host.
Configuration/native changes and unmanaged state require a controlled restart;
irreversible external effects are never automatically replayed.

[The M6 record](docs/m6-completion.md) maps issues #28–#33 to their implementation
and qualification scope and preserves three failed development attempts beside
the accepted native and comparison runs. Replay the five retained archives without
launching a desktop or implicitly fetching historical source:

```sh
bun run verify:managed-acceptance
```

The comparison reports raw timings for different engine and restart/persistence
cohorts; it makes no speedup claim. Native reliability issues
[#124](https://github.com/0xPlayerOne/bunly/issues/124) and
[#129](https://github.com/0xPlayerOne/bunly/issues/129) remain open.

## Interactive comparison workbench

```sh
bun scripts/bootstrap-benchmark-dependencies.ts
bun run workbench
```

Open the printed local URL to exercise real xterm.js rendering, deterministic
streaming, cancellation, form navigation, and local file fixtures. The web-only
preview is a sandboxed iframe, not a native embedded browser. Terminal data is a
numbered ANSI fixture, not a real shell or PTY.

The [benchmark guide](benchmarks/README.md) also covers a pinned Electron adapter
with actual browser windows, isolated profiles, sandboxed renderer execution,
terminal rendering, and deliberate renderer-failure observation. Electron is a
benchmark dependency, never Bunly's runtime.

## Framework contributor probes

Contributors need the pinned Rust toolchain for the native fixtures. The optional
process-tree observer uses Python with `psutil==7.0.0`; set `PYTHON` to the same
executable used to install it.

```sh
bun run native:test
bun run native:build
bun run qualify:host
bun run qualify:lifecycle
bun run artifact:probe
```

The fixtures exercise native-main-thread/Bun-Worker handoff through FFI and
Node-API, same-host Worker replacement, GC/reentrancy and failure cases, and a
native-owner/Bun-subprocess candidate selected by [ADR 0002](docs/decisions/0002-host-qualification.md).
The probes themselves are **not CEF, AppKit, Win32 or GTK window implementations**.
Process-tree resources and Linux/macOS kernel counters have recorded observations.
Windows wakeup measurement remains explicitly unsupported. Artifact tests use
ephemeral test keys, not production trust roots. See the [M1 closeout](docs/m1-completion.md).

## Repository

| Location             | Responsibility                                                         |
| -------------------- | ---------------------------------------------------------------------- |
| `packages/contracts` | Browser-safe contracts and capability/version rules                    |
| `packages/client`    | Browser-side discovery; no native authority                            |
| `packages/runtime`   | Native adapters, resource ownership, service supervision and reload    |
| `packages/artifacts` | Authenticated manifests, archive verification and cache                |
| `packages/cli`       | Diagnostics, artifact resolution, prepared hosts and development edits |
| `native/host-probe`  | Original Node-API/FFI and native subprocess fixtures                   |
| `examples/workbench` | Mock consumer and shared browser workbench UI                          |
| `benchmarks`         | Deterministic fixtures, reports, inventory and adapters                |
| `tests`              | Contracts, artifacts, faults, result validation and real process tests |
| `docs`               | Architecture, provenance and qualification boundaries                  |

## Roadmap and evidence

[Manual cloud qualification](docs/manual-native-qualification.md) runs portable or native tests on disposable Windows, Linux, and macOS runners without restarting local VMs or enabling automatic CI.

The [M3 closeout](docs/m3-completion.md) records the declared macOS, Windows and Linux native functional acceptance, packaged resources, lifecycle and verified acquisition. Hosted smoke results do not establish hardware-input, GPU performance or release qualification.

The [pre-M4 foundation pass](docs/pre-m4-foundation.md) covers bounded native asset
loading, verified macOS helper cleanup and maintained regression workloads.
[Foundation profiling](docs/foundation-performance.md) documents the explicit
portable/native measurement commands and their qualification limits.

[Master roadmap](https://github.com/0xPlayerOne/bunly/issues/1) ·
[Milestones](https://github.com/0xPlayerOne/bunly/milestones) ·
[M1/M2 implementation notes](docs/history/m1-m2-progress.md)

M1 establishes the accepted foundation and host decision. M2 supplies reproducible
comparison infrastructure and competitor baselines. M3 qualifies the visible CEF
host; M4 and M5 add native authority, isolated sessions, streams, PTYs and service
supervision. M6 integrates persistent development sessions and their acceptance
workloads. Packaging and additional native webviews belong to later milestones.

Start with [the documentation index](docs/README.md), [architecture](docs/architecture.md), [host decision](docs/decisions/0002-host-qualification.md),
[validation](docs/validation.md), and [contributing](.github/CONTRIBUTING.md).

This is not a Tauri plugin, Bun fork, package manager, or full Electron clone.
No production Adea settings, repository visibility, or public publishing are changed.
