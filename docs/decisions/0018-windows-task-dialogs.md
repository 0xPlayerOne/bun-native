# ADR 0018 — Windows task dialogs for message and confirm dialogs

Status: accepted; implemented. Nothing here is qualified on a real Windows
desktop; hosted Windows CI is the only runtime evidence, and it has not run yet.

Date: 2026-11-06.

Related: [menus and dialogs #239](https://github.com/0xPlayerOne/bun-native/issues/239),
[message dialogs](0014-message-dialogs.md),
[file dialogs](0013-native-file-dialogs.md) and
[application menu bar](0015-application-menu-bar.md).

## Context

[ADR 0014](0014-message-dialogs.md) draws message and confirm dialogs on the
modal overlay on every platform and left an OS backend as a later value of
`serviceCapabilities.messageDialogs.backend`. Issue #239 keeps the OS-native
part open. On Windows the OS offers the task dialog (`TaskDialogIndirect`):
custom button labels and ids, a main instruction, content, a default button,
Escape/close-box cancellation, system sounds and accessibility roles, and a
modal relationship to an owner window.

Three constraints shape the design:

1. **No nested loop on GPUI's thread.** `TaskDialogIndirect` (like
   `MessageBoxW`) runs its own message loop and returns only when the dialog
   ends. Running it on GPUI's UI thread would re-enter GPUI's window procedure
   and stall every other window, command and timer for as long as the dialog
   is open.
2. **Common Controls 6.** `TaskDialogIndirect` exists only in comctl32
   version 6, which a process gets from a side-by-side manifest. The host has
   no manifest today, so the import would fail to resolve.
3. **Programmatic close.** The overlay can be removed on abort, owner close
   and shutdown. A native dialog needs the same: a pending dialog must lose
   authority without leaked modality or a late result.

## Decision

**Same public API, second backend.** `showMessageDialog` and
`showConfirmDialog` keep their options, validation, queueing (one dialog per
window, at most 8) and result shape. Core uses the OS backend when the host
advertises the optional `task_dialogs_v1` capability and the application
launched with `permissions.taskDialogs: 'allow'`; otherwise it keeps the
overlay. `serviceCapabilities.messageDialogs.backend` becomes `'task_dialog'`
when the OS backend is in use. The grant exists because an OS-chrome dialog
carries system authority an in-window layer does not (it can be mistaken for
a system prompt), matching the file-dialog and application-menu precedents.
Linux and macOS hosts do not advertise the capability.

**Worker thread, owner window.** The host shows each dialog from a dedicated
thread with the owner window's `HWND` as `hwndParent`. The OS disables the
owner while the dialog is open; GPUI's UI thread keeps pumping messages. One
dialog per window; the worker is joined when the dialog ends. The owner
handle is read on the UI thread when the command arrives.

**Closed, bounded mapping.** Wire options are the validated ADR 0014 options
(1-4 buttons). Button `i` gets the custom id `1000 + i`. `title` is the window
title, `message` the main instruction and `detail` the content. The default
button is `nDefaultButton`. `kind` has no task-dialog equivalent and is
ignored. `TDF_ALLOW_DIALOG_CANCELLATION` is set exactly when the dialog has a
`cancelButton` or is `dismissible`, so Escape and the close box otherwise do
nothing, as on the overlay. A cancellation resolves to `cancelButton`, else
`dismissed`.

**Manifest.** `build.rs` for the Windows MSVC target passes
`/MANIFEST:EMBED` and a `/MANIFESTDEPENDENCY` on Common-Controls 6.0.0.0 to
the linker for the host binary. If the import still cannot be resolved the
host reports `service_unavailable` instead of advertising the capability.

**Revocation.** The UI thread owns the registry. Removing an entry stops
delivery at once, then `TDM_CLICK_BUTTON` is posted to the dialog window to
end it. A result that races a close is dropped. Owner close, abort and
shutdown close the dialog this way; shutdown joins the worker with a bound
and reports a stuck dialog instead of waiting forever.

## Consequences

- The Windows host gains a manifest and a capability, a launch flag, two
  commands and events following the file-dialog shape, and a TypeScript core
  routing branch.
- Native dialogs block the owner window at the OS level and play system
  sounds; they do not honor the default theme and ignore button `kind`.
- A dialog whose owner is minimized or hidden is still shown by the OS.
- Only Windows is covered; `NSAlert` stays a possible later value.

## Verification

Planned: shared fixtures through the Rust and TypeScript parsers; host unit
tests of the button mapping and registry on every platform; core tests
against a subprocess peer for routing, fallback, abort, owner close and
shutdown; a Windows hosted run that opens a dialog with a real host and
completes it by clicking a button with `UI Automation` or `TDM_CLICK_BUTTON`
from an independent process, and that closes one by owner close.
