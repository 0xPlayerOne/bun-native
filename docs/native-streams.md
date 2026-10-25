# Native CEF binary stream lane

The M5 native lane carries the existing `BLST` protocol beside, never inside,
native RPC. The browser process grants one native-known view, main frame,
document, session and generation identity. RPC and streams then keep independent
subscription, incoming sequence, outgoing sequence and one-packet pending state.
JavaScript packet fields never select a view, frame or trusted owner.

The renderer installs frozen `__bunlyRpc` and `__bunlyStreams` objects only in the
granted main-frame V8 context. Every captured function requires the current and
entered V8 context to be that exact context. Same-origin children, borrowed
functions, stale grants, foreign frames and non-main frames fail before packet
admission. Navigation start, redirect, renderer exit, view disposal and shutdown
revoke the common binding. Returning to the original origin does not regrant it.

Bridge close is lane-local: it permanently settles that document's binary lane
without stopping RPC. Ordinary `BLST CANCEL` retires only its stream and does not
stop another binary stream or RPC. A corrupt or replaced native document binding
is the larger lifecycle boundary: it revokes both RPC and stream lanes because
they share one authenticated document incarnation. There is no reconnect, replay
backlog or replacement grant.

## Admission and receipts

CEF process messages remain at most 24 KiB. A normal binary packet is the existing
24-byte header plus at most a 16 KiB chunk. Each direction admits one native packet
per lane per view with independent sequences. Browser-to-renderer delivery uses
one shared pool of 128 packets/3 MiB across RPC and streams. Streams may occupy at
most 96 packets/2.25 MiB, preserving 32 packets/768 KiB for RPC/control instead of
doubling native memory. Incoming stream traffic has the same sublimit inside the
existing 3 MiB total.

Already-sent CEF-owned bytes remain charged after lane or document revocation.
They leave the pool only after the exact lane, connection, context, generation,
sequence, frame and native `DELIVERED`/`DISCARDED` receipt returns. Native handoff
acknowledges only transport ownership. `BinaryStreamSender.write()` still waits
for the separate `BLST ACK` emitted after the application consumer finishes.

The private native-to-Bun pipe keeps its existing 8 MiB total/7 MiB ordinary FIFO
bounds. Hex-expanded full-pool traffic remains within that envelope. `stream.ack`
and `stream.disconnect` share the finite control reserve; bulk `stream.deliver`
remains ordinary traffic. No process, thread, poller or deadline is introduced.

## Trusted APIs and qualification

`CefBackend.serveStreams()` must run before sessions or views are created. It owns
one global `StreamBudget` and invokes the application with the stable opaque
`ViewHandle`, a document `AbortSignal`, and one-time sender/receiver factories.
The callback selects exactly one endpoint before returning. It never promotes
renderer-supplied IDs to authority. Disposal releases the connection and listeners
while existing stream reservations remain charged until unsettled consumers
actually settle.

Browser code uses `cefStreamTransport()` or `waitForCefStreamTransport()` and the
browser-safe contracts package. The readiness event is only a wakeup and carries
no grant.

The maintained native RPC/prebuilt stage now also requires two ordered streams
with exact byte counts and SHA-256 digests, a paused consumer whose `BLST ACK` is
withheld while RPC completes, cancellation, hostile-child borrowing denial,
navigation/return denial, and zero observed stream delivery/incoming/portable
accounting. Existing source and artifact fingerprints bind those receipts. Other
hosted stages and provider prerequisites are unchanged.

This is functional CEF qualification, not graphical xterm/PTY integration and not
a throughput, latency or memory-performance claim.

## Review corrections

A stream-only document owner is retired by the common native binding-revocation
receipt even when no RPC server subscribed. Delayed stream subscription receipts
cannot regrant that retired owner. A deterministic regression failed before this
correction. The native fixture additionally closes its stream lane from inside a
consumer callback during delivery, then requires another actual RPC roundtrip.
Already-owned packets arriving after lane retirement are discarded and their exact
reservations released without revoking RPC. Native delivery acknowledgment remains
separate from consumer completion.

The first two actual native fixture attempts failed page readiness and remain
failed evidence. Review corrected premature retirement on the initial native-
approved navigation (a deterministic regression reproduces it) and removed a
duplicate RPC entrypoint: the stream bundle already includes the shared RPC client.
The native callback still retires subsequent untrusted navigation immediately,
and no bridge subscriber limit or qualification deadline was relaxed.

Stream revocation uses the same exact-shape, small-message lifecycle reserve as
RPC revocation. A saturated-ordinary-output regression failed before the stream
event was included. This reserves admission without changing FIFO order or the
existing total native output byte/count limits.
