# ADR 0007 — Bounded native clipboard text worker

Status: accepted; local Linux X11 implementation qualified in development and inspected AOT with both development-profile and hosted release-profile native hosts. Additional platforms remain unavailable.

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
The stream also admits at most 262,144 inbound protocol bytes per operation or
owned-selection service burst. That counter is shared across connections and
all INCR chunks before x11rb can enqueue their events. A 64-event drain alone
would not bound the library's internal input queue. Exceeding the admission
budget produces `limit_exceeded` for a pending operation; an idle selection
connection that exceeds it is relinquished.

Idle workers block on a notification socket and, while owning a selection, the
actual X connection. There is no periodic idle polling after a read, during
selection ownership, or after ownership loss. Notifications coalesce safely;
other notification failures cancel pending work and initiate worker teardown.
The stopping state retains its join task even when teardown began on this
exceptional path; final session shutdown takes and awaits that task. Dropping
the notification sender wakes shutdown.

The trusted local X server, regular local filesystem and process launch
environment remain part of the existing desktop trust boundary. The input-byte
cap does not defend against a malformed trusted X server advertising an invalid
packet allocation length. Authority setup opens one nonblocking descriptor,
validates that descriptor as a regular file, and reads at most 1 MiB plus a
one-byte oversize sentinel from the same descriptor. The attributed pinned
xauth parser preserves family/address/display/MIT-cookie matching. Local
filesystem setup is byte-bounded, not a hard wall-clock filesystem I/O guarantee;
credentials and their path never enter diagnostics.

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
close/shutdown and wrong-owner responses. Socket-pair tests cover deadline, cancellation,
notification coalescing, shutdown and the pre-parser input budget. Authority
tests cover matching, truncation, FIFO/oversize rejection and path replacement
after the checked descriptor has opened. A held real worker thread and pending
GPUI task check that a notification failure cannot detach the join from final
shutdown. These are **headless** checks.

Native acceptance must use only a task-owned isolated Xvfb selection and an
independent foreground owner/reader. It must prove external reading of writes,
ordinary and incremental reads, oversized/malformed data, owner loss, a stalled
owner while native input/paint/commits continue, cancellation and worker teardown
in development and inspected AOT. The foreground peer additionally submits an
invalid format-8 `ATOM_PAIR` MULTIPLE request and a bounded hostile selection
event flood. The controller checks sleeping-worker context-switch/CPU deltas
at three idle checkpoints, complete native paints and every joined peer.

An executor recovery lost the unpublished final source snapshot and raw native
artifacts. The [historical recovery note](../../tests/native/evidence/clipboard-recovery-history.json)
preserves that loss. The reconstructed source subsequently passed a distinct
[fresh qualification](../../tests/native/evidence/clipboard-linux-recovered.json)
on November 2, 2026: both development and inspected AOT completed all 26
outcomes, joined all 22 independent peers and returned seven public ownership
counters to zero without forced cleanup. The three idle checkpoints in each
run observed zero clipboard-worker CPU ticks and context switches. These are
bounded correctness observations, not a sustained performance or leak claim.
The separate [hosted release-host record](../../tests/native/evidence/clipboard-linux-hosted-release.json)
qualifies main `c9ada928eb86ee44abeb85ba13721a68af0057d6` on November 4, 2026.
[Validation run 41831891686](https://github.com/0xPlayerOne/bun-native/actions/runs/41831891686)
passed its native Linux job and aggregate gate. Its downloaded artifact matches
the recorded SHA-256 and byte count. All 75 scenario source fingerprints and
69 compiler fingerprints match that exact commit. Development and inspected
AOT use the same 29,475,240-byte release host; each completes all 26 outcomes,
joins all 22 peers, releases every public owner and exits without forced cleanup.
The audit also checks each peer's raw log, the complete final native paint and
the three sleeping-worker checkpoints, whose CPU/context-switch deltas are zero.

This completes the bounded local Linux X11 text acceptance described in #300.
It does not extend the backend or format contract: macOS, Windows, Wayland,
remote X11 and richer formats remain unavailable, and the wider #255 service
matrix remains open. The hosted observations are correctness evidence, not a
performance budget, sustained power result or leak bound.
