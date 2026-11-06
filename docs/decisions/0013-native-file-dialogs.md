# ADR 0013 — Owned OS file dialogs

Status: accepted; Linux xdg-desktop-portal implementation qualified against
the GTK file chooser backend in development and inspected AOT on an isolated
Xvfb session. Other platforms remain unavailable. Message/confirm dialogs are
decided separately in [ADR 0014](0014-message-dialogs.md) and application menu
bars in [ADR 0015](0015-application-menu-bar.md).

Date: 2026-11-05.

Related: [menus and dialogs #239](https://github.com/0xPlayerOne/bun-native/issues/239),
[shared services #255](https://github.com/0xPlayerOne/bun-native/issues/255),
[filesystem grants #304](https://github.com/0xPlayerOne/bun-native/issues/304),
[trust boundary](0003-bridge-security.md), [service policy](0005-native-service-policy.md)
and [notifications](0009-native-notifications.md).

## Context

The in-window overlay layer covers application-drawn dialogs, menus and
popovers. It cannot open the operating system's file chooser, which users
expect for opening, saving and choosing folders: it knows the user's places,
recent files, mounted volumes and, in a sandbox, the document portal. A
browser-style `<input type="file">` fallback is not offered.

The risks are a dialog that outlives its owner, a selection that silently
turns into filesystem authority, forged results from another process,
unbounded payloads and a request that holds the private channel open while
a user decides.

## GPUI at the pinned revision

[`App::prompt_for_paths` and `App::prompt_for_new_path`](https://github.com/zed-industries/zed/blob/ba63a022c9a22ca66d68ef2a8f0bb9b5b0a9984d/crates/gpui/src/app.rs#L2006-L2030)
call the platform. On Linux, [`gpui_linux`](https://github.com/zed-industries/zed/blob/ba63a022c9a22ca66d68ef2a8f0bb9b5b0a9984d/crates/gpui_linux/src/linux/platform.rs#L819-L940)
sends an xdg-desktop-portal `FileChooser` request through `ashpd` and returns
a oneshot receiver. That API fixes the title (`Open File`/`Open Folder`/`Save
File`), accepts no filters or starting folder for opening, parents the dialog
to the platform's current window rather than a chosen owner, has no bound on
the portal call and gives no handle to close a shown dialog: dropping the
receiver leaves the OS dialog on screen. `Window::prompt` returns `None` on
X11 and Wayland, so GPUI draws its own in-window fallback, not an OS alert.

## Decision

Keep the protocol version and add an optional `file_dialogs_v1` capability, an
immutable default-denied `fileDialogs` launch grant
(`--bun-native-allow-file-dialogs`), owned `show_file_dialog` and
`close_file_dialog` commands, typed `file_dialog_opened`/`file_dialog_closed`
responses and one sequenced `file_dialog_completed` event. The policy field
`file_dialogs` is optional on the wire and omitted when denied, so a
policy object without it remains exact and means denial.

The Linux host talks to `org.freedesktop.portal.FileChooser` directly over its
own session-bus connection (the `zbus` already used for notifications), using
the same portal GPUI uses. This keeps the OS dialog while adding what the GPUI
wrapper lacks: the owner's X11 window as the `x11:<xid>` parent, the caller's
title, accept label, starting folder, suggested save name and glob filters, a
two-second bound on every bus call, and `org.freedesktop.portal.Request.Close`
for cancellation, owner close and shutdown. The capability is advertised when a
session bus is configured; a bus without a portal or without a file chooser
backend reports `service_unavailable` when a dialog is shown.

Modes are `open_file`, `open_files`, `open_directory` and `save_file`. Waiting
for the user is unbounded because that is the dialog's purpose, so the
request completes when the portal shows the dialog and the result arrives as an
event; the private channel never holds a request open across user time.

## Selected paths are data, not authority

A completion carries absolute UTF-8 paths. They are returned to the
application as strings and nothing else: the host attaches no handle, opens no
file and creates nothing (a save selection does not write the file). Bun
Native does not treat a chosen path as permission. Scoped filesystem grants
([ADR 0010](0010-filesystem-grants.md)) open only on launch-policy
`filesystemRoots`, so a chosen path cannot become a grant at run time;
converting a user selection into a grant
([#304](https://github.com/0xPlayerOne/bun-native/issues/304)) would be a
separate, explicit operation outside this decision. Applications that read the path with
ordinary Bun APIs use their own trusted authority, as with any other string.

Non-`file://` URIs, remote hosts, NUL bytes and names that are not valid UTF-8
fail the whole selection as `native_failure`; no partial selection is
returned. More than 256 paths, or a result whose event would exceed one 64 KiB
frame, fails as `payload_too_large`.

## Ownership and lifetime

Each dialog is owned by a live window; a window owns at most one at a time and
a session at most 16. The UI-thread registry decides delivery. Only a
`Response` signal from the bus connection that answered the request, on the
request's handle path, is accepted, so another bus client cannot forge a
selection. A response that arrives before the request reply is processed is
remembered within a fixed bound.

Cancellation, owner close and shutdown remove the entry first, so a response
the portal already queued is never published, then ask the portal to close
the dialog. Shutdown waits, within the bound, for those closes. An aborted
`AbortSignal` before dispatch sends nothing; after the dialog is shown it
rejects with `cancelled` at once and closes the OS dialog. Window close
rejects with `NativeStateError` `invalid_handle`.

## Consequences

- The public surface is `window.showOpenDialog(options, { signal })` and
  `window.showSaveDialog(options, { signal })`, returning frozen
  `{ kind: 'selected', paths }`/`{ kind: 'selected', path }` or
  `{ kind: 'cancelled' }`.
- `serviceCapabilities.fileDialogs` replaces the former unavailable `dialogs`
  record and reports backend `xdg_desktop_portal`; `messageDialogs` was added
  as an unavailable record (now implemented by
  [ADR 0014](0014-message-dialogs.md)).
- Wayland windows are shown unparented, because exporting an `xdg_foreign`
  handle is not implemented; that path is not qualified.
- Flatpak/Snap sandboxes, where the document portal returns `/run/user/.../doc`
  paths, are not qualified.
- macOS (`NSOpenPanel`/`NSSavePanel`) and Windows (`IFileDialog`) report
  `{ availability: 'unavailable', reason: 'unsupported_platform' }`.

## Message and confirm dialogs

Not OS dialogs. Linux has no portal for alerts, and GPUI's `Window::prompt`
falls back to an in-window renderer there that duplicates the overlay layer
while offering no programmatic close. Public core therefore draws
`showMessageDialog`/`showConfirmDialog` on the modal overlay on every
platform; see [ADR 0014](0014-message-dialogs.md). Native `NSAlert` and
Windows task dialogs need their own platform qualification and remain a
possible later backend.

## Application menu bars

GPUI exposes `App::set_menus` with `Menu`/`MenuItem`/`OwnedMenu`. At the pin,
[macOS](https://github.com/zed-industries/zed/blob/ba63a022c9a22ca66d68ef2a8f0bb9b5b0a9984d/crates/gpui_macos/src/platform.rs#L1134-L1149)
installs a native `NSMenu` bar, while
[Linux](https://github.com/zed-industries/zed/blob/ba63a022c9a22ca66d68ef2a8f0bb9b5b0a9984d/crates/gpui_linux/src/linux/platform.rs#L1046-L1054)
and Windows only store the menus for the application to draw itself. Typed action identities, owned menu lifetime, keyboard
behavior and safe action revocation were left out of this decision; the
macOS menu bar is now implemented as described in
[ADR 0015](0015-application-menu-bar.md).

## Verification

Shared fixture cases (`tests/fixtures/native-file-dialogs.json`) run through
both parsers. `tests/core/file-dialogs.test.ts` drives a real Bun subprocess
peer through denial, unavailability, every mode, cancellation before and after
showing, late responses, one-dialog-per-window, owner close, shutdown and
malformed completions; it is headless and never evidence of an OS dialog.
Host unit tests cover URI decoding, response mapping and the frame bound.

`tests/native/file-dialogs.ts` runs in development and inspected AOT on an
isolated Xvfb with openbox, its own D-Bus session, xdg-desktop-portal and the
GTK backend. It requires default denial with no dialog, `service_unavailable`
on a bus without a portal, a real GTK dialog transient for the owner's X11
window, forged `Response` signals from an independent client ignored, real
keyboard selection of a file and a folder, a save selection that creates no
file, Escape cancellation, and the OS dialog closing after an aborted signal,
owner close and shutdown, with all ownership counters at zero.
