# Compatibility and support scope

**Version:** Bun Native **0.27.2**, main [`e456a6d`][v0272]. The exact pins
below always match the checked-out source (`compatibility-pins.test.ts` checks
them); the rest of this page describes 0.27.2. The capability table under
[Languages, frameworks and platforms](#languages-frameworks-and-platforms)
describes [accepted source `38634595`][snapshot] (November 5, 2026), and
[Changes in 0.27.2](#changes-in-0272) lists every capability merged after it,
each with its own evidence. Platform status since then (Linux x64 X11
supported, macOS 15 ARM64 supported as a preview, Wayland within GPUI's limits,
Linux ARM64 and macOS x64 observed) is in the
[platform release decision](decisions/0021-platform-release-readiness.md#acceptance-2026-11-12).
A capability that appears in none of these is not supported.

**Status:** BN0 and BN1 are complete within their recorded Linux scope. The
shared core, Solid and React adapters, native layout, Linux services, the
checkout CLI and standalone package projects are implemented. Their APIs and
qualification remain experimental, and no release is signed with a
production identity yet. [ADR 0013](decisions/0013-release-readiness.md)
records the resulting release-readiness decision and its blocking risks. The
[BN0 audit][bn0] and [BN1 audit][bn1] retain their own source, host and
compiler identities.

## Exact pins

These are exact selections, not promised compatibility ranges or a stable
release API. The current [lockfile][lock] binds dependency integrity. Pin sources link to the
files in this checkout; the accepted-source snapshot links below stay fixed to
their commit.
[`tests/quality/compatibility-pins.test.ts`](../tests/quality/compatibility-pins.test.ts)
fails `bun run test` when a row here differs from the repository source it
names, or when two sources for one pin disagree.

| Component            | Pin                                        | Repository source                                                                                                    |
| -------------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `bun`                | `1.4.4-canary.1`                           | [`toolchain.json`][toolchain] `bun.version` and root `package.json` `engines.bun`                                    |
| `bun revision`       | `b1007f1177fd402fae67387b8548cae5ae9b5707` | [`toolchain.json`][toolchain] `bun.revision`                                                                         |
| `rust`               | `1.98.1`                                   | [`toolchain.json`][toolchain] `rust.version`                                                                         |
| `gpui revision`      | `ba63a022c9a22ca66d68ef2a8f0bb9b5b0a9984d` | [`toolchain.json`][toolchain] and both GPUI crates in [`gpui-host`][host-manifest]                                   |
| `gpui`               | `0.2.2`                                    | [`toolchain.json`][toolchain] `gpui.version`                                                                         |
| `solid-js`           | `1.9.18`                                   | [`@bun-native/solid`][solid-pin] and root `package.json`                                                             |
| `babel-preset-solid` | `1.9.16`                                   | root [`package.json`][root-manifest]; Babel 8 stays excluded under [#316][i316]                                      |
| `@babel/core`        | `7.29.7`                                   | root [`package.json`][root-manifest]                                                                                 |
| `react`              | `19.3.1`                                   | [`@bun-native/react`][react-pin] and root `package.json`                                                             |
| `oxlint`             | `1.92.0`                                   | root [`package.json`][root-manifest] `devDependencies`, the packaged CLI dependency and standalone consumer projects |
| `react-reconciler`   | `0.34.0`                                   | [`@bun-native/react`][react-pin]                                                                                     |
| `native protocol`    | `12`                                       | [`PROTOCOL_VERSION`][protocol-ts] in TypeScript and [Rust][protocol-rs], which must match                            |

The Solid compiler pairing is guarded separately: [#430][pr430] checks the
installed Babel against both the preset and the JSX plugin peer ranges and keeps
the dependency-bot Babel major exclusion, with
[Validation 42117878399][run430] passing on its head.

## Languages, frameworks and platforms

| Capability                    | Implemented or observed scope                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Remaining limits                                                                                                                                                                                                                                                                                                                                                                      |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TypeScript and JavaScript     | [Public core][core] and Solid/React native JSX; four checkout templates cover TypeScript and checked JavaScript.                                                                                                                                                                                                                                                                                                                                                                           | No automatic DOM compatibility; broader consumer and platform combinations need their own evidence.                                                                                                                                                                                                                                                                                   |
| SolidJS                       | [Universal renderer][solid] with signals/effects, keyed updates, native events, revisioned input and root disposal; recorded Linux development/AOT interaction.                                                                                                                                                                                                                                                                                                                            | Component reuse is assessed individually. Collectability checks run without the JSC DFG tier ([#418][pr418]); the underlying [retention #287][i287] is unresolved.                                                                                                                                                                                                                    |
| React                         | [Native reconciler][react] with hooks, refs, effect cleanup, error boundaries and shared native events; recorded Linux development/AOT [behavior cases][react-behavior].                                                                                                                                                                                                                                                                                                                   | The behavior matrix bounds scheduling support. Suspended/hidden subtrees, hydration, portals and native view-transition animations are outside the implemented contract.                                                                                                                                                                                                              |
| Reference applications        | [Solid conversation workspace][solid-app] and [React task workspace][react-app] use the public adapters, native scroll containers and application theme state.                                                                                                                                                                                                                                                                                                                             | Bounded examples do not establish full Adea portability, virtualization, performance, or stability beyond the [recorded long sessions](../benchmarks/results/workspace-long-session-2026-11-11/README.md) (30 min per framework and mode on one local Linux Xvfb/lavapipe container; 120 s per mode in CI) or missing OS dialogs/context menus.                                       |
| Layout and input              | [Shared layout][layout] supplies boxes, text, buttons, inputs, sizing, clipping and retained scrolling; [native interactions][events] include keyboard, pointer, focus and revisioned text. The caret stays inside a horizontal viewport ([#377][pr377]). Split dividers are keyboard Tab stops that report `split_resize` (`split_resize_v1`), and every element kind has an AccessKit role read back by an AT-SPI client on Linux X11 (`accessibility_v1`, [accessibility roles][a11y]). | IME, screen-reader speech, macOS/Windows accessibility adapters, list roles and live regions outside Linux (`accessibility_lists_v1`), mixed-DPI and broader Unicode qualification remain open under [#241][i241].                                                                                                                                                                    |
| Linux GUI                     | Recorded X11/XTest and llvmpipe window/input/paint/close cases for core and adapters in development and inspected AOT. One core [Wayland case][wayland] on headless sway covers window, compositor input, pixels, display snapshot, notification, portal dialog and compositor close.                                                                                                                                                                                                      | Wayland is qualified on headless sway only (not GNOME/KDE, fractional scaling or IME), with X11-only clipboard, shortcuts, drag/drop and popup windows unavailable there. Software evidence does not qualify physical input/GPU performance or the complete display/DPI matrix. Intermittent OS-close ([#358][i358]) and first-window startup ([#296][i296]) failures are unresolved. |
| macOS ARM64 / Windows x64 GUI | [Hosted public-core cases][platforms] and, since [#399][pr399], Solid and React development/AOT cases run real GPUI windows with complete paints, OS-injected input and joined cleanup ([Validation 41977270938][run399]).                                                                                                                                                                                                                                                                 | These cases do not establish templates, standalone consumers, services, screenshots, display presentation, physical input, OS close buttons or complete descendant enumeration.                                                                                                                                                                                                       |
| Native services               | [Permission-gated][services] display snapshots and clipboard text, X11 global shortcuts ([#422][pr422], [Native Linux job][run422]) and freedesktop notifications against dunst ([#424][pr424], [Native Linux job][run424]), each in development and inspected AOT; scoped filesystem grants on launch roots ([#427][pr427]).                                                                                                                                                              | All are Linux-only; macOS/Windows display-service execution is unverified and the others are unavailable there. Drag and drop, processes, dialogs and the macOS menu bar are listed separately; see [advertised capabilities by platform](native-platforms.md#advertised-capabilities-by-platform) and the [service matrix][service-matrix].                                          |
| CLI and source reload         | [Checkout-local create/dev/build][cli] for all four templates, an explicit prebuilt host and serialized full-remount watch; ordinary edits do not invoke Cargo.                                                                                                                                                                                                                                                                                                                            | Remount resets app state. Sustained resource/performance acceptance remains under [#243][i243] and [#372][i372].                                                                                                                                                                                                                                                                      |
| Standalone projects           | [`create --packages`][standalone] from local package archives; [#388][pr388] ran all eight installed-consumer cases on Linux X11 ([Validation 41952309890][run388]).                                                                                                                                                                                                                                                                                                                       | Linux only. There is no published registry package, and macOS/Windows jobs exercise the shared host, not standalone consumer GUI parity.                                                                                                                                                                                                                                              |
| Performance comparison        | The [equivalent-workload harness][comparison] compares core, Solid and React in development and AOT on one host; one [recorded local run][comparison-run] passed 30 measured launches with no failures.                                                                                                                                                                                                                                                                                    | One software-rendered Linux VM with uncontrolled load. No hardware GPU, macOS, Windows, display presentation, input-to-paint latency, Rust GPUI or WebView baseline. [#453][pr453] merged before its ready-stage Validation ran, so the run is local evidence only. See [#244][i244].                                                                                                 |
| Bun AOT and distribution      | Inspected compiled-program/JIT-removal metadata and native execution exist for the recorded target-specific fixtures; unsigned native-host artifacts are experimental.                                                                                                                                                                                                                                                                                                                     | Compile success alone is insufficient. [Installers, signing, clean-machine operation and update integrity/rollback][releasing] are not qualified ([#223][i223], [#247][i247]).                                                                                                                                                                                                        |

Both adapters use one Rust GPUI host. Packages and the prebuilt host must share
the matching native contract. WebView/CEF is not a fallback.

### Adea component-port example after the accepted-source snapshot

At [source `e848d5a`](https://github.com/0xPlayerOne/bun-native/commit/e848d5a149a6f123d5e57865a6ea11e33abafc00),
the [Adea components example](../examples/adea-components/README.md) ports
Button, Input, DropdownMenu, Dialog and a streaming conversation view to the
**public Solid adapter** and shared native box, input, button, text and overlay
primitives. It retains Adea's `keyedRows` source unchanged and adapts two lines
of `transcript-history`; the example records source identities and its
retained/adapted/reimplemented inventory. It neither modifies Adea production
nor provides drop-in compatibility for Adea's DOM, Tailwind or Kobalte layers.

The [component contract test](../tests/examples/adea-components.test.ts)
exercises mounting, streaming row identity, theme changes, menu and dialog
dismissal, and cleanup against an explicitly **synthetic headless protocol
peer**. Its assertions are not real GPUI input, pixels, focus, keyboard
navigation or accessibility evidence. The
[native screenshots record](../examples/adea-components/screenshots/README.md)
is a separately documented local manual observation; it is not a
cross-platform automated acceptance result. Packaging, physical-GPU
performance, IME/assistive technology and full Adea workspace portability
remain unqualified for these components. See [PR #566](https://github.com/0xPlayerOne/bun-native/pull/566)
and [workspace issue #250](https://github.com/0xPlayerOne/bun-native/issues/250)
for their precise scope. This later example does not retroactively expand the
immutable accepted-source snapshot or the release-readiness decision.

## Web compatibility boundary

**JSX is a source authoring syntax, not a browser renderer.** Components relying on HTML elements, the DOM, `window`, `document`, CSS layout, CSSOM or browser events cannot be assumed to work unchanged.

- **SolidJS:** the implemented universal renderer uses native primitives and the official universal JSX transform. `solid-js/web` and DOM component implementations are not supported.
- **React:** the implemented `react-reconciler` host uses native primitives. Logic without browser assumptions may be reusable; `react-dom` components do not become native components automatically.
- **Tailwind/CSS:** native layout/styling primitives are defined explicitly; arbitrary CSS selectors, cascade and browser painting effects are not promised.
- **shadcn, Radix, Kobalte and browser-oriented UI libraries:** some source-level patterns may be reusable, but DOM-dependent components generally require native ports. No universal import compatibility claim.
- **Native OS services:** display (macOS and Windows add a work area, display identity and display-change events), Linux X11 clipboard, Linux X11 global shortcut, Linux freedesktop notification, Linux, macOS and Windows scoped filesystem access (macOS and Windows evidence from hosted CI only), Linux, macOS and Windows owned processes (macOS and Windows verified in CI only), Linux portal file dialog access and drag and drop (Linux X11, macOS and Windows; the latter two qualified in hosted CI only) and the macOS application menu bar (hosted CI evidence only; Linux and Windows report it unavailable) use explicit grants. A chosen file path or a dropped file name is data, not a filesystem grant. Message and confirm dialogs are drawn by public core on the in-window modal overlay on every platform (qualified on Linux X11 only), not as OS alerts; OS context menus remain outside the available native service set. Grants do not sandbox ordinary Bun filesystem or process APIs; applications are trusted programs.
- **Untrusted webpages:** there is no hidden browser sandbox. Displaying untrusted content requires a deliberately scoped, safe native content model.

## Changes in 0.27.2

Merged between [`38634595`][snapshot] and [`e456a6d`][v0272]. Each row is
qualified only at its linked source and environment. "Hosted" means a GitHub
runner (`ubuntu-24.04`, `macos-15` or `windows-2022`) with software rendering
or a virtual display; it is not physical hardware.

| Area                           | Merged scope                                                                                                                                                                                                                                                                                             | Evidence and limits                                                                                                                                                                  |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| BN4 primitives and services    | Streaming lists, split panes, overlays and popups, scoped filesystem grants, owned processes, file dialogs, drag and drop, display details ([#481][pr481], protocol 11)                                                                                                                                  | Linux native fixtures; macOS and Windows steps run in hosted CI and are **unverified** per [capabilities by platform](native-platforms.md#advertised-capabilities-by-platform).      |
| Dialogs and menus              | Message and confirm dialogs drawn by core on the modal overlay ([ADR 0014](decisions/0014-message-dialogs.md)), macOS application menu bar ([ADR 0015](decisions/0015-application-menu-bar.md)), Windows OS task dialogs ([#547][pr547], [ADR 0018](decisions/0018-windows-task-dialogs.md))             | Core dialogs: Linux native and React workspace delete confirmation ([#545][pr545]). Menu bar and task dialogs: hosted oracles only, unverified.                                      |
| Linux Wayland                  | Core window, input, pixels, display snapshot, notification, portal dialog and compositor close on headless sway ([ADR 0017](decisions/0017-wayland.md), [#519][pr519])                                                                                                                                   | Observed, not supported. GNOME, KDE, fractional scaling, IME, clipboard, shortcuts, drag and drop and popups are not qualified ([Linux Wayland](native-platforms.md#linux-wayland)). |
| Text input and accessibility   | Keyboard split divider and AT-SPI roles ([#519][pr519]); one IBus Hangul composition over XIM in development and AOT ([#545][pr545])                                                                                                                                                                     | Linux X11 only. No macOS or Windows IME, no screen-reader run. [#241][i241] stays open.                                                                                              |
| Processes on macOS and Windows | macOS working directory, Windows job objects, ConPTY and pipe interrupt ([#519][pr519], [#549][pr549])                                                                                                                                                                                                   | Hosted only, unverified. [#305][i305] stays open.                                                                                                                                    |
| macOS workspaces               | Solid conversation and React task workspace references with keys, text, wheel, resize and OS close, development and AOT ([#582][pr582])                                                                                                                                                                  | Hosted `macos-15`, [Validation 42746456002][run582]. Includes the scroll repaint fix [#586][i586] and the Ctrl-C fix [#584][i584].                                                   |
| macOS physical Mac             | Fault containment, reproducible builds, a Metal workload run and unsigned install/rollback ([#521][pr521], [macOS qualification](macos-qualification.md)); clean-clone Solid and React quick-start in development and AOT on 2026-11-09 ([getting started](getting-started.md#macos-arm64-physical-mac)) | One Apple M2 Max. Quick-start window presence from CGWindowList only, no input; earlier cases needing event posting are **not run**.                                                 |
| Reproducible hosts             | Cross-runner host hash comparison, Windows `/Brepro` link ([#555][pr555], [#559][pr559])                                                                                                                                                                                                                 | See [reproducible builds](reproducible-builds.md).                                                                                                                                   |
| Benchmarks                     | Direct Rust GPUI baseline ([#557][pr557]); hosted regression gate with committed baselines ([#563][pr563])                                                                                                                                                                                               | Describes the recorded runners only; no comparative claim. [#244][i244] stays open.                                                                                                  |
| Adea component example         | Button, Input, DropdownMenu, Dialog and a conversation view on the public Solid adapter ([#566][pr566])                                                                                                                                                                                                  | Headless contract test against a synthetic peer; not native input or accessibility evidence.                                                                                         |
| Documentation checks           | Documented commands, Cargo-free tutorials and `doctor` OS/CPU logging ([#546][pr546]); comparative claims must cite a record ([#563][pr563])                                                                                                                                                             | [`docs-commands.test.ts`](../tests/quality/docs-commands.test.ts) and [`docs-claims.test.ts`](../tests/quality/docs-claims.test.ts) run in Source quality.                           |

Still unsupported in 0.27.2: signed or notarized artifacts and installers
([#249][i249]), Windows physical hardware, Linux ARM64, macOS x64 and Windows
ARM64 GUI, Babel 8 with the Solid compiler ([#316][i316]), and every DOM, CSS
cascade and WebView path described below. Since then Linux ARM64 and macOS x64
have gating CI lanes and released hosts, which makes them observed, not
supported ([ADR 0021](decisions/0021-platform-release-readiness.md#second-architectures-2026-11-12)).

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
[v0272]: https://github.com/0xPlayerOne/bun-native/tree/e456a6d2f65f8771b663a7fb8f3a6026ce0a9a54
[pr481]: https://github.com/0xPlayerOne/bun-native/pull/481
[pr519]: https://github.com/0xPlayerOne/bun-native/pull/519
[pr521]: https://github.com/0xPlayerOne/bun-native/pull/521
[pr545]: https://github.com/0xPlayerOne/bun-native/pull/545
[pr546]: https://github.com/0xPlayerOne/bun-native/pull/546
[pr547]: https://github.com/0xPlayerOne/bun-native/pull/547
[pr549]: https://github.com/0xPlayerOne/bun-native/pull/549
[pr555]: https://github.com/0xPlayerOne/bun-native/pull/555
[pr557]: https://github.com/0xPlayerOne/bun-native/pull/557
[pr559]: https://github.com/0xPlayerOne/bun-native/pull/559
[pr563]: https://github.com/0xPlayerOne/bun-native/pull/563
[pr566]: https://github.com/0xPlayerOne/bun-native/pull/566
[pr582]: https://github.com/0xPlayerOne/bun-native/pull/582
[run582]: https://github.com/0xPlayerOne/bun-native/actions/runs/42746456002
[i249]: https://github.com/0xPlayerOne/bun-native/issues/249
[i305]: https://github.com/0xPlayerOne/bun-native/issues/305
[i584]: https://github.com/0xPlayerOne/bun-native/issues/584
[i586]: https://github.com/0xPlayerOne/bun-native/issues/586
[bn0]: https://github.com/0xPlayerOne/bun-native/blob/3863459588378532a4af4fb27188f051fa0955df/docs/bn0-audit.md
[bn1]: https://github.com/0xPlayerOne/bun-native/blob/3863459588378532a4af4fb27188f051fa0955df/docs/bn1-audit.md
[lock]: ../bun.lock
[toolchain]: ../toolchain.json
[host-manifest]: ../native/gpui-host/Cargo.toml
[root-manifest]: ../package.json
[solid-pin]: ../packages/solid/package.json
[react-pin]: ../packages/react/package.json
[protocol-ts]: ../packages/protocol/src/messages.ts
[protocol-rs]: ../native/protocol/src/wire.rs
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
[wayland]: native-platforms.md#linux-wayland
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
