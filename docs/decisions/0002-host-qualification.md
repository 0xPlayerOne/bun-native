# ADR 0002: host qualification protocol

Choose bindings from recorded behavior rather than implementation-language assumptions.

**Status:** Probe implemented; results must be attached before a production choice.
**Related issues:** #5, #12, #13, #14, #29.

## Candidates

1. Bun bootstrap calls a blocking native loop; application Worker registers a
   thread-safe FFI callback and posts work through a bounded native queue.
2. The same host/queue is exposed through Node-API, including thread-safe function
   callbacks. No separate Node runtime or development headers are used.
3. A native executable owns a Bun subprocess using a bounded line-based fixture
   protocol. This is a failure-isolation fallback, not a production supervisor.

Each candidate runs in a fresh child process. Five trials qualify startup,
callback delivery, timer progress, binary checksum correctness, and cleanup.
The Worker performs GC before the first dispatch and makes fifty round trips.
macOS additionally checks `pthread_main_np`. Non-macOS main-thread ownership is
established by recording the host entry thread and rejecting other callers.

## Evidence semantics

`bun run qualify:host` produces per-target JSON with actual Bun version, source
commit, trials, elapsed times, and failures. The FFI/Node-API child reports RSS;
this is a smoke diagnostic, not full-process-tree memory or idle wakeup evidence.
The process candidate timing includes its own protocol/startup. These are not
fair microbenchmark claims about FFI versus N-API versus CEF; use M2 for that.

A failed mode fails the qualification command and still preserves its diagnostic
record. Repeated trials create fresh host/Worker processes; they do not establish
safe same-host generation replacement. CEF/GPU helpers, actual AppKit/Win32/GTK
loops, idle wakeups, full process/thread accounting, native-addon unload, and
crash recovery require the later integration probes. Do not close those gaps
by interpreting this fixture as a desktop runtime.

## Selection rule

Use the simplest passing, supportable boundary for the next host spike. Retain
FFI as a measured candidate, not an assumption of stability. Prefer standard
Node-API for native extension compatibility when tested. Use a supervised
subprocess when in-process callbacks or lifetime semantics cannot meet the
requirements. Any choice remains revisable before M3 browser integration lands.
