# ADR 0020 — OS context menus

Status: accepted; implemented on macOS and Windows. Hosted CI (`macos-15`,
`windows-2022`) is the only runtime evidence; nothing here has run on a
physical Mac or Windows machine. Linux reports the service unavailable.

Date: 2026-11-10.

Related: [menus and dialogs #239](https://github.com/0xPlayerOne/bun-native/issues/239),
[application menu bar](0015-application-menu-bar.md) and
[message dialogs](0014-message-dialogs.md).

## Context

[ADR 0015](0015-application-menu-bar.md) added the macOS menu bar and left OS
context menus unimplemented. An editor or file list wants the platform's own
right-click menu: its look, keyboard handling and accessibility come from the
OS, and it may extend past the window. GPUI has no context menu API, and both
platforms track a pop-up menu in a nested loop on the UI thread
(`popUpMenuPositioningItem:atLocation:inView:` on macOS, `TrackPopupMenuEx`
on Windows) that returns only when the menu closes.

## Decision

**One method on the window, no grant.** `window.showContextMenu(items,
{ x, y })` opens a menu at a point in logical pixels of the window's content
and resolves the chosen item's id, or `null` when the user dismissed it. The
items are the same closed model as the menu bar (items, separators and
submenus, `enabled`, `checked` and shortcut hints), validated by the shared
parser, with item ids unique within the menu. A menu is user-initiated UI on
the application's own window, like an overlay, so it needs no launch grant;
the optional `context_menus_v1` capability says the host can show one.

**Protocol.** `show_context_menu` (`window_id`, an increasing `menu_id`, `x`,
`y`, `items`) is answered by `context_menu_opened` once the menu is
scheduled; the sequenced `context_menu_completed` event carries the chosen
`item_id`, absent on dismissal. `close_context_menu` ends a live menu and is
answered by `context_menu_closed`; a menu that is closed, or whose owner
closed, never reports a completion. Only one menu is live per application;
another request fails with `limit_exceeded`. No application string becomes a
native action: the host maps item positions to opaque tags and back.

**macOS.** GPUI runs its main-thread work as blocks on the serial main
dispatch queue, and a nested run loop started inside such a block never
drains that queue, so a menu popped up from a GPUI task would freeze every
GPUI callback, including the close request. The host instead schedules the
pop-up with `NSRunLoop.mainRunLoop.performBlock:`, which runs outside the
queue: while the menu tracks, GPUI's queued work keeps running and a close
calls `cancelTracking`. A private target object records the chosen item's
tag. `y` is flipped because GPUI's view is not flipped.

**Windows.** GPUI posts one wake message for its queued main-thread work
and posts no other while one of those tasks runs, so a menu entered from a
GPUI task would stall every later task, including the close request. The
host instead posts a message to its own message-only window and enters
`TrackPopupMenuEx` (`TPM_RETURNCMD`) from that window's procedure, outside
GPUI's queue: the menu loop dispatches GPUI's wake messages, so GPUI keeps
running and a close calls `EndMenu`. The point is scaled to physical pixels
and mapped with `ClientToScreen`. Shortcuts are shown as right-aligned hints
(`Ctrl+Shift+S`); they bind nothing.

**Core.** The menu is cancelled by an abort signal (which sends
`close_context_menu`), rejected with `invalid_handle` when the owner window
closes and with the usual state error at shutdown. A completion naming an
item the menu was not given fails the channel.

## Consequences

- Shortcut hints on a context menu are text only; the application binds keys
  itself, as for the menu bar.
- One live menu per application matches both platforms' tracking loop.
- Linux has no backend: GPUI's X11 and Wayland backends have no native menu,
  and an in-window overlay menu remains the portable choice there.
- Not implemented: Dock menus, dynamic validation while open, icons, and
  positioning relative to an element rather than a point.

## Verification

`tests/protocol/context-menus.test.ts` and the shared
`tests/fixtures/native-context-menus.json` fixture check both language
implementations of the wire. `tests/core/context-menus-native.test.ts` drives
core against a headless peer: wire fields, nested choice, dismissal,
validation, `limit_exceeded`, abort with a late completion, owner close and a
foreign item id. The native platforms workflow runs
[`tests/native/context-menus.ts`](../../tests/native/context-menus.ts) on
hosted macOS and Windows against independent accessibility oracles
([`macos-context-menu-oracle.m`](../../tests/native/macos-context-menu-oracle.m),
[`windows-context-menu-oracle.ps1`](../../tests/native/windows-context-menu-oracle.ps1)):
the shown items, a top-level and a nested choice, Escape, abort, owner close
and shutdown.
