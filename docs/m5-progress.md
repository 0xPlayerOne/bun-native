# M5 progress

Streams, terminals and responsiveness.

**Current increment:** #23 portable lossless stream foundation, after merged #66/#18.

Implemented: independent binary framing; OPEN/DATA/ACK/CANCEL/CLOSE/ERROR lifecycle;
actual sink-completion credit; explicit per-stream/per-view/global capacity and
count limits; one pending write per stream; finite delivery/consumption deadlines;
retained reservations for uncooperative callbacks; incremental packet decoding and
short-write handling; typed writer/sink APIs; browser-safe public exports; and a
real MessageChannel correctness workbench.

#23 remains open for production adapter and actual PTY-to-renderer integration.
The native identity/revocation path is #19, transport choice is #22, real PTYs are
#24, scheduling/latency integration is #26 and qualification under load is #27.
No current behavior claims a wider credit window, lossy coalescing, replay/resume,
CEF browser execution or a performance win. See [streams](streams.md).

M4's remaining browser sessions, native permissions and frame-authority tasks are
not displaced or marked complete. Independent protocol work can proceed while
hosted CI is paused, as #23's original dependency section explicitly permits.
