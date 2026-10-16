# Bunly

The Bun-native desktop framework.

**Status: experimental planning. Runtime implementation has not started.**

Bunly is exploring a standalone desktop runtime with a TypeScript-first application model, prebuilt native components, and managed backend reloads that preserve explicitly owned windows, browser sessions, and terminals.

CEF is the first browser backend. System-webview adapters and CEF-free Adea qualification are later work, not prerequisites for the initial MVP. Performance and size improvements are hypotheses to validate, not current product claims.

## Implementation roadmap

The [roadmap issue](https://github.com/0xPlayerOne/bunly/issues/1) is the implementation index and source of truth for scope, dependencies, acceptance criteria, and decision points.

- [Milestones](https://github.com/0xPlayerOne/bunly/milestones): M1-M9 cover the CEF MVP; M10-M12 cover system webviews and Adea qualification.
- [Issues](https://github.com/0xPlayerOne/bunly/issues): the initial plan contains 58 implementation tasks plus the roadmap issue.

Start with [product scope](https://github.com/0xPlayerOne/bunly/issues/2), [repository scaffolding](https://github.com/0xPlayerOne/bunly/issues/3), and [upstream provenance](https://github.com/0xPlayerOne/bunly/issues/4) in parallel. [Host qualification](https://github.com/0xPlayerOne/bunly/issues/5) and reproducible benchmarks establish whether the proposed architecture is worth expanding.

## Principles

Application developers use real Bun TypeScript without compiling the native framework. Browser-specific details stay behind capability-based contracts. Security, accessibility, reliable cleanup, and complete output remain requirements when comparing performance.

The native implementation language is an engineering decision to qualify. Selective upstream code reuse must preserve its provenance and applicable notices. This project is not a Tauri plugin, a Bun fork, or a commitment to complete Electron compatibility.
