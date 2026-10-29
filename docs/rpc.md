# Application RPC

Typed, bounded application requests with host-owned document authority.

**Status:** M4 portable implementation for #18 with the first native CEF authority increment for #19.
**Native integration:** CEF uses process messages and an exact-context V8 bridge. No loopback listener or debugging endpoint is enabled.
The authenticated loopback candidate remains opt-in; no listener starts unless its
runtime class is explicitly constructed. See [loopback RPC](rpc-loopback.md).

## Run the example

```sh
bun test tests/rpc.test.ts
bun run typecheck:browser
bun scripts/rpc-workbench.ts
```

The executable example uses an actual MessageChannel and the explicit MockBackend
for view policy. It exchanges typed JSON and binary requests, revokes the channel
on same-origin navigation, and verifies that the window remains alive. It is not
a native browser demonstration or a transport performance benchmark.

## One contract, separate application handlers

```ts
import { defineRpc, procedure } from '@bunly/contracts';

const string = (value: unknown): string => {
  if (typeof value !== 'string') throw new TypeError('Expected a string');
  return value;
};

export const api = defineRpc({ greet: procedure(string, string) });
```

A client calls `client.call('greet', 'Bunly', { signal, timeoutMs: 1000 })` and
receives `Promise<string>`. The server supplies handlers separately, each with an
explicit capability name. This prevents importing server implementations into a
browser bundle. Client parsing is convenience, not security: the server checks
authority, independently parses input, and validates output before responding.
Output validation also runs on the client. Parsers are synchronous, trusted code;
they may throw but must not perform unbounded work or return promises.
Starting another call on the same client synchronously while a request is being
prepared and enqueued (including from a parser, serialization, or injected
scheduler) is rejected with `OVERLOADED`; schedule it after the current call has
returned instead. This keeps request IDs in delivery order and preserves the
pending-call limit.

Application and parser exception text is never sent to a renderer. Wire errors
contain a known code and bounded generic message, without stack traces, private
paths, or payload dumps. There is no automatic reconnect or retry of a request.

## Serialization and versioning

Application RPC is distinct from the existing native-owner control pipe and from
future bulk streams. An adapter delivers exactly one Uint8Array packet per message.
A pipe/socket adapter must assemble complete packets with bounded framing first;
it must not hand arbitrary read chunks directly to the decoder.

Packets contain a 12-byte big-endian prefix: `BLRP` magic, metadata length, and
binary-body length. Strict UTF-8 JSON metadata carries protocol version 1, a
positive safe-integer request ID, message type, and exactly the fields allowed for
that type. Extra authority-looking fields such as `viewId` are rejected. Wrong
versions fail explicitly rather than attempting an implicit compatibility fallback.

Payloads are either JSON data or a **top-level Uint8Array**. Bytes are transmitted
as a separate body, never a base64 string or JSON number array. Sliced buffers are
copied into the packet; incoming binary bodies are isolated from adapter mutation.
Nested typed arrays, SharedArrayBuffer, undefined, BigInt, non-finite numbers,
negative zero, cycles, sparse arrays, accessors, class instances and dangerous
prototype keys are rejected. Use `null`, not `undefined`, for a no-value response.
Objects with non-enumerable data or symbol properties are rejected rather than
silently losing them. JSON depth and node counts are bounded as well as byte size.
Application procedure/schema evolution remains an explicit application API change;
protocol version 1 is not a promise that incompatible schemas are equivalent.

## Budgets and overload behavior

| Resource                                             |                 Default |
| ---------------------------------------------------- | ----------------------: |
| Complete packet                                      |                   1 MiB |
| JSON metadata                                        |                  64 KiB |
| Client outstanding requests per connection           |                      64 |
| Serialized sender queue, including in-flight bytes   |     2 MiB / 128 packets |
| Active handler invocations per server                |                      64 |
| Host-authority active invocations across generations | 128 total / 64 per view |
| Default call deadline / maximum accepted duration    | 10 seconds / 60 seconds |
| In-flight transport drain deadline                   |               5 seconds |

All options are checked against hard ceilings. Limits are application-layer
budgets, not a claim that total browser/OS memory is capped by these values.
The sender snapshots queued packets and counts them until the adapter drains.
Cancelling an unsent request removes its queued packet; cancelling an in-flight
send does not release its byte budget prematurely. Queue exhaustion rejects local
admission. Failure to deliver a response or cancellation closes the connection
and settles all waiters rather than silently dropping essential control records.

A cancelled or timed-out handler keeps its execution reservation until it settles.
This is also enforced by the authority manager across disconnect/reconnect and
service generations: replacing a connection does not erase the budget consumed
by its old handlers. A new transport cannot accumulate unlimited aborted-but-
running work. Trusted handlers should still cooperate with AbortSignal; this is
not preemption of synchronous loops or rollback of external effects.

## Deadline and lifecycle semantics

Client deadlines use monotonic time starting at admission, including validation,
queueing and reply delivery. The request sends a duration, not a wall-clock time.
The receiver separately bounds its processing time from receipt. The client is
the authority on its end-to-end deadline, so network delay is not mistaken for a
shared clock. Expiry is rechecked before transmission, before/after result parsing,
and on reply receipt; delayed timer callbacks cannot convert late work to success.

| Event                                                          | Behavior                                                                                |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Cancellation or client deadline                                | Reject locally, withdraw unsent work, otherwise enqueue cancellation without retry.     |
| Server deadline                                                | Abort the handler signal and send one deadline error; ignore a late result.             |
| Duplicate/late reply for an issued ID                          | Ignore; IDs are never reused and no unbounded tombstone set is retained.                |
| Future unsolicited reply or replayed request                   | Close the connection as a protocol failure.                                             |
| Navigation, frame replacement, view close or service teardown  | Revoke authority, abort active work, close its connection, settle pending client calls. |
| Disconnect, write failure, missing acknowledgement or shutdown | Close locally, reject pending requests, release queued packets/listeners/timers.        |

Transport closure is reported as DISCONNECTED to the opposite endpoint; the
host's `server.closed` retains REVOKED for an authority revocation. Queued results
are re-authorized before sending. An expired result that can no longer be safely
delivered terminates the channel. Cleanup/closed promises resolve with a reason,
rather than creating an unhandled rejected promise when nobody is awaiting close.

Cancellation cannot prove that a side effect did not happen. Applications must
explicitly design idempotency or confirmation for operations that need it.

## Native authority integration contract

`RpcViewAuthority` lives only in the runtime package. It validates an opaque
backend view handle, approved exact origin, current document identity and an
explicit main-frame descriptor. The backend also resolves the exact opaque
session that owns the view; loopback binding compares that registry-owned handle
by identity, so a shaped, copied, foreign, or wrong session cannot authorize a
credential. It issues an opaque single-use lease. Copying
that object, serializing its ID, or using another registry's view does not produce
a valid lease. Capabilities are copied, not inherited from frontend descriptors.

**This policy object is not a renderer authenticator.** The trusted adapter must
obtain the frame identity from the native browser and privately bind the endpoint
before constructing RpcServer. TypeScript annotations and caller-provided strings
are not evidence of that binding. Specifically, the adapter must:

1. Attest the native view/frame and document; only an approved main frame receives
   this initial profile. Do not forward page-supplied metadata into `issue()`.
2. Revoke synchronously on navigation-start, redirect/frame replacement, close,
   backend failure and service teardown. Do not wait for the next origin to finish
   loading. Backend navigated/disposed events provide an additional policy hook.
3. Bind any direct-transport credential to the opaque session returned for the
   attested view. Never accept a page-supplied session ID or object shape.
4. Transfer the endpoint only to that attested context. A MessagePort holder is
   the endpoint, not proof of native origin. Do not expose a reusable port through
   page globals, public window messages, URLs or logs.
5. Establish a new lease explicitly after a permitted replacement. Returning to
   an old origin must not restore a revoked application trust grant implicitly.
6. Keep one persistent authority manager per host/application so retiring
   connections and views cannot evade execution budgets.

The CEF adapter carries the explicit `ViewTrust` grant in `view.create`; the
browser process creates the document identity and binds a one-shot connection to
the callback-provided browser, main frame, exact packaged `app:` origin and a
renderer-native context serial. It injects `__bunlyRpc.send(ArrayBuffer, acknowledged)`,
`subscribe(callback)` and connection-local `close()` after the approved main-frame
context exists. The page cannot submit a view, frame,
document, generation, origin, capability or native control operation. Every
packet is rechecked against current CEF objects. Both the entered (bottom) and
current (top) V8 contexts must match the captured context. Direct same-origin
iframe borrowing is an executable native qualification case, not an inference
from origin checking.

The first supervised #19 trial failed this assertion, without recording whether
the JS call returned normally or threw an unrelated error. A subsequent C ABI
regression reproduced an exception-output bug: assigning a new Rust `CefString`
replaced only the local borrowed wrapper. The callback now uses the pinned
`try_set()` API to write CEF's exception slot. CEF throws only for a nonempty slot;
therefore a normal JS return was **not** evidence of native acceptance. The exact
denial assertion remains required. The resumed real-CEF run observed the exact
child-context rejection and the expected JavaScript exception; later lifecycle
failures and their independent fixes are retained in the M4 evidence.

A separate `rpc-context-diagnostics` contributor feature records at most 32 native
callback observations per renderer, each at most 2048 bytes. It records native
current/entered/bound frame provenance, equality checks, the native decision and
whether the exception slot was written. It logs no packet, URL, connection token,
generation credential or pointer. The external child fixture separately records
its exact bounded JS outcome before the unchanged assertion. Normal builds exclude
the native diagnostic code. These diagnostics are evidence, never authorization.

In [pinned CEF 8037](https://github.com/chromiumembedded/cef/blob/14c5a089e8452874cb1a556dc3fde26ed2d87723/libcef/renderer/v8_impl.cc),
`GetEnteredContext()` delegates to V8's entered-or-microtask context getter. This
must not be described as a universal invoking-frame identity or used to promise
isolation from same-origin parent-world scripting. The diagnostic native run must
establish the specific direct-borrow case; if it cannot, untrusted frames require
supported sandbox/separate-origin isolation, not creation-context-only authority.

The bridge is in the trusted document's main world. This does **not** isolate
main-world XSS or a same-origin script that can modify the parent, inject a script
there, or arrange for parent-world code to invoke the bridge. Same-origin scripting
is a shared trust boundary. Untrusted content must not share the privileged
application origin or script environment. Child, remote, opaque and development
HTTP contexts receive no bridge by default.

Packets are copied from V8 immediately, copied into CEF binary process messages,
and hex-encoded only across the existing private native/Bun inherited pipe. That
profile is deliberately narrower than the portable envelope: 24 KiB per packet,
one unacknowledged packet per connection in each direction, 128 live views,
and 128 / 3 MiB global native delivery reservations (including revoked deliveries).
The inherited pipe retains its existing 256-frame process queue and 64 KiB line
bound. Incoming byte reservations survive until Bun dispatch acknowledgement;
outgoing reservations survive until an exact native delivery/discard acknowledgement.
Revocation settles callers immediately but does not recycle CEF-owned delivery
bytes. A destroyed renderer that cannot acknowledge may leave a bounded reservation
until host teardown; exhaustion refuses further deliveries instead of guessing
that buffers were released. Copy accounting counts actual packet byte lengths;
this is a copied transport, not a zero-copy claim.
There is no socket, URL credential, public token, `postMessage` protocol or debug
listener. The M3 private native control pipe remains unavailable to pages.

The renderer allocates a checked monotonic context serial in native code. READY
names that incarnation; GRANT echoes it with the browser-owned connection and
document generation. The browser emits `rpc.connected` only after an exact
SUBSCRIBED acknowledgement, so no RpcServer response can precede listener
registration. Every packet, ACK, result, revoke and release carries the same
private tuple. All numeric metadata is type-, finite-, integer- and safe-range-
checked before conversion. An ungranted context can release only its matching
pending serial; an old release cannot remove a new binding. Duplicate readiness
and subscription messages do not reissue grants.

`waitForCefRpcTransport(timeoutMs, signal)` installs one event listener and one
deadline timer, then checks for an already-present bridge. Native emits a fixed
no-payload `bunly:rpc-ready` event after installation, outside registry borrows.
Forging this event only wakes the inspection; it does not issue native authority.
Success, abort and timeout remove both registrations. Native functions capture
the complete binding, revalidate snapshots before mutation, and settle pending
send callbacks on revoke/close. Results require a consuming listener; discards
release transport reservations without reporting successful delivery.

Context release, navigation start/redirect, renderer failure, close and host
teardown revoke before further dispatch. Returning to the old URL cannot restore
the one-shot eligibility bit. Initial load completion for the same document does
not revoke a lease established during the context handshake. One authority manager
is allowed for the lifetime of each CefBackend; stopping it cannot reset execution
budgets through a second registration.

The maintained real-browser command is:

```sh
bun run qualify:cef-rpc -- /path/to/prepared/native/app
```

Build the contributor fixture with `packaging,rpc-qualification`; ordinary builds
exclude the native injection probes. It runs the prepared application through the
existing prebuilt qualification, preserving the baseline 20-cycle smoke and clean
shutdown criteria. Exact schema-4 RPC evidence must include typed JSON and binary
roundtrips, independent backend input rejection, backend-started-and-aborted
cancellation, bounded final native resources, an external-CSP-compliant
hostile child script, two navigation/close-in-flight cycles, return-to-origin and
explicit-remote denial, and native protocol rejection cases. The compile-time
probes send wrong context/connection/generation/frame and invalid sequence messages
through real CEF messaging, and send stale grants/ACKs/revokes/results to the renderer.
The contributor host also replays the actual previous binding after a replacement
context announces readiness; the return-to-origin page must remain unprivileged.
They expose no page-callable test controls or debug listener. The qualifier rejects
old smoke markers, missing cases and stale successes. Pure Rust/portable fixtures
also test bounds, replay and timer cleanup; those are not native execution proof.
A documentation-feature Rust build is not a native launch;
report the prepared-app command separately. Cross-platform release qualification,
performance selection (#22), remaining session capabilities, and CEF teardown issue #92
remain separate.

The authenticated loopback candidate from #94 now has a native-private
credential/CSP handoff and a contributor-only paired CEF qualifier. The selected
application baseline remains native-mediated; see ADR 0003 for evidence and limits.

## MessagePort reference transport

`rpcMessagePort()` uses transferable owned packets, a monotonically ordered
transport sequence, and one packet in flight per direction. Its send promise
resolves only when the receiver acknowledges receipt/dispatch. An acknowledgement
is **not** completion of the application operation. The shared writer supplies
a drain watchdog and a bounded queue; `postMessage()` alone is not backpressure.
Explicit close records notify the peer. Bun also emits port-close events; browser
peers that disappear without notification are bounded by call/drain deadlines.

Adapters must not allocate unbounded hidden queues beneath this contract. The
current reference adapter has been exercised in Bun on Linux, not in native CEF
or across all browser engines. It is not yet the chosen CEF production transport.
No polling interval, dependency, native compilation, network listener, background
service, or public package publication is introduced by this implementation.

## Independent view teardown and queued handshakes

`view.dispose` removes only its own embedded BrowserView and releases its native
owner outside registry borrows. The default Alloy `CloseBrowser` path instead
closes the containing widget; using it for an individual child closed its siblings.
If the parent window is already closing, the child remains attached until widget
teardown supplies its destruction callback. Detaching after `TryCloseBrowser` has
accepted the parent close prevents that callback and leaves a request pending.
The native fixture exercises both independent child disposal and 20 concurrent
parent-close/child-dispose cycles without shortening the original workload.

The pinned CEF implementation documents these distinct paths in
[BrowserView destruction](https://github.com/chromiumembedded/cef/blob/14c5a089e8452874cb1a556dc3fde26ed2d87723/libcef/browser/views/browser_view_impl.cc),
[Views host closure](https://github.com/chromiumembedded/cef/blob/14c5a089e8452874cb1a556dc3fde26ed2d87723/libcef/browser/views/browser_platform_delegate_views.cc),
and [Alloy destruction states](https://github.com/chromiumembedded/cef/blob/14c5a089e8452874cb1a556dc3fde26ed2d87723/libcef/browser/alloy/alloy_browser_host_impl.cc).

Bun also marks a view's RPC eligibility permanently retired before sending a
navigation or disposal command. An authentic handshake already queued by native
code cannot create another lease after that local transition. Its exact native
incarnation is disconnected without failing the entire host. Host shutdown ignores
late handshakes while its existing revocation path completes. Deterministic tests
cover navigation, child close, parent close and host shutdown; copied/invalid live
authority metadata still fails closed.

Automatic CEF qualification builds compile the `rpc-qualification` probes and run
the `rpc` suite on Linux, Windows and macOS. This suite retains the entire prebuilt
matrix and requires exact adversarial RPC evidence. Ordinary runtime builds and
manual smoke/full builds do not enable contributor injection probes. These test
artifacts are not production release artifacts. Native issue #92 and the remaining
session/transport-selection acceptance criteria remain independent.

## Probe completion and session integration

The explicit RPC qualifier sets the fixture-only `BUNLY_RPC_QUALIFICATION=1`
requirement. It cannot enable native probes in an ordinary artifact; the host must
already have been built with `rpc-qualification`. Ordinary smoke/full fixtures
still exercise RPC, independent view disposal and session ownership, but they do
not wait for excluded contributor probes or claim adversarial qualification.

The hostile iframe remains alive until its owner document is disposed. Its JS
`onload` and exact borrowed-function rejection are not acknowledgements of CEF
process-message delivery. A bounded backend barrier waits for all eleven native
rejection cases before retiring any view. It registers before creation, accepts
only native `rpc.qualification` events, and releases its single listener/deadline
on completion, failure or cancellation. Missing `wrong-frame` evidence still fails;
no sleep, retry, relaxed acceptance set or deadline extension replaces the receipt.

Schema 4 additionally requires `native-owner-isolation-and-partition-reuse` session
evidence. The real-browser fixture starts RPC in shared and independent ephemeral
sessions, checks the handler's native-bound view identity, proves same-URL cookie
separation, rejects disposal while referenced, and verifies cancellation when the
owning views close. Recreating the same partition yields a new opaque session with
an empty cookie store; the old handle fails. A remote replacement view receives no
bridge, while a separately created explicitly trusted view obtains a distinct
binding. The original sibling remains live and its session resources converge.
These checks do not claim secure persistent credentials or complete HTML5 clearing.

Each accepted launch also requires the maintained ordered shutdown-phase parser.
On macOS, every cleanup observation is validated and any actual failure rejects
the launch. Exact helper/clone completion must be qualified within the same fixed
suite, with per-launch sampling gaps reported separately rather than labeled
qualified. A suite containing no qualified cleanup observation fails.
The wrapper prints its final `native-rpc` success only after every positive launch
passes the stronger checks; the inner prebuilt success alone is insufficient.

## Selected native transport and experimental loopback

The CEF application baseline remains native-mediated messaging. Application RPC
frames are bounded at 96 KiB and fragmented over unchanged 24 KiB native packets;
the backend shares a 3 MiB fragment reservation budget across connections.
Cancellations and partial-message deadlines release owned reassembly buffers;
existing CEF delivery reservations remain independently charged until actual
receipt. This is not a streaming or zero-copy API.

`serveLoopbackRpc` and `waitForCefLoopbackTransport` are internal experimental
contributor integrations, not supported CEF application transports. Ordinary
native builds reject their configuration. They implement an additional socket
challenge confirmed through the exact native binding. The contributor qualifier
adds a separate, explicitly recorded top-origin network-reachability decision for
its fixed packaged fixture, local-only ephemeral context, and configured numeric
CSP endpoint. This is not requesting-frame permission or a production browser
permission API. Same-origin children receive no native RPC binding, and a second
valid main frame cannot confirm another document's stolen socket credential.

The original no-grant control fails before WebSocket upgrade and remains recorded.
The paired fixture does not change global content settings, disable browser
security, or grant another permission type. Ordinary builds reject loopback setup;
normal application startup opens no listener. The native bridge remains active for
revocation throughout a loopback connection. See
[ADR 0003](decisions/0003-transport-selection.md) for the selected baseline,
maintained profiling commands and comparative qualification boundaries.

## Bounded whole-run qualification receipts

Process observation retains native qualification events separately from the last
20 stderr lines. The exact shared event-name allowlist excludes arbitrary page
payloads and transport credentials. Retention is capped at 128 records, 16 KiB per
record and 64 KiB in total, inside the existing 2 MiB output bound. Exhaustion
fails the observation; it never evicts a prior failure or deduplicates repeated
receipts. New observations use this complete retained stream for native event and
ordered shutdown acceptance. Legacy reports without the field continue to use
their historical tails, so missing old evidence remains missing. An empty retained
stream cannot be repaired by selecting more favorable tail events.
