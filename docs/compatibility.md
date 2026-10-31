# Compatibility and support scope

**Status:** BN0 is complete and BN1's shared core is implemented in this source.
The matrix distinguishes actual observed behavior, compile-only contracts and
remaining native release qualification. No signed, installed, cross-platform
application release is qualified. See the [BN0 audit](bn0-audit.md),
[public API](../packages/core/README.md) and [native fixtures](../tests/native/README.md).

## Languages, frameworks and platforms

| Capability                      | Implemented or observed scope                                                                                                       | Remaining acceptance                                                                                               |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| TypeScript `.ts`                | Public core/native tree works in development and inspected AOT on Linux                                                             | Stable release API and remaining OS targets                                                                        |
| JavaScript `.js`                | Checked-JSDoc public consumer passed real dev/AOT click, typing, paint and cleanup                                                  | Broader consumer/library and platform matrix                                                                       |
| Framework `.tsx/.jsx`           | Separate Solid renderer draft #277 has initial real dev/AOT evidence                                                                | Complete adapter behavior and release-host audit; no automatic DOM compatibility                                   |
| SolidJS                         | Pinned 1.9.18 shared-core import/type fixture; actual native renderer in [#277](https://github.com/0xPlayerOne/bun-native/pull/277) | BN2 #231/#234/#233, including controlled input and component reuse                                                 |
| React                           | Pinned 19.3.1 shared-core import/type fixture compiles; no renderer is included here                                                | BN3 reconciler, native effect/event/lifecycle tests and representative example                                     |
| Shared native tree              | Boxes, text, buttons and inputs; atomic mutations, opaque ownership and input revisions                                             | Advanced BN4 widgets, scrolling, theme and accessibility                                                           |
| Linux native window             | X11/XTest and llvmpipe input/paint/close passed in dev/AOT; BN0 includes release host                                               | BN1's current release audit, Wayland and hardware-GPU matrix                                                       |
| macOS / Windows GUI             | Headless protocol/contract lanes pass                                                                                               | Native GUI/AOT target qualification under BN6 #246 and CI #256                                                     |
| Bun machine-code AOT            | Actual compiler and artifact inspection plus native execution                                                                       | Per-target artifact inspection and release packaging                                                               |
| Native text/input               | Actual typing and versioned replacement; preserved full values                                                                      | Horizontal scrolling, general focus order, IME, assistive technology and full Unicode/DPI qualification under #241 |
| Sensitive native services       | Not exposed; unknown service commands fail validation                                                                               | Scoped capability contracts and native implementation under #255                                                   |
| Installers, signing and updates | Experimental Linux executable payload and provenance only                                                                           | BN6 packaging, clean-machine, signing and integrity/rollback checks                                                |

The renderer starts with Rust GPUI. An agent may choose a different real native renderer with recorded evidence and update this document; WebView/CEF is not a fallback.

## Web compatibility boundary

**JSX is a source authoring syntax, not a browser renderer.** Components relying on HTML elements, the DOM, `window`, `document`, CSS layout, CSSOM or browser events cannot be assumed to work unchanged.

- **SolidJS:** custom native renderer planned, not `solid-js/web`. Signals and component state can be reused; DOM components may need a native counterpart.
- **React:** custom `react-reconciler` host planned, not react-dom. Hooks and component logic can be reused if browser assumptions are removed.
- **Tailwind/CSS:** native layout/styling primitives are defined explicitly; arbitrary CSS selectors, cascade and browser painting effects are not promised.
- **shadcn, Radix, Kobalte and browser-oriented UI libraries:** some source-level patterns may be reusable, but DOM-dependent components generally require native ports. No universal import compatibility claim.
- **Native OS services:** clipboard, files, PTY/processes, dialogs, menus, notifications and shortcuts require typed capability grants and OS-specific implementation. Unsupported operations fail explicitly.
- **Untrusted webpages:** there is no hidden browser sandbox. Displaying untrusted content requires a deliberately scoped, safe native content model.

## Evidence procedure

For each component/platform capability, record:

1. Source revision, exact Bun/renderer/adapter versions and target OS/CPU/GPU.
2. Whether it runs in Bun dev, compiles with AOT and launches a real native window.
3. Supported native behavior and automated/GUI test evidence.
4. Source retained/adapted/reimplemented, DOM/CSS dependencies and a supported native replacement.
5. Unsupported or failed cases linked to an owned issue.

[BN2 #233](https://github.com/0xPlayerOne/bun-native/issues/233) ports five representative Adea Solid components; [BN3 #238](https://github.com/0xPlayerOne/bun-native/issues/238) tests React. [BN4](https://github.com/0xPlayerOne/bun-native/issues/222) supplies the common widgets; [BN7 #245](https://github.com/0xPlayerOne/bun-native/issues/245) owns the final audited support matrix.

## Platform qualification

A compile success is not a native GUI acceptance result. Each supported OS/arch needs actual window launch and input evidence; text/IME/assistive technology and hardware-specific GPU behavior need explicit coverage. Prefer GitHub-hosted runners, then the connected Mac via Remote Desktop Commander for interactive macOS cases. Label unavailable hardware tests as **unsupported** and continue independent work.

Read [architecture](architecture.md), [testing](testing.md), [releasing](releasing.md) and the [roadmap](https://github.com/0xPlayerOne/bun-native/issues/1).
