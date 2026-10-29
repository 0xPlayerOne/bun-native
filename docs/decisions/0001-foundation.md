# ADR 0001: standalone Bun foundation

Preserve the intended product path without a Tauri-specific detour.

**Status:** Accepted for M1; native production host decision remains conditional.
**Related issues:** #2, #3, #5, #6, #7.

## Decisions

Use one Bun monorepo, strict TypeScript, one Bun lockfile, and prebuilt native
artifacts for consumers. Keep the native probe independent of CEF. Adopt a narrow
browser-independent contract with a fake implementation and explicit capabilities.
Use notification-driven bounded native queues in the probe, not a periodic GUI
pump. Test Bun FFI, Node-API, and the process fallback before choosing a native
integration for M3.

Pin Bun (version redacted), TypeScript 7.0.2, and Rust 1.85.1 for this foundation. Rust is a
conservative fixture toolchain pin, not a claim that it is the latest release or
a product requirement. Oxlint handles linting; no ESLint, custom package manager,
or fleet-wide tooling migration is introduced. The built-in Bun checker is not
made authoritative without qualification; it is separate from the runtime choice.

## Alternatives

A Tauri plugin adds a host-specific layer we do not need. A wholesale competitor
fork inherits application/tooling choices before our lifetime model is proved.
Embedding undocumented Bun internals couples the project to unsupported APIs.
A rewritten browser engine or Bun fork would overwhelm the experiment. These
alternatives are not selected.

## Acceptance boundary

M1 must produce executable contracts, native experiments, actual native matrix
artifacts, import-boundary checks, and installer verification tests. A green mock
suite is not a green native suite. A green native ABI probe is not a working CEF
application. Consumer builds must never fall back to a systems compiler silently.

The architecture does not hard-code Bun.ModuleGraph or presume that Worker
termination preserves resources. Later reload qualification may use documented
experimental APIs only with recorded behavior and a controlled fallback.

## Consequences

A prebuilt core cannot be optimized away per application as finely as an
application-specific whole-program native build. Start small and select substantial
optional modules rather than shipping every feature. Full Bun and CEF payloads
remain package floors. Avoid promising Rust-only binary sizes or rendering
speedups merely from changing the native implementation language.
