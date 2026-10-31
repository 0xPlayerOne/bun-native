# ADR 0001 — Direct Bun Native desktop framework rewrite

**Status:** Accepted for experimental implementation

**Date:** 2026-10-31

**Related:** [roadmap #1](https://github.com/0xPlayerOne/bun-native/issues/1), [BN0 #217](https://github.com/0xPlayerOne/bun-native/issues/217), [source replacement #251](https://github.com/0xPlayerOne/bun-native/issues/251)

## Context

The former Bunly 0.6.x CEF/WebView application host is a different product architecture. The owner has decided to replace it completely with a browserless native desktop framework built around Bun-authored TypeScript/JavaScript and production machine-code AOT. Retaining compatibility with the old host would create complexity and slow down an entirely experimental rewrite.

## Decision

1. Delete obsolete Bunly/CEF/WebView runtime, tests, workflows, wrappers and package dependencies from the active codebase under BN0. Git history retains old work and attribution.
2. Use Bun for TS/JS application runtime, packages, checker, formatter, tests and AOT production compilation.
3. Build genuine native windows/UI with Rust GPUI as the **first implementation**. An agent may choose a better-supported genuine native renderer with reproducible evidence and an ADR, without owner sign-off.
4. Provide independent SolidJS and React renderers over one typed native host and common components; Solid first.
5. Build for macOS, Windows and Linux with each platform's support evidence. Prefer hosted GitHub runners; use the connected Mac via Remote Desktop Commander when hosted UI tests are insufficient.
6. Keep architecture, memory, responsiveness, startup and executable size optimized by measured checkpoints throughout the roadmap.
7. Let agents complete milestones autonomously. Technical failure becomes a reproduction and engineering fix, not a vote to stop Bun Native or return to CEF.

## Consequences

- The framework may include a trimmed Bun runtime, GC and event loop; it is **not** pure Rust.
- AOT does not compile JSX/CSS/DOM into native UI; custom framework adapters/components are necessary.
- Existing DOM-dependent components may require native ports. Do not promise arbitrary shadcn/Radix/Kobalte/Tailwind compatibility.
- App developers should not write Rust or invoke Cargo on ordinary TS/JS edits; framework builders may use Rust.
- Native binding, platform support, release packaging and high-performance behavior are implementation work, **not accepted facts** until measured.
- This decision authorizes repository-local rewrites, not unrelated Adea production changes.

## Verification

BN0 must demonstrate real window, input/events/teardown and genuine Bun AOT integration; BN1–BN7 provide contracts, adapters, native widgets, tooling, artifacts and real-app acceptance. See [engineering-quality.md](../engineering-quality.md) for the recurring hygiene and optimization audit policy.
