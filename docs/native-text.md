# Native text, focus, Unicode, composition and accessibility

This document is the BN4 ([#241](https://github.com/0xPlayerOne/bun-native/issues/241))
support matrix for the single-line native `input`, keyboard focus and the
accessibility tree exposed by the GPUI host. It separates what was **observed**
on a real native run from what is implemented but **not run** on a platform, and
from what is **unsupported**. Unsupported or not-run is never reported as passed.

## Contract

- **Editing unit.** Caret movement (Left/Right, Home/End), Backspace/Delete and
  Shift selection (Shift+Left/Right, Shift+Home/End, Ctrl/Cmd+A) move by extended
  grapheme clusters (`unicode-segmentation` 1.13.3). Combining marks, emoji ZWJ
  and modifier sequences, regional-indicator flags, keycaps, CR LF and conjoining
  Hangul jamo are each one step. The platform IME interface addresses UTF-16 code
  units; conversions clamp and never split a scalar value
  (`native/gpui-host/src/input/editing.rs`).
- **Clipboard.** Ctrl/Cmd+C, X, V copy, cut and paste the selection. Pasted line
  breaks become spaces, because the input is single-line.
- **States (`input_states_v1`, optional capability, no protocol bump).** The input
  element accepts `disabled` and `read_only` booleans. Only `true` is sent, so
  ordinary inputs keep the same wire form. Core rejects either state locally with
  `UnsupportedFeatureError('input:disabled' | 'input:read_only')` when the host
  does not advertise the capability. Solid and React expose them as the
  `disabled` and `readOnly` props. Changing a state is an input `set`, so it needs
  the current input revision.
  - `read_only`: the input can be focused and is in Tab order. Caret movement,
    selection and copy work. Typing, Backspace/Delete, cut, paste and IME
    composition are rejected with the platform bell and send no `input` event.
  - `disabled`: the input is not focusable, not in Tab order, ignores the pointer,
    hides its caret and selection, and is drawn dimmed. If it is disabled while
    focused, the host moves focus to the window and the input receives `blur`.
- **Keyboard focus.** Tab and Shift+Tab move through enabled buttons and enabled
  or read-only inputs in tree order and wrap. Enter and Space activate the
  focused button. The window itself holds focus when no control does: before any
  control is focused, and after the focused control is disabled or removed. The
  window is never a Tab stop or a reported `focus` target, so Tab always reaches
  the first control again. Before this change, Tab did nothing in that state.
  The first enabled input still takes initial focus.
- **Composition.** The platform's marked (preedit) text is inserted, underlined
  and reported through the ordinary `input` event, then replaced when the text
  is committed. Applications see the intermediate marked value as an `input`
  event; there is no separate composition event.
- **Accessibility.** GPUI's AccessKit tree is filled only while an assistive
  technology is connected. Text is `Label` (its value is the name), buttons are
  `Button` with their label and disabled state, and inputs are `TextInput` with
  the placeholder, the read-only/disabled state and one `TextRun` that carries
  the value. The run's characters are grapheme clusters, and it carries the
  caret and selection. Native focus is reported as accessibility focus.
  Character bounds, word boundaries and AT-initiated text edits are not exposed.
- **Programmatic focus.** There is no `focus(node)` application API. Moving
  keyboard focus from application code is not implemented. An assistive
  technology can focus a control through AccessKit's Focus action, but this is
  not qualified.

## Support matrix

Linux evidence is `tests/native/text-input.ts`, run by Native Linux CI in Bun
development and in the inspected AOT executable, each at X11 scale factors 1 and
2, inside Xvfb, openbox and DBus with XTEST input. Rust unit tests in
`native/gpui-host/src/input/editing/tests.rs` and the headless suite
`tests/core/input-states.test.ts` cover the pure rules on every platform.

| Area                                                                               | Linux X11 (Xvfb)                                                                                         | Linux Wayland | macOS                                      | Windows                             |
| ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------- | ------------------------------------------ | ----------------------------------- |
| Grapheme caret/Backspace/Delete (combining marks, ZWJ family, flag)                | **Observed** through OS keys; unit-tested                                                                | Not run       | Not run (same host code)                   | Not run (same host code)            |
| OS-typed Hebrew (RTL) committed in logical order; RTL Backspace                    | **Observed**                                                                                             | Not run       | Not run                                    | Not run                             |
| RTL/Arabic shaping and bidi display                                                | Painted with cosmic-text Advanced shaping. No automated glyph or caret-position oracle: **not verified** | Not run       | Not run                                    | Not run                             |
| Dead-key composition: preedit `´` marked, then `é` committed; cancelled sequence   | **Observed** (xkbcommon compose, `us intl`, `LC_CTYPE=C.UTF-8`)                                          | Not run       | Not run                                    | Not run                             |
| Full IME (IBus/Fcitx through XIM, candidate windows, CJK)                          | **Not run**: no IME engine in the isolated session                                                       | Not run       | Not run                                    | Not run                             |
| Selection + copy/cut/paste through the X11 CLIPBOARD (checked with `xclip`)        | **Observed**                                                                                             | Not run       | Not run                                    | Not run                             |
| Read-only: focusable, copyable, every edit path rejected                           | **Observed**                                                                                             | Not run       | Not run                                    | Not run                             |
| Disabled: skipped by Tab, no edits, blur on disable, focusable again on re-enable  | **Observed**                                                                                             | Not run       | Not run                                    | Not run                             |
| Keyboard-only Tab/Shift+Tab order with wrap, Space activation                      | **Observed**                                                                                             | Not run       | Not run                                    | Not run                             |
| Scale factor 2: snapshot `scaleFactor` and physical window size, editing unchanged | **Observed** (`GPUI_X11_SCALE_FACTOR=2`)                                                                 | Not run       | Not run (Retina)                           | Not run (per-monitor DPI)           |
| Accessibility tree read by an independent AT-SPI client                            | **Observed**: roles, names, values, caret, focus, read-only/disabled states                              | Not run       | Not run (AccessKit macOS adapter is built) | Not run (AccessKit Windows adapter) |
| Screen reader speech (Orca, VoiceOver, Narrator/NVDA)                              | **Not run**                                                                                              | Not run       | Not run                                    | Not run                             |
| Physical keyboard, physical display DPI, GPU                                       | **Not run** (software Vulkan, XTEST)                                                                     | Not run       | Not run                                    | Not run                             |
| Programmatic focus from application code                                           | Unsupported                                                                                              | Unsupported   | Unsupported                                | Unsupported                         |
| Multi-line text input                                                              | Unsupported                                                                                              | Unsupported   | Unsupported                                | Unsupported                         |

AT-SPI states follow AccessKit 0.24's mapping. A read-only or disabled entry is
reported `read-only` and without `enabled` or `sensitive`. The two differ only in
that a read-only entry stays `focusable` and is not `editable`. Ordinary entries
are `editable`, `enabled` and `focusable`.

## Observed run notes

- `xdotool type` remaps a spare keycode for each character while the host is
  running. In Xvfb, about one run in three dropped one Hebrew letter, because
  the press raced the host's keymap reload. The fixture therefore binds the
  Hebrew keysyms with `xmodmap` before launch and presses them as ordinary keys.
  Whether GPUI drops input during a live keymap change is not qualified.
- At scale 2, the 420×360 logical window is 840×720 physical pixels, and the
  window display snapshot reports `scaleFactor: 2`.

## Reproduce

Install the Native Linux prerequisites, including `x11-xkb-utils`,
`x11-xserver-utils`, `xclip`, `at-spi2-core`, `gir1.2-atspi-2.0` and `python3-gi`.
Then build the release host and run:

```sh
mkdir -p .bun-native/text && out=$(mktemp -d "$PWD/.bun-native/text/run.XXXXXX")
BUN_NATIVE_HOST="$PWD/target/release/bun-native-host" \
BUN_NATIVE_TEXT_EVIDENCE="$out" BUN_NATIVE_TEXT_MODE=development \
BUN_NATIVE_ATSPI_PYTHON=/usr/bin/python3 \
  xvfb-run --auto-servernum --server-args='-screen 0 1280x1024x24 -nolisten tcp' \
  dbus-run-session -- bash scripts/quality/native-linux-session.sh "$out/session" -- \
  env GPUI_X11_SCALE_FACTOR=2 LC_CTYPE=C.UTF-8 bun tests/native/text-input.ts
```

`$out/result.json` records each outcome, and `$out/atspi-tree.json` records the
accessible subtree. The AOT entry is `text-input` in
`experiments/aot-gpui/build-window.ts`.
