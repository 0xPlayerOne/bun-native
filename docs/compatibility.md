# Compatibility and support scope

**Status:** This describes [accepted source `38634595`][snapshot]. BN0 and BN1 are
complete within their recorded Linux scope. The shared core, Solid and React
adapters, native layout, four Linux services, the checkout CLI and standalone
package projects are implemented. Their APIs and qualification remain
experimental; no signed, installed, cross-platform application release is
qualified. [ADR 0013](decisions/0013-release-readiness.md) records the resulting
release-readiness decision and its blocking risks. The [BN0 audit][bn0] and
[BN1 audit][bn1] retain their own source, host and compiler identities.

## Exact pins

These are exact selections, not promised compatibility ranges or a stable
release API. The accepted [lockfile][lock] binds dependency integrity.
[`tests/quality/compatibility-pins.test.ts`](../tests/quality/compatibility-pins.test.ts)
fails `bun run test` when a row here differs from the repository source it
names, or when two sources for one pin disagree.

| Component            | Pin                                        | Repository source                                                                         |
| -------------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------- |
| `bun`                | `1.4.4-canary.1`                           | [`toolchain.json`][toolchain] `bun.version` and root `package.json` `engines.bun`         |
| `bun revision`       | `da867c60bf0bcbf9d6d36994f8ca0efa42075115` | [`toolchain.json`][toolchain] `bun.revision`                                              |
| `rust`               | `1.98.1`                                   | [`toolchain.json`][toolchain] `rust.version`                                              |
| `gpui revision`      | `ba63a022c9a22ca66d68ef2a8f0bb9b5b0a9984d` | [`toolchain.json`][toolchain] and both GPUI crates in [`gpui-host`][host-manifest]        |
| `gpui`               | `0.2.2`                                    | [`toolchain.json`][toolchain] `gpui.version`                                              |
| `solid-js`           | `1.9.18`                                   | [`@bun-native/solid`][solid-pin] and root `package.json`                                  |
| `babel-preset-solid` | `1.9.16`                                   | root [`package.json`][root-manifest]; Babel 8 stays excluded under [#316][i316]           |
| `@babel/core`        | `7.29.7`                                   | root [`package.json`][root-manifest]                                                      |
| `react`              | `19.3.1`                                   | [`@bun-native/react`][react-pin] and root `package.json`                                  |
| `react-reconciler`   | `0.34.0`                                   | [`@bun-native/react`][react-pin]                                                          |
| `native protocol`    | `11`                                       | [`PROTOCOL_VERSION`][protocol-ts] in TypeScript and [Rust][protocol-rs], which must match |

The Solid compiler pairing is guarded separately: [#430][pr430] checks the
installed Babel against both the preset and the JSX plugin peer ranges and keeps
the dependency-bot Babel major exclusion, with
[Validation 42117878399][run430] passing on its head.

## Languages, frameworks and platforms

| Capability                    | Implemented or observed scope                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Remaining limits                                                                                                                                                                                                                                                                      |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TypeScript and JavaScript     | [Public core][core] and Solid/React native JSX; four checkout templates cover TypeScript and checked JavaScript.                                                                                                                                                                                                                                                                                                                                                                           | No automatic DOM compatibility; broader consumer and platform combinations need their own evidence.                                                                                                                                                                                   |
| SolidJS                       | [Universal renderer][solid] with signals/effects, keyed updates, native events, revisioned input and root disposal; recorded Linux development/AOT interaction.                                                                                                                                                                                                                                                                                                                            | Component reuse is assessed individually. Collectability checks run without the JSC DFG tier ([#418][pr418]); the underlying [retention #287][i287] is unresolved.                                                                                                                    |
| React                         | [Native reconciler][react] with hooks, refs, effect cleanup, error boundaries and shared native events; recorded Linux development/AOT [behavior cases][react-behavior].                                                                                                                                                                                                                                                                                                                   | The behavior matrix bounds scheduling support. Suspended/hidden subtrees, hydration, portals and native view-transition animations are outside the implemented contract.                                                                                                              |
| Reference applications        | [Solid conversation workspace][solid-app] and [React task workspace][react-app] use the public adapters, native scroll containers and application theme state.                                                                                                                                                                                                                                                                                                                             | Bounded examples do not establish full Adea portability, virtualization, long-session performance or missing OS dialogs/menus.                                                                                                                                                        |
| Layout and input              | [Shared layout][layout] supplies boxes, text, buttons, inputs, sizing, clipping and retained scrolling; [native interactions][events] include keyboard, pointer, focus and revisioned text. The caret stays inside a horizontal viewport ([#377][pr377]). Split dividers are keyboard Tab stops that report `split_resize` (`split_resize_v1`), and every element kind has an AccessKit role read back by an AT-SPI client on Linux X11 (`accessibility_v1`, [accessibility roles][a11y]). | IME, screen-reader speech, macOS/Windows accessibility adapters, list roles, mixed-DPI and broader Unicode qualification remain open under [#241][i241].                                                                                                                              |
| Linux GUI                     | Recorded X11/XTest and llvmpipe window/input/paint/close cases for core and adapters in development and inspected AOT.                                                                                                                                                                                                                                                                                                                                                                     | Software X11 evidence does not qualify Wayland, physical input/GPU performance or the complete display/DPI matrix. Intermittent OS-close ([#358][i358]) and first-window startup ([#296][i296]) failures are unresolved.                                                              |
| macOS ARM64 / Windows x64 GUI | [Hosted public-core cases][platforms] and, since [#399][pr399], Solid and React development/AOT cases run real GPUI windows with complete paints, OS-injected input and joined cleanup ([Validation 41977270938][run399]).                                                                                                                                                                                                                                                                 | These cases do not establish templates, standalone consumers, services, screenshots, display presentation, physical input, OS close buttons or complete descendant enumeration.                                                                                                       |
| Native services               | [Permission-gated][services] display snapshots and clipboard text, X11 global shortcuts ([#422][pr422], [Native Linux job][run422]) and freedesktop notifications against dunst ([#424][pr424], [Native Linux job][run424]), each in development and inspected AOT; scoped filesystem grants on launch roots ([#427][pr427]).                                                                                                                                                              | All are Linux-only; macOS/Windows display-service execution is unverified and the others are unavailable there. Drag and drop, processes, dialogs and menus are not on this source; see the [service matrix][service-matrix].                                                         |
| CLI and source reload         | [Checkout-local create/dev/build][cli] for all four templates, an explicit prebuilt host and serialized full-remount watch; ordinary edits do not invoke Cargo.                                                                                                                                                                                                                                                                                                                            | Remount resets app state. Sustained resource/performance acceptance remains under [#243][i243] and [#372][i372].                                                                                                                                                                      |
| Standalone projects           | [`create --packages`][standalone] from local package archives; [#388][pr388] ran all eight installed-consumer cases on Linux X11 ([Validation 41952309890][run388]).                                                                                                                                                                                                                                                                                                                       | Linux only. There is no published registry package, and macOS/Windows jobs exercise the shared host, not standalone consumer GUI parity.                                                                                                                                              |
| Performance comparison        | The [equivalent-workload harness][comparison] compares core, Solid and React in development and AOT on one host; one [recorded local run][comparison-run] passed 30 measured launches with no failures.                                                                                                                                                                                                                                                                                    | One software-rendered Linux VM with uncontrolled load. No hardware GPU, macOS, Windows, display presentation, input-to-paint latency, Rust GPUI or WebView baseline. [#453][pr453] merged before its ready-stage Validation ran, so the run is local evidence only. See [#244][i244]. |
| Bun AOT and distribution      | Inspected compiled-program/JIT-removal metadata and native execution exist for the recorded target-specific fixtures; unsigned native-host artifacts are experimental.                                                                                                                                                                                                                                                                                                                     | Compile success alone is insufficient. [Installers, signing, clean-machine operation and update integrity/rollback][releasing] are not qualified ([#223][i223], [#247][i247]).                                                                                                        |

Both adapters use one Rust GPUI host. Packages and the prebuilt host must share
the matching native contract. WebView/CEF is not a fallback.

## Web compatibility boundary

**JSX is a source authoring syntax, not a browser renderer.** Components relying on HTML elements, the DOM, `window`, `document`, CSS layout, CSSOM or browser events cannot be assumed to work unchanged.

- **SolidJS:** the implemented universal renderer uses native primitives and the official universal JSX transform. `solid-js/web` and DOM component implementations are not supported.
- **React:** the implemented `react-reconciler` host uses native primitives. Logic without browser assumptions may be reusable; `react-dom` components do not become native components automatically.
- **Tailwind/CSS:** native layout/styling primitives are defined explicitly; arbitrary CSS selectors, cascade and browser painting effects are not promised.
- **shadcn, Radix, Kobalte and browser-oriented UI libraries:** some source-level patterns may be reusable, but DOM-dependent components generally require native ports. No universal import compatibility claim.
- **Native OS services:** display, clipboard, Linux X11 global shortcut, Linux freedesktop notification, Linux and macOS scoped filesystem access (macOS evidence from hosted CI only), Linux and macOS owned processes (macOS without a working directory, verified in CI only), Linux portal file dialog access and drag and drop (Linux X11, macOS and Windows; the latter two qualified in hosted CI only) use explicit grants. A chosen file path or a dropped file name is data, not a filesystem grant. Message dialogs and menus remain outside the available native service set. Grants do not sandbox ordinary Bun filesystem or process APIs; applications are trusted programs.
- **Untrusted webpages:** there is no hidden browser sandbox. Displaying untrusted content requires a deliberately scoped, safe native content model.

## Evidence procedure

For each component/platform capability, record:

1. Source revision, exact Bun/renderer/adapter versions and target OS/CPU/GPU.
2. Whether it runs in Bun dev, compiles with AOT and launches a real native window.
3. Supported native behavior and automated/GUI test evidence.
4. Source retained/adapted/reimplemented, DOM/CSS dependencies and a supported native replacement.
5. Unsupported or failed cases linked to an owned issue.

Recorded results qualify their exact source and environment, not every later
combined tree. Zero public ownership counters do not prove heap collectability,
and native paint callbacks do not measure display presentation. Failed outcomes
remain failures even when a later correction passes.

## Platform qualification

A compile success is not a native GUI acceptance result. Each claimed OS/CPU,
adapter and execution mode needs matching window/input evidence. Text, IME,
assistive technology and hardware-specific GPU behavior need explicit coverage.
The [platform record][platforms] distinguishes hosted input/paint from those
unverified capabilities. Mark unavailable checks **unsupported**, not passed.

[BN7 #245](https://github.com/0xPlayerOne/bun-native/issues/245) owns this
support matrix and [ADR 0013](decisions/0013-release-readiness.md);
[#254](https://github.com/0xPlayerOne/bun-native/issues/254) retains the
complete user-documentation acceptance.

Read [architecture](architecture.md), [testing](testing.md), [releasing](releasing.md) and the [roadmap](https://github.com/0xPlayerOne/bun-native/issues/1).

[snapshot]: https://github.com/0xPlayerOne/bun-native/tree/3863459588378532a4af4fb27188f051fa0955df
[bn0]: https://github.com/0xPlayerOne/bun-native/blob/3863459588378532a4af4fb27188f051fa0955df/docs/bn0-audit.md
[bn1]: https://github.com/0xPlayerOne/bun-native/blob/3863459588378532a4af4fb27188f051fa0955df/docs/bn1-audit.md
[lock]: https://github.com/0xPlayerOne/bun-native/blob/3863459588378532a4af4fb27188f051fa0955df/bun.lock
[toolchain]: https://github.com/0xPlayerOne/bun-native/blob/3863459588378532a4af4fb27188f051fa0955df/toolchain.json
[host-manifest]: https://github.com/0xPlayerOne/bun-native/blob/3863459588378532a4af4fb27188f051fa0955df/native/gpui-host/Cargo.toml
[root-manifest]: https://github.com/0xPlayerOne/bun-native/blob/3863459588378532a4af4fb27188f051fa0955df/package.json
[solid-pin]: https://github.com/0xPlayerOne/bun-native/blob/3863459588378532a4af4fb27188f051fa0955df/packages/solid/package.json
[react-pin]: https://github.com/0xPlayerOne/bun-native/blob/3863459588378532a4af4fb27188f051fa0955df/packages/react/package.json
[protocol-ts]: https://github.com/0xPlayerOne/bun-native/blob/cbcced75/packages/protocol/src/messages.ts#L44
[protocol-rs]: https://github.com/0xPlayerOne/bun-native/blob/cbcced75/native/protocol/src/wire.rs#L6
[core]: https://github.com/0xPlayerOne/bun-native/blob/3863459588378532a4af4fb27188f051fa0955df/packages/core/README.md
[solid]: https://github.com/0xPlayerOne/bun-native/blob/3863459588378532a4af4fb27188f051fa0955df/packages/solid/README.md
[react]: https://github.com/0xPlayerOne/bun-native/blob/3863459588378532a4af4fb27188f051fa0955df/packages/react/README.md
[react-behavior]: https://github.com/0xPlayerOne/bun-native/blob/3863459588378532a4af4fb27188f051fa0955df/docs/react-behavior.md
[solid-app]: https://github.com/0xPlayerOne/bun-native/blob/3863459588378532a4af4fb27188f051fa0955df/examples/solid-workspace/README.md
[react-app]: https://github.com/0xPlayerOne/bun-native/blob/3863459588378532a4af4fb27188f051fa0955df/examples/react-workspace/README.md
[a11y]: native-text.md#accessibility-roles-accessibility_v1
[layout]: https://github.com/0xPlayerOne/bun-native/blob/3863459588378532a4af4fb27188f051fa0955df/docs/native-layout.md
[events]: https://github.com/0xPlayerOne/bun-native/blob/3863459588378532a4af4fb27188f051fa0955df/docs/native-events.md
[platforms]: https://github.com/0xPlayerOne/bun-native/blob/3863459588378532a4af4fb27188f051fa0955df/docs/native-platforms.md
[services]: https://github.com/0xPlayerOne/bun-native/blob/3863459588378532a4af4fb27188f051fa0955df/docs/native-services.md
[service-matrix]: https://github.com/0xPlayerOne/bun-native/blob/3863459588378532a4af4fb27188f051fa0955df/docs/native-services.md#service-and-platform-matrix
[cli]: https://github.com/0xPlayerOne/bun-native/blob/3863459588378532a4af4fb27188f051fa0955df/docs/developer-tooling.md
[standalone]: https://github.com/0xPlayerOne/bun-native/blob/3863459588378532a4af4fb27188f051fa0955df/docs/standalone-projects.md
[comparison]: https://github.com/0xPlayerOne/bun-native/blob/3863459588378532a4af4fb27188f051fa0955df/benchmarks/COMPARISON.md
[comparison-run]: https://github.com/0xPlayerOne/bun-native/blob/3863459588378532a4af4fb27188f051fa0955df/benchmarks/comparison/results/linux-x64-llvmpipe-2026-11-05/README.md
[releasing]: https://github.com/0xPlayerOne/bun-native/blob/3863459588378532a4af4fb27188f051fa0955df/docs/releasing.md
[pr377]: https://github.com/0xPlayerOne/bun-native/pull/377
[pr388]: https://github.com/0xPlayerOne/bun-native/pull/388
[pr399]: https://github.com/0xPlayerOne/bun-native/pull/399
[pr418]: https://github.com/0xPlayerOne/bun-native/pull/418
[pr422]: https://github.com/0xPlayerOne/bun-native/pull/422
[pr424]: https://github.com/0xPlayerOne/bun-native/pull/424
[pr430]: https://github.com/0xPlayerOne/bun-native/pull/430
[pr453]: https://github.com/0xPlayerOne/bun-native/pull/453
[run388]: https://github.com/0xPlayerOne/bun-native/actions/runs/41952309890
[run399]: https://github.com/0xPlayerOne/bun-native/actions/runs/41977270938
[run422]: https://github.com/0xPlayerOne/bun-native/actions/runs/42103802861/job/127513230930
[run424]: https://github.com/0xPlayerOne/bun-native/actions/runs/42107349701/job/127525552193
[run430]: https://github.com/0xPlayerOne/bun-native/actions/runs/42117878399
[i223]: https://github.com/0xPlayerOne/bun-native/issues/223
[i241]: https://github.com/0xPlayerOne/bun-native/issues/241
[i243]: https://github.com/0xPlayerOne/bun-native/issues/243
[i244]: https://github.com/0xPlayerOne/bun-native/issues/244
[i247]: https://github.com/0xPlayerOne/bun-native/issues/247
[i287]: https://github.com/0xPlayerOne/bun-native/issues/287
[i296]: https://github.com/0xPlayerOne/bun-native/issues/296
[i316]: https://github.com/0xPlayerOne/bun-native/issues/316
[i358]: https://github.com/0xPlayerOne/bun-native/issues/358
[i372]: https://github.com/0xPlayerOne/bun-native/issues/372
[pr427]: https://github.com/0xPlayerOne/bun-native/pull/427
