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
every engine.

The same fixture then checks candidate selection and the caret position an
input method places its candidate window at. An independent IBus panel,
[`ibus-panel-probe.py`](../tests/native/ibus-panel-probe.py), takes the panel
role that `ibus-ui-gtk3` has on a desktop and records what the daemon relays to
it. The caret position (XIM spot location, translated to screen pixels by the
daemon) must lie on the input and move right as the composition grows. The
engine's Hanja key (F9) on the composing `가` must open a candidate list of Han
characters in the panel with the first highlighted. Down must highlight the
second candidate, and Return must replace the syllable with it and close the
list. The next key must then start a new syllable. Observed locally in
development and inspected AOT: candidates `可, 家, 加, …` (9 per page), `家`
selected, values `가 家` and `가 家ㄱ`. The panel probe draws nothing, so the
drawing of a candidate window by a desktop panel is not covered.

That check found a host defect. GPUI reads the caret rectangle for XIM right
after it applies a preedit, before the next frame paints it (and Wayland text
input does the same). The host answered `bounds_for_range` only from the last
paint, which showed the old text, so it returned nothing. GPUI then sent no spot
location, and IBus placed every candidate window at the window's bottom-left
corner (`(0, 160)` relative to the window, on every relay, before the fix).
The host now lays the changed text out the way the next paint will: the same
font, viewport and scroll rule
(`InputPaint::projected_bounds_for_range`, unit-tested in
`native/gpui-host/src/input/viewport/tests.rs`). macOS reads the same method
for `firstRectForCharacterRange:`. That path has not been run on macOS.
The Wayland column comes from `tests/native/wayland.ts` on headless sway
([native platforms](native-platforms.md#linux-wayland)) at output scales 1 and
2; it covers basic entry, grapheme Backspace, Hebrew, Tab order, IME
composition through a test input method and the accessibility rows marked
there. Sway 1.9 has no input popup surfaces, so the IME cursor rectangle GPUI
sets is never relayed to an input method and stays unverified on Wayland.
Before the host projected the caret for changed text (below), GPUI had no
rectangle to send while composing. It now sets one and commits its text input
after each preedit, and the compositor answers that commit with another
`done`. The test input method (`wayland-input-peer`) therefore reads every
pending event before each of its own commits, as a real input method does. Its
commits otherwise carried a stale serial, and wlroots dropped the cancelling
empty preedit.

| Area                                                                                  | Linux X11 (Xvfb)                                                                                                                                                                                                                                                                                                                                                                                                 | Linux Wayland                                                                                                                                                                                                      | macOS                                                                                                                                                                                                                                  | Windows                                                                                                                                                                 |
| ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OS-typed text entry (ASCII and `é`) and Enter activation                              | **Observed**                                                                                                                                                                                                                                                                                                                                                                                                     | **Observed** (headless sway, `zwp_virtual_keyboard_v1`)                                                                                                                                                            | Not run in this suite; see [native platforms](native-platforms.md)                                                                                                                                                                     | Not run in this suite; see [native platforms](native-platforms.md)                                                                                                      |
| Grapheme caret/Backspace/Delete (combining marks, ZWJ family, flag)                   | **Observed** through OS keys; unit-tested                                                                                                                                                                                                                                                                                                                                                                        | **Observed** Backspace over a combining mark and a ZWJ family (scales 1 and 2)                                                                                                                                     | Not run (same host code)                                                                                                                                                                                                               | Not run (same host code)                                                                                                                                                |
| OS-typed Hebrew (RTL) committed in logical order; RTL Backspace                       | **Observed**                                                                                                                                                                                                                                                                                                                                                                                                     | **Observed** (logical order, Backspace)                                                                                                                                                                            | Not run                                                                                                                                                                                                                                | Not run                                                                                                                                                                 |
| Bidirectional display: Hebrew after Latin text, Arabic joining                        | **Observed**: AT-SPI character extents from the painted glyphs put Hebrew right to left after the Latin run, each box over glyph ink; Arabic سلام is painted with joined forms and the lam-alef ligature (narrower than the same letters split by ZERO WIDTH NON-JOINER, ink across the seen-lam joint, a blank column when split). Scales 1 and 2. The caret's visual position in mixed text is **not verified** | Not run                                                                                                                                                                                                            | Not run                                                                                                                                                                                                                                | Not run                                                                                                                                                                 |
| Dead-key composition: preedit `´` marked, then `é` committed; cancelled sequence      | **Observed** (xkbcommon compose, `us intl`, `LC_CTYPE=C.UTF-8`)                                                                                                                                                                                                                                                                                                                                                  | Not run                                                                                                                                                                                                            | Not run                                                                                                                                                                                                                                | Not run                                                                                                                                                                 |
| IME composition through a real engine (IBus Hangul over XIM; OS Korean input methods) | **Observed** (`tests/native/ime.ts`: preedit, syllable composition, engine Backspace, commit by Space)                                                                                                                                                                                                                                                                                                           | **Observed** with a test input method, not a real engine: `zwp_input_method_v2` preedit, in-place replacement, commit and cancel reach `zwp_text_input_v3` through sway (scales 1 and 2)                           | **Gating, passed on hosted CI** (runs 42938725505, 43087027363 and 43093920340, development and AOT): `tests/native/ime-platform.ts`, the bundled 2-Set Korean input source selected through Text Input Sources before the host starts | **Experimental, failed on two hosted runs**: `tests/native/ime-platform.ts`, the Microsoft Korean IME switched on with `WM_INPUTLANGCHANGEREQUEST` and `WM_IME_CONTROL` |
| Candidate windows, CJK candidate selection, Fcitx, other engines                      | **Observed** (`ime.ts`): Hanja candidate list in an independent IBus panel, highlight moved, selection commits; caret position relayed on the input. Fcitx, other engines and a drawn candidate window not run                                                                                                                                                                                                   | Not run (`zwp_text_input_v3`)                                                                                                                                                                                      | Not run                                                                                                                                                                                                                                | Not run                                                                                                                                                                 |
| Selection + copy/cut/paste through the X11 CLIPBOARD (checked with `xclip`)           | **Observed**                                                                                                                                                                                                                                                                                                                                                                                                     | Not run                                                                                                                                                                                                            | Not run                                                                                                                                                                                                                                | Not run                                                                                                                                                                 |
| Read-only: focusable, copyable, every edit path rejected                              | **Observed**                                                                                                                                                                                                                                                                                                                                                                                                     | Not run                                                                                                                                                                                                            | Not run                                                                                                                                                                                                                                | Not run                                                                                                                                                                 |
| Disabled: skipped by Tab, no edits, blur on disable, focusable again on re-enable     | **Observed**                                                                                                                                                                                                                                                                                                                                                                                                     | Not run                                                                                                                                                                                                            | Not run                                                                                                                                                                                                                                | Not run                                                                                                                                                                 |
| Keyboard-only Tab/Shift+Tab order with wrap, Space activation                         | **Observed**                                                                                                                                                                                                                                                                                                                                                                                                     | **Observed** (Tab to the button, Space activation, Shift+Tab back)                                                                                                                                                 | Not run                                                                                                                                                                                                                                | Not run                                                                                                                                                                 |
| Scale factor 2: snapshot `scaleFactor` and physical window size, editing unchanged    | **Observed** (`GPUI_X11_SCALE_FACTOR=2`)                                                                                                                                                                                                                                                                                                                                                                         | Snapshot `scaleFactor: 2` and typing observed (sway output scale 2); physical buffer size not checked                                                                                                              | Not run (Retina)                                                                                                                                                                                                                       | Not run (per-monitor DPI)                                                                                                                                               |
| Accessibility tree read by an independent client                                      | **Observed** (AT-SPI): roles, names, values, caret, character bounds, focus, read-only/disabled states                                                                                                                                                                                                                                                                                                           | **Observed** (AT-SPI on headless sway, scales 1 and 2): every element kind's role, name and states, character bounds in physical pixels                                                                            | **Observed** (AXUIElement, hosted macos-15): roles, names, values, divider limits (a read-only field still reports AXValue settable, see below)                                                                                        | **Observed** (UI Automation, hosted windows-2022): control types, names, values, divider limits, read-only (the divider's RangeValue is always read-only, see below)    |
| Assistive-technology requests: caret/selection, value, press, focus, divider value    | **Observed** (AT-SPI): caret and selection moves that later OS typing lands at, press, grab_focus, divider value with min_size clamp                                                                                                                                                                                                                                                                             | **Observed** (AT-SPI): caret move that compositor typing lands at, grab_focus, press, divider value with min_size clamp                                                                                            | **Observed** (AX): AXValue text (and rejected on read-only), AXSelectedTextRange, AXPress, AXFocused, divider AXValue and AXIncrement                                                                                                  | **Observed** (UIA): ValuePattern.SetValue (and rejected on read-only), Invoke, SetFocus; divider RangeValue.SetValue **unsupported** (refused by the client)            |
| Content beneath an open modal dialog hidden from assistive technology                 | **Observed** (AT-SPI)                                                                                                                                                                                                                                                                                                                                                                                            | **Observed** (AT-SPI, scales 1 and 2)                                                                                                                                                                              | **Observed** (AX)                                                                                                                                                                                                                      | **Observed** (UIA)                                                                                                                                                      |
| Roles of every element kind, modal dialog, split divider value (`accessibility.ts`)   | **Observed** at scales 1 and 2, development and AOT (see below)                                                                                                                                                                                                                                                                                                                                                  | **Observed** at scales 1 and 2, development and AOT (`wayland.ts`): roles, divider value and limits, wtype Right/End, modal dialog tree and Tab cycle                                                              | **Observed** in `accessibility-platform.ts`, development and AOT                                                                                                                                                                       | **Observed** in `accessibility-platform.ts`, development and AOT                                                                                                        |
| Screen reader speech (Orca, VoiceOver, NVDA, Narrator)                                | **Observed** with Orca 46.1 (`tests/native/screen-reader.ts`, development and AOT): exact phrases for focus, role, name, read-only state, typed value, caret characters, selection, deletion, a modal dialog and a split divider; see [screen reader speech](#screen-reader-speech)                                                                                                                              | **Observed** with Orca 46.1 (development and AOT): focus, role, name, read-only state, dialog and divider phrases; no key echo, caret characters or Where Am I (see [screen reader speech](#screen-reader-speech)) | **Gating, passed** (development and AOT, Validation runs 43087027363 and 43093920340): VoiceOver through its AppleScript `last phrase`, after the focus routing fix (see [screen reader speech](#screen-reader-speech))                | **Experimental, failed on two hosted runs**: NVDA 2024.4.2 IO-level speech log. Narrator: not run (no automation interface used)                                        |
| Physical keyboard, physical display DPI, GPU                                          | **Not run** (software Vulkan, XTEST)                                                                                                                                                                                                                                                                                                                                                                             | Not run (software Vulkan, virtual keyboard)                                                                                                                                                                        | Not run                                                                                                                                                                                                                                | Not run                                                                                                                                                                 |
| Programmatic focus from application code (`focus_v1`)                                 | **Observed** in `tests/native/overlays.ts`, not in this fixture                                                                                                                                                                                                                                                                                                                                                  | Not run                                                                                                                                                                                                            | Not run                                                                                                                                                                                                                                | Not run                                                                                                                                                                 |
| Multi-line text input                                                                 | Unsupported                                                                                                                                                                                                                                                                                                                                                                                                      | Unsupported                                                                                                                                                                                                        | Unsupported                                                                                                                                                                                                                            | Unsupported                                                                                                                                                             |

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
(`surface: 'window'`) are given the same dialog role in their popup window
(see **Popup windows** below). There is no list or list-item role:
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
scales 1 and 2, `at-spi2-core` registry, PyGObject `Atspi` 2.0 client
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
`min_size`, as keyboard `split_resize` events. At scale 2 the same
run checks every OS coordinate, capture pixel and drag position in device
pixels, the window at twice its logical size, and the divider's AT-SPI window
extents at twice its painted logical bounds (`[475, 176, 12, 320]` against
`[238, 88, 6, 160]` at scale 1). `tests/native/text-input.ts`
reads the Hebrew entry's extents as the bidirectional display oracle.

**Modal dialogs.** While a modal overlay is open, every node that is neither
inside it nor on its route is marked hidden (AccessKit `hidden`, as for
`aria-modal`), so AT-SPI, AX and UI Automation clients see only the dialog
and its content, and it all returns when the dialog closes. Before this
change the content beneath stayed exposed, `showing` and `focusable`; only
keyboard and pointer input were trapped.

The content returns as **new** accessible nodes. AccessKit 0.24's AT-SPI
adapter marks every node it removes `defunct` and never clears that state when
a node with the same id comes back, and libatspi keeps the cached state. Orca
46.1 then ignored every focus change beneath a closed dialog: after Cancel,
neither the returned focus nor later Tab presses were spoken (measured with the
release host built from main, SHA-256 `ac894d24…`; Orca's debug log reads
`Ignoring defunct object: [push button: 'Open dialog']`). The view now folds a
counter into every element id, and the counter changes whenever a modal layer
stops being the active one
([`overlays.rs`](../native/gpui-host/src/view/overlays.rs)
`Overlays::exposure`), so the re-exposed content gets fresh AccessKit node
ids. Element state that GPUI keys by element id (hover and similar transient
state) starts over at that moment; focus, scroll offsets and input contents
live in host entities and are unaffected.

**Measured AccessKit 0.24 limits, not worked around:** a disabled button is
still reported `enabled` and `sensitive` on AT-SPI (AccessKit maps disabled
to AT-SPI only for roles that support read-only), so Linux assistive
technology sees it only as not focusable. On Windows, UI Automation reports
every splitter's RangeValue as read-only (the role is not in AccessKit's
read-only-supported set), so a UIA client refuses to set the divider; the
fixture asserts the refusal and that no resize is reported. On macOS a
read-only text field still reports `AXValue` as settable; the host rejects
the request without an `input` event. The macOS and Windows clients
record the platform's enabled flag for it without asserting it.

**Announcements.** The same run starts an independent AT-SPI event listener
(`atspi-probe.py watch`) before the divider steps and asserts, from the host's
live nodes, one `object:property-change:accessible-value` event on the
`Sidebar` separator per keyboard step carrying its new value (41, 51, 50, the
`min_size` limits, in order), one for the drag's final value, and an
`object:children-changed:add` for a dialog named `Confirm dialog` when the
modal opens, after which `Confirm` is focused. Orca speaks the dialog and a
re-announced splitter on these events (see
[screen reader speech](#screen-reader-speech)).

**Popup windows.** A popup window overlay (`surface: 'window'`,
`popup_windows_v1`) is read through its own OS window, titled
`Bun Native popup`: its tree is exactly one dialog named by
`accessible_label`, not `modal`, holding the overlay's label and button; none
of those nodes appear in the parent window's tree; and an AT-SPI click on the
popup's button reaches Bun as one `click`.

**Wayland.** [`tests/native/wayland.ts`](../tests/native/wayland.ts) opens a
second window on headless sway (scales 1 and 2, development and AOT) and
checks with the same AT-SPI client: every role above, the scrolling panel's
children, the disabled button not focusable, the divider's value 40 and
`min_size` limits, Shift+Tab to the divider and wtype Right and End each
changing its `split_resize` ratio and AT-SPI value, an AT value request
clamped to `min_size`, and the modal dialog's name, `modal` state, nested
content, nothing beneath it exposed, its Tab cycle and the tree after it
closes. GPUI's Wayland window reports no screen position to AccessKit
(`a11y_update_window_bounds` is a no-op in
`crates/gpui_linux/src/linux/wayland/window.rs:2278-2280` at zed `ba63a022`),
so only character bounds relative to the window are checked there.

**Not verified:** screen reader speech on macOS and Windows (see
[screen reader speech](#screen-reader-speech) for Orca); the popup window tree
and AT-SPI announcements on Wayland; and virtualized lists. A
[streaming list](native-lists.md) has no list or list-item role, no set size
or position, rows windowed out of view have no node at all, and streamed text
is not announced (the protocol has no live-region attribute). These are host
and protocol gaps, not GPUI or AccessKit limits: AccessKit 0.24 has `List`,
`ListItem`, `size_of_set`, `position_in_set` and `Live`.

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
request read back as `AXSelectedTextRange`; press as a click; focus; on macOS
the divider's value, its `min_size` clamp and `AXIncrement`, each one keyboard
`split_resize`, and on Windows the refused read-only RangeValue; and an AT-opened modal dialog that hides everything
beneath it until it closes.

## Screen reader speech

[`tests/native/screen-reader.ts`](../tests/native/screen-reader.ts) runs a real
screen reader against the host while real OS keys drive the application, and
checks what the screen reader decided to say. Every focus step also waits for
the matching public Bun `focus` event, and typing for the matching `input`
event, so a phrase only counts after the host really changed state.

**Linux X11, Orca: Observed** locally (Ubuntu 24.04, `orca` 46.1-1ubuntu1,
`speech-dispatcher` 0.12.0~rc2-2build3) in development and inspected AOT;
Native Linux CI shard 2 runs the same step and gates on it; it passed in development and AOT in Validation runs 43087027363 and 43093920340. Orca runs
inside the isolated Xvfb, openbox and AT-SPI session with its own preferences
directory. It speaks through a private `speech-dispatcher` whose only output
module is `sd_generic` running `printf '%s\n' '$DATA' >> spoken.txt` (the
ALSA `null` device satisfies the module's audio initialization), so
`spoken.txt` holds exactly the text Orca sent to the synthesizer. Orca's
`--debug-file` log is kept beside it. Keys come from XTEST. The fixture
asserts these phrases, in order, among everything said for each step:

| Action (XTEST)                      | Host event                 | Orca phrases                                                     |
| ----------------------------------- | -------------------------- | ---------------------------------------------------------------- |
| Window opens with the input focused | `focus` search             | `entry typed.`                                                   |
| Tab                                 | `focus` button             | `Leading action push button.`                                    |
| Tab                                 | `focus` read-only          | `read only entry Fixed.`                                         |
| Tab (skips the disabled button)     | `focus` button             | `Open dialog push button.`                                       |
| Tab (wraps)                         | `focus` search             | `entry typed.`                                                   |
| End, then type `x`                  | `input` `typedx`           | `x` (key echo)                                                   |
| KP_Enter (Orca "Where Am I")        | none                       | `entry typedx.`                                                  |
| Left, Home, Right                   | none                       | `x`, `t`, `y` (the character at the caret)                       |
| Shift+End                           | none                       | `ypedx`, `selected`                                              |
| Backspace                           | `input` `t`                | `Selection deleted.`                                             |
| Shift+Tab (wraps backwards)         | `focus` button             | `Open dialog push button.`                                       |
| Space                               | `focus` Confirm            | `Confirm dialog dialog Discard changes?`, `Confirm push button.` |
| Tab inside the dialog               | `focus` Cancel             | `Cancel push button.`                                            |
| Space on Cancel (dialog closes)     | `focus` button             | `Open dialog push button.`                                       |
| Tab, Tab                            | `focus` search, button     | `entry t.`, `Leading action push button.`                        |
| Shift+Tab, Shift+Tab (wraps)        | `focus` search, divider    | `entry t.`, `vertical splitter Sidebar.`                         |
| Right, End on the divider           | `split_resize` 0.41, limit | `vertical splitter` each time                                    |
| KP_Enter on the divider             | none                       | `vertical splitter Sidebar.`                                     |

No phrase may mention `Disabled action`. Observed locally with the host rebuilt
from this change and the final fixture: five consecutive development runs
passed; of seven AOT runs, six passed and one failed at the first step (see the
`get_role_name` limit below). An earlier fixture registered its focus listeners
per control after the batch that created them, and one of three development
runs missed the initial focus event that way even though Orca had already said
`entry typed.`; the fixture now listens on the root before any control exists.
The release host built from main (SHA-256
`ac894d24…`) passes every step up to the dialog and then fails at "Space on
Cancel" (observed only `space`): the defunct-node defect described under
[modal dialogs](#accessibility-roles-accessibility_v1). Orca also says the
window title (`Bun Native screen reader qualification frame.`) when the window
activates. That phrase is recorded but not asserted, because whether it is
spoken depends on whether the window manager activates the window before or
after AccessKit registers.

Measured limits:

- The input's placeholder is not its accessible name, so Orca says
  `entry typed.` and does not name the field. Inputs take no label (see the
  role table above).
- Orca says `Confirm dialog dialog …` because the overlay's
  `accessible_label` is `Confirm dialog`; the role word is Orca's.
- A disabled button is never reached by Tab, so its disabled state is not
  spoken in this scenario. Orca's flat review is not driven.
- Orca's event loop can block for about 15 s on its first `get_role_name` call
  to a newly registered application (`Did not receive a reply`, then
  `The process appears to be hung`) and then catch up. In the isolated session
  the first host launch D-Bus-activates `xdg-desktop-portal`, and that
  registration triggered it during development, so the fixture starts both
  portals before Orca, as a desktop session would have them running. It was
  still seen once afterwards, on the host's own application object, in one of
  the seven AOT runs above: the first step's 10 s limit expired before Orca
  spoke. In every other run the host's window and focus were spoken within
  about 100 ms of launch. The cause on the host side has not been isolated, and
  the step can fail on CI the same way.
- Orca never speaks the divider's value. It re-announces the focused
  separator on every AT-SPI value change, but Orca 46.1's separator format
  (`orca/formatting.py`, `Atspi.Role.SEPARATOR`: `'focused': 'roleName +
  availability'`) has no value field, so only `vertical splitter` is said.
  The value change itself is asserted by
  [`accessibility.ts`](../tests/native/accessibility.ts) (below).
- Braille, Orca's browse modes, non-default speech settings and the physical
  audio path are not run.

**Linux Wayland, Orca: Observed** locally in development and inspected AOT
with the same fixture on the owned headless sway session
(`scripts/quality/native-wayland-session.sh`), keys from `wtype`, and the host
a native Wayland client with no `DISPLAY`. Native Linux CI shard 2 runs it in
the same step after each X11 run. Orca 46.1 itself exits without an X display
(`orca_modifier_manager.py` runs `xkbcomp $DISPLAY` while loading settings;
GNOME and KDE give it XWayland's), so the fixture gives Orca alone a private
Xvfb. Every focus, role, name, read-only, dialog and divider phrase in the
table above is asserted as on X11. Not spoken on Wayland, and not asserted
there: key echo (`x`), the characters at a moved caret, and Orca commands
(Where Am I). With `WAYLAND_DISPLAY` set libatspi gives Orca its legacy key
device, which hears only keys an application forwards to the AT-SPI
registry's DeviceEventController; AccessKit forwards none (Orca's debug log
has no `KEYBOARD EVENT` on Wayland, four on X11). The keys still reach the
host and are checked through Bun `input` and `split_resize` events. This is
not a GPUI limit: the host could forward keys itself, and does not.

**macOS, VoiceOver: gating, passed. Windows, NVDA: experimental, failing
(#629).** The Native Platforms step `macOS VoiceOver and experimental Windows
NVDA speech in development and AOT (#241)` runs the same scenario (without the
"Where Am I" step on macOS). On macOS it gates the job: every step was spoken
in development and AOT in Validation runs 43087027363 (#632) and 43093920340
(main), after the focus routing fix below. On Windows it keeps
`continue-on-error` and reports its outcome in a warning and the job summary
until it has passed there. It does not replace or relax the AX and UI
Automation step.

The history below records how the macOS cause was found.

The first hosted run (Native Platforms run 42936020446, shard 2) failed on
both systems at the first step, and the fixture has changed since without a
hosted run:

- macOS 15.8.2: VoiceOver started (`_SCRStartup returned 0`) and answered
  AppleScript. On activation it said
  `application Bun Native screen reader qualification window Screen reader qualification`
  and `You are currently on a text element.`: its cursor went to the first
  element, the text, not to the input that had keyboard focus, so the expected
  `typed` and `edit text` phrase never came. The first macOS step was then
  changed to expect that exact window phrase. Since the cause was found (see
  below), it expects the focused input's name and role again, as on the other
  systems.
- windows-2022: NVDA 2024.4.2 started and said
  `Bun Native screen reader qualification window`, then the runner's own
  console took the foreground. The input controller could not bring the window
  back: PowerShell passed `""` instead of a null class name to `FindWindowW`,
  so no window matched. The controller now passes the null from C#. NVDA's
  `LangChangeCommand ('en')` was also read as the spoken word `en`; the parser
  now keeps only the sequence's own strings.

The second hosted run (run 42938725505, with those changes) failed at the
same first step on both systems:

- macOS: VoiceOver said the same window phrase with ` has keyboard focus`
  appended, then `You are currently on a text element.` again. The step was
  changed to accept either of the two recorded phrases, until the third run.
- windows-2022: the window stayed in front this time. NVDA said
  `Bun Native screen reader qualification window` twice within 130 ms of
  starting and nothing more in the next 15 s, although Bun had reported focus on
  the input. In the UI Automation step of the same run, that input reports
  `HasKeyboardFocus`. NVDA never announced the focused edit field when the
  window was activated. A native Windows application gets that announcement,
  so this is treated as a host or AccessKit gap. It is not fixed, and its cause
  has not been isolated.

Both runs stopped at the first step, so nothing is yet known about the later
steps on either system. A step whose phrase is missing is now recorded under
`missed` in `utterances.json` and the scenario continues. The run still fails
at the end if any phrase was missing.

The third macOS run (Validation run 42962662996, macOS 15.8.2, SIP disabled,
TCC granted, VoiceOver answering AppleScript) ran every step in development.
Every Bun `focus` and `input` event arrived. VoiceOver announced the window on
activation and then said nothing for the remaining 15 steps. A dispatched run
(42989336392) added the AX oracle's `focused` command and found the cause on
the host side: the application's `AXFocusedUIElement`, the attribute VoiceOver
follows, was the `AXWindow`, not the focused input. Re-sending
`windowDidBecomeKey:` to GPUI's window delegate did not change that.

Cause, from the pinned sources. GPUI creates its AccessKit adapter with
`accesskit_macos::SubclassingAdapter::for_window`
(`gpui_macos/src/window.rs`, `a11y_init`). That call dynamically subclasses the
window's content view and overrides `accessibilityFocusedUIElement` and
`accessibilityHitTest:` there (`accesskit_macos` 0.26.3 `subclass.rs`,
`for_window` and `new_internal`). GPUI's own `GPUIView` is not the content
view. `MacWindow::open` adds it as a subview of the default content view and
makes it the window's first responder (`addSubview:` followed by
`makeFirstResponder:`). AppKit resolves the focused element through the key
window's first responder. That is `GPUIView`, which inherits `NSView`'s answer,
its nearest unignored ancestor (the window), and never asks AccessKit. A
second, smaller gap is that the adapter starts out believing its view is
unfocused (`Adapter::new(view, false, …)`). GPUI updates that only from
`windowDidBecomeKey:` and `windowDidResignKey:`, and the window became key in
`open`, before the adapter existed. While the adapter believes it is
unfocused, `focus()` returns nil.

Fix (macOS only; passed on hosted CI in the runs above):
[`focus_route.rs`](../native/macos-surface/src/focus_route.rs) adds
`accessibilityFocusedUIElement` to the GPUI view's and window's classes, and
`accessibilityHitTest:` to the view's class. Each forwards to the AccessKit
subclass of the content view and falls back to the inherited answer when
AccessKit has none. The window's hit test is left alone because it also covers
the title bar. [`key_status.rs`](../native/macos-surface/src/key_status.rs)
again re-sends `windowDidBecomeKey:` once the adapter exists, only while the
window is the key window of the active application.
[`accessibility-platform.ts`](../tests/native/accessibility-platform.ts) (a
gating step) now asserts that the application's `AXFocusedUIElement` is the
focused input, for the first window and for a second window opened while the
application is active. It also asserts that the AX hit test at the input's
centre returns the input. The screen-reader fixture checks the same attribute
after every focus step before it judges VoiceOver.

- macOS: [`macos-voiceover-setup.sh`](../scripts/quality/macos-voiceover-setup.sh)
  repeats what `@guidepup/setup` 0.29.3 does for CI: VoiceOver
  `SCREnableAppleScript`, the
  `/private/var/db/Accessibility/.VoiceOverAppleScriptEnabled` marker, and TCC
  rows for Accessibility, event posting and Apple Events to VoiceOver and
  System Events. It refuses to run outside a GitHub-hosted runner, and it needs
  System Integrity Protection disabled, as it is on those images. VoiceOver is
  started with the private `_ScreenReaderStart` call that Command-F5 makes, and
  its `content of last phrase` is polled through AppleScript. Keys come from
  [`macos-input-oracle.m`](../tests/native/macos-input-oracle.m)
  (`CGEventPost`, only while the host is frontmost). Each step must produce a
  phrase containing the control's name and `button`, or `edit text` or
  `text field` for inputs. Polling sees only the last phrase, so a phrase
  replaced within one poll interval is not recorded.
- Windows: NV Access's signed NVDA 2024.4.2 launcher is pinned by SHA-256
  `b66bbc3d87f11140fe9493ca22955c401c0b09abd0bf3c9d49260807986d4f05`. The hash
  was computed from the file downloaded on 2026-11-11, because NV Access
  publishes no checksum file beside it. The step also requires a valid
  Authenticode signature. It unpacks the launcher with 7-Zip and runs its
  `nvda_noUIAccess.exe` with `--minimal --disable-addons`, a private
  configuration that selects the silence synthesizer, and `--log-level=12`.
  NVDA logs each sequence as `Speaking [...]` before it reaches the
  synthesizer, and
  [`screen-reader-speech.ts`](../tests/native/screen-reader-speech.ts) turns
  those records into phrases. Keys come from
  [`windows-input-oracle.ps1`](../tests/native/windows-input-oracle.ps1)
  (`SendInput`), and "Where Am I" is NVDA+Tab. Each step must produce a phrase
  containing the name and `button` or `edit`.
- Narrator offers no automation interface that this suite uses, and it is not
  run.

**OS input methods: macOS gating and passing; Windows experimental and has
not passed (#629).**
[`tests/native/ime-platform.ts`](../tests/native/ime-platform.ts) repeats the
Linux Hangul sequence (`ㄱ`, `가`, `갈`, Backspace `가`, Space `가 `, `가 ㄱ`,
`가 가`) with the operating system's own Korean input method. On macOS that is
the bundled `com.apple.inputmethod.Korean.2SetKorean` source, enabled and
selected through Text Input Sources and restored afterwards. On Windows it is
the Microsoft Korean IME, switched on in the host window with
`WM_INPUTLANGCHANGEREQUEST` and `IMC_SETOPENSTATUS`/`IMC_SETCONVERSIONMODE`, or
with the Hangul key if the mode request does not take. The step records whether
windows-2022 has the Korean IME and installs `Language.Basic~~~ko-KR~0.0.1.0`
when it does not. Japanese or Chinese conversion with a candidate window is not
attempted. The step `macOS and experimental Windows Korean input method
composition in development and AOT (#241)` gates on macOS, where it passed in
development and AOT in runs 42938725505, 43087027363 and 43093920340. On
Windows it keeps the screen-reader step's non-gating status.

In the first hosted run (run 42936020446), macOS selected the 2-Set Korean
mode (the helper read it back as selected) while the host was frontmost, but
`r` still arrived as `r`, not `ㄱ`. The fixture now selects the mode before the
host starts and checks the selection again from a fresh process with the host
in front. On Windows the step failed before any input: `Get-WinUserLanguageList`
cannot marshal its arguments under PowerShell 7, so the image record now asks
Windows PowerShell. Whether windows-2022 has the Korean IME is still unknown.

In the second hosted run (run 42938725505), macOS passed in development and
AOT. On windows-2022 the Korean TIP and the `00000412` layout are present
(`Language.Basic~~~ko-KR` is `NotPresent` and was not needed). The window
switched to `04120412`, and IMM then reported the IME open in Hangul
conversion mode. Even so, `r` from `SendInput` arrived as `r`, not `ㄱ`. IMM
also reported Hangul mode before the switch, while the layout was still US
English, so its conversion mode may not show the TSF Korean IME's real state.
The cause is unknown. The fixture now records the IMM state again when a step
fails. The Windows step stays experimental.

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

The IBus scenario needs `ibus` and `ibus-hangul`. `BUN_NATIVE_IBUS_PYTHON`
names a Python whose `gi` module loads the IBus typelib (the AOT entry is
`ime`):

```sh
mkdir -p .bun-native/ime && out=$(mktemp -d "$PWD/.bun-native/ime/run.XXXXXX")
BUN_NATIVE_HOST="$PWD/target/release/bun-native-host" \
BUN_NATIVE_TEXT_EVIDENCE="$out" BUN_NATIVE_TEXT_MODE=development \
BUN_NATIVE_IBUS_PYTHON=/usr/bin/python3 \
  xvfb-run --auto-servernum --server-args='-screen 0 1280x1024x24 -nolisten tcp' \
  dbus-run-session -- bash scripts/quality/native-linux-session.sh "$out/session" -- \
  env LC_CTYPE=C.UTF-8 bun tests/native/ime.ts
```

It writes `result.json` and every panel request in `panel-events.json`.

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

To capture what Orca says (Linux, with `orca` and `speech-dispatcher`
installed), run the fixture below. It writes `spoken.txt`, `orca-debug.log`,
`utterances.json` and `result.json` to the evidence directory.

```sh
mkdir -p .bun-native/sr && out=$(mktemp -d "$PWD/.bun-native/sr/run.XXXXXX")
BUN_NATIVE_HOST="$PWD/target/release/bun-native-host" \
BUN_NATIVE_SR_EVIDENCE="$out" BUN_NATIVE_SR_MODE=development \
BUN_NATIVE_ATSPI_PYTHON=/usr/bin/python3 \
  xvfb-run --auto-servernum --server-args='-screen 0 1280x1024x24 -nolisten tcp' \
  dbus-run-session -- bash scripts/quality/native-linux-session.sh "$out/session" -- \
  bun tests/native/screen-reader.ts
```
