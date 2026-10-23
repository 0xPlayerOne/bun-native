# Application RPC

Typed, bounded application requests with host-owned document authority.

**Status:** M4 portable implementation for #18 and the policy portion of #19.
**Native integration:** Not yet injected into CEF renderers. The separate
authenticated loopback candidate is opt-in and opens no listener unless its
runtime class is explicitly constructed; see [loopback RPC](rpc-loopback.md).

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

CEF frame attestation, isolated-context injection and remote-page adversarial
tests remain #19 integration work. #22 now has a loopback candidate, but its
native-private credential/CSP handoff and paired CEF comparison remain open.
The M3 private native command pipe is unchanged and is not exposed to pages.

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
