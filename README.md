# Bunly

The Bun-native desktop framework.

**Status:** Experimental. M1 foundations and M2 local benchmark acceptance are complete. M3 initial macOS/Windows/Linux functional acceptance is complete; M4 remains in progress. This is not a release-qualified desktop runtime. [M2 closeout](docs/m2-completion.md) records the skipped Apple signing and pending final performance qualification.

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
| `packages/runtime`   | Application entry point, registry and mock backend                     |
| `packages/artifacts` | Authenticated manifests, archive verification and cache                |
| `packages/cli`       | Foundation diagnostics and artifact resolution                         |
| `native/host-probe`  | Original Node-API/FFI and native subprocess fixtures                   |
| `examples/workbench` | Mock consumer and shared browser workbench UI                          |
| `benchmarks`         | Deterministic fixtures, reports, inventory and adapters                |
| `tests`              | Contracts, artifacts, faults, result validation and real process tests |
| `docs`               | Architecture, provenance and qualification boundaries                  |

## Roadmap and evidence

[Manual cloud qualification](docs/manual-native-qualification.md) runs portable or native tests on disposable Windows, Linux, and macOS runners without restarting local VMs or enabling automatic CI.

The [M3 closeout](docs/m3-completion.md) records the declared macOS, Windows and Linux native functional acceptance, packaged resources, lifecycle and verified acquisition. Hosted smoke results do not establish hardware-input, GPU performance or release qualification.

[Master roadmap](https://github.com/0xPlayerOne/bunly/issues/1) ·
[Milestones](https://github.com/0xPlayerOne/bunly/milestones) ·
[M1/M2 implementation notes](docs/history/m1-m2-progress.md)

M1 establishes the accepted foundation and host decision. M2 completes reproducible
comparison infrastructure and competitor baselines. M3 qualifies the visible CEF host. Later
milestones add secure IPC, PTYs, managed reload, packaging, and native webviews.
The M2 workbench does not imply those runtime capabilities already exist.

Start with [the documentation index](docs/README.md), [architecture](docs/architecture.md), [host decision](docs/decisions/0002-host-qualification.md),
[validation](docs/validation.md), and [contributing](.github/CONTRIBUTING.md).

This is not a Tauri plugin, Bun fork, package manager, or full Electron clone.
No production Adea settings, repository visibility, or public publishing are changed.
