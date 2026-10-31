# ADR 0006 — Bounded native clipboard text worker

Status: accepted implementation direction; source and headless checks are distinct from pending native clipboard qualification.

Date: 2026-10-31.

Related: [#300](https://github.com/0xPlayerOne/bun-native/issues/300),
[shared services #255](https://github.com/0xPlayerOne/bun-native/issues/255),
[trust boundary](0003-bridge-security.md) and [service policy](0005-native-service-policy.md).

## Context

The public core needs an actual bounded native text operation shared by Solid
and React. GPUI's pinned desktop `read_from_clipboard_async` wraps its
synchronous read. The X11 implementation waits for selection replies and can
extend waits during an incremental transfer; its write method returns no
operation result. Its cached own-selection content cannot prove that an OS
write succeeded. These paths cannot supply the intended result, UI scheduling
or fixed transfer deadline by simple forwarding. Source links and platform
limits are recorded in [native services](../native-services.md).

## Decision

Protocol 6 adds separate immutable clipboard read and write grants, bounded
text commands and typed empty/text/native-error responses. A live public
window owns each request. Clipboard operations use a separate eight-request
public queue and a native worker, leaving the serialized tree commit queue and
GPUI input/paint scheduling free to progress.

Implement the first backend for a **local Linux X11 session** using the exact
`x11rb 0.13.2`, `rustix 1.1.6` and `raw-window-handle 0.6.2` dependencies already
in the pinned native graph. No additional process, renderer, JavaScript
runtime, browser or package version is introduced. macOS, Windows, Wayland and
remote/TCP X11 clipboard services explicitly remain unavailable. Native editor
keyboard copy/paste is a separate GPUI behavior and keeps its existing scope.

The worker uses the actual GPUI compositor/environment and validates the live
window's native backend. It connects to that local X server, uses a private
unmapped window, obtains an X server timestamp, sets CLIPBOARD ownership and
queries the server to verify the owner. UTF-8 data is served to independent
requestors; there is no application-side clipboard cache used as an operation
result. Incoming INCR transfers have the same total deadline as ordinary
transfers, never a fresh deadline per chunk. The
[ICCCM selection protocol](https://www.x.org/releases/current/doc/xorg-docs/icccm/icccm.html)
defines selection ownership, timestamps, conversion replies and incremental
transfer acknowledgement.

Each request has at most two seconds from native submission, including worker
queue time. A nonblocking stream bounds x11rb's reply waits and checks owner
revocation/shutdown between short polls. Payloads are at most 8,192 UTF-8 bytes,
without NUL, which also fit the 65,536-byte JSON frame under worst-case escaping.
The trusted local X server and process launch environment remain part of the
existing desktop trust boundary. Authority-file setup is restricted to a
bounded regular local file; credentials never enter diagnostics.

## Ownership and cancellation

A read cancelled before dispatch sends nothing. Cancellation after submission
withholds delivery after the bounded response is drained and validated. It
does not claim to stop an already executed OS read. Window close cancels native
pending requests and prevents subsequent stale-handle calls. Shutdown cancels
all pending requests and joins the worker before its final acknowledgement.

Writes deliberately have no cancellable API. A successful OS copy is a global
clipboard side effect; later window revocation cannot honestly roll it back.
The selected text remains available until another owner replaces it or the
host exits. Worker connection teardown relinquishes only its own selection;
it never restores stale data or clears a newer external owner's selection.

## Verification and remaining scope

Paired TypeScript/Rust cases cover grants, strict shapes, Unicode, empty text,
byte limits and malformed responses. Real subprocess tests cover a held read
alongside a completed tree commit, pending-request limits, read cancellation,
close/shutdown and wrong-owner responses. A socket-pair test covers deadline
and cancellation without calling an X server. These are **headless** checks.

Native acceptance must use only a task-owned isolated Xvfb selection and an
independent foreground owner/reader. It must prove external reading of writes,
ordinary and incremental reads, oversized/malformed data, owner loss, a stalled
owner while native input/paint/commits continue, cancellation and worker teardown
in development and inspected AOT. Until those tests execute, this slice is not
qualified as native clipboard support. Broader platform and format support
remains open under #300.
