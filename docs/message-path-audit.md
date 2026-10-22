# Message-path foundation audit

Bounded stream ownership and lower-allocation protocol decoding after PR #86.

**Scope:** Existing control transport and portable RPC/stream helpers, not M4/M5 closeout.
**Baseline:** `a6598a36c0aa6ea99d56a1e0e8503164f7f369f5`.
**Evidence:** `evidence/stream-foundation-local.json`, with raw samples and the exact measurement harness.

## Correctness before throughput

Eight focused tests were first run against the merged baseline and all failed.
They demonstrate three classes of ownership defects, rather than hypothetical
style improvements:

- StreamLink released its byte reservation by reading the packet's current length.
  Transferable MessagePorts detach the original buffer, making that length zero.
  Repeated completed writes therefore accumulated queue debt and eventually failed
  with overload. The reservation now keeps the original immutable byte count.
  A hung adapter still retains its charge until its send actually settles, even
  after cancellation or endpoint closure.
- Buffer.slice aliases its source rather than making the bounded copy promised by
  the typed-array call sites. RPC queued packets, decoded binary values and stream
  sink chunks now explicitly construct an owned Uint8Array. MessagePort slices
  similarly copy exactly the selected bytes, without transferring or exposing
  unrelated backing storage. Full owned buffers retain the existing transfer path.
- The RPC writer now rejects shared backing memory before adapter handoff, matching
  the other protocol boundaries' shared-memory policy.

These changes preserve consumer-acknowledged backpressure and existing limits.
They do not add native renderer authority, a terminal implementation, or a new
transport. The real MessageChannel regression sends cumulative traffic far beyond
its small queue budget while checking exact sequence, consumption and zero final
byte/stream reservations.

## Native control framing

The previous reader repeatedly concatenated, scanned and recounted an accumulated
UTF-8 prefix. Small fragments of a long frame made that work quadratic. The reader
now scans bounded byte windows, retains at most one lazily allocated 64 KiB scratch
buffer for split frames, and decodes completed bytes once. Complete short frames
still use a 16 KiB batched decoder path rather than paying one decoder call per event.
An initial per-frame-only candidate was not kept after it slowed the batched case.

The protocol still enforces 65,535 bytes before LF, fatal UTF-8, valid JSON, version,
identity and ordering checks. BOM handling remains stream-wide. Ownership promise
continuations still run before following lifecycle events, and the reader still
yields to the event loop after 32 processed frames. Oversized searches themselves
are bounded. New tests cover byte-by-byte Unicode fragmentation, exact-size frames,
coalesced blocks, partial EOF, invalid encoding, extra BOMs and scheduled work.

## RPC JSON validation

The decoder's metadata was already created by JSON.parse without a reviver, but
it allocated descriptor maps, entry tuples and cycle-tracking state as though each
received object could contain accessors or arbitrary prototypes. It now walks
parsed data directly while retaining the same depth/node/size limits, forbidden
property names, finite-number checks, strict envelope fields and schema gates.
The parser is captured at module initialization, not looked up from an application-
modified JSON.parse on every receive.

Arbitrary outbound application values still receive descriptor-based validation;
getters, nonenumerable fields, cycles, classes, sparse arrays and shared binary
buffers remain rejected. The fast mode is internal and selected only by the
byte decoder. No unvalidated packet or caller-supplied object enters that path.

## Descriptive paired measurements

Same-process measurements used Bun 1.4.3 on macOS arm64, one warmup and eight
measured repetitions in alternating old/new order. Native tests use protocol
peers; JSON tests use the same pre-encoded bytes. There is no quiet-machine or
thermal qualification, no timing threshold in unit tests, and no CEF rendering,
application startup, total-memory or competitor claim.

| Workload                                      | Baseline median | Updated median |
| --------------------------------------------- | --------------: | -------------: |
| 512 sequential control request/reply pairs    |        3.492 ms |       3.059 ms |
| 4,096 batched native events                   |        1.839 ms |       1.814 ms |
| Eight large UTF-8 frames in 64-byte chunks    |       39.223 ms |       2.430 ms |
| 256 structured RPC decodes (128 records each) |       59.091 ms |      19.950 ms |
| 4,096 small RPC control decodes               |        6.764 ms |       3.424 ms |

The large fragmented-frame result is a stress case, not a forecast for normal
small-event workloads. Smaller differences should be treated as noisy local
observations. Integrity, ownership copies and real consumer acknowledgement are
not removed to improve timing. The benchmark script is archived as data rather
than added as another permanent maintainer command.

## Validation and delivery boundaries

Run `bun run check:portable`, `bun run check:ci`, and `bun run check:ci:native`
with the documented contributor environment. The added regressions exercise
actual MessageChannels, Buffers, streams and timers, alongside hostile metadata.
Native packaged execution is recorded against its clean source commit in the PR;
portable helper tests do not establish native renderer or terminal acceptance.

Historical evidence and existing lockfiles remain untouched. No dependency,
compiler, CEF or packaged-Bun version changes. CI billing stays paused; this round
uses local macOS validation and does not claim fresh Windows/Linux execution.
M4 and M5 integration/security acceptance remain with their roadmap owners.
