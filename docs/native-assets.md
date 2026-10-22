# Bounded native asset loading

Verified packaged responses without synchronous file work in the CEF scheme factory.

**Scope:** The existing packaged `app://ui` scheme, before M4 renderer authority and transport qualification.
**Integrity:** Every successful file response verifies the complete installed representation against its manifest SHA-256.
**Limits:** Two workers, 64 admitted requests, 64 pending continuations, 64 MiB of body reservations, and one reusable 64 KiB scratch buffer per worker.

## Request path

The request adapter reads bounded metadata and constructs a response plan from the
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

### CEF range and HEAD handling

The pinned CEF loader interprets `Range` before asking the resource handler for
response headers. Passing the original header alongside an already selected body
would make it skip those bytes again, and a clipped range could retain CEF's
original requested length instead of the verified response length.

For packaged requests, `OnBeforeResourceLoad` captures the original bounded plan
before normalizing a nonempty or oversized `Range` to the internal value
`bytes=0-`. CEF then skips zero bytes and uses the verified response's actual
length. The URL, method, and other headers remain intact; requests without a range
avoid this extra skip step. A fresh adapter belongs to each request. It consumes
the captured plan once in `GetResourceHandler`, checking the original request
identifier, URL, and method. Unexpected reuse or a mismatch fails closed instead
of planning from the normalized header. This identifier correlates callbacks; it
does not supply renderer authority.

Both the browser request handler and the request-context fallback create the same
adapter. The latter covers worker and `CefURLRequest` paths without a browser
handler. For HEAD, an unknown CEF stream length (`-1`) preserves the explicit full
representation `Content-Length`; the verified body remains empty and reads end
immediately. A 304 keeps its existing empty body and omits `Content-Length` and
`Content-Range`.

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

### SHA-256 backend selection

The macOS AArch64 host enables the `asm` feature of the existing pinned
`sha2 = 0.10.9`. This selects RustCrypto's upstream SHA-256 implementation using
ARM SHA instructions; it does not change the digest, the complete-file check, or
the response's verification barrier. Other host targets keep their existing
feature selection. No application-time compiler or additional runtime is needed.

The upstream AArch64 dispatcher selects hardware or software through
`cpufeatures`. On Apple ARM64, the pinned `cpufeatures = 0.2.17` treats SHA-256
instructions as a platform guarantee and returns true; this is not a macOS
runtime hardware probe. The upstream software backend remains available through
`force-soft` for qualification. No global CPU feature flags or custom cryptography
are introduced. The feature also activates the upstream optional `sha2-asm`
dependency, recorded in the native lockfile and dependency audit.

Fixed expected digests cover standard SHA-256 vectors and input lengths around
padding, 64-byte block, and 64 KiB verification-buffer boundaries, including
short reads and retained ranges. Expected hashes are independent of the backend
being tested. A controlled hash workload can establish the cost of verification;
it does not establish a desktop startup or interaction-latency improvement.

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

Normal shutdown emits fixed JSON start/completion events for `process-stop`,
`host-release`, `asset-service-stop`, and `cef-shutdown`. Each completion records
the monotonic elapsed milliseconds. These eight bounded events identify the phase
that has not returned during a failure, without changing the shutdown order or
deadlines. They also support measuring the cost of each completed stage.

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
Adapter tests cover single-use plan capture, request-key mismatches, and the CEF
stream lengths used for HEAD, full and partial bodies, 304, and 416.

Run the pinned native checks with:

```sh
cargo +1.91.0 test --locked --manifest-path native/cef-host/Cargo.toml --lib
cargo +1.91.0 clippy --locked --manifest-path native/cef-host/Cargo.toml --all-targets --features packaging -- -D warnings
```

To exercise the upstream software implementation against the same fixed digest
checks without changing the installed feature selection:

```sh
cargo +1.91.0 test --locked --manifest-path native/cef-host/Cargo.toml --lib --features sha2/force-soft sha256_
```

These checks establish deterministic resource and integrity behavior. Actual
packaged CEF execution is still required to qualify the asynchronous API boundary.
The explicit native profile gates success on nine sequential range/conditional
cases with exact status, header, and body checks. These include nonzero, clipped,
suffix, unsatisfiable, and multiple ranges, matching and mismatching `If-Range`,
HEAD with Range, and conditional 304 with Range. They run after the measured
concurrent workload so their time is excluded from its performance samples.
Concurrent-load responsiveness, cold/warm startup, and interaction latency are
profiling measurements; no millisecond threshold or desktop speedup follows from
the unit tests alone. Platform executions and raw measurements belong in the
pass's evidence record. M4 renderer identity/authority and representative transport
selection remain separate acceptance work.

## Upstream contracts

- [Pinned cef-rs resource-handler wrapper](https://github.com/tauri-apps/cef-rs/blob/163744c8286d5f593d89202c7807751a7898db28/cef/src/wrapper/stream_resource_handler.rs).
- [Pinned cef-rs string ownership and conversion](https://github.com/tauri-apps/cef-rs/blob/163744c8286d5f593d89202c7807751a7898db28/cef/src/string.rs).
- [Pinned CEF request interception and mutable-header ordering](https://github.com/chromiumembedded/cef/blob/14c5a089e8452874cb1a556dc3fde26ed2d87723/libcef/browser/net_service/resource_request_handler_wrapper.cc).
- [Pinned CEF range parsing, skip, and response-length handling](https://github.com/chromiumembedded/cef/blob/14c5a089e8452874cb1a556dc3fde26ed2d87723/libcef/browser/net_service/stream_reader_url_loader.cc).
- [Pinned CEF response-header construction](https://github.com/chromiumembedded/cef/blob/14c5a089e8452874cb1a556dc3fde26ed2d87723/libcef/common/net_service/net_service_util.cc).
- [Pinned CEF request-context fallback API](https://github.com/chromiumembedded/cef/blob/14c5a089e8452874cb1a556dc3fde26ed2d87723/include/cef_request_context_handler.h).
- [Pinned SHA-256 backend selection](https://github.com/RustCrypto/hashes/blob/sha2-v0.10.9/sha2/src/sha256.rs) and [AArch64 dispatcher](https://github.com/RustCrypto/hashes/blob/sha2-v0.10.9/sha2/src/sha256/aarch64.rs).
- [Pinned Apple ARM64 CPU-feature contract](https://github.com/RustCrypto/utils/blob/cpufeatures-v0.2.17/cpufeatures/src/aarch64.rs).
- [RFC 6234 SHA-256 test vectors](https://www.rfc-editor.org/rfc/rfc6234.html#section-8.5).

This change does not alter the documented private-installation filesystem threat
model. Observed symlinks are rejected; hostile same-user filesystem races and
production release qualification remain explicit broader boundaries.
