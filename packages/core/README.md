# @bun-native/core

The experimental TypeScript and JavaScript API for one owned Bun Native application. It creates native windows and a small shared element tree through the prebuilt Rust GPUI host. It provides owned handles, atomic updates, input revisions and cancellable application listeners.

This workspace package is private at version `0.0.0`; it is not a published stable SDK. SolidJS and React adapters are future consumers of this same API. Neither adapter is implemented by this package.

## Run a consumer

Use the exact Bun toolchain from [the repository instructions](../../docs/toolchain.md) and an already built native host for the target machine. Application edits do not invoke Cargo. In a repository checkout:

```sh
BUN_NATIVE_HOST="$PWD/target/release/bun-native-host" bun examples/native-window/main.ts
```

The explicit executable path is trusted configuration. A successful handshake checks protocol compatibility; it does not authenticate an arbitrary executable. `app.capabilities` is a frozen, readonly list containing the required `tree`, `input_revisions`, `layout_v1` and `interactions_v1` features. Launch fails if the host cannot negotiate all four. These are rendering features, not grants to use OS services; see [the trust boundary](../../docs/decisions/0003-bridge-security.md).

```ts
import { createApplication } from '@bun-native/core'

const executable = process.env['BUN_NATIVE_HOST']
if (!executable) throw new Error('Set an absolute BUN_NATIVE_HOST path')

const app = await createApplication({ executable })
try {
  const window = await app.openWindow({ title: 'Counter', width: 560, height: 380 })
  const { label, button } = await window.batch((batch) => {
    batch.set(window.root, {
      kind: 'box',
      style: { direction: 'column', gap: 12, padding: 24 },
    })
    const label = batch.create({ kind: 'text', text: 'Clicks: 0' })
    const button = batch.create({ kind: 'button', text: 'Increment' })
    batch.append(window.root, label)
    batch.append(window.root, button)
    return { label, button }
  })
  let clicks = 0
  window.onClick(button, async (event) => {
    if (event.signal.aborted) return
    clicks += 1
    await window.batch((batch) => batch.set(label, { kind: 'text', text: `Clicks: ${clicks}` }))
  })
  await window.closed
} finally {
  await app.shutdown()
  await app.closed
}
```

Plain JavaScript uses the same imports and runtime checks. Add `// @ts-check` and JSDoc types for editor and compiler checking; see [the JavaScript consumer](../../tests/native/javascript.js). [The compile-only TypeScript fixture](../../tests/types/public-api.ts) records accepted calls and rejected type combinations.

## Handles and tree operations

`NativeNode<'box' | 'text' | 'button' | 'input'>` is an opaque identity. Its `kind` is readable, but copying the object does not create another usable handle. Each node belongs to one window and one application session. Passing a foreign, forged or disposed handle fails at runtime, including from JavaScript. Native IDs, request IDs, process streams and GPUI objects are not part of this API.

Every window starts with a root box. Create and attach new elements in the same batch. A committed tree cannot contain unattached nodes or cycles. Only boxes own children; closing the window disposes its root.

| Operation                             | Contract                                                                                                               |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `batch.create(element)`               | Creates a typed handle in the candidate tree. Return it from the callback and use it after the batch promise succeeds. |
| `batch.set(node, element)`            | Replaces all properties of the same element kind. Omitted optional properties return to their defaults.                |
| `batch.set(input, element, revision)` | Replaces input properties using its current observed edit revision.                                                    |
| `batch.append(parent, child)`         | Attaches or moves a child to the end of a box.                                                                         |
| `batch.insert(parent, child, index)`  | Attaches or reorders a child; the index is evaluated after detaching it from its old position.                         |
| `batch.remove(node)`                  | Deletes the entire subtree. Its handles and listeners are revoked after successful commit.                             |

`window.batch` callbacks must be synchronous. Their native work is committed atomically, and the returned promise resolves after the native acknowledgement. Fetch or compute asynchronous data before entering the callback. Retaining a `NativeBatch` and using it after the callback returns is an error. If validation or native preflight rejects a batch, its mutations do not commit; escaped handles created by that failed batch are unusable.

Transactions from all windows are serialized in submission order. At most 128 application transactions may be pending, with reserved capacity for closing live windows. The negotiated `app.limits` bound windows, nodes, operations, text, depth and frame size. A batch acknowledgement confirms committed native state; it does not establish when a frame reached the display.

## Input state and callbacks

`window.input(input)` returns an immutable `{ value, revision }` snapshot. Native edits advance that input's revision independently of `window.revision`. Unrelated label updates therefore do not race merely because someone is typing.

To replace an input intentionally, read its revision inside the synchronous batch callback and supply the complete new input properties:

```ts
await window.batch((batch) => {
  const current = window.input(input)
  batch.set(input, { kind: 'input', value: 'Replacement', placeholder: 'Type here' }, current.revision)
})
```

The native side rejects a replacement if a newer edit wins the race before commit. Handle that stale-revision error according to the application's intent; do not retry blindly with an old value. An accepted explicit replacement advances the input revision even if its text is unchanged. An input callback already describes a native edit: update application state without echoing the same text back into the native input.

## Shared native events

`window.on(node, type, listener, { capture?: boolean })` registers one binding for that node, event type and phase. It accepts any owned node, including an ancestor box. A new binding replaces the previous binding in that exact slot; it does not replace another event type or phase. The returned unsubscribe is idempotent and cannot remove a replacement. `onClick(button, listener)` and `onInput(input, listener)` are target-specific bubble conveniences using the same registry.

```ts
window.on(window.root, 'key_down', (event) => {
  console.log(event.key, event.modifiers.control, event.phase)
}, { capture: true })

window.on(button, 'pointer_up', (event) => {
  console.log(event.button, event.x, event.y)
})
```

| Type                         | Additional fields                      | Meaning                                                                  |
| ---------------------------- | -------------------------------------- | ------------------------------------------------------------------------ |
| `click`                      | None                                   | Native button activation, including pointer or keyboard activation.      |
| `input`                      | `value`, `revision`                    | Committed native edit; the input snapshot is updated before callbacks.   |
| `key_down`, `key_up`         | `key`, optional `keyChar`, `modifiers` | GPUI logical key/text, including keys used by native actions.            |
| `pointer_down`, `pointer_up` | `button`, `x`, `y`, `modifiers`        | Native hit-tested pointer target; coordinates are window logical pixels. |
| `focus`, `blur`              | None                                   | Retained native focus changed.                                           |

Every event exposes immutable `node` (the native target), `currentTarget`, `path`, `phase`, `treeRevision` and `sequence`. The path is the native committed ancestry at input, root first and target last. `phase` is `capture`, `target` or `bubble`; both target registrations use `target`. Modifiers are a frozen record of `control`, `alt`, `shift`, `platform` and `function`. The API does not fabricate physical key codes or repeat metadata that the current native interception path cannot observe. `keyChar` is optional logical text, not a committed input or IME notification. The current contract does not emit pointer movement/coalescing or scrolling events.

Callbacks run in capture order from root to target, then bubble from target to root. The registration identities and native path are captured when the core ingests an event. A queued event therefore keeps its original route after a keyed move; a new registration does not receive earlier events. Each invocation rechecks revocation. Deleted ancestors are skipped, a deleted target cancels the event, and a disposed handle in an older captured path does not regain authority. Malformed routes, foreign owners, impossible future revisions and invalid input revisions fail the session.

`event.stopPropagation()` prevents delivery to later nodes. At the target it still permits the target's other phase. `event.stopImmediatePropagation()` also stops that remaining target delivery. These controls are effective only while that listener is executing, including while its returned promise is pending. Retaining an event and calling its control methods after that invocation settles has no effect. The controls affect JavaScript dispatch only: native focus, editing and button actions may already have happened across the subprocess boundary. There is no misleading asynchronous `preventDefault` API. GPUI focus notifications follow its rendered-focus phase and may arrive after click; DOM pointer/focus ordering is not promised.

Application callbacks run one at a time in native global event order, across windows. The pending queue is bounded at 128 events, separate from the active dispatch. Each route contains at most 65 nodes, with one capture and one bubble binding per node/type. Overflow fails the session instead of growing memory indefinitely. A callback failure is observed through application shutdown/completion. Sequence numbers count all native UI events, so click-only or input-only listeners can legitimately observe gaps; count activations separately and use input revisions for edit ordering.

Native ingestion is independent of waiting for listener promises. Input snapshots and OS-close events continue to update across windows while an asynchronous listener waits. This does not make synchronous CPU-heavy JavaScript nonblocking: that still blocks Bun's event loop.

Every invocation carries the binding's `event.signal`. Unsubscribe, replacement, deletion of the registered node, window close and application shutdown abort that registration, discard its queued deliveries and release dispatch from an unresolved listener. Deleting an event's target also releases a waiting ancestor callback without revoking that still-live ancestor registration or changing its signal. Use the signal for cancellable work and validate delayed application intent before committing it. Cancellation does not forcibly terminate an arbitrary promise or undo application side effects.

## Lifetime and errors

`window.close()` is idempotent and revokes listeners immediately before its serialized native close. OS close also revokes the window. `window.closed` observes that local lifetime ending; the application owns the host process until shutdown.

`app.shutdown()` is idempotent and can be awaited inside a listener. Await `app.closed` outside that listener to join event ingestion and callback dispatch without a self-deadlock. Normal shutdown clears all six `app.diagnostics` counters: windows, nodes, callbacks, queued transactions, queued callbacks and active callbacks. These counters describe owned JavaScript resources; they are not a native memory-leak measurement.

The public package exports the error classes needed to distinguish failures:

| Error                     | Meaning                                                                                                                         |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `NativeStateError`        | Invalid local handles/state, stale input revisions or public queue/model limits; inspect `code`.                                |
| `NativeCommandError`      | A native semantic rejection; inspect its native `code`.                                                                         |
| `ProtocolError`           | A malformed value or broken protocol/channel invariant. Malformed received messages and invalid native events fail the session. |
| `UnsupportedFeatureError` | An unknown native element kind; `feature` is `element:` followed by that kind. It does not trigger a fallback renderer.         |

Protocol incompatibility prevents launch. Recreating an application creates a new session; old handles never become valid in it. An unsupported field within a known element or style is a validation error, not an accepted extension point.

## Supported scope

The initial elements are `box`, `text`, `button` and single-line `input`. `Style` explicitly supports `direction`, `gap`, `padding`, `width`, `height`, `min_width`, `max_width`, `min_height`, `max_height`, `flex_grow`, `flex_shrink`, `align_items`, `justify_content`, `overflow`, `background`, `color` and `font_size`. Dimensions are numeric logical native pixels, with `fill` available for width and height; colors are unsigned 24-bit RGB values. These fields are validated and bounded by the [shared layout contract](../../docs/native-layout.md). Scroll overflow is accepted only for `box` containers; leaf element types also enforce this restriction. Styles are shared by every framework adapter.

There is no DOM, HTML, CSS parser, browser navigation, WebView, CEF, React DOM or automatic compatibility with web component libraries. Native service APIs for files, processes, notifications, menus and other desktop integrations remain separate roadmap work. The current renderer does not claim complete scrolling, IME, focus traversal or accessibility coverage. See [the native host limitations](../../native/gpui-host/README.md) and [testing evidence](../../docs/testing.md) before treating a platform as supported.

Protocol 4 requires the shared layout and interaction contracts and replaces protocol 3 without a compatibility layer. During this private experimental phase, pin the application packages and native host together at the tested source revision. A package build or type check is not native GUI acceptance; a bundled executable is not proof of Bun machine-code AOT. [ADR 0004](../../docs/decisions/0004-public-api.md) records the API boundary and its tradeoffs.
