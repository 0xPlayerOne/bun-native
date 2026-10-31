# Shared native layout and styling

This is the initial shared layout increment for [BN4 #237](https://github.com/0xPlayerOne/bun-native/issues/237). Boxes, text, buttons and inputs use one TypeScript contract, one Rust validator and one GPUI implementation. Solid and React consume these elements through public core; neither framework owns a separate native layout engine.

Protocol **3** requires `layout_v1`, `tree` and `input_revisions`. A version-2 host is incompatible. Pin packages and the prebuilt host to the same tested revision and rebuild both sides when upgrading. Historical protocol-2 artifacts and measurements remain evidence for their original sources.

## Supported style fields

All dimensions are finite **logical pixels**. GPUI applies the actual platform scale during rendering. These names are a native API, not a CSS parser or Tailwind class mapping.

| Field                                                | Supported values                                                                | Omitted behavior                                                                                                                            |
| ---------------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `direction`                                          | `row`, `column`                                                                 | Boxes lay out a column; a supplied direction enables flex layout.                                                                           |
| `gap`, `padding`                                     | 0–4,096                                                                         | No additional spacing.                                                                                                                      |
| `width`, `height`                                    | 0–16,384, or `fill`                                                             | Native intrinsic sizing; the window root fills the viewport. `fill` is the parent's full corresponding dimension, not remaining flex space. |
| `min_width`, `max_width`, `min_height`, `max_height` | 0–16,384                                                                        | GPUI's normal constraints. A minimum greater than the supplied maximum is rejected.                                                         |
| `flex_grow`, `flex_shrink`                           | 0–1,000                                                                         | Elements do not grow or shrink unless requested.                                                                                            |
| `align_items`                                        | `start`, `center`, `end`, `stretch`                                             | GPUI's normal flex alignment; buttons center their content.                                                                                 |
| `justify_content`                                    | `start`, `center`, `end`, `space_between`, `space_around`, `space_evenly`       | Normal flex placement; buttons center their content.                                                                                        |
| `overflow`                                           | `visible`, `hidden`; boxes additionally accept `scroll_x`, `scroll_y`, `scroll` | Visible within the ancestor clip. The native window always clips its content.                                                               |
| `background`, `color`                                | Unsigned 24-bit RGB integers                                                    | Existing primitive defaults and inherited text color.                                                                                       |
| `font_size`                                          | 1–512                                                                           | Inherited native text size, initially 18.                                                                                                   |

Unknown fields, nulls, nonfinite numbers and unsupported enum values are rejected in both languages. Text/button/input element types restrict overflow to `visible` or `hidden`; JavaScript receives the same runtime check. A `set` replaces the complete properties rather than merging them. Omitting a previously supplied field restores the primitive's default.

Min/max constraints can clamp an explicitly requested width or height. A row of nonshrinking children may overflow even when its parent fills the window. Set `flex_shrink` explicitly and choose a minimum when a child should contract. There is no CSS grid, absolute-position API, arbitrary transform, selector engine or browser fallback.

## Scroll, clipping and lifetime

`hidden` clips content and pointer hit testing at both viewport axes. Every scrolling mode also clips both axes; `scroll_x` and `scroll_y` select which axis changes its offset. A single-axis GPUI viewport accepts wheel movement on the other axis as scrolling along its enabled axis. The two-axis mode follows GPUI's native dominant-axis behavior. Visible scrollbar chrome and programmatic scroll positioning are not part of this increment.

The native view owns each scroll handle by the box's node identity. Style updates, keyed movement and reparenting preserve the handle and its current offset. Changing the scroll mode resets the now-disabled axis. Turning scrolling off or removing the subtree releases that handle; enabling it again starts at the origin. GPUI clamps an offset after content removal or viewport resizing. Nested scroll chaining, overscroll and touchpad physics require separate qualification.

Inputs and buttons retain native focus handles by identity. Tab and Shift-Tab traverse the rendered child order, skip disabled buttons, and wrap according to GPUI's native tab order. Removing a focused control or disabling a focused button blurs it. This increment does not automatically scroll an offscreen tab stop into view and does not draw focus rings.

Restyling or moving an ancestor preserves an input's value, revision, selection and focus. A full input `set` still requires the current edit revision and advances it once, even when only appearance changes. Equal content preserves the native caret; different content intentionally moves it to the new end. Do not turn an input callback into an echo of a stale value.

## Verification and evidence

The shared [layout corpus](../tests/fixtures/layout-style.json) is consumed by TypeScript and Rust tests. It covers accepted enum values and boundary sizes, min/max inversion, wrong types, unknown CSS-style properties and scrolling on noncontainers. Additional tests reject NaN and infinity from in-process callers. Headless subprocess tests reject and reap an obsolete-version or missing-layout host.

The [public-core fixture](../tests/native/layout.ts) is driven through the existing owned-process, nonce, deadline and cleanup infrastructure. Its layout scenario uses real XTest pointer/wheel/key events and window-manager resize. It requires native geometry plus application events to check min/max/shrink/alignment, clipping, scrolling, retained offsets through style/reorder, caret preservation, resize, content-removal clamping, focus order, disabled/deleted focus and final resource cleanup. Screenshots are separate evidence of actual pixels; native paint callbacks are not presentation timestamps.

Opt-in geometry reports are bounded to 128 model nodes and 65,536 bytes per JSONL record. Larger geometry is explicitly marked omitted. Geometry and focus/scroll changes are deduplicated separately from model revisions, so a resize or wheel event does not require an application transaction to become observable. Instrumented runs are diagnostics, not uninstrumented performance baselines.

```sh
export BUN_NATIVE_HOST="$PWD/target/release/bun-native-host"
mkdir -p .bun-native
layout_run=$(mktemp -d "$PWD/.bun-native/layout.XXXXXX")
xvfb-run --auto-servernum --server-args='-screen 0 1280x800x24 -nolisten tcp' \
  dbus-run-session -- bash scripts/quality/native-linux-session.sh "$layout_run/session-dev" -- \
  python3 scripts/quality/native-diagnostics-linux.py --output "$layout_run/development" \
    --scenario layout --mode development --host-profile release -- bun tests/native/layout.ts

bun experiments/aot-gpui/build-window.ts --entry layout --host "$BUN_NATIVE_HOST" \
  --host-profile release --outdir "$layout_run/aot-build"
xvfb-run --auto-servernum --server-args='-screen 0 1280x800x24 -nolisten tcp' \
  dbus-run-session -- bash scripts/quality/native-linux-session.sh "$layout_run/session-aot" -- \
  python3 scripts/quality/native-diagnostics-linux.py --output "$layout_run/aot" \
    --scenario layout --mode aot --host-profile release -- "$layout_run/aot-build/layout"
```

The checked-in [development/AOT evidence record](../tests/native/evidence/layout-linux-development-aot.json) binds the tested source files, native binary, compiled application and raw report/screenshot hashes. Both final runs passed with a development-profile native host on Linux X11, Mesa 25.2.8 llvmpipe and actual native scale 1. The AOT application has a compiled-program record; its JIT is marked unused with 27 JIT ranges removed. The interpreter remains present. The required native Linux job now repeats this scenario in development and AOT using its already-built release host.

| Observed assertion                                       | Development and AOT result                                                                                                                                                                                      |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Minimum/constrained text widths                          | 80 / 200 logical pixels at a 640-pixel viewport.                                                                                                                                                                |
| Shrink after actual OS resize                            | The constrained child shrank to 184 pixels at viewport width 420, then returned to its 200-pixel maximum at width 800.                                                                                          |
| Vertical scroll retained through styling/movement/resize | Offset remained −168 pixels.                                                                                                                                                                                    |
| Clipping and horizontal scroll                           | An invisible button received no pointer activation; scrolling revealed it. Switching to horizontal reset the vertical offset and accepted real wheel input.                                                     |
| Scroll disposal and content shrink                       | Disabling removed the handle; re-enabling started at the origin. Removing excess content clamped the offset to zero; subtree deletion removed all scroll handles.                                               |
| Native editor selection                                  | `ABC` became `ABxC` at revision 1 after ancestor styling, then `ABxYC` at revision 3 after an explicit appearance Set advanced revision 2.                                                                      |
| Focus and lifetime                                       | Reordered Tab/Shift-Tab activation, disabled-focus clearing and OS close passed; application exit was zero and every public ownership counter was zero. No forced cleanup or surviving observed child remained. |

A preliminary controller run captured an intermediate wheel offset and failed its retention comparison. The native trace showed the final offset was preserved; the controller now waits for native clamping, with a negative test for the intermediate value. That failed diagnostic is retained separately and is not counted as passed. A local build also needed one targeted GPUI cache rebuild after malformed compiler metadata; the successful build conditions are recorded, without a compiler pin change.

These checks establish their actual scope, not a leak proof or performance baseline. Software X11 at scale 1 does not qualify HiDPI, Wayland, macOS, Windows, physical GPU/input, accessibility or IME. Theme tokens, split panes, full text-input scrolling, two-adapter native comparisons and the remaining #237 acceptance stay open.
