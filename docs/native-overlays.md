# Native overlays, modal focus and scroll anchoring

This is the first implemented slice of [BN4 #239](https://github.com/0xPlayerOne/bun-native/issues/239): one shared overlay element for dialogs, menus and popovers, a modal focus scope, focus return after dismissal, and a scroll anchor that keeps streaming content at its end. The GPUI host, the Rust and TypeScript validators and public core own one implementation. Solid and React expose the same `overlay` intrinsic through the shared renderer; neither adapter has its own layer, focus or dismissal logic.

There is no protocol version change. The host advertises two **optional** capabilities on protocol 8: `overlays_v1` (the `overlay` element) and `scroll_anchor_v1` (the `scroll_anchor` style field). Public core rejects either feature locally with `UnsupportedFeatureError` (`element:overlay`, `style:scroll_anchor`) when the connected host does not advertise it, so an older host never receives an unknown element. The current GPUI host always advertises both, on every platform it builds for.

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

## Verification

| Check                                                                                                                                                         | Command                                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Shared accept/reject corpus ([`overlays.json`](../tests/fixtures/overlays.json)), normalization, nesting bound, modal anchoring and kind-preserving `set`     | `cargo test --locked -p bun-native-protocol overlay` and `bun test tests/protocol/overlays.test.ts` |
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

The required Native Linux job runs this in development and AOT against its release host. Locally, both modes passed on Linux X11 (Xvfb + openbox, XTest via xdotool, Mesa llvmpipe, scale 1) with a development-profile host; the AOT manifest recorded the JIT as unused. Each run writes `overlays.json` plus two screenshots:

| Outcome                    | Observed                                                                                                                                                                                                                                        |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Modal focus trap           | Opening moved focus to `Confirm`; Tab, Tab, Shift-Tab produced `confirm, cancel, confirm, cancel` and never left the dialog. The screenshot pixel over the covered opener was the backdrop color.                                               |
| Backdrop blocks pointer    | A real click on the covered opener targeted the overlay (`backdrop`), produced no button click and left focus in the dialog.                                                                                                                    |
| Nested modal               | Focus moved to the inner control and stayed there through Tab/Shift-Tab. Escape dismissed only the inner layer, focus returned to `Cancel`, and its dismissal registrations were revoked.                                                       |
| Focus and selection return | Escape closed the dialog; focus returned to the editor with its `lo` selection intact, so typing `X` produced `helX`. The dialog's callbacks were revoked.                                                                                      |
| Control-less modal         | Opening blurred the editor; Escape reached the overlay node, closed it and focus returned to the editor.                                                                                                                                        |
| Parent-anchored popover    | Its item painted 4 pixels (the popover padding) below its parent, over the next sibling; the displayed pixel was the popover color, a real click activated only the popover item, and focus never moved.                                        |
| Streaming scroll           | Eight 4-row appends kept the 64-pixel viewport at its growing end (maximum 52 → 864). Two wheel-ups released it at −690; a further append kept −690 while the maximum grew; wheeling back to the end pinned it again (offset −1096 = −maximum). |
| Ownership                  | Window close and shutdown left all seven public ownership counters at zero.                                                                                                                                                                     |

## Limitations

- **Platforms.** Only Linux X11 with software rendering at scale 1 is exercised. macOS and Windows build the same GPUI code but their overlay, focus and pointer behavior is unverified, as are Wayland, HiDPI, physical GPUs and touchpads.
- **No native OS menus or dialogs.** These are in-window GPUI layers. Application menu bars, OS context menus, native file/message dialogs and child popup windows that extend beyond the window are not implemented.
- **Anchoring.** A parent-anchored overlay always opens below its parent's bottom-left corner and is shifted, not flipped, to fit the window. There is no anchoring to an arbitrary node, the pointer position or a side other than below; no arrow, sizing to the trigger or collision-aware flipping.
- **Keyboard.** There is no programmatic focus API. Non-modal popovers never take focus, so a menu that needs keyboard navigation must be modal (and therefore window-anchored) or be reached with Tab. Arrow-key menu navigation, type-ahead and roving focus are not implemented. Escape for a non-modal popover reaches it only when focus is inside it.
- **Modal scope.** Overlays above the active modal in paint order (deeper non-modal popovers) remain interactive by pointer. Modality affects this window only; other windows of the application are not blocked.
- **Dismissal.** Outside-press detection for parent-anchored popovers is left to the application; `onDismiss` reports only Escape and presses on the overlay node itself.
- **Scrolling.** The anchor is vertical. Programmatic scroll positioning, scroll-into-view of a focused control, visible scrollbars, nested scroll chaining and virtualization remain separate work. Wheel deltas are GPUI's native X11 steps.
- **Accessibility.** No accessibility roles, labels or focus announcements are exposed for overlays; focus rings are still not drawn.
