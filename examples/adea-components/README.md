# Adea components on native Solid

This example ports five Adea Solid components to Bun Native for [#233](https://github.com/0xPlayerOne/bun-native/issues/233): Button, Input, DropdownMenu, Dialog and a streaming conversation view. It runs on the shared GPUI host through the public Solid adapter, with no WebView, DOM, CSS or Kobalte. It is an example in this repository: Adea itself is unchanged.

Sources inventoried:

- `@adea-ai/ui` at [adea-ai/ui `79dda121`](https://github.com/adea-ai/ui/tree/79dda121a7f0b34a5d8fc7b8332e745dda63cf65/packages/ui/src) (package version 0.151.0): `components/ui/button/button.tsx`, `components/ui/input/input.tsx`, `components/ui/dropdown-menu/dropdown-menu.tsx`, `components/ui/dialog/dialog.tsx`, `components/composites/message-scroller/message-scroller.tsx`, `styles/theme.css`.
- Adea at [adea-ai/adea `37dd7406`](https://github.com/adea-ai/adea/tree/37dd7406faff73af7da2882fff4e0c42afa342dc/packages/workspace-ui/src): `keyed-rows.ts`, `transcript-history.ts`, `conversation-surface.tsx`, `message-row.tsx`.

## Port inventory

"Retained" means the upstream source or values are used unchanged; "modified" means upstream source with a recorded edit; "reimplemented" means new native code that keeps the upstream contract. No component is reused with zero changes.

| Component         | Upstream (lines)                                                                                                                            | Retained                                                                                                                                                                                                    | Modified                                                                                                                                                                                                                                             | Reimplemented                                                                                                                                                                                                                      | Not ported                                                                                                                                                                                     |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Button            | `button.tsx` (118)                                                                                                                          | The variant names and their purpose (`default`, `secondary`, `destructive`, `outline`, `ghost`, `toolbar`, `subtle`, `success`, `link`), the size ladder names `2xs`–`2xl`, and the token each variant uses | Tailwind classes become native style fields; `font-medium` becomes `font_weight: 500`; the `toolbar` variant's `data-[expanded]` tint becomes an `expanded` prop                                                                                     | `Button` and `buttonStyle` in `components.tsx` over the native `button`                                                                                                                                                            | `hover:`/`focus-visible:` states (no native hover style; GPUI draws focus), `icon-*` sizes and SVG children, `touchTarget`, the polymorphic `as` prop                                          |
| Input             | `input.tsx` (70)                                                                                                                            | Plain input contract: height and padding from the control ladder so it aligns with Button; the `input` border token                                                                                         | —                                                                                                                                                                                                                                                    | `Input` over the native `input` with versioned `InputState`                                                                                                                                                                        | `suggestions` (HTML `datalist`), the `Field` ARIA wiring (`aria-describedby`, `aria-invalid`, error message)                                                                                   |
| DropdownMenu      | `dropdown-menu.tsx` (433)                                                                                                                   | A `toolbar` trigger that holds the accent tint while open; popover surface and border tokens; destructive item color                                                                                        | —                                                                                                                                                                                                                                                    | `DropdownMenu` over a parent-anchored native `overlay` with `navigation: 'menu'` (arrow keys, Home/End, type-ahead) and `autofocus`; native focus return to the trigger; Escape closes                                             | Kobalte positioning, submenus, checkbox and radio items, group labels, separators, shortcuts, close on outside press, and the scroll-lock bookkeeping (`readInlineOverflow`…) a DOM menu needs |
| Dialog            | `dialog.tsx` (406)                                                                                                                          | The rule that the close button is part of the content, title and description roles, and the decision footer                                                                                                 | —                                                                                                                                                                                                                                                    | `Dialog` over a modal window `overlay`: native Tab trap, unfocused-key routing and focus return replace Kobalte's focus trap and `createDialogFocusRestoration`; Escape and a backdrop press dismiss                               | Portal and stacking context (overlays paint above the tree natively), scroll locking (a window overlay blocks input beneath it), size presets, `band` header, animation                        |
| Conversation view | `keyed-rows.ts` (64), `transcript-history.ts` (67), `message-scroller.tsx` (301), `message-row.tsx` (348), `conversation-surface.tsx` (935) | `retained/keyed-rows.ts` byte-identical (git blob `0f30eab6`)                                                                                                                                               | `retained/transcript-history.ts`: 2 of 67 lines (the `OpenedMessage` import points at the local `types.ts`; `olderBefore?: number \| undefined` for this repository's `exactOptionalPropertyTypes`); upstream blob `9c36ed88` is checked by the test | `ConversationView`: a native `scroll_y` box with `scroll_anchor: 'end'` replaces `MessageScroller`'s DOM follow/anchor logic; a two-text row replaces `MessageRow`; `types.ts` keeps the six `OpenedMessage` fields the code reads | Server data, sealed bodies, mentions, attachments, markdown, avatars, threads, row-size memory, older-page prefetch and "Jump to latest"                                                       |
| Tokens            | `styles/theme.css` (`:root`, `.dark`, control ladder)                                                                                       | 18 light and 18 dark OKLCH color values verbatim; control heights, paddings and text sizes; `--radius-md`                                                                                                   | `color-mix(... --primary-subtle ...)` is composited once over the background in sRGB                                                                                                                                                                 | `oklchToRgb` (matches Chromium canvas readback on the four values in the test)                                                                                                                                                     | CSS custom properties at runtime, alpha, the other themes and accents, compact density                                                                                                         |

Kobalte, Tailwind and the DOM are not dependencies of this example. Every behavior above that Kobalte supplied in the browser comes from the shared native overlay contract ([`docs/native-overlays.md`](../../docs/native-overlays.md)), not from per-adapter code.

## What the demo does

`app.tsx` composes the five components: a header with the conversation menu (Rename disabled, Export, Delete) and a theme switch, a row of every Button variant, the conversation view, and an Input composer with a Send button. Send appends the message and streams a deterministic seven-token reply, publishing a new message version per token through Adea's `withTailPage`. Choosing Delete opens the Dialog; Cancel, Close, Escape or a backdrop press keep the conversation, and Delete clears it.

## Run with an existing host

```sh
bun scripts/solid-build.ts examples/adea-components/main.tsx "$PWD/.bun-native/adea-components"
BUN_NATIVE_HOST=/absolute/path/to/bun-native-host bun .bun-native/adea-components/application.js
```

A production AOT executable uses the same transformed source:

```sh
bun experiments/aot-gpui/build-window.ts --entry adea-components \
  --host /absolute/path/to/bun-native-host --host-profile release \
  --outdir "$PWD/.bun-native/adea-components-aot"
BUN_NATIVE_HOST=/absolute/path/to/bun-native-host .bun-native/adea-components-aot/adea-components
```

Neither command invokes Cargo.

## Validation

[`tests/examples/adea-components.test.ts`](../../tests/examples/adea-components.test.ts) builds `tests/examples/adea-components-contract.tsx` with the Solid build path and runs the real public adapter against the headless overlay peer (`tests/core/overlay-peer.ts`, with overlay, keyboard-menu, accessibility and decoration capabilities). It drives routed synthetic events and checks the committed native tree:

- the initial tree has every component and all nine Button variants;
- a native input edit, Send and the full streamed reply create exactly two new rows and dispose none, so the eight reply versions updated one row in place (Adea's retained `keyedRows` with `sameShownMessage`);
- the theme switch changes the scheme without remounting any row;
- the menu opens as an overlay with its three items, Escape on the overlay closes it, and choosing Export closes it and updates the status;
- the dialog opens from Delete; a backdrop press and the Close button each dismiss it; the dialog's Delete clears the conversation and disposes all four rows;
- closing the window leaves zero nodes, listeners, timers and application resources.

The retained sources are checked against their upstream git blob ids, and the OKLCH conversion against Chromium readbacks.

This is synthetic, headless evidence: it makes no claim about pixels, focus movement, arrow-key menu navigation or OS input. The native screenshots below are a separate, local manual record.

## Native screenshots

See [`screenshots/README.md`](screenshots/README.md) for the exact host, OS, renderer and commands.
