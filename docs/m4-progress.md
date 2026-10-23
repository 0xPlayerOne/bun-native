# M4 protocol increment

Typed application RPC and per-document capability policy.

**Scope:** #18 portable protocol; #19 host policy and adversarial fixtures.
**Base:** merged `1bb2df5cd2e10076d1a3dac21ca33dc592aa2edf` (PR #64).
**Actions:** Account minutes are exhausted. No Actions retries or workflow changes are part of this increment.

## Delivered

The contracts/client/runtime packages now export shared procedure definitions,
typed client calls, capability-gated server routing, bounded binary framing,
request deadlines/cancellation, a bounded writer, and an acknowledged MessagePort
reference transport. The authority policy uses opaque single-use leases, exact
origins and native-known document/frame metadata; it revokes connections across
navigation and service teardown. Execution reservations remain charged across
connection replacement until old handlers actually settle.

Run `bun scripts/rpc-workbench.ts` for the executable protocol example. The
MessageChannel is real; its view registry is the explicit mock. No native browser
bridge is silently substituted or declared implemented.

## Validation boundary

Local environment: Linux x64, Bun `1.4.3+c6da4a4d3`. Toolchain dependencies come
from the hash-verified offline contributor snapshot retained from PR #63. The new
files and the directly imported contracts/client/runtime entry points, mock and
registry are checked against the merged repository's content identities before
publication. This is scoped local validation, **not a fresh complete checkout's
cross-platform CI result**. Unrelated post-snapshot artifact/native changes are
preserved in the remote base tree and are not overwritten by this change.

- `bun test tests/rpc.test.ts`: 75 test cases pass, including 1,000 deterministic
  malformed-packet inputs, actual MessageChannel transfer/acknowledgement, real
  AbortSignals, injected monotonic deadline tests and reentrant authority changes.
- Final boundary review covers validation overrunning a deadline, reentrant grant
  replacement, and preventing unrelated backing-buffer bytes from crossing ports.
- Strict TypeScript and browser-only typecheck: pass on the local source set.
- Oxlint and AST package/browser boundaries: pass on the local source set.
- Compiler-free SDK builds and the executable RPC workbench: pass locally.

No CEF rendering, native sandbox, macOS/Windows behavior, browser-port teardown,
new benchmark advantage, or production readiness is claimed from these tests.
Existing M1–M3 outstanding criteria remain outstanding; moving independent M4
protocol work forward does not close them.

## Acceptance mapping

| Issue | Implemented here                                                                                                                                                                                       | Still needs integration/evidence                                                                                                                           |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #18   | Versioned envelopes, inferred routes, independent parsers, sanitized errors, monotonic IDs, binary bodies, cancellation/deadlines, disconnect/reload behavior and bounded admission/delivery/execution | Native renderer integration and platform execution are deliberately separate; the portable implementation is covered by local tests.                       |
| #19   | Host-side lease checks, native-known identity contract, no frontend authority fields, revocation and reconnect-safe budgets                                                                            | Actual native frame attestation/injection, remote-page attempts in CEF, navigation-start hooks, and loopback authentication if that transport is selected. |
| #22   | Acknowledged bounded MessagePort reference plus opt-in authenticated Bun loopback candidate, adversarial real-socket tests, candidate profiler and incomplete ADR template                             | #19 native-private handoff/CSP integration, paired native-mediated CEF trials, throttling/disconnect/platform wakeup evidence and final selection.         |

See [application RPC](rpc.md) for APIs, serialization limits, timing rules,
capacity behavior and the native integration contract. PR closure should not be
used to imply that #19, M4, or the earlier milestones are fully complete.
