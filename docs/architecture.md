# Bun Native architecture

**Status: target design, not yet an implemented runtime.** This is the implementation contract for the direct migration tracked in [BN0–BN7](https://github.com/0xPlayerOne/bun-native/issues/1). A fresh agent can refine mechanisms through a recorded ADR; the non-negotiable outcome is **Bun TS/JS application logic + real browserless native UI + Bun AOT production compilation**.

## System layers

```text
Application packages  (TypeScript / JavaScript; .ts .tsx .js .jsx)
     ├── SolidJS adapter  ┐
     └── React adapter    ┴─→ Shared typed native component/host API
                                         │
                              Versioned native bridge
                                         │
                             Rust native renderer host
                                         │
                          GPU + OS windows and services
```

**Rust GPUI is the initial rendering engine.** Switching to another native rendering engine is allowed if technically justified and documented, but a WebView/CEF/Chromium UI is not an accepted fallback.

### Development and release modes

- **Development:** ordinary Bun executes application TS/JS, supports watchers and framework reloads while the native host remains alive where safe.
- **Production:** Bun's experimental `bun compile` checks/compiles supported program logic to machine code on the target host. A reduced Bun runtime, event loop and GC may still ship; no JIT is claimed only after inspecting the real AOT artifact.
- **Native host:** GPUI or another approved native renderer is compiled by framework maintainers and distributed as versioned host artifacts. A consumer editing a TSX component must not silently invoke Cargo.

AOT is an execution mechanism, **not** a JSX/CSS-to-Rust compiler. The Solid/React adapters must translate framework tree operations into the native host's supported elements.

## Package boundaries (suggested, not frozen names)

| Area | Responsibility | May depend on |
| --- | --- | --- |
| Public core API | Typed windows, elements, events, errors, capabilities, lifecycle | Portable contracts |
| Native host and bridge | ABI, event queue, resource ownership, renderer integration | Core contract and native OS libraries |
| Solid adapter | Solid signals/owner lifecycle mapped to native host | Public core, Solid |
| React adapter | React reconciler mapped to native host | Public core, React |
| Shared components | Layout, text, input, overlays, style tokens, accessibility | Public native host primitives |
| CLI/tooling | Create/dev/build/diagnose, AOT, package resolution, reload | Public contracts, compiler/native artifacts |
| Platform artifacts | Per-OS/arch native host and manifest | Pinned native build |
| Examples/tests/benchmarks | Consumer behavior and evidence | Only public APIs wherever possible |

Enforce this dependency direction, without introducing layers that merely forward arguments. Public UI packages should not import Rust internals or require browser globals. Avoid duplicate native widget implementations across Solid/React.

## Native bridge and host lifecycle

[BN1 #219](https://github.com/0xPlayerOne/bun-native/issues/219) owns the concrete selection between validated FFI, Node-API, C ABI, subprocess or other native interop. Choose from measured build/AOT compatibility, memory and crash isolation, UI-thread constraints and overhead—not from assumptions.

The host contract must specify:

1. Window and element identities, typed kinds and immutable ownership scope.
2. Create/update/reorder/delete tree mutations; diffing and batching to minimize crossings.
3. UI-thread mutation authority; bounded queues, callback dispatch, event ordering and backpressure.
4. Resource and callback disposal, shutdown, startup rollback and stale-handle rejection.
5. Version/ABI negotiation and explicit unsupported-platform errors.
6. Security: capability validation for file/process/clipboard/network/window services and rejection of malformed or untrusted content.

Opaque IDs alone are not authorization. Use runtime validation at trust and native boundaries even when TypeScript types are precise.

## Framework renderers

**SolidJS (BN2):** investigate `solid-js/universal`; implement a native custom renderer for signals, effects, keyed lists, mount/update/unmount and mapped input. No assumption that `solid-js/web` or DOM-oriented components work without adaptation.

**React (BN3):** implement a pinned `react-reconciler` host configuration over the **same** native tree. Validate refs, hooks/effects, scheduling, errors, input and cleanup. Do not use React DOM or duplicate the Rust widget implementation.

**Shared native UI (BN4):** provide text/layout/input/buttons/menus/dialogs/scrollers/virtualized lists, theme tokens and OS services. Minimal primitives begin as soon as the BN1 host is stable, in parallel with renderer adapters; advanced text/IME/accessibility and widgets may complete later.

## Native desktop services and security

Use explicit, scoped capabilities for clipboard, files, PTY/processes, notifications, shortcuts, dialogs and other OS integrations. Native handles must have owners, lifetime and revocation behavior. Browserless rendering does not itself sandbox app logic or untrusted data. The [BN1 threat model #252](https://github.com/0xPlayerOne/bun-native/issues/252) and [BN4 platform APIs #255](https://github.com/0xPlayerOne/bun-native/issues/255) own the actual contracts.

## Hot reload, platform targets and packaging

BN5 owns the edit loop: watch TS/JS source, update/recreate the component tree safely, preserve state only where supported, dispose old callbacks, restart only on native ABI/config changes. No Rust recompilation for normal app edits.

BN6 owns macOS/Windows/Linux host-native AOT builds and verified artifacts. Each OS/CPU target needs its own support evidence, resources, launcher and ABI manifest. Signing, installers, updates and rollback are distinct from merely compiling an executable.

## Quality, performance and observability

Follow [engineering-quality.md](engineering-quality.md). The highest-risk paths are native crossing count/batching, event queue growth, UI-thread stalls, text layout/IME, scrolling/virtualization, repeated reload/disposal, memory retention and AOT compiler slow paths. Record the same workload on actual supported hardware with source version, Bun/renderer pins, startup, RSS, frame/input latency, artifact bytes and raw samples. No performance advantage is assumed.

## Current gaps

There is **no accepted Bun Native ABI, component contract, AOT+GPUI application, package layout or supported release matrix yet**. BN0 establishes the first implementation and test evidence; BN1 stabilizes public/native interfaces. Treat every package/layout/CLI name here as guidance until its implementation issue and ADR make it concrete.

See [decision records](decisions/README.md), [toolchain](toolchain.md), [testing](testing.md) and the [master roadmap](https://github.com/0xPlayerOne/bun-native/issues/1).
