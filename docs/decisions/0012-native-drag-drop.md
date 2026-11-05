# ADR 0012 — Bounded native drag and drop with owned targets

Status: accepted. The Linux X11 implementation is verified locally in
development and inspected AOT, through core, Solid and React, on an isolated
Xvfb display with a development-profile host. Hosted release-host
qualification runs in Native Linux. Other platforms and Wayland report the
service unavailable.

Date: 2026-11-05.

Related: [#303](https://github.com/0xPlayerOne/bun-native/issues/303),
[shared services #255](https://github.com/0xPlayerOne/bun-native/issues/255),
[filesystem grants](0010-filesystem-grants.md),
[trust boundary](0003-bridge-security.md) and
[service policy](0005-native-service-policy.md).

## Context

Dropping files onto a window is a user choice made outside the application.
The payload comes from another process, though: its file names, its number of
items and its claims about what it carries are untrusted. A dropped path must
not become file authority on its own, and a drop must not reach a component
that has gone. Drag hover and drop also have to coexist with native focus,
editing and pointer routing.

The pinned GPUI revision implements the X11 XDND target protocol itself and
exposes drops as an `ExternalPaths` drag on the element tree. Its behavior
constrains the design:

- It answers every `XdndPosition` with accept and every `XdndDrop` with
  finished/copy, whatever the application does. The host cannot refuse a drop
  at the protocol level, so the source always believes it was accepted.
- It reads the `text/uri-list` selection with a single 4,096-byte property
  request and does not check for remaining bytes, so a longer list can arrive
  silently truncated.
- Its XDND state belongs to the X connection. If the window under a drag closes
  before a drop or leave reaches a live window, the next drag is not converted
  until the source sends a leave, and GPUI's app-global active drag keeps the
  stale payload.
- It only accepts `text/uri-list` and plain-text targets. Plain text arrives as
  an empty path list.

## Decision

Protocol 11 adds a separate, default-denied `dragDrop` launch permission
(`--bun-native-allow-drag-drop`) and an optional `drag_drop_files_v1`
capability, advertised only on Linux under the GPUI X11 backend. Protocol 10 is
reserved for the process service that stacks on the same base.

`NativeWindow.registerDropTarget(node, listener)` makes a committed node an
owned target. The renderer's `registerDropTarget(ref, listener)` uses the same
window method, and Solid and React re-export it. The core allocates increasing
target IDs; the host rejects reused, lower, foreign and uncommitted
identities. At most 32 targets are live per session and a node has at most one.

The listener receives frozen events: `drag_entered`, `drag_left`, `drop` and
`drop_rejected`. Each carries a sequence, the target handle and an
`AbortSignal`. A drop carries at most 64 items, and each item exposes only a
`name`. The name is the final path component, lossily decoded, with control
characters replaced and truncated to 255 bytes. It is display text: it is not
unique and it is not a path. Drops arriving as plain text are rejected as
`empty`. The host also rejects a drop as `limit_exceeded` when it has more than
64 items, or when the largest possible URI encoding of the list (each
`file://` entry with every byte percent-encoded, plus CRLF) could reach
GPUI's 4,096-byte read. Only such a list is certain not to have been
truncated.

Full paths stay in the host, which retains them only for the target's latest
drop. `item.resolve(root)` asks the host to match that retained path lexically
beneath a launch filesystem root (ADR 0010). It returns the relative path, or
rejects with `path_denied` or `permission_denied`. Resolution grants nothing
new: the application still needs `openFileGrant(root)`, whose `openat2` checks
apply to the returned path as to any other. A newer drop or rejection on the
same target, closing the target, removing its node, closing its window or
stopping the application cancels older items locally, without a native request.

Hover uses the target's painted bounds in GPUI's capture-phase drag-move
handler, so outer and inner targets can both report `drag_entered`. A drop
uses GPUI's hit test and goes to the innermost live target under the pointer.
If a frame painted before a node removal still holds the removed element, the
drop falls to the nearest live ancestor target. During an active drag, the
pointer-up that GPUI synthesizes for a drop is not delivered as a pointer
event, so a drop never looks like a click or a release on the application's
own controls.

Revocation is local and immediate: `close()` and node removal mark the handle
inactive and abort its signal before any native round trip. The core also drops
late events for revoked targets, and treats events naming unallocated targets,
non-increasing drop IDs or another window's target as protocol errors. If a
window closes mid-drag, the host suspends drop delivery and stops GPUI's stale
active drag in a surviving window. It resumes once no drag is active.

## Alternatives

- **Deliver paths to the application.** That makes any process that can
  start a drag the author of file paths the application then trusts. Keeping
  paths in the host and resolving only beneath an existing root keeps the
  launch policy the only source of authority.
- **Turn a drop into a new filesystem grant.** A drop is a user choice, but
  authorizing new directories from it would bypass the immutable launch policy.
  Converting a selection into new authority stays with the dialogs work
  (#239), where the choice is made in a trusted system surface.
- **Refuse unwanted drops at the XDND level.** That needs a patched GPUI or a
  separate X11 client competing with GPUI for the same window. The source is
  told "copy", and the application is told precisely what happened instead.
- **Synthesized drag events in tests.** These would test our own model of
  XDND. The native test uses an independent x11rb XDND source process that
  grabs and warps the real pointer and serves the selection conversion itself.

## Consequences and verification

Applications see an honest result: a drop on a target, a typed rejection, a
leave, or nothing at all when the drop lands outside every target. They never
see a simulated acceptance. Because GPUI always replies accept/copy, a source
application may still treat a rejected or ignored drop as a successful copy.
Only local files are supported. Long lists are rejected conservatively. After a
window closes mid-drag, the next drag on that connection is not converted until
its source leaves; that is a GPUI backend limitation, which the native test
records.

Rust unit tests cover names, rejection bounds and lexical resolution. A shared
fixture of 38 command and event cases runs through both parsers. Headless core
tests cover capability records, frozen events, explicit resolution,
replacement, revocation during resolution, node removal, window close,
shutdown and protocol errors. The native test
[`tests/native/drag-drop.ts`](../../tests/native/drag-drop.ts) drives real XDND
drags into the host. It covers default denial, a multi-file drop resolved and
then read through a grant, a move-off, a source leave, a bare drop, nested hit
testing, typed rejections, closing a target and removing its node mid-drag,
closing the window mid-drag, and raw protocol handle checks.
[`tests/native/solid-drag-drop.tsx`](../../tests/native/solid-drag-drop.tsx) and
[`tests/native/react-drag-drop.tsx`](../../tests/native/react-drag-drop.tsx)
register through the adapter exports, unmount the zone mid-drag, remount it and
dispose with zero remaining resources. Physical pointer devices, real file
managers, Wayland, macOS and Windows are unverified.
