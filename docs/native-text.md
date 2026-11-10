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
- **Clipboard.** Ctrl/Cmd+C, X, V copy, cut and paste the selection. Each pasted
  line break (`\n`, `\r` or `\r\n`) becomes one space, because the input is
  single-line.
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
  technology is connected. Inputs are `TextInput` with the placeholder, the
  read-only/disabled state and one `TextRun` that carries the value. The run's
  characters are grapheme clusters, and it carries the caret and selection.
  Native focus is reported as accessibility focus. Each character's bounds
  come from the glyphs of the latest paint of the same text, in visual order,
  so a right-to-left letter lies to the right of the letter after it; a paint
  that moved them is followed by one more frame that exposes them. Word
  boundaries are not exposed. The roles of every other element kind are listed
  under [accessibility roles](#accessibility-roles-accessibility_v1).
- **Assistive-technology requests.** An enabled or read-only input accepts a
  caret or selection request (AccessKit `SetTextSelection`: AT-SPI
  `set_caret_offset`/`set_selection`, macOS `AXSelectedTextRange`). An
  editable input also accepts `SetValue` (UI Automation `ValuePattern`, macOS
  `AXValue`) and `ReplaceSelectedText`. A value request goes through the same
  policy, line-break, size and binding checks as typing and reports one ordinary
  `input` event; a read-only input registers no edit action, so platforms
  report it as not settable, and a disabled input accepts no request. Buttons
  take the platform press (AccessKit `Click`) and every focusable control takes
  `Focus`. The split divider takes `SetValue` as a percentage, clamped to its
  `min_size` limits, and `Increment`/`Decrement` as one 1% step along its own
  axis; each is reported once as a `split_resize` with `source: 'keyboard'`,
  because it is a discrete step rather than a drag. A request on a
  node beneath an open modal layer cannot be made, because that node is not
  in the tree (see below).
- **Programmatic focus.** On a host advertising `focus_v1`, `batch.focus(node)`
  (Solid and React: `focusNode(ref)`) focuses an enabled button or input after
  the batch's tree changes; see the
  [overlay contract](native-overlays.md#batch-requests-focus_v1-scroll_control_v1).
  `tests/native/overlays.ts` exercises it on Linux X11; this text fixture does
  not. An assistive technology can focus a control through AccessKit's Focus
  action (qualified through AT-SPI, AX and UI Automation clients). There is no `blur` request.

## Support matrix

Linux evidence is `tests/native/text-input.ts`, run by Native Linux CI in Bun
development and in the inspected AOT executable, each at X11 scale factors 1 and
2, inside Xvfb, openbox and DBus with XTEST input. Rust unit tests in
`native/gpui-host/src/input/editing/tests.rs` and the headless suite
`tests/core/input-states.test.ts` cover the pure rules on every platform.
`tests/native/ime.ts` runs in the same job, in development and AOT: an `ibus-daemon`
with its XIM server and the Hangul engine, XTEST keys, and the host launched with
`XMODIFIERS=@im=ibus`. It checks that a consonant becomes a preedit, that a vowel
composes it into a syllable, that the engine's own Backspace undoes only the last
jamo, and that Space commits the syllable before a new one starts. It qualifies
the XIM preedit path of the pinned GPUI with one engine; it is not coverage of
CJK candidate windows or of every engine.
The Wayland column comes from `tests/native/wayland.ts` on headless sway
([native platforms](native-platforms.md#linux-wayland)); it covers basic entry
only, not the editing, composition or accessibility rows.

| Area                                                                                | Linux X11 (Xvfb)                                                                                                                                                                                                                                                               | Linux Wayland                                                                                         | macOS                                                                                                                                 | Windows                                                                                                              |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| OS-typed text entry (ASCII and `é`) and Enter activation                            | **Observed**                                                                                                                                                                                                                                                                   | **Observed** (headless sway, `zwp_virtual_keyboard_v1`)                                               | Not run in this suite; see [native platforms](native-platforms.md)                                                                    | Not run in this suite; see [native platforms](native-platforms.md)                                                   |
| Grapheme caret/Backspace/Delete (combining marks, ZWJ family, flag)                 | **Observed** through OS keys; unit-tested                                                                                                                                                                                                                                      | Not run                                                                                               | Not run (same host code)                                                                                                              | Not run (same host code)                                                                                             |
| OS-typed Hebrew (RTL) committed in logical order; RTL Backspace                     | **Observed**                                                                                                                                                                                                                                                                   | Not run                                                                                               | Not run                                                                                                                               | Not run                                                                                                              |
| Bidirectional display of Hebrew after Latin text                                    | **Observed**: AT-SPI character extents from the painted glyphs put the Hebrew letters right to left after the Latin run, and each box covers glyph ink in a window capture (scales 1 and 2). Arabic joining and the caret's visual position in mixed text are **not verified** | Not run                                                                                               | Not run                                                                                                                               | Not run                                                                                                              |
| Dead-key composition: preedit `´` marked, then `é` committed; cancelled sequence    | **Observed** (xkbcommon compose, `us intl`, `LC_CTYPE=C.UTF-8`)                                                                                                                                                                                                                | Not run                                                                                               | Not run                                                                                                                               | Not run                                                                                                              |
| IME composition through a real engine (IBus Hangul over XIM)                        | **Observed** (`tests/native/ime.ts`: preedit, syllable composition, engine Backspace, commit by Space)                                                                                                                                                                         | Not run (`zwp_text_input_v3`)                                                                         | Not run                                                                                                                               | Not run                                                                                                              |
| Candidate windows, CJK candidate selection, Fcitx, other engines                    | **Not run**: Hangul has no candidate list                                                                                                                                                                                                                                      | Not run (`zwp_text_input_v3`)                                                                         | Not run                                                                                                                               | Not run                                                                                                              |
| Selection + copy/cut/paste through the X11 CLIPBOARD (checked with `xclip`)         | **Observed**                                                                                                                                                                                                                                                                   | Not run                                                                                               | Not run                                                                                                                               | Not run                                                                                                              |
| Read-only: focusable, copyable, every edit path rejected                            | **Observed**                                                                                                                                                                                                                                                                   | Not run                                                                                               | Not run                                                                                                                               | Not run                                                                                                              |
| Disabled: skipped by Tab, no edits, blur on disable, focusable again on re-enable   | **Observed**                                                                                                                                                                                                                                                                   | Not run                                                                                               | Not run                                                                                                                               | Not run                                                                                                              |
| Keyboard-only Tab/Shift+Tab order with wrap, Space activation                       | **Observed**                                                                                                                                                                                                                                                                   | Not run                                                                                               | Not run                                                                                                                               | Not run                                                                                                              |
| Scale factor 2: snapshot `scaleFactor` and physical window size, editing unchanged  | **Observed** (`GPUI_X11_SCALE_FACTOR=2`)                                                                                                                                                                                                                                       | Snapshot `scaleFactor: 2` and typing observed (sway output scale 2); physical buffer size not checked | Not run (Retina)                                                                                                                      | Not run (per-monitor DPI)                                                                                            |
| Accessibility tree read by an independent client                                    | **Observed** (AT-SPI): roles, names, values, caret, character bounds, focus, read-only/disabled states                                                                                                                                                                         | Not run                                                                                               | **Observed** (AXUIElement, hosted macos-15): roles, names, values, divider limits, settable/read-only                                 | **Observed** (UI Automation, hosted windows-2022): control types, names, values, divider limits, read-only           |
| Assistive-technology requests: caret/selection, value, press, focus, divider value  | **Observed** (AT-SPI): caret and selection moves that later OS typing lands at, press, grab_focus, divider value with min_size clamp                                                                                                                                           | Not run                                                                                               | **Observed** (AX): AXValue text (and rejected on read-only), AXSelectedTextRange, AXPress, AXFocused, divider AXValue and AXIncrement | **Observed** (UIA): ValuePattern.SetValue (and rejected on read-only), Invoke, SetFocus, divider RangeValue.SetValue |
| Content beneath an open modal dialog hidden from assistive technology               | **Observed** (AT-SPI)                                                                                                                                                                                                                                                          | Not run                                                                                               | **Observed** (AX)                                                                                                                     | **Observed** (UIA)                                                                                                   |
| Roles of every element kind, modal dialog, split divider value (`accessibility.ts`) | **Observed** at scale 1, development and AOT (see below)                                                                                                                                                                                                                       | Not run                                                                                               | **Observed** in `accessibility-platform.ts`, development and AOT                                                                      | **Observed** in `accessibility-platform.ts`, development and AOT                                                     |
| Screen reader speech (Orca, VoiceOver, Narrator/NVDA)                               | **Not run**                                                                                                                                                                                                                                                                    | Not run                                                                                               | Not run                                                                                                                               | Not run                                                                                                              |
| Physical keyboard, physical display DPI, GPU                                        | **Not run** (software Vulkan, XTEST)                                                                                                                                                                                                                                           | Not run (software Vulkan, virtual keyboard)                                                           | Not run                                                                                                                               | Not run                                                                                                              |
| Programmatic focus from application code (`focus_v1`)                               | **Observed** in `tests/native/overlays.ts`, not in this fixture                                                                                                                                                                                                                | Not run                                                                                               | Not run                                                                                                                               | Not run                                                                                                              |
| Multi-line text input                                                               | Unsupported                                                                                                                                                                                                                                                                    | Unsupported                                                                                           | Unsupported                                                                                                                           | Unsupported                                                                                                          |

AT-SPI states follow AccessKit 0.24's mapping. A read-only or disabled entry is
reported `read-only` and without `enabled` or `sensitive`. The two differ only in
that a read-only entry stays `focusable` and is not `editable`. Ordinary entries
are `editable`, `enabled` and `focusable`.

## Accessibility roles (`accessibility_v1`)

A host that advertises the optional `accessibility_v1` capability (no protocol
version change; the GPUI host advertises it on every platform) gives each
element kind the AccessKit node below and accepts an `accessible_label` string
on `overlay` and `split` elements. The label is never painted, follows the text
rules (at most 16,384 UTF-8 bytes, no NUL) and counts toward the per-element and
per-window text budgets. Core rejects it with
`UnsupportedFeatureError('overlay:accessible_label')` or `'split:accessible_label'`
before sending to a host without the capability; Solid and React spell it
`accessibleLabel`. Rust and TypeScript share
[`tests/fixtures/accessibility.json`](../tests/fixtures/accessibility.json).
Other kinds take no label: text and buttons are named by their text, and a box
or input label is not implemented.

| Element                       | AccessKit role → AT-SPI role (AccessKit 0.24)  | Name                                 | States and value                                                                                                              |
| ----------------------------- | ---------------------------------------------- | ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `box` (not scrolling)         | none: layout only, children move to the parent | —                                    | —                                                                                                                             |
| `box` with scrolling overflow | `ScrollView` → `panel`                         | none                                 | contains its children                                                                                                         |
| `text`                        | `Label` → `label`                              | the text                             | —                                                                                                                             |
| `button`                      | `Button` → `push-button`                       | the label                            | `focusable` when enabled; a disabled button is only not focusable (see below); no `checkable`/`checked` state                 |
| `input`                       | `TextInput` → `entry`                          | none (the placeholder is not a name) | as in the matrix above                                                                                                        |
| `split` divider               | `Splitter` → `separator`                       | `accessible_label`                   | `focusable`, `focused`; `vertical` (row) or `horizontal` (column); Value interface: ratio × 100, `min_size` limits as min/max |
| `overlay`                     | `Dialog` → `dialog`                            | `accessible_label`                   | `modal` when `modal: true`; AccessKit adds `active` while it is the active dialog; contains its children                      |

The split itself has no node; only its divider does. Popup window overlays
(`surface: 'window'`) are given the same dialog role in their popup window, but
that tree is **not run** by any client. There is no list or list-item role:
[streaming lists](native-lists.md) are application-level boxes, so their rows
appear as their text and controls only.

**Before this change** (measured with the same AT-SPI probe against the
protocol-11 host from `main` on a scene with every kind and an open modal
overlay), the window's AT-SPI subtree was a flat list of 9 nodes: labels,
push-buttons and one entry. Scrolling boxes, the split divider and the overlay
had no node; dialog content was a sibling of the content beneath it; and the
disabled button differed from an enabled one only by the missing `focusable`.

**Verified** by [`tests/native/accessibility.ts`](../tests/native/accessibility.ts)
(Native Linux CI, development and inspected AOT, Xvfb + openbox + DBus at X11
scale 1, `at-spi2-core` registry, PyGObject `Atspi` 2.0 client
[`atspi-probe.py`](../tests/native/atspi-probe.py), XTEST input): the role, name,
states and nesting above for every kind; the separator's value 40 at ratio 0.4
and its minimum/maximum from `min_size`; Tab and Shift+Tab reaching the divider
between its panes with AT-SPI `focused` following; each Right, Shift+Right, Left,
Home and End step changing both the exposed value and a `split_resize` event
(`source: 'keyboard'`), cross-axis arrows and a step past the limit changing
neither; one `pointer` event after a real drag, which does not move focus; the
divider focus-ring pixels (`#101828` across the divider, white edges); the
modal dialog named `Confirm dialog` with `modal` state and its label and buttons
nested under it, nothing else in the tree while it is open, the Tab cycle
staying inside it, and focus and the tree returning after it closes. The same
run checks the entry's character extents, and AT-SPI requests: a caret offset
and then a selection, each confirmed by OS typing landing there; a button's
click action; `grab_focus`; and the divider's `set_current_value`, clamped to
`min_size`, as keyboard `split_resize` events. `tests/native/text-input.ts`
reads the Hebrew entry's extents as the bidirectional display oracle.

**Modal dialogs.** While a modal overlay is open, every node that is neither
inside it nor on its route is marked hidden (AccessKit `hidden`, as for
`aria-modal`), so AT-SPI, AX and UI Automation clients see only the dialog
and its content, and it all returns when the dialog closes. Before this
change the content beneath stayed exposed, `showing` and `focusable`; only
keyboard and pointer input were trapped.

**Measured AccessKit 0.24 limit, not worked around:** a disabled button is
still reported `enabled` and `sensitive` on AT-SPI (AccessKit maps disabled
to AT-SPI only for roles that support read-only), so Linux assistive
technology sees it only as not focusable. The macOS and Windows clients
record the platform's enabled flag for it without asserting it.

**Not verified:** screen reader speech or navigation (Orca, VoiceOver,
Narrator, NVDA); Wayland; accessibility at scale 2; announcements of value or
dialog changes; and the popup window tree.

**Verified on macOS and Windows** by
[`tests/native/accessibility-platform.ts`](../tests/native/accessibility-platform.ts)
(Native macOS and Windows CI, development and inspected AOT, the hosted GUI
session, no synthesized pointer or keys). The tree is read and operated by an
independent client that never links GPUI:
[`macos-accessibility-oracle.m`](../tests/native/macos-accessibility-oracle.m)
through `AXUIElement`, the API VoiceOver uses, and
[`windows-accessibility-oracle.ps1`](../tests/native/windows-accessibility-oracle.ps1)
through UI Automation, the API Narrator uses. It checks every kind's role and
name, the editable and read-only entries' settable state, the divider's value
and limits; an AT value on the editable entry producing one `input` event and
the same request on the read-only entry producing none; on macOS a selection
request read back as `AXSelectedTextRange`; press as a click; focus; the
divider's value, its `min_size` clamp and on macOS `AXIncrement`, each one
keyboard `split_resize`; and an AT-opened modal dialog that hides everything
beneath it until it closes.

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

The accessibility-role scenario runs the same way at scale 1:

```sh
mkdir -p .bun-native/a11y && out=$(mktemp -d "$PWD/.bun-native/a11y/run.XXXXXX")
BUN_NATIVE_HOST="$PWD/target/release/bun-native-host" \
BUN_NATIVE_A11Y_EVIDENCE="$out" BUN_NATIVE_A11Y_MODE=development \
BUN_NATIVE_ATSPI_PYTHON=/usr/bin/python3 \
  xvfb-run --auto-servernum --server-args='-screen 0 1280x1024x24 -nolisten tcp' \
  dbus-run-session -- bash scripts/quality/native-linux-session.sh "$out/session" -- \
  env GPUI_X11_SCALE_FACTOR=1 bun tests/native/accessibility.ts
```

It writes `result.json`, every AT-SPI dump in `atspi-trees.json` and the
`divider-focused.png` capture.

On macOS and Windows, compile or locate the client and run the platform
scenario (the AOT entry is `accessibility-platform`):

```sh
xcrun clang -fobjc-arc -framework AppKit -framework ApplicationServices \
  tests/native/macos-accessibility-oracle.m -o "$out/oracle"   # macOS only
BUN_NATIVE_HOST="$PWD/target/release/bun-native-host" \
BUN_NATIVE_A11Y_EVIDENCE="$out" BUN_NATIVE_A11Y_MODE=development \
BUN_NATIVE_A11Y_ORACLE="$out/oracle" \
  bun tests/native/accessibility-platform.ts
```

On Windows, `BUN_NATIVE_A11Y_ORACLE` is the absolute path of
`tests/native/windows-accessibility-oracle.ps1`. On macOS the terminal running
it needs the Accessibility permission. The run writes `result.json` and every
platform dump in `platform-trees.json`. `BUN_NATIVE_ATSPI_PYTHON` must name a Python
whose `gi` module loads (on the local Debian image only `python3.12` did). The
AOT entry is `accessibility`.
