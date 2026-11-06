# Native overlays, modal focus and scroll anchoring

This is the first implemented slice of [BN4 #239](https://github.com/0xPlayerOne/bun-native/issues/239): one shared overlay element for dialogs, menus and popovers, a modal focus scope, focus return after dismissal, and a scroll anchor that keeps streaming content at its end. The GPUI host, the Rust and TypeScript validators and public core own one implementation. Solid and React expose the same `overlay` intrinsic through the shared renderer; neither adapter has its own layer, focus or dismissal logic.

There is no protocol version change. The host advertises two **optional** capabilities on protocol 8: `overlays_v1` (the `overlay` element) and `scroll_anchor_v1` (the `scroll_anchor` style field). Public core rejects either feature locally with `UnsupportedFeatureError` (`element:overlay`, `style:scroll_anchor`) when the connected host does not advertise it, so an older host never receives an unknown element. The current GPUI host always advertises both, on every platform it builds for.

Keyboard-driven overlays add three more optional capabilities, still on protocol 8: `focus_v1` (the batch `focus` request), `scroll_control_v1` (the batch `scroll_to` and `scroll_into_view` requests) and `overlay_keyboard_v1` (the overlay `autofocus` and `navigation` fields). Core rejects them locally on a host that lacks them (`operation:focus`, `operation:scroll_to`, `operation:scroll_into_view`, `overlay:autofocus`, `overlay:navigation`). Explicit defaults (`autofocus: false`, `navigation: 'tab'`) normalize away and still reach an older overlay host. See [Keyboard menus, programmatic focus and scrolling](#keyboard-menus-programmatic-focus-and-scrolling).

For a ready-made modal question, `window.showMessageDialog` and `window.showConfirmDialog` build one window-anchored modal layer through this contract and handle its input in core; see [message and confirm dialogs](native-services.md#message-and-confirm-dialogs).

## Element contract

```ts
import { createApplication, onDismiss } from '@bun-native/core'

const dialog = await window.batch((batch) => {
  const layer = batch.create({
    kind: 'overlay',
    modal: true,
    style: { align_items: 'center', justify_content: 'center', background: 0x334455 },
  })
  const panel = batch.create({ kind: 'box', style: { width: 260, padding: 12, background: 0xffffff } })
  batch.append(window.root, layer)
  batch.append(layer, panel)
  batch.append(panel, batch.create({ kind: 'button', text: 'Confirm' }))
  return layer
})
onDismiss(window, dialog, () => window.batch((batch) => batch.remove(dialog)))
```

| Field    | Values                                        | Meaning                                                                                                                                                                                                                           |
| -------- | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `anchor` | `window` (default), `parent`                  | `window` covers the whole viewport and blocks pointer input, including wheel scrolling, to everything beneath it. `parent` is content-sized below its parent's bottom-left corner and shifted to stay 8 pixels inside the window. |
| `modal`  | boolean, default `false`                      | Traps Tab/Shift-Tab, moves focus into the layer and routes unfocused keys to it. Only window overlays may be modal; `{ anchor: 'parent', modal: true }` is rejected by both validators.                                           |
| `style`  | The complete [layout](native-layout.md) style | An overlay is a column container like a box and may scroll. A window overlay's size is forced to the viewport, so `width`/`height` do not apply to it; position its content with `align_items`, `justify_content` and `padding`.  |

Overlays own ordered children and may contain further overlays, up to **8** nested overlay layers (`MAX_OVERLAY_DEPTH`, the outermost counting as one). Ordinary boxes inside an overlay do not count. Deeper nesting fails the whole batch with `limit_exceeded` in core preflight and again in the Rust model. GPUI processes each nested deferred layer in a separate prepaint round and asserts at ten rounds; the bound keeps the host below that with the diagnostics observer included. Normalized overlays always carry `anchor` and `modal`.

## Z-order and pointer input

Each overlay renders an absolutely positioned, zero-size placeholder in its parent's flow and paints its content through a GPUI deferred layer. Layers paint above the ordinary tree, escape ancestor clipping and are ordered by **(nesting depth, tree order)**: a nested overlay paints above every shallower overlay, and among equal depths a later sibling paints above an earlier one. Hit testing follows the same order. Overlay content occludes pointer input beneath its own bounds, so a press on a popover never also activates a control under it. A window overlay's occluding surface is the whole viewport.

The native pointer observer is itself deferred above every overlay while any overlay is live, so `pointer_down`/`pointer_up` still target the deepest visible model node. A press on a window overlay outside its children targets the overlay node itself: that is the backdrop press. A press outside a parent-anchored overlay reaches the UI beneath it normally.

## Modal focus and focus return

The host derives the layer stack from the committed tree after every batch; it holds no callbacks.

- The **active modal** is the modal overlay highest in the paint order. Tab and Shift-Tab cycle only through its enabled buttons and inputs in tree order and wrap. Without an active modal, GPUI's native tab order is unchanged.
- When a modal becomes active and focus is outside it, focus moves to its first enabled control. If it has none, outside focus is blurred and key events target the overlay node itself, so Escape still reaches it.
- Every overlay records the control that was focused when it first committed. When overlays are removed and no control is focused afterward (removal blurs a control inside the removed subtree), focus returns to the recorded control of the outermost removed overlay, if that control is still live, enabled and inside the active modal when one remains. Closing a nested modal therefore returns to the control in its parent dialog; closing both together returns to the control focused before the outer one opened.
- Focus return re-focuses the same native editor entity, so its value, caret and selection survive. Non-modal overlays never take focus on open; focus inside them returns on close in the same way.
- `focus`/`blur` events report every transition through the existing [interaction contract](native-events.md).

## Dismissal and callback lifetime

The native host performs no implicit dismissal. `onDismiss(window, overlay, listener)` from `@bun-native/core` composes the existing public events:

- `escape`: an unmodified `escape` key-down whose captured route passes through the overlay. It is handled while bubbling, so the innermost overlay sees it first and stops propagation: one press closes one layer.
- `backdrop`: a `pointer_down` whose target is the overlay node itself (for a parent-anchored overlay, its own padding outside its children).

The helper occupies the overlay's bubbling `key_down` and `pointer_down` registrations; capture listeners remain available. Its returned function revokes both. Removing the overlay, closing the window and shutdown revoke every registration inside the removed subtree through the existing listener ownership rules, including queued deliveries: a second Escape queued behind an awaiting dismissal that removes the overlay is never delivered.

## Scroll anchoring under streaming updates

`scroll_anchor: 'end'` is valid only with `overflow: 'scroll_y'` or `'scroll'`, on boxes and overlays. Before each render, a viewport whose vertical offset is within one logical pixel of its previous maximum is pinned: GPUI places it at the new end during that frame's layout, after appended content or a viewport resize. A user wheel scroll away from the end releases it, and later appends preserve that offset exactly. Scrolling back to the end pins it again. An initially empty or non-overflowing viewport starts pinned. `start` and omission keep the ordinary top-anchored behavior. The anchor is vertical only; horizontal anchoring is rejected.

## Keyboard menus, programmatic focus and scrolling

### Overlay fields (`overlay_keyboard_v1`)

| Field        | Values                   | Meaning                                                                                                                                                                                                                                                                                                         |
| ------------ | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `autofocus`  | boolean, default `false` | When the layer first commits, focus moves to its first enabled control (controls of nested overlays excluded). This lets a **non-modal** popover, including a parent-anchored one, take focus; focus returns on close by the rule above. Inside an active modal, only a layer within that modal can take focus. |
| `navigation` | `tab` (default), `menu`  | `menu` makes the layer a roving-focus menu, described below. Tab and Shift-Tab are unchanged.                                                                                                                                                                                                                   |

With `navigation: 'menu'`, while focus is on a control whose innermost overlay is the menu layer:

- **Down/Up** move focus to the next/previous enabled button or input of that layer in tree order and wrap; **Home/End** move to the first/last. Disabled buttons and controls inside nested overlays are skipped. A focused input keeps its own Home/End caret keys, but Up/Down leave it, so a filter field above the items works.
- **Type-ahead**: a printable key without Control, Alt, Platform or Function, while a menu **button** is focused, moves focus to the next button whose label (leading whitespace ignored) starts with the typed text, case-insensitively. Keys within one second extend the search; repeating one character cycles through the labels that start with it. Space and Enter still activate the focused button.
- These keys are still delivered as ordinary `key_down`/`key_up` events. `onDismiss` handles Escape as before, so an autofocused menu closes on Escape.

### Batch requests (`focus_v1`, `scroll_control_v1`)

```ts
await window.batch((batch) => {
  batch.focus(saveButton) // an enabled button or an input
  batch.scrollTo(list, { y: 0 }) // logical pixels from the content start; omitted axis unchanged
  batch.scrollIntoView(selectedRow)
})
```

The requests travel as `focus`, `scroll_to` and `scroll_into_view` batch operations. Both validators check them against the batch's **final** tree, after every create, set, insert and delete, so a request can target a node created in the same batch and the whole batch fails if the target is removed, disabled or (for `focus`) outside the active modal (`invalid_handle` or `invalid_state`). `scroll_to` needs a scrolling box or overlay whose overflow scrolls on each given axis; offsets must be finite, between 0 and 1 000 000 (`MAX_SCROLL_OFFSET`), and at least one axis is required. The host applies requests in order after the tree commit and after modal or `autofocus` focus moves, so an explicit request wins. It clamps `scroll_to` to the laid-out maximum during the next frame, and a programmatic scroll is not re-pinned by an `end` scroll anchor in that frame.

`scrollIntoView(node)` scrolls each scrolling ancestor, from the node outward and stopping at the node's own overlay layer, so that the ancestor's **child on the node's route** is fully visible with the least movement (its top if it is taller than the viewport). For a direct child, such as a menu or list item, that is the node itself; for a deeper descendant the whole containing child is revealed.

**Focus scrolls into view.** Every focus move the host makes (`focus` requests, Tab and Shift-Tab, menu arrows, type-ahead, modal and `autofocus` entry, focus return) reveals the focused control the same way. Pointer focus never scrolls.

Solid and React expose the same requests on refs: `focusNode(ref)`, `scrollNodeTo(ref, { x, y })` and `scrollNodeIntoView(ref)` wait for staged renderer changes to commit, then send one request batch; overlays accept `autofocus` and `navigation` properties.

### Focus rings

A keyboard-focused enabled button draws an inset ring: a 1-pixel white edge over a 2-pixel dark (`0x101828`) band, visible on light and dark backgrounds. A focused input always draws it. Buttons follow GPUI's focus-visible rule: the ring appears only after keyboard input, not after a click. The ring is inset, so it never changes layout and ancestor clipping never hides it; it is not themeable.

## Verification

| Check                                                                                                                                                         | Command                                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Shared accept/reject corpus ([`overlays.json`](../tests/fixtures/overlays.json)), normalization, nesting bound, modal anchoring and kind-preserving `set`     | `cargo test --locked -p bun-native-protocol overlay` and `bun test tests/protocol/overlays.test.ts` |
| Request wire shape, final-tree validation, active modal scope and offset bounds                                                                               | `cargo test --locked -p bun-native-protocol request` and `bun test tests/core/focus-scroll.test.ts` |
| Capability gating of each request and overlay field, focus events, adapter refs and properties (headless subprocess)                                          | `bun test tests/core/focus-scroll.test.ts tests/react/focus.test.tsx`                               |
| Capability gating, preflight nesting, innermost Escape, backdrop targeting, unsubscribe/removal disposal and discarded queued callbacks (headless subprocess) | `bun test tests/core/overlays.test.ts`                                                              |
| Shared renderer `overlay` intrinsic properties                                                                                                                | `bun test tests/renderers/overlay-nodes.test.ts`                                                    |
| Real host, real XTest input, native paint geometry and screenshots, development and AOT                                                                       | [`tests/native/overlays.ts`](../tests/native/overlays.ts), below                                    |

The native fixture drives only public core. It reads click positions from the host's nonce-tagged paint evidence instead of assuming geometry:

```sh
export BUN_NATIVE_HOST="$PWD/target/release/bun-native-host"
for mode in development aot; do
  command=(bun tests/native/overlays.ts)
  if [[ "$mode" == aot ]]; then
    bun experiments/aot-gpui/build-window.ts --entry overlays --host "$BUN_NATIVE_HOST" \
      --host-profile release --outdir "$PWD/.bun-native/overlays-package"
    command=("$PWD/.bun-native/overlays-package/overlays")
  fi
  evidence="$PWD/.bun-native/overlays-$mode"; mkdir -p "$evidence"
  BUN_NATIVE_OVERLAY_EVIDENCE="$evidence" BUN_NATIVE_OVERLAY_MODE="$mode" \
    BUN_NATIVE_EVIDENCE_LOG="$evidence/native-evidence.jsonl" \
    BUN_NATIVE_EVIDENCE_NONCE="$(python3 -c 'import secrets; print(secrets.token_hex(16))')" \
    xvfb-run --auto-servernum --server-args='-screen 0 1280x800x24 -nolisten tcp' \
    dbus-run-session -- bash scripts/quality/native-linux-session.sh "$evidence-session" -- "${command[@]}"
done
```

The required Native Linux job runs this in development and AOT against its release host. Locally, both modes passed on Linux X11 (Xvfb + openbox, XTest via xdotool, Mesa llvmpipe, scale 1) with a development-profile host; the AOT manifest recorded the JIT as unused. Each run writes `overlays.json` plus three screenshots:

| Outcome                    | Observed                                                                                                                                                                                                                                                |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Modal focus trap           | Opening moved focus to `Confirm`; Tab, Tab, Shift-Tab produced `confirm, cancel, confirm, cancel` and never left the dialog. The screenshot pixel over the covered opener was the backdrop color.                                                       |
| Backdrop blocks pointer    | A real click on the covered opener targeted the overlay (`backdrop`), produced no button click and left focus in the dialog.                                                                                                                            |
| Nested modal               | Focus moved to the inner control and stayed there through Tab/Shift-Tab. Escape dismissed only the inner layer, focus returned to `Cancel`, and its dismissal registrations were revoked.                                                               |
| Focus and selection return | Escape closed the dialog; focus returned to the editor with its `lo` selection intact, so typing `X` produced `helX`. The dialog's callbacks were revoked.                                                                                              |
| Control-less modal         | Opening blurred the editor; Escape reached the overlay node, closed it and focus returned to the editor.                                                                                                                                                |
| Parent-anchored popover    | Its item painted 4 pixels (the popover padding) below its parent, over the next sibling; the displayed pixel was the popover color, a real click activated only the popover item, and focus never moved.                                                |
| Streaming scroll           | Eight 4-row appends kept the 64-pixel viewport at its growing end (maximum 52 → 864). Two wheel-ups released it at −690; a further append kept −690 while the maximum grew; wheeling back to the end pinned it again (offset −1096 = −maximum).         |
| Keyboard menu              | A parent-anchored `autofocus` + `menu` popover took focus on `Copy` without being modal. Down, Down, Down (skipping disabled `Rename`), Up, End, Home, Up (wrap) and Down (wrap) visited `cut, paste, delete, paste, duplicate, copy, duplicate, copy`. |
| Type-ahead                 | `d` → `Delete`, `d` → `Duplicate` (cycling), then after a pause `pa` → `Paste`, `c` → `Copy`, `u` (extending `cu`) → `Cut`.                                                                                                                             |
| Focus ring                 | Screenshot pixels on the keyboard-focused `Cut`: edge `ffffff`, band `101828`; the same offset on unfocused `Copy` was the plain `2255cc`.                                                                                                              |
| Menu activation and return | Enter clicked only `Cut`; Escape dismissed the popover and focus returned to the editor focused before it opened.                                                                                                                                       |
| Programmatic focus         | `focus(Option 9)` in a 100-pixel list of twelve 44-pixel buttons focused it and scrolled the list to −340 so it was fully visible.                                                                                                                      |
| Programmatic scroll        | `scrollTo` y 0 → 0, y 50 → −50 exactly, y 100 000 → clamped to −428 (= −maximum); `scrollIntoView(Option 11)` → −428.                                                                                                                                   |
| Tab reveals focus          | Tab, Tab from `Option 1` focused `Option 3` and scrolled the list to −76 to show it.                                                                                                                                                                    |
| Ownership                  | Window close and shutdown left all seven public ownership counters at zero.                                                                                                                                                                             |

## Popup windows beyond the parent window

A parent-anchored overlay with `surface: 'window'` paints into an **owned OS popup window** instead of an in-window layer, so a menu may extend past its parent window's edges. It requires the optional `popup_windows_v1` capability; core rejects it locally with `UnsupportedFeatureError('overlay:surface_window')` otherwise. There is no protocol version change.

```ts
const menu = batch.create({
  kind: 'overlay',
  anchor: 'parent',
  surface: 'window',
  style: { width: 220, height: 160, padding: 4, background: 0xf4e3c1 },
})
batch.append(triggerBox, menu)
batch.append(menu, batch.create({ kind: 'button', text: 'Copy' }))
onDismiss(window, menu, () => window.batch((batch) => batch.remove(menu)))
```

| Rule               | Contract                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shape              | `anchor` must be `parent` (so never modal), and `style.width`/`style.height` must be fixed pixels of at least 1: the popup window has that logical size. `surface: 'layer'` is the default and is omitted from normalized output. Shared corpus: [`popup-windows.json`](../tests/fixtures/popup-windows.json).                                                                                                                            |
| Content            | Boxes, text and buttons. An `input` or any `overlay` anywhere beneath a popup surface fails the whole batch with `invalid_state` in core and in the Rust model, because keyboard focus never moves to the popup. A popup may itself sit inside a layer overlay, such as a modal dialog.                                                                                                                                                   |
| Ownership          | The content stays in the parent window's model tree and is drawn by the same `NativeView` renderer and element code. The popup window closes when its node leaves the tree, when the parent window closes, and at shutdown.                                                                                                                                                                                                               |
| Placement          | Below the parent node's bottom-left corner in screen coordinates; flipped above the parent node when only that fits vertically; otherwise shifted onto the X screen, as is the horizontal position. It is placed again when the parent window moves or the popup is resized by `set`.                                                                                                                                                     |
| Pointer            | Presses and clicks in the popup reach its nodes. `pointer_down`/`pointer_up` coordinates stay in the **parent window's** logical space, so they may lie outside its viewport. A press on the popup itself, outside its children, is a `backdrop` dismissal like other overlays.                                                                                                                                                           |
| Keyboard and focus | The parent window keeps keyboard focus and stays the active window. While a popup is open, the parent window's key events target the topmost popup node, so an unmodified Escape reaches `onDismiss`. Typing still edits the parent's focused editor natively; only the routed key events target the popup. A popup surface therefore rejects `autofocus` and `navigation: 'menu'` (`overlay_keyboard_v1`) in core and in the Rust model. |
| Dismissal          | When the parent window stops being the active window, the host emits a routed `dismiss` event (`reason: 'window_blur'`) for every open popup, in tree order. `onDismiss` reports it as `blur`. As elsewhere, the host never removes the node; the application commits the removal. A `dismiss` targeting anything but a popup surface is a protocol error.                                                                                |

### Platform mechanics

GPUI at the pinned revision (zed [`ba63a02`](https://github.com/zed-industries/zed/tree/ba63a022c9a22ca66d68ef2a8f0bb9b5b0a9984d)) offers two relevant window kinds ([`crates/gpui/src/platform.rs`](https://github.com/zed-industries/zed/blob/ba63a022c9a22ca66d68ef2a8f0bb9b5b0a9984d/crates/gpui/src/platform.rs#L2837-L2864)):

- `WindowKind::AnchoredPopup(PopupOptions)` places a popup relative to a parent window and anchor rectangle with gravity and constraint adjustment. Only Wayland and macOS implement it; the X11 backend rejects it with `PopupNotSupportedError` ([`x11/window.rs`](https://github.com/zed-industries/zed/blob/ba63a022c9a22ca66d68ef2a8f0bb9b5b0a9984d/crates/gpui_linux/src/linux/x11/window.rs#L477-L481)), as do Windows and the web backend.
- `WindowKind::PopUp` is, on X11, an **override-redirect** window typed `_NET_WM_WINDOW_TYPE_NOTIFICATION`, created at an absolute root position ([`x11/window.rs`](https://github.com/zed-industries/zed/blob/ba63a022c9a22ca66d68ef2a8f0bb9b5b0a9984d/crates/gpui_linux/src/linux/x11/window.rs#L509-L627)). It has no parent: `WM_TRANSIENT_FOR` is only set for `Floating` and `Dialog`. Its x position is offset by two pixels at creation ([`L549-L553`](https://github.com/zed-industries/zed/blob/ba63a022c9a22ca66d68ef2a8f0bb9b5b0a9984d/crates/gpui_linux/src/linux/x11/window.rs#L549-L553)).

GPUI does not expose a window's root position on X11: `bounds()` comes from `ConfigureNotify` coordinates without distinguishing synthetic events, so under a reparenting window manager it can be frame-relative ([`x11/client.rs`](https://github.com/zed-industries/zed/blob/ba63a022c9a22ca66d68ef2a8f0bb9b5b0a9984d/crates/gpui_linux/src/linux/x11/client.rs#L1036-L1052)). Its X11 display is the whole X screen, not a RandR monitor ([`x11/display.rs`](https://github.com/zed-industries/zed/blob/ba63a022c9a22ca66d68ef2a8f0bb9b5b0a9984d/crates/gpui_linux/src/linux/x11/display.rs)). Because of that, the host opens each popup as `WindowKind::PopUp` and does the X11 part itself through one bounded local connection per native window (250 ms per round trip, no events selected, the same local-socket and authority rules as the native services): `TranslateCoordinates` for the parent's root position, `ConfigureWindow` for exact device-pixel bounds with `StackMode::Above`, and `WM_TRANSIENT_FOR` plus `_NET_WM_WINDOW_TYPE_POPUP_MENU` on the popup. Override-redirect windows are not managed, so the window manager neither moves nor focuses them, and the parent keeps the X input focus. The parent node's bounds come from a zero-cost measuring element painted in the parent's flow; placement runs after that paint and again on parent window moves.

On hosts without a local X11 connection the capability is not advertised. A raw protocol client that still sends `surface: 'window'` gets the ordinary in-window parent-anchored layer.

### Popup verification

| Check                                                                                                   | Command                                                                                                       |
| ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Shared accept/reject corpus, normalization, popup content rules, `dismiss` event route validation       | `cargo test --locked -p bun-native-protocol popup` and `bun test tests/protocol/popup-windows.test.ts`        |
| Placement below, shift and upward flip against the screen                                               | `cargo test --locked -p bun-native-host popups`                                                               |
| Capability gating, content preflight, blur/Escape/backdrop dismissal, propagation stop, queued disposal | `bun test tests/core/popup-windows.test.ts`                                                                   |
| Real host, X server geometry and stacking, XTest input, screenshots, development and AOT                | [`tests/native/popups.ts`](../tests/native/popups.ts), run like the overlay fixture with `BUN_NATIVE_POPUP_*` |

Locally on Linux X11 (Xvfb 1280×800 + openbox, XTest via xdotool, Mesa lavapipe, scale 1) with a development-profile host, both development and AOT passed. Observed in one run:

| Outcome                  | Observed                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Placed beyond the parent | Parent content at (460, 307) 360×200; anchor painted at (0, 146) 120×44. `xwininfo` reported the popup at exactly (460, 497) 220×160, override-redirect, crossing the parent's bottom edge; `xprop` showed `WM_TRANSIENT_FOR` = the parent and `POPUP_MENU`. It stacked above the parent frame. Screenshot pixels matched the popup background and the native button color. |
| Pointer                  | A real click on the popup's `Copy` button produced `click`; its `pointer_down` reported (110, 216) in parent coordinates, below the 200-pixel viewport. No focus/blur event, the parent stayed the active window and the popup stayed above it.                                                                                                                             |
| Escape                   | Escape in the parent dismissed the popup, its X window disappeared, and typing continued in the parent editor (`ab` → `abc`).                                                                                                                                                                                                                                               |
| Parent move              | Moving the parent frame to (200, 120) moved the open popup to the new anchor position (201, 330).                                                                                                                                                                                                                                                                           |
| Blur                     | Activating a second application window produced a `blur` dismissal and the popup closed.                                                                                                                                                                                                                                                                                    |
| Clamping                 | With the parent near the bottom-right corner the popup was shifted to x = 1060 (1280 − 220) and flipped above its anchor (y = 576).                                                                                                                                                                                                                                         |
| Close and ownership      | Closing the parent window closed its open popup; all seven public ownership counters returned to zero.                                                                                                                                                                                                                                                                      |

The existing overlay fixture still passed against the same host.

### Popup limitations

- **Linux X11 only.** Wayland (GPUI's `AnchoredPopup` there is unused), macOS and Windows do not advertise `popup_windows_v1`; on Wayland, `tests/native/wayland.ts` checks on headless sway that the capability is absent and that core rejects `surface: 'window'` with `UnsupportedFeatureError`. The `xdg_popup` plan is in [ADR 0017](decisions/0017-wayland.md). Only Xvfb + openbox at scale 1 is verified; other window managers, compositors, HiDPI and physical GPUs are not.
- **Display.** Clamping uses the whole X screen, like GPUI's X11 display. On a multi-monitor RandR layout a popup can be placed across a monitor gap or on another monitor's area.
- **Size.** Popups have a fixed declared size; there is no content sizing. Content larger than it is clipped unless the popup scrolls.
- **Keyboard.** No arrow-key navigation, type-ahead or keyboard activation of popup buttons; Tab stays in the parent window. Editors and nested overlays are rejected inside popups.
- **Outside presses.** A press elsewhere in the parent window is delivered there normally and is not reported as a dismissal; the application decides. Presses on other applications' windows dismiss only through the resulting parent blur, which depends on the window manager changing focus.
- **Placement races.** The popup is opened at its computed position and then moved to exact bounds; a first frame may briefly appear two pixels to the right. Parent moves are followed only when GPUI reports them; a popup does not follow a parent node that moves without a repaint of the parent window.
- **Accessibility.** With `accessibility_v1` a popup window's content is given the dialog role and `accessible_label` like an in-window overlay, but no AT-SPI client has read a popup window, and no announcement is made.

## Limitations

- **Platforms.** Only Linux X11 with software rendering at scale 1 is exercised. macOS and Windows build the same GPUI code but their overlay, focus and pointer behavior is unverified, as are Wayland, HiDPI, physical GPUs and touchpads.
- **No native OS menus or alerts.** These are in-window GPUI layers, except [popup windows](#popup-windows-beyond-the-parent-window) on Linux X11. The macOS application menu bar is a separate service (`app.setMenuBar`, see [native services](native-services.md#application-menu-bar)); OS context menus and OS alerts are not implemented. Public core builds [message and confirm dialogs](native-services.md#message-and-confirm-dialogs) on this modal overlay ([ADR 0014](decisions/0014-message-dialogs.md)); OS file dialogs are a separate [service](native-services.md#file-dialogs).
- **Anchoring.** A parent-anchored overlay always opens below its parent's bottom-left corner and is shifted, not flipped, to fit the window. There is no anchoring to an arbitrary node, the pointer position or a side other than below; no arrow, sizing to the trigger or collision-aware flipping.
- **Keyboard.** Menu navigation is vertical only: Left/Right, submenus opening on Right, grid or tree navigation and roving focus outside overlays are not implemented. Type-ahead matches button labels only and is not locale-aware beyond Unicode lower-casing. There is no `blur` request and no way to make a box or text node focusable. A non-modal popover without `autofocus` still never takes focus, and Escape reaches a non-modal popover only while focus is inside it. Arrow keys used by the menu are still reported to the application, which must not also act on them.
- **Modal scope.** Overlays above the active modal in paint order (deeper non-modal popovers) remain interactive by pointer. Modality affects this window only; other windows of the application are not blocked.
- **Dismissal.** Outside-press detection for parent-anchored popovers is left to the application; `onDismiss` reports only Escape and presses on the overlay node itself.
- **Scrolling.** The anchor is vertical. Scroll-into-view reveals the scroll container's child on the target's route, not the exact descendant bounds; there is no alignment option (start/center/end), no smooth scrolling and no scroll position read-back or scroll event. Visible scrollbars, nested scroll chaining and virtualization remain separate work. Wheel deltas are GPUI's native X11 steps.
- **Accessibility.** With `accessibility_v1` every overlay is an AccessKit `Dialog` named by its optional `accessible_label`, with the `modal` state when it is modal; an AT-SPI client verified this and the dialog's nested content on Linux X11 ([accessibility roles](native-text.md#accessibility-roles-accessibility_v1)). Menu roles (`menu`, `menuitem`) for `navigation: 'menu'` overlays, alert dialogs and focus announcements are not exposed, and content beneath a modal dialog stays exposed to assistive technology. Focus rings are drawn for buttons and inputs but are fixed in color and width; there is no high-contrast or reduced-motion adaptation. The ring was verified by screenshot on Linux X11 only.
