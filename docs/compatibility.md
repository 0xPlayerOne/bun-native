# Compatibility and support scope

**Status:** Bun Native is a new framework under implementation. The matrix below distinguishes **intended scope** from **verified support**; no native app release has been qualified yet. Update this matrix from real tests and linked issues, not optimism.

## Intended languages, frameworks and platforms

| Capability                                     | Intended support                             | Verified today      |
| ---------------------------------------------- | -------------------------------------------- | ------------------- |
| TypeScript `.ts/.tsx`                          | First-class app and framework authoring      | Not yet qualified   |
| JavaScript `.js/.jsx`                          | First-class consumer authoring               | Not yet qualified   |
| SolidJS                                        | First native UI adapter                      | Not yet implemented |
| React                                          | Separate native UI adapter using shared host | Not yet implemented |
| macOS native GPU window                        | Target                                       | Not yet verified    |
| Windows native GPU window                      | Target                                       | Not yet verified    |
| Linux native GPU window                        | Target                                       | Not yet verified    |
| Bun machine-code AOT release                   | Required production target                   | Not yet verified    |
| Native text, input, accessibility, OS services | Required useful desktop functionality        | Not yet verified    |

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
