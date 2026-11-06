# ADR 0017 — Wayland qualification and service backends

Status: accepted. GPUI's Wayland backend is qualified for windows, paint,
compositor input, display snapshots, notifications, portal file dialogs and
compositor close on one headless sway (wlroots) compositor, in development and
inspected AOT. X11-only services report unavailable under Wayland. Wayland
clipboard, global shortcut, drag-and-drop and popup-window backends are not
implemented; the plan for each is below.

Date: 2026-11-06.

Related: [platform acceptance #246](https://github.com/0xPlayerOne/bun-native/issues/246),
[shared services #255](https://github.com/0xPlayerOne/bun-native/issues/255),
[service policy](0005-native-service-policy.md),
[clipboard](0007-native-clipboard.md), [global shortcuts](0008-native-global-shortcuts.md),
[drag and drop](0012-native-drag-drop.md) and [file dialogs](0013-native-file-dialogs.md).

## Context

The host links `gpui_platform` with both the `x11` and `wayland` features.
At the pinned revision, GPUI picks Wayland whenever `WAYLAND_DISPLAY` is set
([`display_connection.rs`](https://github.com/zed-industries/zed/blob/ba63a022c9a22ca66d68ef2a8f0bb9b5b0a9984d/crates/gpui_linux/src/linux/display_connection.rs#L30-L36)),
so most Linux desktops run the host on Wayland, while every Linux GUI test ran
on Xvfb. Several services were written against X11 directly: clipboard text
(X11 selections), global shortcuts (root-window key grabs), file drops (GPUI's
XDND target) and popup windows (override-redirect windows placed through X11).
Each gates its capability on `cx.compositor_name() == "X11"` and a local X11
display, so under Wayland they were already advertised as unavailable, but no
run had shown that, or that the shared Wayland paths work at all.

## Decision

1. **Qualify on a real compositor, headless.**
   `scripts/quality/native-wayland-session.sh` starts sway 1.9 (wlroots 0.17)
   with `WLR_BACKENDS=headless`, no libinput devices and the pixman renderer,
   one 1280×800 logical output at scale 1 (or 2), XWayland disabled, and
   removes `DISPLAY`/`XAUTHORITY` so no X server is reachable. The application
   renders with Mesa lavapipe through Vulkan, as on Xvfb. sway was chosen over
   weston because its wlroots protocols give an independent oracle for each
   check: IPC `get_tree`/`get_outputs` for mapping, geometry and output scale,
   `[title=…] kill` for an `xdg_toplevel.close`, `zwlr_virtual_pointer_v1`
   and `zwp_virtual_keyboard_v1` for input and `wlr-screencopy` (grim) for
   pixels. weston's headless backend has no client input path without its
   test plugin, which Ubuntu does not ship.
2. **Input devices outlive each action.** The headless backend has no input
   devices, so the seat has no capabilities until a virtual device appears.
   Short-lived tools (wlrctl, a lone wtype) add and remove their device per
   command; the seat capability then appears with the device and the first
   event races the client binding `wl_pointer`/`wl_keyboard` (observed: no
   click at all, and the first typed character lost). The test therefore holds
   one virtual pointer for the whole run
   ([`wayland-input-peer`](../../native/gpui-host/examples/wayland-input-peer.rs),
   built on the `wayland-client` and `wayland-protocols-wlr` versions GPUI
   already locks) and one idle wtype keyboard; typing uses further wtype runs.
3. **Report X11-only services as unavailable before any request.** The host's
   existing gates stay: no `clipboard_text_v1`, `global_shortcuts_v1`,
   `drag_drop_files_v1` or `popup_windows_v1` on Wayland, so core reports
   `{ availability: 'unavailable', reason: 'unsupported_platform' }` and
   rejects `surface: 'window'` overlays with `UnsupportedFeatureError`. Direct
   clipboard and shortcut requests still reach the host and fail at once with
   `service_unavailable`. No `reason` value is added: a new one would be a
   public API change for every service, and `unsupported_platform` already
   means "no backend for this session".
4. **Do not implement Wayland service backends in this change.** Each one has
   a different trust and focus model from X11 (below); none was cheap and safe.

## Plan for the remaining backends

- **Clipboard text.** The client-safe path is `wl_data_device`, which only
  works for the focused client with a recent input serial. GPUI already owns
  that object and reads offers with a pipe timeout, but its read is
  synchronous on the UI thread and its write returns no result, which is why
  the X11 backend did not forward to GPUI ([ADR 0007](0007-native-clipboard.md)).
  A Wayland backend would need a host-owned `wl_data_device` on GPUI's
  connection (or GPUI changes) with the same bounded worker contract, and must
  report `service_unavailable` when the owner is not focused.
  `zwlr_data_control` and `ext-data-control` are not client-safe defaults:
  they read every client's clipboard without focus and are meant for
  clipboard managers, so they will not be used.
- **Global shortcuts.** Wayland has no client-side global grab. The design is
  the `org.freedesktop.portal.GlobalShortcuts` portal: the application binds
  named shortcuts through a user-confirmed session, the user may reassign
  them, and activations arrive over D-Bus. KDE and GNOME 48+ ship backends;
  the GTK backend used by the test session does not. The public contract
  would need a "preferred trigger" and "bound trigger" distinction, so this is
  a separate decision.
- **Drag and drop.** GPUI's Wayland `wl_data_device` file drop path exists but
  is unqualified. Qualifying it needs a Wayland drag source that starts a
  drag from its own pointer grab, which the input peer could provide later.
- **Popup windows.** GPUI implements `WindowKind::AnchoredPopup` on Wayland
  with `xdg_popup` and an `xdg_positioner`, so the compositor, not the
  application, places and constrains the popup. The X11 placement code
  (screen coordinates, clamping, parent tracking) does not apply; a Wayland
  path would use the positioner's anchor/gravity/constraint flags and accept
  that `xdg_popup` grabs dismiss on outside clicks.
- **File dialog parenting.** The portal dialog works but is unparented: the
  portal accepts a `wayland:<handle>` parent from `zxdg_exporter_v2`
  (xdg-foreign), which must be exported on GPUI's own connection and surface.
  That needs either GPUI support or access to its `wl_surface` on its
  connection, so it is follow-up work.
- **Activation.** GPUI already uses `xdg_activation_v1` to activate its own
  windows. Forwarding the token from a notification server's
  `ActivationToken` signal to `xdg_activation_v1` would let notification
  clicks raise the owner window without focus-stealing; not implemented.

## Consequences

- `tests/native/wayland.ts` and its session script run in Native Linux CI in
  development and inspected AOT at scale 1 and in development at output scale 2. The step adds `sway`, `grim` and `wtype` to the pinned apt set.
- The X11 suite is unchanged; the Wayland scenario does not replace it.
- No host code changed: the qualification found no Wayland-specific defect
  in the paths it covers.

## Not qualified

GNOME (Mutter) and KDE (KWin) compositors, fractional scaling
(`wp_fractional_scale_v1`), mixed-DPI or multiple outputs, IME through
`zwp_text_input_v3`, physical input devices and GPUs, server-side decoration
negotiation on other compositors, Wayland clipboard/drag/drop/shortcuts/popups,
and accessibility on Wayland.
