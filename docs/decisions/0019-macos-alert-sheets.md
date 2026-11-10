# ADR 0019 — macOS alert sheets for message and confirm dialogs

Status: accepted; implemented. Hosted macOS CI (`macos-15`) is the only
runtime evidence; nothing here has run on a physical Mac.

Date: 2026-11-10.

Related: [menus and dialogs #239](https://github.com/0xPlayerOne/bun-native/issues/239),
[message dialogs](0014-message-dialogs.md) and
[Windows task dialogs](0018-windows-task-dialogs.md).

## Context

[ADR 0018](0018-windows-task-dialogs.md) added an OS backend for
`showMessageDialog` and `showConfirmDialog` on Windows behind the optional
`task_dialogs_v1` capability and the `taskDialogs` grant, and left `NSAlert`
as a later value. On macOS an alert can run app-modally (`runModal`, a nested
event loop on the main thread, which is GPUI's thread) or as a document-modal
sheet on a window (`beginSheetModalForWindow:completionHandler:`).

## Decision

**Same capability, grant and API.** The macOS host advertises
`task_dialogs_v1` and honors the same `--bun-native-allow-task-dialogs` launch
flag. There is no new command, event or protocol version. Core reports
`serviceCapabilities.messageDialogs.backend` as `'alert_sheet'` on macOS and
`'task_dialog'` on Windows; the host runs beside core, so its platform names
the backend, as it already does for drops and filesystem grants.

**A sheet on the owner window.** Each dialog is an `NSAlert` attached to the
owner `NSWindow` as a sheet. A sheet needs no nested loop, so the host stays
on GPUI's main thread with no worker thread, only the owner window is
blocked, and the one-dialog-per-window rule matches one sheet per window.
The completion handler only queues the result; a GPUI task applies it, so
AppKit never re-enters the host's registry.

**Closed, bounded mapping.** `title` becomes the bold message text (a sheet
has no title bar), `message` and `detail` the informative text. Buttons keep
their order (AppKit draws the first rightmost) and their response is
`NSAlertFirstButtonReturn + index`. Every button's key equivalent is set
explicitly: Return for `defaultButton`, Escape for `cancelButton`, none for
the rest, which replaces AppKit's title-based assignments.

**Revocation.** Abort, owner close and shutdown call
`endSheet:returnCode:` with `NSModalResponseAbort`. The registry entry is
already closing, so no completion event follows; an abort response on a live
entry would be reported as `failed`.

## Consequences

- Each button owns at most one key. When the cancel button is also the
  default button it keeps Return and Escape does nothing.
- A sheet has no close box, so a `dismissible` dialog without a
  `cancelButton` can only end through a button or the application.
- Button `kind` and the default theme are ignored, as on Windows.
- A sheet requested while another sheet (not created by this service) is
  attached to the window would queue behind it; this service never creates
  such a sheet.

## Verification

- Host unit tests (every platform) cover the text and key mapping;
  `bun-native-macos-surface` tests (macOS) cover button bounds, key
  ownership and response mapping.
- The macOS job runs [`tests/native/task-dialogs.ts`](../../tests/native/task-dialogs.ts)
  against the real host in development. An independent Accessibility oracle
  ([`macos-alert-oracle.m`](../../tests/native/macos-alert-oracle.m)) finds
  the sheet by its text, reads its buttons, presses them with `AXPress` and
  types real Return and Escape keys; the run covers button choice, Escape to
  the cancel button, ignored Escape, Return to the default button, abort,
  queueing, confirm, owner close and shutdown. The step fails if the runner
  does not trust the oracle.
