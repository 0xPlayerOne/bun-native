# Bounded native asset loading

Verified packaged responses without synchronous file work in the CEF scheme factory.

**Scope:** The existing packaged `app://ui` scheme, before M4 renderer authority and transport qualification.
**Integrity:** Every successful file response verifies the complete installed representation against its manifest SHA-256.
**Limits:** Two workers, 64 admitted requests, 64 pending continuations, 64 MiB of body reservations, and one reusable 64 KiB scratch buffer per worker.

## Request path

The factory reads bounded request metadata and constructs a response plan from the
already loaded inventory. It does not stat, canonicalize, open, read, or hash the
asset. Native UTF-16 values are checked before Bunly duplicates or converts them;
oversized or invalid input produces a bounded error response.

`ResourceHandler::Open` admits the plan to the worker pool, sets `handle_request`
to false, and returns true. A worker rechecks the file's containment/type/size,
streams it through SHA-256, and publishes the verified response. Only then does a
posted CEF IO task continue the request. Headers and reads consume detached,
reference-counted request state; no worker or continuation retains a raw handler
pointer.

The pinned CEF API supports deferred `Open`. `Open` and `Read` are sequenced calls
without a dedicated thread; response headers and cancellation use IO. Bunly
explicitly posts its continuation to IO and protects cancellation from other
threads as well. The wrappers delegate substantive work to ordinary functions.
The small unsafe output-buffer conversion has an explicit CEF lifetime and size
contract.

## Verification and retained bytes

| Response                            | Verification                                     | Retained body          |
| ----------------------------------- | ------------------------------------------------ | ---------------------- |
| Full GET                            | Complete file                                    | Complete verified file |
| Single byte range                   | Complete file, including bytes outside the range | Requested range only   |
| HEAD                                | Complete file                                    | None                   |
| Matching conditional GET/HEAD (304) | Complete file                                    | None                   |
| Unsatisfiable range (416)           | Complete file                                    | None                   |

Read bytes feed both the hash and the selected response buffer. The implementation
does not verify one read and serve a subsequent read. A truncated, grown, or
same-size corrupted file fails closed, including when the request would otherwise
produce a bodyless 304. Modification timestamps are not an integrity authority.
Existing content restrictions, CSP, manifest allowlisting, and range semantics
remain in force.

The byte reservation is made before enqueueing and covers the planned body through
verification and consumption. Worker completion does not release a still retained
body. Errors shrink the reservation when the body is discarded. EOF, cancellation,
or handler destruction releases retained data. Bodyless responses release their
request reservation when headers are consumed, because CEF may never call `Read`
for them.

The 64 MiB limit describes retained response payloads, not total process RSS.
Worker stacks, the two fixed scratch buffers, bounded request metadata, allocator
overhead, and CEF's own buffers are additional costs. No full-file copy is created
to extract a range. Admission rejects overload with 503 instead of starting more
threads or building an unbounded queue.

## Cancellation and shutdown

Each pending job has a cancellable queue token. Cancel removes a job that has not
started and immediately drops its plan, callback, and reservation outside the
queue lock. If a worker already took it, the real allocation remains charged until
the worker observes cancellation and discards it. Verification checks cancellation
between reads of at most 64 KiB. This is cooperative cancellation of ordinary
files; it is not a hard deadline for a kernel-blocked filesystem call.

A continuation must claim the request under its state lock before invoking CEF.
Cancel prevents future claims. Cross-thread cancellation waits for an existing
claim to finish; synchronous same-thread CEF reentry can cancel without deadlocking.
No state, queue, or budget lock is held while calling CEF. Continuation claims are
released on unwinding as well as ordinary return.

Shutdown stops admission, cancels tracked requests, discards queued work, fences
claimed continuations, and joins the fixed workers. The service guard covers
startup errors after asset initialization as well as normal exit. On the normal
path it is dropped before `cef::shutdown`. A posted task that runs after its
request was cancelled cannot invoke its callback.

The active registry is bounded independently of CEF wrapper lifetime. Completed
handlers can remain reference-counted by CEF without accumulating admission debt.
A bodyless response remains registered while its continuation is executing, even
after its body reservation reaches zero.

Posted CEF tasks hold a separate continuation permit from admission through task
execution/destruction. Cancelling a posted response frees its body promptly, but
does not pretend that the still queued CEF task has disappeared. At most 64 such
permits exist, including wrapper clones. Repeated cancel/re-admit cycles therefore
cannot grow the CEF continuation queue without bound while IO is stalled.

## Regression protection and qualification

The normal CEF library test suite checks queued cancellation before workers become
available, retained-byte accounting through EOF, independent byte/request caps,
repeated bodyless requests with live wrappers, cancellation before continuation,
reentrant cancellation, shutdown fencing, worker-buffer reuse, and cancellation
under a deliberately stalled continuation consumer. Resource tests cover corruption
outside a requested range, same-size corruption before 304/HEAD,
file growth/truncation, bounded reads, malformed metadata, and path restrictions.

Run the pinned native checks with:

```sh
cargo +1.91.0 test --locked --manifest-path native/cef-host/Cargo.toml --lib
cargo +1.91.0 clippy --locked --manifest-path native/cef-host/Cargo.toml --all-targets --features packaging -- -D warnings
```

These checks establish deterministic resource and integrity behavior. Actual
packaged CEF execution is still required to qualify the asynchronous API boundary.
Concurrent-load responsiveness, cold/warm startup, and interaction latency are
profiling measurements; no millisecond threshold or desktop speedup follows from
the unit tests alone. Platform executions and raw measurements belong in the
pass's evidence record. M4 renderer identity/authority and representative transport
selection remain separate acceptance work.

## Upstream contracts

- [Pinned cef-rs resource-handler wrapper](https://github.com/tauri-apps/cef-rs/blob/163744c8286d5f593d89202c7807751a7898db28/cef/src/wrapper/stream_resource_handler.rs).
- [Pinned cef-rs string ownership and conversion](https://github.com/tauri-apps/cef-rs/blob/163744c8286d5f593d89202c7807751a7898db28/cef/src/string.rs).
- [CEF ResourceHandler API](https://cef-builds.spotifycdn.com/docs/116.0/classCefResourceHandler.html), with the pinned headers/bindings taking precedence over this older online reference.

This change does not alter the documented private-installation filesystem threat
model. Observed symlinks are rejected; hostile same-user filesystem races and
production release qualification remain explicit broader boundaries.
