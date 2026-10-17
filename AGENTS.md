# Bunly implementation rules

Read README, docs/architecture.md, and the relevant issue before implementation.
Use real Bun and strict TypeScript. Application builds must not silently compile
native code. M1's mock and native probes are not a working CEF runtime.

Keep contracts/client browser-safe; run the browser-only typecheck and AST
boundary tests. IDs are not authority. Native identity and generation must be
validated at every future IPC boundary. Retain lifecycle and cancellation tests.

Commands: `bun install --frozen-lockfile`, `bun run check`,
`bun run typecheck:browser`, `bun run native:test`, `bun run native:build`,
`bun run qualify:host`, `bun run artifact:probe`.

Use a feature branch, link actual validation, and leave incomplete issue criteria
open. Do not invent platform tests or benchmark wins. Record unsupported paths
explicitly; do not pass no-op tests for missing browser capabilities.

Do not add a Tauri integration, Bun fork, custom package manager, hidden CEF
fallback, or per-service process fan-out without an evidence-backed decision.
Preserve upstream notices and update provenance when code is copied. Never
publish packages, change repository visibility, or alter Adea production as a
side effect of completing a framework issue.
