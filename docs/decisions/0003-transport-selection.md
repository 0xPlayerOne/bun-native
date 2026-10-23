# ADR 0003: renderer application RPC transport selection

**Status:** Proposed; decision blocked on paired native CEF evidence.
**Related issues:** #18, #19, #22, #9.
**Decision date:** Not decided.

## Decision

No transport is selected by this increment. Native-mediated messaging remains
the conservative baseline because its native authority and lifecycle path is
simpler. Authenticated loopback is a bounded candidate. Shared memory is rejected
for now and may be reconsidered only if complete-path measurements show a need.

Do not fill in a winner until both candidates run the same committed workload
through actual CEF with native-attested credential/endpoint delivery.

## Candidates

| Candidate              | Hops and ownership                                                                                    | Security/lifecycle surface                                                                        | Current evidence                                                                |
| ---------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Native-mediated        | Renderer ↔ native host ↔ Bun service                                                                  | Native frame attestation and native lifecycle remain on every message path                        | #19 integration pending in this branch; no measurements recorded here           |
| Authenticated loopback | Renderer ↔ Bun loopback for application RPC; native path retained for privileged/lifecycle operations | Exact Host/Origin, one-use bound credential, bounded unauthenticated sockets and ACK backpressure | Real Bun candidate and adversarial tests; no CEF handoff or throttling evidence |
| Shared memory          | Additional mapping/ring ownership and wakeup protocol                                                 | Larger synchronization and stale-generation surface                                               | Not implemented; no demonstrated need                                           |

## Required paired evidence

Use `benchmarks/rpc-transport-comparison.ts` without changing workload values:

- first authenticated handoff latency;
- 100 fixed structured calls at concurrency 16;
- 50 binary calls of 65,536 bytes;
- 20 cancellations after handler admission;
- raw independent trial distributions for each candidate;
- client/server queue byte and frame peaks;
- named serialization and copy stages, including unknown native/browser/kernel
  copies (never label the path zero-copy without complete tracing);
- actual platform idle-wakeup counters. A missing provider, particularly on
  Windows, is `unavailable`, never numeric zero;
- actual CEF renderer throttling, navigation-start revocation, service
  disconnect and server-close observations.

The candidate-only profiler intentionally refuses comparability. Final reduction
must call `assertComparable()` and retain at least five independent trials per
candidate. Do not pair a CEF run with Bun MessageChannel mock observations.

## Result template

| Metric                | Native-mediated raw distribution | Authenticated loopback raw distribution | Notes                               |
| --------------------- | -------------------------------- | --------------------------------------- | ----------------------------------- |
| Handoff latency       | pending                          | pending                                 | same native attestation point       |
| Structured calls      | pending                          | pending                                 | identical payload/count/concurrency |
| Binary bytes          | pending                          | pending                                 | identical bytes/count               |
| Cancellation          | pending                          | pending                                 | cancel only after handler admission |
| Queue peaks           | pending                          | pending                                 | client/server bytes and frames      |
| Complete-path copies  | pending                          | pending                                 | unknown stages remain explicit      |
| Idle wakeups          | pending                          | pending                                 | platform-qualified provider only    |
| Throttled renderer    | pending                          | pending                                 | actual CEF                          |
| Disconnect/revocation | pending                          | pending                                 | actual CEF/navigation hooks         |

## Selection rule

Prefer the simpler native-mediated baseline unless paired evidence shows a
material loopback benefit without weaker authority, lifecycle, CSP, resource or
platform behavior. Throughput alone does not override the security/simplicity
decision. Record rejected alternatives and unsupported paths in the final ADR.
