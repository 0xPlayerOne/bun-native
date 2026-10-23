# Authenticated loopback RPC candidate

An opt-in Bun WebSocket candidate for M4 transport comparison.

**Status:** Implemented and locally testable as a candidate. It is not selected,
enabled by default, or integrated with CEF. The native-mediated path remains the
baseline until equivalent #19 integration and measurements support a decision.

## Security boundary

`RpcLoopbackServer` binds only `127.0.0.1` with `Bun.serve({ port: 0 })`, so the
operating system selects an ephemeral port atomically. There is no pre-probe,
random-port retry loop, or free-port race.

The HTTP upgrade requires the exact `Host` for that listener, the exact approved
document `Origin`, the fixed `/.bunly/rpc/v1` path, and no query or fragment.
There are no wildcard origins. A 256-bit credential is the first binary message,
never a URL, query parameter, cookie, subprotocol, error, diagnostic, or log
field. Credentials expire, are single-use, and are scoped to one listener.

The trusted native integration calls `bindRpcAuthority(lease, session)` only
after attesting the main view/frame/document. Binding resolves the session that
owns the exact opaque view through the backend registry and requires object
identity with the supplied opaque handle; copied, foreign, stale, or wrong
sessions fail before a credential exists. `provision()` accepts only the opaque
binding, never a page/session-shaped value. The server record therefore binds
the credential to the authority identity's view, frame, document, origin and
generation plus the opaque session identity. Page-provided IDs do not authorize
anything. Authentication consumes the binding into the existing `RpcLease`; an
object with matching string fields cannot substitute for it.

This is a bearer credential whose isolation depends on private native delivery
to the attested document. The future #19 bridge must not place it in a normal
page global, DOM, storage, URL, console, public `window` message, or remote-debug
surface. Revocation is registered before the application `RpcServer` and closes
the credential or socket on navigation start, frame replacement, service
disconnect, view closure, or authority teardown. Native lifecycle and privileged
operations remain on the native-authority path; loopback carries application RPC
only.

## Bounds and backpressure

The candidate uses binary WebSocket records around the existing BLRP packets.
It never represents bytes as JSON number arrays. Authentication sockets,
credentials, message bytes, aggregate retained bytes, total
active/authenticating/closing sockets, Bun WebSocket backpressure, active RPC handlers,
sender queue bytes/frames, authentication time, credential lifetime and drain
time are all bounded. Each direction permits one adapter packet in flight and
requires an exact sequence acknowledgement. There is no reconnect, retry,
replay, polling loop, or hidden per-view process.

`diagnostics()` counts upgrade reservations as unauthenticated sockets and keeps
closing sockets plus retained bytes charged until Bun's close callback. It also
exposes authentication, credential, timer, listener, queue and peak queue counts.
`sendBinary()` status `-1` remains accepted and charged while backpressured, `0`
is a dropped send that closes the connection, and positive values are sent bytes.
A cancellation or disconnect aborts the handler but
retains its shared `RpcViewAuthority` execution reservation until the handler
actually settles.

## CSP requirement

The exact selected endpoint must be added only to the native-attested application
document's `connect-src`, for example:

```text
connect-src 'self' ws://127.0.0.1:54321
```

The port is illustrative and must come from the private handoff. Do not add
`ws:`, `ws://127.0.0.1:*`, `connect-src *`, or a global development exception.
The native packaged-origin response must synthesize the exact per-launch policy
for the attested main document and revoke it with that document. Remote pages and
unattested frames receive no credential and no CSP grant. The current repository
does not yet modify CEF CSP; that remains an explicit #19 integration gate.

## Reproduction and comparison boundary

```sh
bun test tests/rpc-loopback.test.ts
bun run profile:rpc-loopback --output .bunly/profiles/rpc-loopback.json --samples 9 --warmups 1
```

The profile records raw independent trials for fixed structured, binary and
cancellation workloads, queue peaks, source hashes and explicit copy stages.
It emits `comparable: false` and `winner: null`. It collects no invented idle
wakeups. Windows wakeups remain unavailable, not zero.

The same workload must run through the actual native-mediated CEF path after #19
integration. A final comparison additionally requires actual renderer throttling,
navigation/disconnect behavior and platform-qualified idle instrumentation.
MessageChannel tests and this loopback-only Bun run do not substitute for CEF.
The separate unresolved CEF teardown issue #92 is unchanged by this candidate and
must not be inferred fixed from loopback server cleanup tests.

## Transport allocation boundary

Each upgraded, unauthenticated, authenticated or closing socket reserves its
maximum fragmented inbound record size before upgrade. A separate global
`maxReceiveBytes` ceiling bounds this worst-case reassembly allowance; the
`maxRetainedBytes` ceiling bounds outbound records retained for ACK/drain/close.
Both default to 32 MiB and remain charged until their respective release point.
These are protocol payload reservations, not a claim that kernel buffers, TLS
implementation allocations or all Bun/WebSocket metadata are measured heap bytes.
Closing sockets reject all further input and retain reservations until the actual
close callback. An owned socket that does not finish the close handshake is
terminated after the bounded, explicit close timeout (one timer, no polling).
