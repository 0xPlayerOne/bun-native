# ADR 0015 — Application menu bar

Status: accepted; macOS implementation exercised only in hosted CI
(`.github/workflows/native-platforms.yml`), not on a local Mac. Linux and
Windows report the service unavailable. OS context menus remain unimplemented.

Date: 2026-11-06.

Related: [menus and dialogs #239](https://github.com/0xPlayerOne/bun-native/issues/239),
[shared services #255](https://github.com/0xPlayerOne/bun-native/issues/255),
[service policy](0005-native-service-policy.md),
[global shortcuts](0008-native-global-shortcuts.md) and
[file dialogs](0013-native-file-dialogs.md#application-menu-bars).

## Context

Desktop applications on macOS are expected to put their commands in the
menu bar, with key equivalents shown beside them. The in-window overlay layer
can draw menus, but not the system menu bar. ADR 0013 recorded GPUI's menu
API and left typed action identities, owned lifetime and safe revocation as
the open questions.

The risks are an application naming arbitrary GPUI actions through the wire,
a selection of a replaced menu reaching the new listener, menus or shortcuts
outliving the session, unbounded payloads and claiming a menu bar on a
platform that never shows one.

## GPUI at the pinned revision

[`App::set_menus`](https://github.com/zed-industries/zed/blob/ba63a022c9a22ca66d68ef2a8f0bb9b5b0a9984d/crates/gpui/src/app.rs#L2875-L2879)
passes `Menu`/`MenuItem` values to the platform with the current keymap.

- **macOS** [builds an `NSMenu`](https://github.com/zed-industries/zed/blob/ba63a022c9a22ca66d68ef2a8f0bb9b5b0a9984d/crates/gpui_macos/src/platform.rs#L1134-L1149)
  and makes it the application's main menu. Each action item gets the
  `handleGPUIMenuItem:` selector and a tag indexing a platform list of boxed
  actions; selection calls `App::dispatch_action`, which reaches global
  `on_action` listeners. A menu item's key equivalent is taken from the first
  keymap binding for an equal action. The list of boxed actions only grows:
  every `set_menus` call appends its items for the process lifetime.
- AppKit enables menu items automatically. GPUI's `validateMenuItem:`
  answers with `App::is_action_available`, which is true for any action type
  that has a global listener. That answer overrides `MenuItem::disabled`, and
  a submenu item is enabled whenever it has a submenu.
- AppKit shows the first menu under the process name, whatever its title.
  GPUI makes a top-level menu titled exactly `Window` AppKit's Windows menu,
  to which AppKit appends its window list.
- **Linux** and **Windows** [only store the menus](https://github.com/zed-industries/zed/blob/ba63a022c9a22ca66d68ef2a8f0bb9b5b0a9984d/crates/gpui_linux/src/linux/platform.rs#L1046-L1054)
  for an application to draw itself. Nothing is shown.

## Decision

**Optional capability.** The host advertises `app_menu_v1` only on macOS
(`cfg!(target_os = "macos")`). There is no protocol version change: the
command, reply and event are additive, the `app_menu` policy field is
optional on the wire like `file_dialogs`, and core rejects locally with
`NativeServiceError('app_menu', 'service_unavailable')` when the capability
is missing. Linux and Windows hosts reply `service_unavailable` to a raw
request.

**Explicit grant.** `permissions.appMenu: 'allow'` passes
`--bun-native-allow-app-menu` at launch. Without it core rejects with
`permission_denied` before any request, and the host does the same.

**Application scope.** A menu bar belongs to the application, not to a
window: closing a window leaves it installed. `app_menu_item` is the first
sequenced event without a `window_id`; the runtime exposes it as
`ApplicationEvent` alongside `WindowEvent`.

**Closed, bounded model.** `set_app_menu { menu_id, menus }` carries at most
16 top-level menus and 128 entries in all; an entry is an item, a separator
or a submenu, and submenus nest at most two levels below a top-level menu.
Titles and labels are 1-64 UTF-8 bytes without control characters. An item
`id` is 1-64 bytes of `A-Z a-z 0-9 . _ : -`, unique in the bar. A shortcut
names one key from a closed set (`a`-`z`, `0`-`9`, `f1`-`f12`, eleven
punctuation keys and fourteen named keys) and explicit control, alt, shift
and platform flags; every key except `f1`-`f12` needs control, alt or
platform, and shortcuts are unique in the bar. Those bounds keep the largest
valid bar inside one 64 KiB frame. An empty `menus` removes the bar. Rust and
TypeScript validate the same fixture file.

**Opaque actions.** Nothing on the wire names a GPUI action. The host builds
each item with `AppMenuAction { menu, item }`, a registry slot of the
current `menu_id`, and reports the selection as the application's item id.
`menu_id` must increase across the session.

**Revocation.** Installing a bar (or an empty one) replaces the host registry,
so a selection that still carries an older `menu_id` (an AppKit callback
queued before the replacement, a stale binding) is ignored. Core revokes the
previous handle synchronously when `setMenuBar`, `clearMenuBar` or a handle's
`clear()` is called, and drops any queued or late event for it. Shutdown and
disconnect revoke the registry and install an empty bar.

**Disabled items.** Because GPUI's validation overrides `disabled`, a
disabled item (or any item under a disabled submenu) gets a different action
type, `DisabledAppMenuAction`, which nothing listens for: AppKit then
disables it, and its shortcut, still shown, dispatches nothing. A disabled
submenu therefore still opens on macOS, with every item disabled.

**Shortcuts.** On every install the host rebuilds the keymap: it clears it,
restores the host's own input and view bindings and adds the current bar's
shortcuts. The menu bindings use the `NativeWindow` context, the owned
window's root, so a deeper focused control keeps its own keys (a focused text
input's Command-C still copies). Outside a GPUI window AppKit's key
equivalent selects the item directly.

**Standard items.** The host adds nothing: no About, Services, Hide or Quit
item, and no Edit or Window menu. GPUI requires none of them. An application
that wants Quit adds an item (usually Command-Q) and calls `app.shutdown()`
from its listener; without one, Command-Q does nothing. Quitting from the
Dock keeps GPUI's existing behavior and is not changed here.

## Consequences

- Checked and enabled state is static per bar: to change it the application
  sets a new bar, which revokes the old item handles.
- GPUI's macOS backend retains a boxed action for every item of every bar set
  during the process, and AppKit may add its own items to a menu titled
  `Window`. Both are outside this host's control and documented, not hidden.
- The host's own key bindings are rebuilt on each install; a future host
  binding must be added through the same functions.
- Linux and Windows have no menu bar. An in-window overlay menu remains the
  portable choice there.
- Not implemented: OS context menus, the Dock menu, dynamic item validation,
  menu roles beyond what AppKit infers, mnemonics and accessibility labels
  beyond the item titles.

## Verification

- Shared fixtures (`tests/fixtures/native-app-menu.json`) run through the
  Rust and TypeScript parsers, and a Rust test proves the largest valid bar
  fits a frame.
- Host unit tests (Linux) cover the pure registry: GPUI menu structure,
  opaque slots, the disabled action type, revocation on replacement and
  clearing, increasing identities, and that every shortcut in the grammar
  parses as the intended GPUI keystroke.
- Core tests against a headless subprocess peer cover validation without a
  request, local gating, event delivery, stale selections, idempotent clear,
  shutdown revocation and host faults.
- A development-profile Linux host on Xvfb reports no `app_menu_v1`; core
  rejects with `service_unavailable` and the raw host request returns
  `service_unavailable` (granted) or `permission_denied` (denied).
- On macOS, [`tests/native/app-menu.ts`](../../tests/native/app-menu.ts) runs
  in development and inspected AOT in the hosted macOS job. An independent
  Accessibility oracle ([`macos-menu-oracle.m`](../../tests/native/macos-menu-oracle.m))
  reads the host's `AXMenuBar` (titles, separators, check marks, enabled
  state, key equivalents and modifiers) and performs `AXPress` by title. If
  the runner does not trust the oracle for Accessibility, the report says
  `unverified` and the job prints a warning; nothing is assumed. This
  macOS code has not been compiled or run outside hosted CI.
