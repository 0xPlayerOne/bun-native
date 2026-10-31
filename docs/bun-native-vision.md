# Bun Native: Bun AOT + GPUI native desktop framework

**Decision (2026-10-31):** The experimental Bunly project is now **Bun Native**. The engineering target is **Bun machine-code AOT + Rust GPUI**. The legacy CEF/WebView implementation is throwaway and its old M1–M12 roadmap is superseded. This is an approved direction, **not** proof that an AOT+GPUI app has been shipped.

## Goal

Make native desktop software approachable to JavaScript and TypeScript developers (**TypeScript preferred**) with first-party **SolidJS (preferred)** and **React** support:

> Write desktop applications in TypeScript or JavaScript using SolidJS or React, iterate with Bun's fast development loop, and ship ahead-of-time-compiled application code driving Rust GPUI's browserless native UI.

Optimize for **both** developer experience and shipped application experience. The aspiration is low startup latency, low idle memory, small distribution size, responsive rendering, accessible native interaction, and reproducible packaging on macOS, Windows and Linux. We will measure rather than assume those outcomes.

The **native renderer is Rust GPUI**. Application authors should not have to write Rust. The shipped AOT app may contain Bun's runtime and GC alongside GPUI; it is not a pure-Rust binary.

## Two independent technical requirements

1. **Native rendering** determines how UI is drawn. A renderer backed by operating-system widgets or a GPU engine can display UI without a Chromium, CEF or system-WebView document. This is possible with regular, JIT-driven Bun; GPUIX, Electrobun's experimental Warren UI, and Blitsen are relevant prior art.
2. **Bun machine-code AOT** determines how application JavaScript/TypeScript executes. Experimental `bun compile` (equivalent to `bun build --compile --aot`) compiles supported program code to machine instructions before launch and ships a trimmed Bun runtime without its JIT. It retains runtime facilities such as garbage collection, the event loop, and an interpreter for dynamically generated code. AOT does **not** translate HTML/CSS/DOM components into native controls.

A successful Bun Native release needs **both** for the ordinary desktop UI. It does not get the benefit of native rendering merely by applying `--aot` to today's CEF/WebView application.

Sources:
- [Bun compiler overview](https://bun.com/docs/compiler)
- [Bun compiler internals](https://bun.com/docs/compiler/internals)
- [Bun AOT compatibility](https://bun.com/docs/compiler/compatibility)
- [Warren native renderer](https://framework.blackboard.sh/electrobun/guides/electrobun-ui/)
- [Blitsen architecture](https://blitsen.dev/docs/tech/)
- [GPUIX](https://www.gpuix.dev/)

## Product promise and non-goals

**Desired developer contract**

- TypeScript-first (`.ts/.tsx`) and JavaScript-compatible (`.js/.jsx`) application entry points, typed native APIs and fast development reloads.
- **SolidJS and React are both supported via separate first-party renderers** over shared GPUI primitives. Solid is prioritized for the first implementation.
- Production build uses Bun's machine-code AOT **when qualified**; AOT correctness and stable native addon compatibility are release gates, not assumed.
- Browserless native drawing of application UI with serious text input, focus, accessibility, selection, layout and internationalization support.
- Familiar SolidJS/React JSX authoring, with explicit documentation of the component-compatibility boundary.
- Bun toolchain for packages/runtime, `bun check` TypeScript checking, `bun fmt` formatting, `bun test` testing, and `bun compile` production AOT. In projects defining scripts named `check` or `fmt`, use `--no-script` to invoke the actual built-in.
- Prebuilt native framework artifacts; ordinary consumer builds should not silently compile native toolchains. Per-OS/architecture AOT builds must be explicit.

**Not promised**

- Arbitrary DOM, Kobalte, shadcn-style or Tailwind applications running unchanged.
- Rust-equivalent runtime speed, universally smaller files, zero runtime or zero garbage collection.
- A browser engine, safe rendering of arbitrary untrusted websites, or an invisible fallback to a WebView.
- Cross-compiling AOT binaries on one host before Bun supports that; compile on each target host as needed.

## Candidate architecture

```text
Application source: TypeScript or JavaScript + SolidJS or React JSX
        |
        +-- Development: Bun runtime, fast edit loop, native renderer
        |
        +-- Production: Bun AOT compilation (type checks + machine code)
                             |
                Compiled app logic + trimmed Bun runtime
                             |
                Framework-specific Solid or React reconciler
                             |
                Typed Bun-to-GPUI native host bridge
                             |
                Rust GPUI native window + GPU rendering (no WebView)
```

GPUI is the **chosen** rendering engine, not an interchangeable candidate. Implement a small, versioned, typed Bun-to-GPUI bridge with clear ownership, events and shutdown behavior. A Solid adapter (investigate `solid-js/universal`) and React adapter (investigate `react-reconciler`) both target the same GPUI-backed host elements. Native GPUI internals are compiled separately from the app's Bun AOT code; AOT does not translate JSX to Rust. Prior work such as GPUIX can inform the bridge but is not the product boundary. Do not assume arbitrary DOM-dependent Solid or React components can be automatically translated.

The former Bunly CEF host, its M1–M12 results and qualifications remain **historical evidence**, not implementation dependencies or release gates. Existing tracking issues are superseded, with their histories preserved.

## First evidence milestones

### 0 — Feasibility gate (smallest runnable spike)

- Confirm exact Bun version and `bun compile` availability on actual target OS/architectures.
- Build a real **GPUI** native window with text, button and text input from a TypeScript entry point under regular Bun.
- Build and run the **same application** with `bun compile`; verify the shipped executable has no JIT, no CEF/WebView dependency, and that the renderer/native addon loads correctly.
- Exercise click, keyboard input, teardown, errors and repeat launches. Keep a runnable reproduction and failure logs.
- If Bun AOT-to-GPUI integration is unsupported, report the precise blocker and stop to revisit the architectural decision, rather than silently substituting the old `bun build --compile` JIT path or a different renderer.

### 1 — Real component compatibility gate

First implement a **SolidJS** renderer, then a separate **React** renderer over shared GPUI primitives. Port five representative components from the actual Adea Solid UI library: a simple button, styled input, menu, dialog and a complex streaming/conversation view. Validate a separate React component fixture with hooks, events and reconciler lifecycle. For each, record (a) reused source, (b) adapted source, (c) newly implemented native behavior, and (d) unsupported features. Prioritize typography, focus management, accessibility, IME, keyboard navigation and selection. A near-zero-change import is a hypothesis to test, not a claim.

### 2 — Measured developer and user experience

Compare identical workloads and builds against at least a Bun JIT + native renderer baseline and a representative existing desktop framework. Record startup time, peak/idle RSS, bundle/install size, interactive responsiveness, CPU/GPU under load, reload latency, state preservation, build time and OS-specific behavior. Include unsuccessful runs; do not extrapolate claims from competitors' unrelated benchmarks.

### 3 — Distribution and maintainability

Only after passing the prior gates: package signed/native artifacts across macOS, Windows and Linux; validate updates, crash reporting, security model, accessibility, packaging reproducibility and release evidence. Keep the native framework maintainable for contributors who do not use Rust.

## Current implementation tracker

- **BN0:** [#217](https://github.com/0xPlayerOne/bunly/issues/217) — real Bun AOT + GPUI proof (hard first gate)
- **BN1:** [#219](https://github.com/0xPlayerOne/bunly/issues/219) — typed host ABI, event and ownership model
- **BN2:** [#218](https://github.com/0xPlayerOne/bunly/issues/218) — SolidJS first-party renderer
- **BN3:** [#221](https://github.com/0xPlayerOne/bunly/issues/221) — React first-party renderer
- **BN4:** [#222](https://github.com/0xPlayerOne/bunly/issues/222) — native components, styling, accessibility, IME
- **BN5:** [#220](https://github.com/0xPlayerOne/bunly/issues/220) — Bun-first development tools and HMR
- **BN6:** [#223](https://github.com/0xPlayerOne/bunly/issues/223) — cross-platform AOT distribution
- **BN7:** [#224](https://github.com/0xPlayerOne/bunly/issues/224) — Adea/React adoption and comparative evidence

The active product roadmap is [issue #1](https://github.com/0xPlayerOne/bunly/issues/1). Old CEF and WebView issues should be retired as superseded, while Git history and measurement evidence remain intact. Do not migrate Adea production as an incidental side effect.

## Decision rule

Proceed with **Bun AOT + GPUI** as the experimental target. Only scale the adapter/component work after BN0 proves a real browserless AOT app. Ship only if native input/accessibility and reproducible performance evidence justify it. If AOT integration is blocked, record a clear continue/narrow/stop decision instead of relabeling a JIT build as AOT.
