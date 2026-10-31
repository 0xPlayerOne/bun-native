# Shared native interaction events

This implements the shared native event foundation for [BN2 #234](https://github.com/0xPlayerOne/bun-native/issues/234). The GPUI host, protocol and public core own one event implementation. Solid and React map their listener props to that public API; they do not create native event backends or reconstruct a DOM.

Protocol **4** requires `interactions_v1` together with `tree`, `input_revisions` and `layout_v1`. Earlier hosts are incompatible and fail negotiation before a window opens. Rebuild and pin packages and the prebuilt native executable together. Historical protocol-2/3 artifacts remain evidence for their original revisions, not for the new event contract.

## Public listener contract

```ts
const unsubscribe = window.on(panel, 'key_down', (event) => {
  console.log(event.key, event.modifiers, event.phase)
}, { capture: true })

window.on(button, 'pointer_down', (event) => {
  event.stopPropagation()
  // Native focus/activation is already independent of this Bun callback.
}, { capture: true })

unsubscribe()
```

`window.on(node, type, listener, { capture?: boolean })` supports `click`, `input`,
`key_down`, `key_up`, `pointer_down`, `pointer_up`, `focus` and `blur`. It owns one
registration for each node/type/phase. Registering a replacement revokes its
predecessor; the returned unsubscribe function cannot remove a newer binding.
`onClick(button, listener)` and `onInput(input, listener)` remain convenient target
bubble bindings. Public node handles are opaque and cannot be forged from IDs.

Each event exposes the native target `node`, this binding's `currentTarget`, a
frozen `path`, `phase`, `treeRevision`, `sequence` and registration `signal`.
The path is the committed native ancestry captured when the event was emitted,
root first and target last. Capture runs root to target; the target's capture
and bubble bindings both have phase `target`; bubbling then runs toward root.
The event object, ancestry and modifier objects are immutable.

`stopPropagation()` stops delivery to subsequent nodes. At the target, its
other binding still runs. `stopImmediatePropagation()` also suppresses that
remaining target binding. The `propagationStopped` getter observes the shared
state. Calls after the invoking listener settles, or after its registration is
revoked, have no effect. These methods control Bun callback traversal. They do
not prevent a native focus change, text edit or button activation. There is no
`preventDefault()` contract or implicit read-only input policy.

Callbacks execute globally in native event order, with one active callback and
at most 128 waiting event plans. Ingestion proceeds separately while a listener
awaits: new input state, acknowledgements and native close still update owned
state. Unsubscribe, replacement, deletion and close revoke the relevant
registration and discard its queued delivery. Deleting an event's target also
cancels its active dispatch, including an awaiting ancestor callback; that
cancellation does not revoke the ancestor's still-live registration signal.
The runtime cannot terminate arbitrary user JavaScript that ignores cancellation.

## Observed native fields

| Event                        | Additional public fields               | Native meaning                                                                                                 |
| ---------------------------- | -------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `click`                      | None                                   | Logical enabled-button activation through pointer or its native keyboard action.                               |
| `input`                      | `value`, `revision`                    | Accepted native content change and its independent input revision. Selection-only changes do not increment it. |
| `key_down`, `key_up`         | `key`, optional `keyChar`, `modifiers` | GPUI logical key identity and optional logical text. `keyChar` is not committed text or an IME notification.   |
| `pointer_down`, `pointer_up` | `button`, `x`, `y`, `modifiers`        | Native hit-tested target; coordinates are logical pixels relative to the owned window.                         |
| `focus`, `blur`              | None                                   | Observed native control focus transitions. They can arrive during GPUI's subsequent focus/render phase.        |

The five modifier fields are required booleans: `control`, `alt`, `shift`,
`platform` and `function`. Supported pointer buttons are `left`, `right`,
`middle`, `back` and `forward`. Current actual input evidence exercises left
click and Shift; it does not qualify every modifier, navigation button or OS.
Logical key strings are nonempty and at most 256 UTF-8 bytes. Optional logical
text may be empty but cannot be null, contain NUL or exceed 256 UTF-8 bytes.
Pointer coordinates must be finite with magnitude at most 1,048,576.

The host observes key-down before GPUI keymap dispatch, so Enter, Tab and editor
actions remain visible even when GPUI consumes their action. Key-up uses native
capture. GPUI's standalone modifier-release pseudo-keystrokes are excluded;
the API does not invent physical key codes or repeat metadata. A key targets
the current enabled native focus owner, or the root when no control has focus.
Pointer capture uses GPUI's own clipping and hit tests and selects the deepest
visible model node; it does not perform a parallel JavaScript hit test.

Focus subscriptions live with native controls and are dropped on disposal.
Duplicate subscription observations are suppressed; a surviving transition
reports blur before focus. A revoked target emits no new callback. There is no
promise of DOM focus-versus-click ordering, and native focus events are not
synthesized merely because a listener was attached after focus occurred.

## Ordering across mutations

Every node event has a native tree revision and a unique root-to-target route
of at most 65 IDs. The existing maximum tree depth is 64 **edges**. All UI
events, including window closure, share one contiguous global sequence. A
listener subscribed only to input or clicks sees an increasing subset with gaps.

The host commits a batch and queues its `applied` reply before a new-revision
native event can be emitted. The core rejects impossible future revisions.
An older event can wait while a later reparent commits: its route and listener
identities stay captured, so it never redirects to the new parent. A removed
ancestor's registration is skipped; removing the target cancels the entire
event. Deleted IDs are never reused, and a replacement node does not inherit
queued authority.

Native editing still owns content, caret and selection. The public core updates
its input state as events are ingested, even when callbacks await. An explicit
application value replacement requires the current input revision; ordinary
typing is observed without echoing stale values into the editor. Ancestor
movement or styling does not reset a surviving editor's value or input revision.

## Reproduce actual native verification

Build the pinned native host once, then reuse it in the existing isolated X11
session and diagnostics driver. That driver verifies process and window
ownership before input, bounds nonce-tagged logs and deadlines, captures native
geometry/paint and screenshots, and cleans up only its owned process tree.

```sh
cargo build --locked --release -p bun-native-host
export BUN_NATIVE_HOST="$PWD/target/release/bun-native-host"
mkdir -p .bun-native
events_run=$(mktemp -d "$PWD/.bun-native/interactions.XXXXXX")
xvfb-run --auto-servernum --server-args='-screen 0 1280x800x24 -nolisten tcp' \
  dbus-run-session -- bash scripts/quality/native-linux-session.sh "$events_run/session-dev" -- \
  python3 scripts/quality/native-diagnostics-linux.py --output "$events_run/development" \
    --scenario interactions --mode development --host-profile release -- bun tests/native/interactions.ts

bun experiments/aot-gpui/build-window.ts --entry interactions --host "$BUN_NATIVE_HOST" \
  --host-profile release --outdir "$events_run/aot-build"
xvfb-run --auto-servernum --server-args='-screen 0 1280x800x24 -nolisten tcp' \
  dbus-run-session -- bash scripts/quality/native-linux-session.sh "$events_run/session-aot" -- \
  python3 scripts/quality/native-diagnostics-linux.py --output "$events_run/aot" \
    --scenario interactions --mode aot --host-profile release -- "$events_run/aot-build/interactions"
```

The [checked-in evidence record](../tests/native/evidence/interactions-linux-development-aot.json)
binds the actual development and AOT runs to their source/configuration hashes,
native artifact, compiled program and raw evidence hashes. Both runs passed
with a development-profile host on Linux X11/XTest and Mesa llvmpipe at scale 1.
The AOT executable has compiled-program metadata and 27 removed JIT ranges;
the interpreter remains present. The required Linux lane repeats these scenarios
against its already-built release host. A driver mode label alone does not
prove AOT; its matching compiler manifest supplies that separate evidence.

| Actual assertion  | Development and AOT result                                                                                                                                                                    |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pointer and Enter | Native hit-tested down/up/click routes, actual logical Enter down/activation/up and six total accepted activations across the scenario.                                                       |
| Native editor     | Home/Right plus `x` yielded `AxBCD` at input revision 1; Shift-Left plus `Y` replaced the selection, yielding `AYBCD` at revision 2.                                                          |
| Native focus      | Pointer focus and Tab focus produced observed blur/focus transitions without resetting editor state.                                                                                          |
| Propagation       | Full capture/target/bubble order; target `stopPropagation` retained target bubble, while immediate stop suppressed it. Both still permitted native button activation.                         |
| Queued reparent   | A deliberately suspended callback let native up/click queue before a batch moved the button; delivery retained the old committed ancestry.                                                    |
| Delete/remount    | Deleting the held event's target canceled its remaining/queued callbacks; a fresh native ID received only its later OS click.                                                                 |
| Teardown          | 236 trace records and 72 observed registration signals per run; every observed signal revoked, all six public ownership counters zero, exit 0, no forced cleanup or surviving observed child. |

These are bounded correctness observations with instrumentation. They are not
display-presentation timestamps, performance baselines or proof of long-term
leak freedom. Full IME/composition, native read-only policy, physical-key/repeat
metadata, pointer movement/capture, focus rings, accessibility, Wayland,
macOS/Windows GUI and hardware input/GPU remain unqualified. Adapter-specific
Solid/React event mapping and the remaining #234 acceptance are separate work;
neither adapter receives a second native event implementation.
