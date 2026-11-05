# Shared native layout and styling

This is the shared layout and styling contract for [BN4 #237](https://github.com/0xPlayerOne/bun-native/issues/237). Boxes, text, buttons, inputs and split panes use one TypeScript contract, one Rust validator and one GPUI implementation. Solid and React consume these elements through public core; neither framework owns a separate native layout engine.

The initial layout increment used protocol **3**. The [current native protocol](native-abi.md) requires `layout_v1` alongside `tree`, `input_revisions`, `interactions_v1` and `window_display_v1`; older hosts are incompatible. Pin packages and the prebuilt host to the same tested revision and rebuild both sides when upgrading. Historical protocol-2/3 artifacts and measurements remain evidence for their original sources. The [interaction contract](native-events.md) describes observed focus/key/pointer events without changing this style contract.

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

## Decoration fields (`style_decoration_v1`)

These fields are optional host features advertised by `style_decoration_v1`; the protocol version is unchanged. Core rejects them with `UnsupportedFeatureError('style:decoration')` before sending when the host does not advertise the capability, so an older host never sees an unknown field. Every element kind accepts them.

| Field           | Supported values            | Native behavior                                                                                                                                       |
| --------------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `border_width`  | 0–64 logical pixels         | One uniform solid border on all four edges. It is part of the element's box, so it insets content like padding.                                       |
| `border_color`  | Unsigned 24-bit RGB integer | The border color. Without it the border is transparent and only insets content.                                                                       |
| `corner_radius` | 0–4,096 logical pixels      | One radius for all four corners of the background and border. Children are not clipped to the rounded shape.                                          |
| `opacity`       | 0–1                         | Multiplies this element and all its descendants.                                                                                                      |
| `font_weight`   | 100, 200, … 900             | Inherited by descendant text. GPUI chooses the nearest installed face of the system UI family; a host without a heavier face renders the regular one. |

## Split panes (`split_v1`)

`{ kind: 'split', ratio?, min_size?, style? }` owns at most two children, the leading and trailing panes, separated by a 6-logical-pixel divider drawn by the host (`SPLIT_DIVIDER`). `style.direction` chooses the axis: `row` (the default) places panes side by side with a column-resize cursor, and `column` stacks them with a row-resize cursor. Each pane fills the split's cross axis and clips its child at both axes; a child that should fill its pane sets `width`/`height` to `fill`.

- `ratio` (0–1, default 0.5) is the leading pane's share of the main-axis space left after padding, border and the divider. `min_size` (0–16,384, default 0) is the smallest main-axis size of each pane; a ratio that would violate it is clamped, and when both minimums cannot fit the panes split evenly.
- The host owns the ratio after a drag, like a scroll offset. A left-button drag on the divider moves it under the pointer. A later `set` that repeats the same declared `ratio` (for example, a theme switch or any re-render) keeps the user's position; declaring a different `ratio` adopts the new value. Removing the split releases its state.
- A split accepts the ordinary sizing, padding, color, border and decoration fields. `gap`, `align_items`, `justify_content` and scrolling overflow are rejected because the host owns pane placement; put scrolling on a pane's child box instead.
- The divider is pointer-only: it is not a Tab stop, has no keyboard resizing and emits no resize event, so an application cannot yet observe or persist a user's drag. Panes do not collapse. Nested splits work through ordinary child boxes but have no shared drag coordination.

Core exposes `ContainerKind = 'box' | 'split'` for `insert`/`append`. A third pane is rejected by core (`limit_exceeded`), by the shared renderer at commit, and by native preflight.

## Theme tokens

Theme tokens are a typed JavaScript layer in `@bun-native/core`, not a host feature. `defineTheme({ colors, space, radii, fontSizes })` validates and freezes named values (colors must be 24-bit RGB; other tokens finite and nonnegative). `theme.style({...})` replaces token names in `background`, `color`, `border_color` (colors), `gap`, `padding` (space), `corner_radius` (radii) and `font_size` (fontSizes) with numbers and leaves every other field, including literal numbers, unchanged. An unknown token throws before a batch is staged; the resolved style is then validated by the normal contract.

Because the native host never sees a token, switching themes is an ordinary property update. Core, Solid and React commit it the same way: one batch that `set`s the affected elements, preserving node identity, scroll offsets, focus and split ratios. `defaultTheme` names the host's built-in primitive defaults (`surface` window background, `text`, button `accent`/`on_accent`, `disabled`, split `divider`) so an application can match them. The host defaults themselves are fixed; a themed button or input sets its own `background` and `color`.

## Style subset versus CSS and Tailwind

The contract is a closed set of snake_case native fields with numeric logical pixels. There is no CSS parser, no cascade or selectors, no units, no shorthand and no Tailwind class strings. Unknown fields — including CSS names such as `border`, `border_radius`, `box_shadow` or `class` — are rejected in both languages.

| CSS / Tailwind concept                                             | Native contract                                                                                                                                                                                                                       |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `display: flex`, `flex-direction` / `flex`, `flex-row`, `flex-col` | `direction: 'row' \| 'column'`. Every box is a flex column by default; there is no `block`, `inline`, `grid` or `display: none`.                                                                                                      |
| `gap`, `padding` / `gap-*`, `p-*`                                  | `gap`, `padding` as one uniform value. No per-side padding, margins (`m-*`) or negative values.                                                                                                                                       |
| `width`, `height` / `w-*`, `h-*`, `w-full`                         | Pixels or `'fill'` (100% of the parent). No percentages, `auto`, `vh`/`vw`, `em`/`rem` or `calc()`.                                                                                                                                   |
| `min-*` / `max-*` width and height                                 | `min_width`, `max_width`, `min_height`, `max_height` in pixels.                                                                                                                                                                       |
| `flex-grow`, `flex-shrink` / `grow`, `shrink`                      | `flex_grow`, `flex_shrink`. Native elements do not shrink by default (CSS default is 1). No `flex-basis`, `order` or `flex-wrap`.                                                                                                     |
| `align-items`, `justify-content` / `items-*`, `justify-*`          | The listed enum values; no `baseline`, `align-self`, `align-content` or `place-*`.                                                                                                                                                    |
| `overflow` / `overflow-hidden`, `overflow-*-scroll`                | `visible`, `hidden`, `scroll_x`, `scroll_y`, `scroll`. Any non-visible mode clips both axes; there is no mixed visible/scroll axis. No visible scrollbars.                                                                            |
| `background-color`, `color` / `bg-*`, `text-*`                     | 24-bit RGB integers. No alpha channel, gradients, images or named colors; use `opacity` for translucency.                                                                                                                             |
| `font-size`, `font-weight` / `text-*`, `font-*`                    | `font_size` pixels, `font_weight` 100–900. No font family, style, line height, letter spacing, alignment or decoration.                                                                                                               |
| `border`, `border-radius` / `border`, `rounded-*`                  | `border_width` + `border_color` (uniform, solid) and `corner_radius` (uniform). No per-side borders, dashed styles or outlines.                                                                                                       |
| `opacity` / `opacity-*`                                            | `opacity` 0–1.                                                                                                                                                                                                                        |
| Not provided                                                       | `position`/`inset`/`z-index` (use overlays where available), transforms, transitions/animation, shadows, filters, `cursor`, `:hover`/`:focus` variants, media queries, responsive prefixes and dark-mode variants (use theme tokens). |

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

These checks establish their actual scope, not a leak proof or performance baseline. Software X11 does not qualify Wayland, macOS, Windows, physical GPU/input, accessibility or IME.

## Split, decoration, theme, HiDPI and adapter qualification

[`tests/native/layout-style-scene.ts`](../tests/native/layout-style-scene.ts) defines one scene — a themed root, a header, a row split whose leading pane scrolls and holds an over-wide row, a trailing pane with an input and a decorated button, and a footer — and qualifies it through three consumers of the same native elements: public core ([`layout-style.ts`](../tests/native/layout-style.ts)), Solid ([`solid-layout-style.tsx`](../tests/native/solid-layout-style.tsx)) and React ([`react-layout-style.tsx`](../tests/native/react-layout-style.tsx)). Real XTEST input (xdotool) drives clicks, divider drags, wheel, Tab and window-manager resize in isolated Xvfb with openbox. Geometry, scroll offsets, focus and the committed element tree come from nonce-tagged native paint evidence; displayed pixels come from window captures taken after the scene's own surface is presented. Each run must:

- divide the split at the declared ratio with a 6-pixel divider, and keep the over-wide row's pixels inside its pane (the trailing pane's color is displayed where the row would continue);
- move focus with Tab/Shift-Tab across both panes and the footer in rendered order, wrapping at the end;
- scroll the leading pane with real wheel input;
- follow a real divider drag within 2 logical pixels, stop at the trailing pane's `min_size`, and keep the dragged ratio and the scroll offset across a theme switch that re-declares the same ratio;
- display the dark theme's surface after one token switch, then adopt a newly declared ratio and keep it across an OS resize to 640 pixels and back;
- report the native scale factor requested by `GPUI_X11_SCALE_FACTOR` (1 or 2, set through `BUN_NATIVE_TEST_SCALE_FACTOR` in the session script), capture a window of exactly the logical size times that scale, and release every public ownership counter.

[`layout-style-compare.ts`](../tests/native/layout-style-compare.ts) then requires every report to contain the identical element tree at its initial, declared-ratio and resized checkpoints, with identical logical bounds at the same scale and bounds within half a logical pixel across scales. The required native Linux job runs all three adapters in development and AOT at scales 1 and 2 with its release host and compares all twelve reports.

The local qualification for this change used a development-profile host on Linux X11 (Xvfb, Mesa lavapipe). At source commit 3226e7e, core, Solid and React each passed in development and AOT at scales 1 and 2, and all twelve reports compared identical; the [evidence record](../tests/native/evidence/layout-style-linux-development-aot.json) binds the host hash and each report hash. The required CI job repeats this with its release host. The header's `font_weight: 700` reached the host but rendered with the regular face, because GPUI's Linux system UI family (IBM Plex Sans) is not installed on that image; weight rendering is therefore not pixel-qualified.

Not qualified by these runs: fractional scale factors (only integer GPUI X11 overrides 1 and 2), real HiDPI monitors, Wayland, macOS, Windows, keyboard divider control, nested or collapsible splits, rounded child clipping, IME and accessibility. Full text-input scrolling remains separate input work.
