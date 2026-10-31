# Native host protocol 6

This is the implemented private Bun-to-GPUI contract for BN1, shared native interactions and the initial BN4 layout primitives. Application code
uses [`@bun-native/core`](../packages/core/README.md); Solid and React adapters
must target that same public API. They do not import this transport or construct
numeric handles. Protocols 1–5 are superseded without a compatibility fallback.
Protocol 6 requires `tree`, `input_revisions`, `layout_v1`, `interactions_v1` and `window_display_v1`; missing features or
older versions fail launch before a window is opened. The [layout contract](native-layout.md)
defines the supported style subset; the [interaction contract](native-events.md)
defines native event observations and public propagation. The
[service contract](native-services.md) defines immutable launch policy and
owned-window display reads and bounded clipboard transfers.

The authoritative schemas and validators are
[`packages/protocol/src/messages.ts`](../packages/protocol/src/messages.ts),
[`elements.ts`](../packages/protocol/src/elements.ts), and
[`native/protocol/src/wire.rs`](../native/protocol/src/wire.rs), and
[`events.rs`](../native/protocol/src/events.rs). The
[Rust model](../native/protocol/src/tree.rs) independently validates mutations.
This document explains their ownership and ordering rules; it is not a second
schema implementation.

## Ownership and execution

```mermaid
flowchart TD
  App["Application: Bun or inspected AOT"] --> Core["Core: opaque handles and callbacks"]
  Core --> Runtime["Runtime: one child and private pipes"]
  Runtime --> Reader["Native reader: bounded commands"]
  Reader --> UI["GPUI main thread: session and tree"]
  UI --> Windows["Owned windows, input entities and focus"]
  UI --> Writer["Native writer: bounded events"]
  Writer --> Runtime
  Runtime --> Core
```

The application owns one explicitly selected prebuilt host process. Launching
it never invokes Cargo or a shell. Its standard input/output carry the private
protocol; standard error carries bounded diagnostic capture. Rust I/O workers
perform blocking pipe operations, while the GPUI main thread alone changes
native windows, the model, focus and input entities. Native callbacks hold weak,
revocable state rather than owning an application's JavaScript closure.

The public core owns opaque node objects, window membership, a serialized
transaction queue and listener registrations. It continuously ingests native
events separately from executing application callbacks, so an awaiting listener
does not stop input-state observation or native-close revocation. Application
callbacks run in global event order, with at most one active callback. Each
registration has its own `AbortSignal`; replacement, unsubscribe, subtree
disposal and window/application close revoke that registration and discard its
queued callbacks. A callback that ignores cancellation loses authority over
disposed handles. The runtime cannot terminate arbitrary consumer JavaScript.

## Framing, negotiation and identity

- Each frame is one UTF-8 JSON object followed by a newline. The payload limit is
  65,536 bytes. Invalid UTF-8, oversize/truncated framing, malformed JSON, unknown
  fields or invalid message shapes fail the session rather than resynchronizing.
- The first request is `hello` with protocol `6`. The host emits `ready` with the
  same protocol, implemented capabilities, resource limits and explicit
  `service_policy`, then acknowledges the request. `tree`, `input_revisions`,
  `layout_v1`, `interactions_v1` and `window_display_v1` are mandatory. Missing features,
  version mismatch, duplicate readiness or acknowledgement before readiness
  fail launch and clean up the child. The native service policy must exactly
  match the caller's immutable explicit launch permissions; readiness cannot
  silently increase or reduce that authority.
- Request, window, root and node identities are positive JavaScript-safe
  integers. Committed window and node identities increase across the session;
  deletion does not make an identity reusable. Request identities also increase.
  Tree/input revisions begin at zero. UI event sequences begin at one and are
  contiguous across all windows in the session.
- The native model resolves each node within its owning window. A raw identity
  conveys no permission outside the session. The public core additionally checks
  object identity and owner membership; copying an opaque handle's visible
  properties cannot forge a usable handle.
- A failed native mutation does not consume its proposed window/node identity
  high-water mark or tree revision. The public allocator may leave gaps after a
  failed attempt; it never reuses handles already given to application code.

The two parsers deliberately agree on JavaScript-safe integral JSON numbers,
including `1.0` and `1e0`, and on last-value semantics for duplicate JSON keys.
Strings must be well-formed Unicode without NUL. This parity is covered by the
shared [negative corpus](../tests/fixtures/bridge-security.json) and parser tests.

## Commands and replies

Every command contains a request `id`. Replies must match that pending request's
type, owner and expected revision. A mismatched, unsolicited or duplicate reply
poisons the channel instead of satisfying another request.

| Command            | Required fields beyond `id` and `type`             | Successful reply                                                       |
| ------------------ | -------------------------------------------------- | ---------------------------------------------------------------------- |
| `hello`            | `protocol`                                         | `ready`, then `ack`                                                    |
| `open`             | `window_id`, `root_id`, `title`, `width`, `height` | `opened` with matching window/root and tree revision 0                 |
| `batch`            | `window_id`, `base_revision`, `operations`         | `applied` with matching window and tree revision incremented once      |
| `close`            | `window_id`                                        | `ack` after native removal is requested                                |
| `display_snapshot` | `window_id`                                        | `display_snapshot` with matching owner and validated native `snapshot` |
| `clipboard_read`   | `window_id`                                        | `clipboard_text` with matching owner and empty/text result             |
| `clipboard_write`  | `window_id`, `text`                                | `clipboard_written` after X11 confirms selection ownership             |
| `shutdown`         | none                                               | flushed final `ack`, then process exit                                 |

The root is an existing `box` created by `open`. Closing the final window does
not automatically end the session; explicit GPUI quit mode permits later
windows. `closed` events describe native window closure and revoke the owning
public window. Public `close()` and `shutdown()` are idempotent even though raw
commands targeting a disposed window are invalid.

`display_snapshot` reads the live window's GPUI display bounds and window
scale factor. It requires the immutable native `window_display` launch grant,
which defaults to false. The response does not mutate a tree or consume a UI
event sequence. Its small finite geometry schema, platform semantics and
delivery cancellation are defined in the [service contract](native-services.md).

`clipboard_text_v1` is optional and is advertised only by the implemented
local Linux X11 backend. The mandatory policy object contains independent
`window_display`, `clipboard_read` and `clipboard_write` booleans. Clipboard
work is queued separately from tree commits and completes asynchronously,
without consuming a UI event sequence or tree revision. Replies may complete
out of request order and still must match the exact request and window.
There are at most eight pending clipboard operations, each with a two-second
total deadline including its native queue time. Text is at most 8,192 UTF-8
bytes; empty text differs from no selection owner. See
[clipboard semantics](native-services.md#clipboard-text-and-lifecycle).

Each atomic `batch` supports the following operations:

| Operation | Meaning                                                                                                               |
| --------- | --------------------------------------------------------------------------------------------------------------------- |
| `create`  | Allocate a new `box`, `text`, `button` or `input` with complete validated properties.                                 |
| `set`     | Replace a node's properties with the same element kind; it is not a shallow property merge.                           |
| `insert`  | Attach or move a node under a `box`; the index is evaluated after detaching it from its old parent.                   |
| `delete`  | Remove a complete subtree and revoke its identities, input entities, focus and listeners. The root cannot be deleted. |

Validation runs against a candidate graph before native commit. It checks the
base revision, owner and element kind, root invariants, attachment, parent/child
consistency, ordering, cycles, depth and aggregate budgets. Every live node must
be attached when the batch finishes. A failure rolls back the entire batch.
An `applied` reply means native model/UI-thread acceptance, not GPU presentation.
Empty public batches stay local and do not increment the revision.

## Events and controlled input

All node events carry `sequence`, `window_id`, `node_id`, `tree_revision` and a
captured `path` from the committed root to the target. The path contains unique
positive IDs, ends at `node_id`, and has at most 65 entries: tree depth is bounded
at 64 edges, not 64 nodes. `click`, `input`, `key_down`, `key_up`, `pointer_down`,
`pointer_up`, `focus` and `blur` use this route. `closed` carries only sequence and
window identity. The transport checks contiguous sequence across **all** UI
events; a click/input callback subset naturally has gaps.

`input` additionally carries the complete value and independent
`input_revision`. Key events carry `key`, optional `key_char` and five boolean
modifiers; pointer events carry a supported button, finite window-logical `x`/`y`
and the same modifiers. The [event contract](native-events.md) defines the exact
fields and limits. The core validates owner, kind, revision and captured path
before delivery. It executes capture, target and bubble listeners against that
immutable route, never against ancestry reconstructed after a later mutation.
Events already in flight for a deleted target lose all callback authority;
removing an ancestor registration skips that binding without redirecting it.

The host enqueues `applied(R+1)` before a native event from revision R+1 can be
emitted. Preflight, commit and reply enqueue share one synchronous foreground
update; GPUI input/focus notifications run afterward. An older event may remain
queued while newer tree revisions commit. The core accepts its old snapshot but
rejects a future revision. Public propagation controls affect subsequent Bun
listeners only; they cannot cancel a native action that already occurred.

Native input edits increment the input revision without incrementing the tree
revision. An intentional application `set` of an input must include
`expected_input_revision` equal to the current native value's revision. A
successful replacement increments it; a stale replacement returns
`stale_revision` and changes nothing. A delayed unrelated tree transaction must
preserve newer input events observed while it was in flight. Ordinary typing
is observed without echoing older values back to the native editor.

## Bounds and backpressure

| Resource                                         |                                 Implemented maximum |
| ------------------------------------------------ | --------------------------------------------------: |
| Frame payload                                    |                                        65,536 bytes |
| Operations in one batch                          |                                                 256 |
| Live windows                                     |                                                  16 |
| Nodes per window, including root                 |                                               4,096 |
| Tree depth, measured in edges from root          |                                                  64 |
| Event ancestry, root and target included         |                                                  65 |
| Key / optional logical-text UTF-8 bytes          |                                                 256 |
| Pointer coordinate magnitude, logical pixels     |                                           1,048,576 |
| Individual text/input string                     |                                  16,384 UTF-8 bytes |
| Aggregate model text per window                  |                               4,194,304 UTF-8 bytes |
| Window title                                     | 256 UTF-8 bytes; nonempty and no control characters |
| Clipboard text UTF-8 bytes                       |                                               8,192 |
| Pending clipboard service requests               |                                                   8 |
| Native command queue                             |                                                  64 |
| Native output queue                              |                                                 256 |
| Runtime pending requests / unread UI events      |                                           128 / 128 |
| Public ordinary transactions / waiting callbacks |                                           128 / 128 |
| Concurrent application callbacks                 |                                                   1 |

The public transaction queue reserves additional cleanup capacity for one close
per live window. Reaching its ordinary-work limit rejects new work. Native
output uses nonblocking enqueue; an overflowing/disconnected output channel
terminates the failed session rather than blocking the UI thread. Event floods
also fail the bounded runtime/core queues. The reader may block on its bounded
command queue without blocking the GPUI thread. These limits bound selected
retained work, not total RSS, frame time or GPU allocation.

The native command dispatcher also limits each foreground turn to 16 completed
commands or 4 milliseconds, measured between atomic commands. It then awaits a
nonzero 1-millisecond background timer so GPUI can process native input and
paint before the next turn. This preserves FIFO order and batch atomicity; it
does not preempt an individual expensive command. Continuously ready channel
reads otherwise keep the GPUI foreground executor occupied even though the
command queue is bounded. The native scheduling regression injects input during
a sustained stream and requires its delivery before that stream stops.

The runtime applies request/exit deadlines (default 5 seconds, configurable from
1 to 60,000 milliseconds), bounded output draining after process exit, ordered
writes and one event consumer. Failure rejects pending work, stops the child
and releases readers. Shutdown cannot wait forever for inherited pipes.

## Errors, trust and compatibility

Native errors are `invalid_command`, `version_mismatch`, `invalid_state`,
`invalid_handle`, `stale_revision`, `limit_exceeded`, `native_failure`,
`permission_denied`, `service_unavailable`, `cancelled`, `operation_timed_out` and
`payload_too_large`.
A correlated recoverable command error becomes public `NativeCommandError`.
Malformed protocol, invalid sequence/reply or fatal transport failure ends the
session. Public preflight/ownership errors use `NativeStateError`, malformed
values use `ProtocolError`, and unsupported element kinds use
`UnsupportedFeatureError`. See the [public API ADR](decisions/0004-public-api.md)
for consumer handling and experimental compatibility policy.

The negotiated flags describe implemented features, not OS permission grants.
Protocol 6's services additionally require their immutable explicit
launch policy; there is no wire grant or general service selector. No file,
shell, process, network, update or browser service command exists. The
[security ADR](decisions/0003-bridge-security.md) defines the trusted
application/untrusted data boundary and default-deny requirements for future
services. Neither AOT nor the child-process boundary sandboxes trusted Bun code.

## Verification scope

TypeScript and Rust schema/model tests, actual subprocess failure tests and
public lifecycle/type fixtures cover the contract's positive and negative
paths. Real Linux GPUI development and inspected AOT runs cover tree mutations,
pointer input, native typing, Enter activation, stale-input rejection, OS close
and teardown. See [bridge measurements](../benchmarks/BRIDGE.md) and
[testing](testing.md) for reproduction and evidence distinctions. A native
acknowledgement benchmark is not input-to-presentation latency.

Linux evidence currently uses X11/XTest and Mesa llvmpipe. macOS/Windows GUI,
Wayland, physical GPU/input, IME, accessibility, sanitizer instrumentation and
long-running leak qualification remain separate work. Headless cross-platform
protocol success cannot satisfy those native acceptance claims.
