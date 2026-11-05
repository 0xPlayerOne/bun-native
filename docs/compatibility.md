# Compatibility and support scope

**Status:** This describes [accepted source `c4de68de`][snapshot]. BN0 and BN1 are
complete within their recorded Linux scope. The shared core, Solid and React
adapters, native layout, initial services and checkout CLI are implemented.
Their APIs and qualification remain experimental; no signed, installed,
cross-platform application release is qualified. The [BN0 audit][bn0] and
[BN1 audit][bn1] retain their own source, host and compiler identities.

The exact pins are [Solid `1.9.18`][solid-pin], [React `19.3.1` and
`react-reconciler` `0.34.0`][react-pin], and [Bun `1.4.4-canary.1`, revision
`da867c60bf0bcbf9d6d36994f8ca0efa42075115`][toolchain]. The accepted
[lockfile][lock] binds dependency integrity. These are exact selections, not
promised compatibility ranges or a stable release API.

## Languages, frameworks and platforms

| Capability                     | Implemented or observed scope                                                                                                                                                               | Remaining limits                                                                                                                                                                                                                                                                            |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TypeScript and JavaScript      | [Public core][core] and Solid/React native JSX; four checkout templates cover TypeScript and checked JavaScript.                                                                            | No automatic DOM compatibility; broader consumer and platform combinations need their own evidence.                                                                                                                                                                                         |
| SolidJS                        | [Universal renderer][solid] with signals/effects, keyed updates, native events, revisioned input and root disposal; recorded Linux development/AOT interaction.                             | Component reuse is assessed individually. Broader platform/performance acceptance and [retention investigation #287](https://github.com/0xPlayerOne/bun-native/issues/287) remain separate.                                                                                                 |
| React                          | [Native reconciler][react] with hooks, refs, effect cleanup, error boundaries and shared native events; recorded Linux development/AOT [behavior cases][react-behavior].                    | The behavior matrix bounds scheduling support. Suspended/hidden subtrees, hydration, portals and native view-transition animations are outside the implemented contract.                                                                                                                    |
| Reference applications         | [Solid conversation workspace][solid-app] and [React task workspace][react-app] use the public adapters, native scroll containers and application theme state.                              | Bounded examples do not establish full Adea portability, virtualization, long-session performance or missing OS dialogs/menus.                                                                                                                                                              |
| Layout and input               | [Shared layout][layout] supplies boxes, text, buttons, inputs, sizing, clipping and retained scrolling; [native interactions][events] include keyboard, pointer, focus and revisioned text. | Complete text viewport behavior, IME, accessibility, mixed-DPI and broader Unicode qualification remain open under [#241](https://github.com/0xPlayerOne/bun-native/issues/241).                                                                                                            |
| Linux GUI                      | Recorded X11/XTest and llvmpipe window/input/paint/close cases for core and adapters in development and inspected AOT.                                                                      | Software X11 evidence does not qualify Wayland, physical input/GPU performance or the complete display/DPI matrix.                                                                                                                                                                          |
| macOS ARM64 / Windows x64 GUI  | [Hosted public-core cases][platforms] execute real GPUI windows, complete paints, native OS-injected input and joined cleanup in development and inspected AOT.                             | These cases do not establish the full adapter/template matrix, screenshots, display presentation, physical input, OS close buttons or complete descendant enumeration.                                                                                                                      |
| Display and clipboard services | [Permission-gated display snapshots and bounded clipboard text][services]; recorded local Linux development/AOT with a development-profile host.                                            | Hosted release-host service acceptance remains separate. macOS/Windows display-service execution is unverified; clipboard is local X11 only. Other service families remain unavailable.                                                                                                     |
| CLI and source reload          | [Checkout-local create/dev/build][cli] for all four templates, an explicit prebuilt host and serialized full-remount watch; ordinary edits do not invoke Cargo.                             | Remount resets app state. Independent installation, other-platform template qualification and sustained resource/performance acceptance remain separate; see [#243](https://github.com/0xPlayerOne/bun-native/issues/243) and [#372](https://github.com/0xPlayerOne/bun-native/issues/372). |
| Bun AOT and distribution       | Inspected compiled-program/JIT-removal metadata and native execution exist for the recorded target-specific fixtures; unsigned native-host artifacts are experimental.                      | Compile success alone is insufficient. [Installers, signing, clean-machine operation and update integrity/rollback][releasing] are not qualified.                                                                                                                                           |

Both adapters use one Rust GPUI host. Packages and the prebuilt host must share
the matching native contract. WebView/CEF is not a fallback.

## Web compatibility boundary

**JSX is a source authoring syntax, not a browser renderer.** Components relying on HTML elements, the DOM, `window`, `document`, CSS layout, CSSOM or browser events cannot be assumed to work unchanged.

- **SolidJS:** the implemented universal renderer uses native primitives and the official universal JSX transform. `solid-js/web` and DOM component implementations are not supported.
- **React:** the implemented `react-reconciler` host uses native primitives. Logic without browser assumptions may be reusable; `react-dom` components do not become native components automatically.
- **Tailwind/CSS:** native layout/styling primitives are defined explicitly; arbitrary CSS selectors, cascade and browser painting effects are not promised.
- **shadcn, Radix, Kobalte and browser-oriented UI libraries:** some source-level patterns may be reusable, but DOM-dependent components generally require native ports. No universal import compatibility claim.
- **Native OS services:** display, clipboard, Linux X11 global shortcut, Linux freedesktop notification, Linux scoped filesystem access and Linux X11 drag and drop use explicit grants. PTY/process services, dialogs and menus remain outside the available native service set. Grants do not sandbox ordinary Bun filesystem or process APIs; applications are trusted programs.
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

[BN7 #245](https://github.com/0xPlayerOne/bun-native/issues/245) still owns the final
audited support matrix; [#254](https://github.com/0xPlayerOne/bun-native/issues/254)
retains the complete user-documentation acceptance. This source snapshot does
not close either scope.

Read [architecture](architecture.md), [testing](testing.md), [releasing](releasing.md) and the [roadmap](https://github.com/0xPlayerOne/bun-native/issues/1).

[snapshot]: https://github.com/0xPlayerOne/bun-native/tree/c4de68deee812cd816316b33f9276786e6eae5c8
[bn0]: https://github.com/0xPlayerOne/bun-native/blob/c4de68deee812cd816316b33f9276786e6eae5c8/docs/bn0-audit.md
[bn1]: https://github.com/0xPlayerOne/bun-native/blob/c4de68deee812cd816316b33f9276786e6eae5c8/docs/bn1-audit.md
[solid-pin]: https://github.com/0xPlayerOne/bun-native/blob/c4de68deee812cd816316b33f9276786e6eae5c8/packages/solid/package.json
[react-pin]: https://github.com/0xPlayerOne/bun-native/blob/c4de68deee812cd816316b33f9276786e6eae5c8/packages/react/package.json
[toolchain]: https://github.com/0xPlayerOne/bun-native/blob/c4de68deee812cd816316b33f9276786e6eae5c8/toolchain.json
[lock]: https://github.com/0xPlayerOne/bun-native/blob/c4de68deee812cd816316b33f9276786e6eae5c8/bun.lock
[core]: https://github.com/0xPlayerOne/bun-native/blob/c4de68deee812cd816316b33f9276786e6eae5c8/packages/core/README.md
[solid]: https://github.com/0xPlayerOne/bun-native/blob/c4de68deee812cd816316b33f9276786e6eae5c8/packages/solid/README.md
[react]: https://github.com/0xPlayerOne/bun-native/blob/c4de68deee812cd816316b33f9276786e6eae5c8/packages/react/README.md
[react-behavior]: https://github.com/0xPlayerOne/bun-native/blob/c4de68deee812cd816316b33f9276786e6eae5c8/docs/react-behavior.md
[solid-app]: https://github.com/0xPlayerOne/bun-native/blob/c4de68deee812cd816316b33f9276786e6eae5c8/examples/solid-workspace/README.md
[react-app]: https://github.com/0xPlayerOne/bun-native/blob/c4de68deee812cd816316b33f9276786e6eae5c8/examples/react-workspace/README.md
[layout]: https://github.com/0xPlayerOne/bun-native/blob/c4de68deee812cd816316b33f9276786e6eae5c8/docs/native-layout.md
[events]: https://github.com/0xPlayerOne/bun-native/blob/c4de68deee812cd816316b33f9276786e6eae5c8/docs/native-events.md
[platforms]: https://github.com/0xPlayerOne/bun-native/blob/c4de68deee812cd816316b33f9276786e6eae5c8/docs/native-platforms.md
[services]: https://github.com/0xPlayerOne/bun-native/blob/c4de68deee812cd816316b33f9276786e6eae5c8/docs/native-services.md
[cli]: https://github.com/0xPlayerOne/bun-native/blob/c4de68deee812cd816316b33f9276786e6eae5c8/docs/developer-tooling.md
[releasing]: https://github.com/0xPlayerOne/bun-native/blob/c4de68deee812cd816316b33f9276786e6eae5c8/docs/releasing.md
