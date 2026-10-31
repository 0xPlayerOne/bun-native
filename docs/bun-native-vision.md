# Bun Native: proposed product direction

**Status:** Product direction proposed on 2026-10-31. Not implemented or release-qualified. This document is a decision brief, not evidence that the current Bunly v0.6.9 CEF host has migrated.

## Goal

Make native desktop software approachable to TypeScript developers:

> Write desktop applications in TypeScript (ideally Solid/TSX), iterate with Bun's fast development loop, and ship ahead-of-time-compiled application code driving a truly native, browserless UI.

Optimize for **both** developer experience and shipped application experience. The aspiration is low startup latency, low idle memory, small distribution size, responsive rendering, accessible native interaction, and reproducible packaging on macOS, Windows and Linux. We will measure rather than assume those outcomes.

The framework may contain a Rust/C++/Zig native renderer or platform layer. **Application authors should not have to write Rust.** A shipped AOT executable is not a pure-Rust binary.

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

- TypeScript-first application entry points, a reactive component model, typed native APIs and fast development reloads.
- Production build uses Bun's machine-code AOT **when qualified**; AOT correctness and stable native addon compatibility are release gates, not assumed.
- Browserless native drawing of application UI with serious text input, focus, accessibility, selection, layout and internationalization support.
- Familiar Solid/JSX authoring and a deliberate, documented component-compatibility surface.
- Prebuilt native framework artifacts; ordinary consumer builds should not silently compile native toolchains. Per-OS/architecture AOT builds must be explicit.

**Not promised**

- Arbitrary DOM, Kobalte, shadcn-style or Tailwind applications running unchanged.
- Rust-equivalent runtime speed, universally smaller files, zero runtime or zero garbage collection.
- A browser engine, safe rendering of arbitrary untrusted websites, or an invisible fallback to a WebView.
- Cross-compiling AOT binaries on one host before Bun supports that; compile on each target host as needed.

## Candidate architecture

```text
Application source: TypeScript + Solid/TSX + supported styling
        |
        +-- Development: Bun runtime, fast edit loop, native renderer
        |
        +-- Production: Bun AOT compilation (type checks + machine code)
                             |
                Compiled app logic + trimmed Bun runtime
                             |
                Typed native renderer/platform API
                             |
                Native window + GPU/OS rendering (no WebView)
```

Native rendering and the AOT runtime must integrate through a stable, testable native boundary. Reuse a mature renderer wherever possible: investigate whether GPUIX/GPUI, Warren, Blitsen/Blitz, or another suitable engine provides the necessary composition, input and accessibility infrastructure. Do **not** write a new renderer before demonstrating a specific gap. Do not assume an arbitrary Solid DOM component can be automatically translated.

The former Bunly CEF host, its M1–M7 results, and open qualification work remain historical/current implementation evidence, **not** the new architecture. This proposal changes the goal; it does not silently remove existing code, tests, artifact provenance, security gates or qualification obligations.

## First evidence milestones

### 0 — Feasibility gate (smallest runnable spike)

- Confirm exact Bun version and `bun compile` availability on actual target OS/architectures.
- Build a minimal native window with text and a button from a TypeScript entry point under regular Bun.
- Build and run the **same application** with `bun compile`; verify the shipped executable has no JIT, no CEF/WebView dependency, and that the renderer/native addon loads correctly.
- Exercise click, keyboard input, teardown, errors and repeat launches. Keep a runnable reproduction and failure logs.
- If an integration is unsupported, report that explicitly and evaluate an alternative renderer, rather than substituting the old `bun build --compile` path as if it were AOT.

### 1 — Real component compatibility gate

Port five representative components from the actual Adea UI library: a simple button, styled input, menu, dialog and a complex streaming/conversation view. For each, record (a) reused source, (b) adapted source, (c) newly implemented native behavior, and (d) unsupported features. Prioritize typography, focus management, accessibility, IME, keyboard navigation and selection. A near-zero-change import is a hypothesis to test, not a claim.

### 2 — Measured developer and user experience

Compare identical workloads and builds against at least a Bun JIT + native renderer baseline and a representative existing desktop framework. Record startup time, peak/idle RSS, bundle/install size, interactive responsiveness, CPU/GPU under load, reload latency, state preservation, build time and OS-specific behavior. Include unsuccessful runs; do not extrapolate claims from competitors' unrelated benchmarks.

### 3 — Distribution and maintainability

Only after passing the prior gates: package signed/native artifacts across macOS, Windows and Linux; validate updates, crash reporting, security model, accessibility, packaging reproducibility and release evidence. Keep the native framework maintainable for contributors who do not use Rust.

## Decision rule

Proceed with Bun Native as an experimental product direction **now**, but make a full replacement of the existing host contingent on the feasibility and component gates. Continue only if the AOT/native combination is reliable, the compatibility story saves developers meaningful work, and measured size/memory/startup results are competitive. If AOT is blocked, retain the native renderer experiment and record the compiler blocker rather than claiming Bun AOT support.

Do not migrate Adea production, delete Bunly history, rename published packages, or close existing qualification issues as a side effect of this direction document.
