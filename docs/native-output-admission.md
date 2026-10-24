# Native event output admission

M5 #26: bound the native-to-Bun side of the existing private FIFO. This is not a
new renderer bulk transport or a global fair scheduler.

## Ownership and bounds

The former channel limited queued `serde_json::Value` objects to 256 entries but
had no cumulative byte admission; removing an item also stopped charging it to
that channel even while the writer was blocked. The new queue owns one permit
per admitted frame through actual serialization, write and flush completion.
Dropping an unsent frame or receiver releases its permit. Closing every sender
does not release a writer-owned frame: a separate read-only monitor keeps that
reservation observable without keeping the channel open.

| Resource                                       | Total                                    | Ordinary traffic                 |
| ---------------------------------------------- | ---------------------------------------- | -------------------------------- |
| Retained frames, including active writer       | 256                                      | 192                              |
| Serialized wire-equivalent bytes, including LF | 8 MiB                                    | 7 MiB                            |
| Individual frame                               | 64 KiB including LF                      | Same                             |
| Eligibility for reserved capacity              | Exact control/reply shape, at most 1 KiB | No reserved-capacity eligibility |

The ordinary byte budget accommodates all 128 existing 24-KiB renderer packets
after hexadecimal expansion and envelope overhead. A native regression constructs
that complete permitted pool rather than silently reducing its capacity. The
count and byte bounds apply simultaneously; neither replaces the other.

These counters represent **serialized wire-equivalent reservations**, not Rust
heap/RSS or all application/browser/kernel memory. The existing `Value` is already
constructed before admission. Its allocation and container overhead, the active
encoded buffer, kernel pipe storage and upstream RPC ownership are separate.

## Control, order and failure

Only small native command responses and explicitly named readiness, shutdown,
revocation, view/window close and renderer-exit events may use reserved capacity.
Large responses, unknown names and extra priority fields remain ordinary.
Classification grants no renderer authority. A compromised page cannot choose a
native event kind by adding metadata to its payload.

FIFO is preserved: reserved admission does not move shutdown or disposal ahead of
previously accepted frames. The single writer still blocks on notification when
idle, with no new timer, worker, poll or busy loop. Saturation fails explicitly
through the existing host failure path; there is no silent dropping/coalescing,
pretended success or unbounded backlog. Reserved headroom is finite, not a
promise that control can always be admitted or interrupt a blocked OS write.

## Encoding and accounting

Admission counts the exact JSON encoding through a nonallocating, bounded writer
and stops at the existing frame limit. Encoded-buffer allocation and blocking pipe
I/O remain on the existing writer thread. The writer verifies that its immutable
value produces exactly the admitted length and retains the permit until flush
settles, including error/unwind paths. Counting is additional bounded CPU work;
this change is not a claim of faster serialization or zero-copy transport.

The actual native RPC fixture now requires `outputAdmission` diagnostics and a
schema-6 receipt. It checks cumulative peaks and current counts while exercising
real control commands and renderer traffic. Deterministic native tests separately
saturate frame/byte bounds, preserve control headroom and FIFO, hold writes/flush,
discard queued work, close all senders, simulate short/failed writes and run
concurrent producers. Those queue tests are not graphical load measurements.

## Remaining work

Native bulk-stream authority, global per-view scheduling, terminal group/job
ownership and representative interaction latency/full-process-tree measurements
remain M5 work. Managed backend replacement remains M6. Neither this admission
bound nor passing shutdown tests establishes a causal fix for the historical CEF
watchdog intermittency.
