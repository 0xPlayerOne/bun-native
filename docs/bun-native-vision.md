# Bun Native — product vision

**Decision:** Bunly's experimental browser-based desktop runtime is being replaced by **Bun Native**, a new TypeScript-first native desktop application framework. This is an unconditional rewrite, not a feasibility vote. The old CEF/WebView code is obsolete and will be removed from the active source under [BN0 #251](https://github.com/0xPlayerOne/bun-native/issues/251).

## The promise

> Write native desktop applications in TypeScript or JavaScript, use SolidJS or React, develop with Bun's fast feedback loop, and distribute machine-code AOT application logic driving a real browserless native interface.

TypeScript is preferred but JavaScript is a supported consumer language. Developers should not need to write Rust, understand GPUI or run Cargo on normal application-source edits.

## Two independent parts

**Native rendering** controls how a desktop interface is displayed and interacted with. Bun Native uses native GPU/OS rendering and a typed host tree rather than a Chromium/CEF or system WebView document. **Rust GPUI is the initial engine**, and an assigned agent can select a different genuine native renderer based on reproducible technical evidence and an architecture decision record.

**Bun AOT** controls how application JavaScript/TypeScript executes in a production build. Experimental `bun compile` converts supported code into CPU machine instructions ahead of time and ships a reduced Bun runtime without its JIT. It does not turn JSX, CSS or browser DOM components into native widgets. It does not erase the event loop, garbage collection or every runtime cost.

The product depends on both pieces functioning together. Development may use normal Bun; the published AOT claim requires real `bun compile` output.

## Developer experience target

- One coherent, typed native host API shared by **SolidJS first** and **React second** adapters.
- Native components for layout, text, inputs, menus, dialogs, scrolling, virtualization and desktop OS services.
- App code changes with fast reload; the native renderer and Rust toolchain are not rebuilt unnecessarily.
- Project generation, checks, formatting, tests, builds and diagnostics managed through Bun-oriented tooling.
- Prebuilt host artifacts and explicit target platform support. macOS, Windows and Linux are the intended platforms; actual acceptance is tracked independently.
- Reasonable default security and lifecycle semantics: capability-scoped OS APIs, handle ownership, bounded updates and safe cleanup.

## What is not promised

- Existing DOM-dependent Solid/React apps, Tailwind, shadcn, Radix or Kobalte running unchanged.
- A browser sandbox, arbitrary untrusted website rendering or hidden WebView fallback.
- Zero GC, no Bun runtime, pure-Rust app logic, Rust-equivalent speed or guaranteed tiny binaries.
- Universal AOT package compatibility, cross-compilation or supported GPU hardware before testing proves it.
- Adea production migration as an incidental side effect of building reference examples.

## Success means

A new developer can follow documented Bun Native commands to create a real native app in TS/JS with Solid or React, edit components rapidly and produce an AOT application package that launches and accepts input on a documented supported OS—**without using a browser renderer or writing Rust**.

We will measure startup-to-interactive, process-tree memory, CPU/GPU load, frame/input tail latency, executable/install bytes, AOT compile time, native bridge cost, accessibility, text editing, lifecycle correctness and reload latency. Performance budgets derive from correct measured baselines. The [engineering-quality standard](engineering-quality.md) requires repeated architecture and optimization audits throughout the build.

## Delivery phases

- [BN0](https://github.com/0xPlayerOne/bun-native/issues/217) — remove Bunly/CEF, establish real native window and Bun AOT integration.
- [BN1](https://github.com/0xPlayerOne/bun-native/issues/219) — typed native host API and security/lifecycle contract.
- [BN2](https://github.com/0xPlayerOne/bun-native/issues/218) — SolidJS renderer.
- [BN3](https://github.com/0xPlayerOne/bun-native/issues/221) — React renderer.
- [BN4](https://github.com/0xPlayerOne/bun-native/issues/222) — shared native components, accessibility and OS services.
- [BN5](https://github.com/0xPlayerOne/bun-native/issues/220) — CLI, fast reload and CI.
- [BN6](https://github.com/0xPlayerOne/bun-native/issues/223) — native AOT installers, updates, rollback.
- [BN7](https://github.com/0xPlayerOne/bun-native/issues/224) — real apps, compatibility, benchmarks and final cleanup.

These are parallelizable engineering scopes, not owner approval checkpoints. An agent starting any milestone should execute missing prerequisites and continue. [Full roadmap](https://github.com/0xPlayerOne/bun-native/issues/1).
