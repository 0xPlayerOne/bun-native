# Bounded binary streams

M5 protocol foundation, separate from request/response RPC and from native control.

**Issue:** #23. **Status:** portable implementation and local qualification;
production transport, native authorization and PTY/renderer integration remain open.

## Application API

A host provisions a dedicated, ordered transport, a shared `StreamBudget`, and a
local owner object representing the already-authenticated view. The receiver has
an explicit allowlist of sinks. Never populate these from packet fields.

```ts
const receiver = new BinaryStreamReceiver(bulkTransport, {
  budget: hostBudget,
  owner: nativeView,
  signal: documentLifetime.signal,
}, {
  terminal: {
    consume(chunk, context) {
      if (context.signal.aborted) throw new Error('Revoked');
      return new Promise<void>(resolve => terminal.write(chunk, resolve));
    },
  },
});

const writer = await sender.open('terminal', { signal: operation.signal });
for await (const chunk of source) await writer.write(chunk);
await writer.end();
```

This shows the intended xterm callback boundary; the new headless workbench does
not install or render xterm, launch a PTY, or implement native bridge injection.
An upstream producer must honor the awaited write. A PTY callback that appends to
its own unbounded array defeats backpressure and is not a qualified integration.

## Protocol

Each packet starts with a 24-byte network-order header: magic `BLST`, version 1,
kind, zero reserved bits, stream ID, sequence, body length, and argument. IDs and
sequences are unsigned 32-bit integers; IDs increase and are never reused within
a connection. Exhaustion requires a new connection, not wrapping identifiers.
Only OPEN (a bounded ASCII sink name) and DATA (binary) carry bodies.

| Operation      | Meaning                                                                      |
| -------------- | ---------------------------------------------------------------------------- |
| OPEN / OPENED  | Request and acknowledge a named lossless sink.                               |
| DATA / ACK     | Deliver one numbered chunk; ACK includes exactly its consumed byte count.    |
| CLOSE / CLOSED | Complete after prior writes and sink finalization.                           |
| CANCEL         | Abort one stream. In-flight application effects cannot be rolled back.       |
| ERROR          | Fixed error code without exception text, paths, credentials or stack traces. |

Version 1 uses **one outstanding chunk per stream**. `write` resolves only after
both transport handoff and the matching consumer ACK, never just `postMessage`.
A second concurrent write or end rejects with `OVERLOADED` rather than creating a
hidden producer queue. Consumers grant another credit only when the previous ACK
is actually sent, not while it waits behind an unrelated transport write.

This stop-and-wait profile establishes correctness, not maximum throughput.
Credit-window enlargement and scheduling measurements belong with #22/#26/#27.
Control RPC must use a separate lane; putting bulk packets into an arbitrary
shared FIFO would reintroduce head-of-line blocking.

## Capacity and lifetime

Defaults: 16 KiB chunks, 32 streams per view, 128 streams globally, 256 KiB maximum
reserved capacity per stream, 4 MiB per view and 32 MiB globally. Each admission
reserves three complete packet capacities before accepting data, covering bounded
snapshots and in-flight framing. Idle streams reserve capacity without allocating
that much memory. Increasing chunk size may require increasing the capacity limit.
All byte and stream-count constraints apply together.

These are conservative **protocol-owned capacity reservations**, not measured RSS
or a cap on application/renderer/OS allocations. The transport's own queue also has
byte/frame limits. Callers, logging adapters and consumers must not retain copies
outside their declared lifetime; no library can bound arbitrary application code.

Reuse one pool and the same owner object across replacement connections. Never
create a fresh pool per reconnect. Cancellation immediately settles callers but
keeps the reservation while a consumer or raw adapter is still executing. An
uncooperative callback cannot recycle its slot by reconnecting. Diagnostics retain
those outstanding reservations instead of claiming buffers vanished on close.

Delivery and consumption have finite deadlines. Timer callbacks and completion
paths both check deadlines. Closing/revoking a lane settles its callers and signals
consumers. Raw I/O that ignores close may keep its reservation indefinitely until
it settles; producers still fail within the watchdog deadline. The host must decide
how to terminate that defective adapter, not silently reset the pool.

## Loss, reconnect and security

Only lossless mode is implemented. Empty/oversized chunks and other modes are
rejected; terminal output is never silently dropped or coalesced. There is no
retained replay backlog and no automatic reconnect/resume. Applications need an
explicit source cursor and idempotency policy for replay, outside this protocol.

Consumed bytes are not proof that a compromised recipient honestly rendered them.
ACK is a flow-control statement by the authorized consumer, not an authentication
primitive. IDs, sink names and owner objects do not authenticate remote messages.
#19 must bind the real native view/frame/document and revoke the supplied lifetime
at navigation start. No loopback server, remote debugging port or renderer privilege
has been enabled by this implementation.

`StreamFramer` handles fragmented/coalesced byte input with one bounded partial
packet and no output array. It rejects incomplete EOF, impossible lengths and
reentrant input. `writeStreamPacket` handles short writes and rejects zero progress
or impossible counts; the enclosing `StreamLink` provides the drain watchdog. A
selected production adapter must implement its actual I/O and close contract.

## Reproduction

```sh
bun test tests/streams.test.ts
bun run typecheck:browser
bun run boundaries
bun scripts/stream-workbench.ts
```

Tests cover slow/paused consumers, checksummed order, capacity exhaustion across
views/connections, malformed frames, fragmented headers/bodies, partial writes,
late replies, consumer failure, cancellation and raw-adapter stalls. The workbench
uses real MessageChannels and a mock-owned view: a blocked bulk consumer leaves an
independent typed RPC lane usable, then drains and verifies 1 MiB of fixture bytes.

These tests do not qualify CEF, WKWebView, WebView2, kernel wakeups, native process
cleanup, real PTYs, browser permissions or comparative performance. The local commands do not require runner dispatch; hosted native acceptance is
separate and does not promote this portable foundation to native stream support.

## Push-only producer adapters

The runtime-only `CallbackStreamSource` feeds this writer from bounded callback
sources. It reserves its own additional capacity from a shared pool, owns exact
chunk snapshots, and stops an unpausable producer explicitly on overload. Source
EOF is distinct from process exit; `drained` is distinct from OS cleanup. The
[M5 increment](m5-progress.md) qualifies actual Bun PTY callback bytes through the
portable stream path. It does not yet grant native renderer authority or implement
graphical xterm, a full terminal service, descendant supervision or reconnect.

Runtime callback sources may explicitly opt into lossless pending-byte coalescing.
Only an unsent block can grow, no batching timer delays the first byte, and unused
block capacity remains charged alongside active/transferred buffers. Generic
sources default to their original callback chunk behavior. See
[terminal service](terminal-service.md) for the terminal-owned use and limits.
