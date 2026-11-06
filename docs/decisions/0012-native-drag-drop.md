# ADR 0012 — Bounded native drag and drop with owned targets

Status: accepted. The Linux X11 implementation is verified locally in
development and inspected AOT, through core, Solid and React, on an isolated
Xvfb display with a development-profile host. Hosted release-host
qualification runs in Native Linux. The macOS (AppKit) and Windows (OLE)
backends are enabled and qualified only in hosted CI (Native macOS and
Windows), with independent real-drag source processes; they were never run
locally. Wayland and other platforms report the service unavailable.

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
capability, advertised on Linux under the GPUI X11 backend, on macOS and on
Windows (see "Platform backends" below). The core reports the backend as
`x11`, `appkit` or `ole` from the platform it shares with the host; the wire
is unchanged. Protocol 10 is
the owned process service ([ADR 0011](0011-owned-processes.md)) it stacks on.

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

## Platform backends

The pinned GPUI revision delivers the same `FileDropEvent` sequence on macOS
and Windows, and the host's registry, bounds, revocation and late-event
suppression are platform-independent. Each backend's own behavior:

- **AppKit** (`gpui_macos/src/window.rs`). The window registers only
  `NSFilenamesPboardType` and reads it as one property list of UTF-8 paths,
  in full; there is no read bound, so the 4,096-byte truncation rule applies
  only to X11. `draggingEntered:` returns copy when the pasteboard holds that
  list and none otherwise, so a drag without files (text, file promises) never
  starts a GPUI drag. `draggingUpdated:` and `performDragOperation:` still
  answer copy and synthesize a left release, and `concludeDragOperation:`
  sends an exit after every drop. A drop also activates the application.
- **OLE** (`gpui_windows/src/window.rs`). `IDropTarget::DragEnter` converts
  only `CF_HDROP`, reading each `DragQueryFileW` name at its queried length
  (no truncation). A name that is not valid UTF-16 is skipped silently, so a
  drop can carry fewer items than the source offered; an all-invalid list is
  rejected `empty`. `DragOver` and `Drop` always answer copy, even for a drag
  without files, and `Drop` synthesizes a left release; there is no exit
  after a drop. A closing window revokes its target before it is destroyed.
- In both, the source is told copy for any drop GPUI received, whatever the
  application did, as on X11.

The synthesized release for a drag without files arrives with no GPUI drag
active, so the active-drag check does not hide it. The host therefore reports
a `pointer_up` only for a button it saw pressed in that window; a drop's
release never has one. Launch roots are POSIX paths (ADR 0010), so on Windows
no dropped path resolves, and filesystem grants are Linux-only, so on macOS a
resolved path cannot yet be opened. The stale-XDND-state limitation after a
mid-drag window close is X11-only; AppKit and OLE start the next drag afresh
once the host has stopped GPUI's stale drag.

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
  On macOS an independent AppKit process starts an `NSDraggingSession` from a
  real CoreGraphics mouse-down on its own window and moves the pointer with
  posted CoreGraphics drag events (Escape cancels); on Windows an independent
  WinForms process enters OLE `DoDragDrop` from a real `SendInput` press and
  moves the cursor with `SendInput` (its `QueryContinueDrag` cancels). Neither
  calls into the host or GPUI.

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
dispose with zero remaining resources. The same three fixtures run in Native
macOS and Windows, in development and AOT, through
[`tests/native/macos-drag-source.m`](../../tests/native/macos-drag-source.m)
and [`tests/native/windows-drag-source.cs`](../../tests/native/windows-drag-source.cs);
there plain text is expected to deliver nothing (not `empty`), the source
cancels instead of dropping after a mid-drag window close, Windows resolves
nothing and macOS cannot open a grant. Physical pointer devices, real file
managers (Finder, Explorer), file promises, Wayland and local macOS/Windows
runs are unverified.
