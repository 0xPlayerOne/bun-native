# ADR 0003: renderer application RPC transport selection

Native-mediated messaging is the qualified baseline; loopback remains experimental.

**Status:** Native baseline selected; comparative performance acceptance remains incomplete.
**Related issues:** #18, #19, #22, #9.
**Decision date:** October 23, 2026.

## Decision

Keep native-mediated CEF messaging as the application RPC baseline. It executes
with the native-known view/frame/session/document/generation authority and the
unchanged restrictive application origin policy. Add bounded adapter fragmentation
so the agreed 65,536-byte binary workload fits without raising the 24 KiB CEF
packet or 64 KiB private control-pipe record limits.

Do **not** select the direct loopback candidate on the pinned CEF runtime. Actual
CEF execution rejects the connection at Chromium's loopback-network permission
boundary before the Bun server receives an upgrade. A failed candidate cannot be
assigned a latency, throughput or relative-speed result. No benchmark win is
inferred, and the requested paired performance comparison remains incomplete.

A safe baseline decision does not require weakening security to manufacture a
passing alternative. Reconsider loopback only after its app-scheme connectivity
and exact native owner authentication both pass real-browser qualification under
an explicit supported permission model. Shared memory is not justified by these
observations and remains unimplemented.

## Native baseline

The #18 envelope remains transport-independent. Native packets are at most 24 KiB;
application frames may be at most 96 KiB. The adapter splits larger frames into
versioned, sequenced fragments. It validates lengths/offsets before allocation,
permits only one in-flight envelope per direction, keeps a hard aggregate 3 MiB
backend reassembly/copy budget across connections, and expires partial messages
without extending the deadline as fragments arrive. Renderer-owned allocations
are bounded independently. Existing native delivery reservations remain charged
until their real receipt or host teardown.

Cancellation drops the adapter's full-envelope copy even when a lower-layer
send is stalled; that lower layer owns only its independently bounded chunk.
Reentrant delivery keeps the inbound reservation until the receiver returns.
Native process-message and pipe copies still exist. This is not zero-copy.

## Experimental loopback authentication

The candidate has an explicit native handoff: a one-use binary credential and
exact numeric-loopback endpoint travel through the existing incarnation-bound
native bridge, never a URL, log or page storage. The server then sends a fresh
socket challenge. The same native connection must confirm it using its opaque
backend binding before the server claims a lease or admits application RPC.
A stolen bearer credential plus a matching Origin is not sufficient.

Real Bun-socket tests prove the protocol model, and native-peer tests prove
adapter plumbing. They do **not** establish successful CEF authentication.
The exact same-origin stolen-credential native fixture is implemented but remains
unreached when Chromium rejects the initial socket. It is not a passing CEF test.

The CEF candidate configuration is contributor-only. Ordinary native builds reject
`rpc.loopback.configure`; they never open this endpoint through the CEF API or
broaden application CSP. Generic standalone loopback transport remains the
explicit opt-in candidate delivered earlier, not the selected application path.

## Actual failure and rejected experiment

The real browser emitted `policy.permission-denied` with mask `134217728`, the
pinned CEF `LOOPBACK_NETWORK` flag. Safe bounded server diagnostics showed no
upgrade or native confirmation. The denial is before WebSocket authentication,
not evidence that native accepted a forged connection.

The inspected Chromium 154 source registers this permission as
`TOP_ORIGIN_ONLY_SCOPE`. It is not a frame-specific grant. A separate experiment
attempted to set only the exact application origin in its private ephemeral CEF
request context, with no default or foreign-origin grant. Exact readback did not
confirm the requested permission, so the host failed closed. Inspection of the
pinned content-settings pattern code shows that the arbitrary `app` scheme is
not accepted by the relevant pattern validation. This experiment was removed;
its source and failed report are retained privately.

No blanket origin/default permission, generic prompt exemption, custom-scheme
security reclassification, Chromium flag, trust-store change or sandbox change
was retained. The generic CEF permission callback still cannot identify the
requesting frame and remains denied. A focus heuristic or page-reported frame
identity would not repair that boundary.

Primary source references for the exact inspected browser branch:

- `components/content_settings/core/browser/content_settings_registry.cc`
  and `host_content_settings_map.cc` at Chromium `154.0.8037.98`.
- `components/content_settings/core/common/content_settings_pattern.cc` at the
  same tag, including `FromURLNoWildcard` and `Builder::Validate`.
- CEF `libcef/browser/request_context_impl.cc`, `setting_helper.cc`, and installed
  `include/cef_request_context.h` from the pinned CEF 8037 distribution.

No upstream implementation code was copied.

## Maintained native workload

```sh
# Selected native baseline, one functional execution:
bun run qualify:cef-transports -- /path/to/prepared-app --native-only --functional

# Native baseline distributions; clean committed source is mandatory:
bun run qualify:cef-transports -- /path/to/prepared-app --native-only --samples 5 --warmups 1

# Explicit investigation of BOTH candidates; currently fails closed on loopback:
bun run qualify:cef-transports -- /path/to/prepared-app --functional
```

The workload preserves 100 structured calls at concurrency 16, 50 binary calls of
65,536 bytes, and 20 cancellations after backend admission. It also requires
20 calls while the actual renderer runs at a fixed 4x Chromium CPU-throttle rate,
positive native completion for both applying and restoring the rate, in-flight
navigation revocation, return-to-origin denial, service disconnect, and resources
returning to baseline. The contributor throttle accepts only the named packaged
fixture and rates 1 or 4. It opens no debugging endpoint or arbitrary evaluation
surface. Both pending registrations and delayed deadline tasks are bounded.

Idle observations span two seconds with one admitted control waiter present in
both candidates; there is no application polling. Kernel providers retain their
own semantics and count only adjacent matching process/task identities. Missing
providers or samples, particularly Windows ETW, remain unavailable rather than
zero. Native/CEF/Bun/kernel copy stages not directly measured remain unknown.

## Acceptance boundary

Only complete native launches with the exact workload record and ordered clean
teardown contribute measurements. Failed attempts remain in the report. Raw
native data is not paired with a Bun MessageChannel substitute. `assertComparable`
requires both candidate identities, at least five unique matching trial indices,
valid distributions and bounded queue data; duplicates and fabricated zeros
cannot repair missing execution.

The native baseline is a functional/security selection, not a measured performance
victory over loopback. Issue #22 still retains its unexecuted paired and platform
comparison criteria. Broader M4 session clearing/persistent credentials and the
historical intermittent teardown investigation remain separate work.
