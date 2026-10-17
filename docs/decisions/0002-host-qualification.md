# ADR 0002: host qualification protocol

Choose bindings from recorded behavior rather than implementation-language assumptions.

**Status:** All three probe candidates pass the initial platform matrix; production adoption and remaining #5 criteria stay open.
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

## Initial results

[Run 38991991211](https://github.com/0xPlayerOne/bunly/actions/runs/38991991211)
passed all three modes on Linux x64, macOS arm64, and Windows x64 with Bun 1.4.3:
45 successful fresh-host trials. Real native libraries were built, packaged,
verified, and loaded from the offline consumer cache on all targets.

For the next CEF spike, retain the native-main-thread/Bun-Worker arrangement and
use the tested Node-API boundary as the preferred starting point. Keep FFI as a
qualified comparison and the subprocess model as a tested fallback. This is a
provisional engineering selection based on functional results and standard native
addon interoperability, not a claim that Node-API is faster or uses less memory.
Rust remains the probe language; this does not require all platform shims to use it.

## Evidence semantics and remaining work

`bun run qualify:host` produces per-target JSON with actual Bun version, source
commit, trials, elapsed times, and failures. The FFI/Node-API child reports RSS;
this is a smoke diagnostic, not full-process-tree memory or idle wakeup evidence.
The process candidate timing includes a different protocol/startup path. Do not
compare these raw timings as if they measure equivalent end-to-end workloads.

A failed mode fails qualification and preserves its diagnostic record. Fresh-host
trials do not establish same-host Worker replacement, reentrant callbacks,
prolonged GC stress, or crash containment. Those tests and full host resource
accounting remain required to close #5. Generalized M2 benchmarks and M3 browser
integration must separately validate actual idle activity, process/thread counts,
CEF helpers, AppKit/Win32/GTK loops, sandboxing, and browser-loaded responsiveness.
No criterion is waived merely because the initial probe passes.

## Fallback rule

If native initialization, callback lifetime, or browser integration invalidates
the preferred boundary, revise this decision with a failing fixture and use the
simplest supported fallback. Do not embed undocumented Bun internals or begin
maintaining a private Bun fork. Experimental ModuleGraph/Worker behavior requires
its own measured qualification before managed reload relies on it.
