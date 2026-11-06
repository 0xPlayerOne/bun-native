# ADR 0014 — Message and confirm dialogs on the modal overlay

Status: accepted; implemented in public core on every platform whose host
advertises `overlays_v1` and `focus_v1`. Qualified on Linux X11 (Xvfb +
openbox, XTest input, Mesa lavapipe, scale 1) in development and inspected
AOT; macOS and Windows build the same code path but are not qualified.

Date: 2026-11-06.

Related: [menus and dialogs #239](https://github.com/0xPlayerOne/bun-native/issues/239),
[file dialogs](0013-native-file-dialogs.md), [overlays](../native-overlays.md)
and [service policy](0005-native-service-policy.md).

## Context

Applications need a blocking question ("Save before closing?", "Delete this
file?") with a known set of answers. [ADR 0013](0013-native-file-dialogs.md)
recorded that Linux has no portal for alerts and that GPUI's `Window::prompt`
falls back, on X11 and Wayland, to its own in-window renderer that duplicates
the overlay layer and offers no programmatic close. Native `NSAlert` and
Windows task dialogs would each need their own modality, ownership and
qualification, and still leave Linux without one.

The modal overlay already provides what an alert needs inside one window: a
window-anchored layer that blocks pointer input beneath it, a Tab/Shift-Tab
trap, focus return when it closes, and (with `focus_v1`) a focus request
validated against the active modal. It is implemented once in the GPUI host
and qualified with real input.

## Decision

Message and confirm dialogs are drawn by public core on the modal overlay,
not by the OS. There is no protocol change, no new host command and no launch
grant: a dialog is ordinary UI in the application's own window and needs no
authority the application does not already have.

```ts
const result = await window.showMessageDialog(
  {
    title: 'Unsaved changes',
    message: 'Save the document before closing?',
    detail: 'Unsaved edits are lost.',
    buttons: [
      { id: 'save', label: 'Save', kind: 'primary' },
      { id: 'discard', label: 'Discard', kind: 'destructive' },
      { id: 'cancel', label: 'Cancel' },
    ],
    defaultButton: 'save', // the first button when absent
    cancelButton: 'cancel', // Escape activates it
  },
  { signal }
)
// { kind: 'button', id } or, for a `dismissible` dialog, { kind: 'dismissed' }
const ok: boolean = await window.showConfirmDialog({ title: 'Delete', message: 'Delete it?' })
```

- **Capability.** `serviceCapabilities.messageDialogs` is
  `{ availability: 'available', scope: 'owned_window', backend: 'modal_overlay' }`
  when the host advertises both `overlays_v1` and `focus_v1`, otherwise
  `{ availability: 'unavailable', reason: 'unsupported_host' }`, and a call
  rejects with `NativeServiceError('message_dialogs', 'service_unavailable')`
  before anything is staged. The current GPUI host advertises both on every
  platform.
- **One batch.** Showing a dialog commits one batch: a modal window overlay
  appended to the window root, a fixed panel (title, message, optional detail,
  a right-aligned row of buttons) and a `focus` request for the default
  button. The layout uses the `defaultTheme` tokens (surface, text, divider,
  accent, sizes and spacing) and needs no `style_decoration_v1`; the panel is
  at most 420 logical pixels wide and has no animation. `destructive` buttons
  use the one color the default theme has no token for, `0xb42318`.
- **Validation.** Options are validated in TypeScript before staging, because
  nothing new crosses the wire: unknown keys are rejected; `title` is one
  nonblank line of at most 256 UTF-8 bytes; `message` (at most 2,048) and
  `detail` (at most 4,096) are nonblank and may contain line feeds but no other
  control character; there are 1–4 buttons with unique `id`s (1–64 bytes, no
  control characters) and one-line labels of at most 64 bytes;
  `defaultButton` and `cancelButton` must name a button. Ordinary element
  limits still apply in the transaction.
- **Input is handled at ingestion.** Routed events whose committed path passes
  through the dialog's layer are consumed by core when they arrive and are not
  delivered to application listeners. Callbacks run one at a time, so a dialog
  that settled through the callback queue would deadlock a listener awaiting
  it (`onClick(..., async () => { await window.showConfirmDialog(...) })`).
  A click on a dialog button chooses it; Enter or Space on the focused button
  is the host's native button activation. An unmodified Escape activates
  `cancelButton`, or dismisses a `dismissible` dialog without one, and is
  otherwise ignored. A press on the backdrop dismisses only a `dismissible`
  dialog.
- **Results after removal.** The first decision wins. The layer is then
  removed in another batch and the promise settles only after that commit, so
  the caller observes the dialog gone and focus returned (by the overlay rule)
  to the control focused before it opened. Results are frozen.
- **Queueing, not stacking.** A window shows one message dialog at a time.
  Later calls wait unseen in call order and open after the previous layer is
  removed; at most 8 per window (shown one included), `limit_exceeded`
  otherwise. Stacking would let a later dialog cover an unanswered one and
  make Escape order depend on timing. Dialogs of different windows are
  independent.
- **Cancellation and lifetime.** An already aborted signal rejects with
  `NativeServiceError` `cancelled` and stages nothing. Aborting a queued dialog
  rejects it at once and it is never shown; aborting an opening or shown one
  removes its layer and then rejects with `cancelled`. Owner close and shutdown
  reject every shown and queued dialog of that window synchronously with
  `NativeStateError` `invalid_handle`; nothing is sent for them.
- **Failure is reported, not hidden.** If the layer batch fails, for example
  because a deeper application modal is active so the focus request is
  outside the active modal (`invalid_state`), that error rejects the call and
  the next queued dialog is tried. If removing the layer fails, that error
  rejects the call.

Solid and React have no separate helper: components call the same methods on
the window they render into. The renderers own one child of the window root
and the dialog layer is another, so neither interferes with the other.

## Consequences

- Dialogs look and behave the same on every platform and are fully testable
  on Linux, headless and with a real host.
- They are not OS alerts: no system sound, no sheet attached to the title bar,
  no application-modal blocking of other windows, and no accessibility role or
  announcement (the overlay layer exposes none yet). An application overlay
  committed later at the same depth, or deeper, paints above a dialog.
- The dialog's nodes count toward the window's ordinary node and text limits.
- Native `NSAlert`/task dialogs remain possible as a different backend value
  later; the public result shape does not depend on the backend.
- **Linux decision (2026-11-06, #239).** Linux has no OS menu or alert service
  that the host could call: there is no portal for alerts and GPUI's own
  prompt is an in-window renderer. The modal overlay is therefore the supported
  and only Linux implementation, not a fallback awaiting an OS backend. Menus
  follow the same rule: in-window overlays everywhere except the macOS
  application menu bar.

## Verification

- `bun test tests/core/message-dialogs.test.ts` drives a real Bun subprocess
  peer: capability gating, validation bounds, result mapping, Escape, backdrop
  and modified keys, default activation, queue order and bound, an awaiting
  listener, abort while queued, opening and shown, owner close, shutdown and a
  failed layer batch. It is headless and not evidence of native focus or
  painting.
- [`tests/native/message-dialogs.ts`](../../tests/native/message-dialogs.ts)
  runs in the Native Linux workflow in development and inspected AOT with real
  XTest input and nonce-tagged paint evidence; the reproduction and observed
  outcomes are in [native services](../native-services.md#message-and-confirm-dialogs).
