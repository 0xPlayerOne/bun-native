# @bun-native/solid

Experimental SolidJS universal renderer over the shared `@bun-native/core` window and element API. The internal `@bun-native/renderer` package implements staged nodes, native transactions, input intents and render-root lifetime for both Solid and React. Solid keeps its own universal-renderer and reactive-owner integration. It creates no browser, DOM tree, WebView or second native backend. Solid `1.9.18`, `babel-preset-solid` `1.9.16` and Babel `7.29.7` are pinned with package integrity in the workspace lockfile.

This implements the renderer in [BN2 #231](https://github.com/0xPlayerOne/bun-native/issues/231), using the shared BN1 core and protocol-4 native interactions. Signals/effects, keyed moves/removal, typed event phases, subscription replacement, unmount and OS-close cleanup are implemented. Native input observations and explicit value/revision intents cover controlled updates in [#234](https://github.com/0xPlayerOne/bun-native/issues/234). Actual Linux software-GPU keyboard, pointer, focus, caret and Shift-selection checks pass in development and machine-code AOT. The [integration record](../../docs/bn2-solid-integration.md) distinguishes each source/artifact snapshot and its limitations. Repeated performance comparisons, unresolved weak-target observations in [#287](https://github.com/0xPlayerOne/bun-native/issues/287), hosted release qualification and broader text/platform acceptance remain open.

## Author and run native TSX

```tsx
import { createApplication } from '@bun-native/core'
import { render } from '@bun-native/solid'
import { createSignal } from 'solid-js'

const app = await createApplication({ executable: '/absolute/path/to/prebuilt/bun-native-host' })
try {
  const window = await app.openWindow({ title: 'Solid native counter' })
  const view = render(() => {
    const [count, setCount] = createSignal(0)
    return (
      <box style={{ direction: 'column', gap: 12, padding: 24 }}>
        <text text={`Clicks: ${count()}`} />
        <button onClick={() => { setCount(value => value + 1) }}>Increment</button>
      </box>
    )
  }, window)
  await view.ready
  await window.closed
  await view.dispose()
} finally {
  await app.shutdown()
  await app.closed
}
```

The official JSX preset uses `generate: 'universal'` and `moduleName: '@bun-native/solid'`. The build script applies it before Bun bundling and selects Solid's reactive package exports. Ordinary Bun resolution selects Solid's server runtime, whose effects are inert; `render` explicitly rejects that runtime. The `browser` export condition means client reactivity here, not browser rendering. `solid-js/web`, HTML/CSS and DOM props are forbidden package edges.

From the repository root, with the pinned Bun and an existing native host:

```sh
bun install --frozen-lockfile
bun run typecheck
bun scripts/solid-build.ts examples/solid-counter/main.tsx "$PWD/.bun-native/solid-example"
BUN_NATIVE_HOST="$PWD/target/release/bun-native-host" bun .bun-native/solid-example/application.js
bun compile --no-script --production --explain=json \
  .bun-native/solid-example/application.js --outfile .bun-native/solid-example/application
BUN_NATIVE_HOST="$PWD/target/release/bun-native-host" .bun-native/solid-example/application
```

The same generated JavaScript module drives development and AOT. The JSX/build step is not itself AOT; the separate `bun compile` step must be inspected and executed. The script does not build or copy the native host. Artifact provenance, native libraries, signing and distribution retain their existing separate acceptance requirements. The private application records optional nonce-scoped evidence using the existing native fixture conventions.

## Render ownership and batching

`render(component, window)` returns a `RenderRoot`:

| Member        | Contract                                                                                                                                             |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ready`       | Resolves after the initial native batch is acknowledged; component/validation errors reject it                                                       |
| `flush()`     | Waits until scheduled reactive work has native acknowledgements; it does not promise display presentation                                            |
| `dispose()`   | Idempotently stops the Solid owner, revokes listeners and removes only this render root's native subtree                                             |
| `closed`      | Completes after unmount or native window close; asynchronous renderer failures reject it                                                             |
| `diagnostics` | Owned native-node/listener counts, pending work and acknowledged create/set/insert/remove operation counts; these are not native memory measurements |

Each render root owns a native container under the existing window root. Several independent render roots can share a window. Adapter nodes cannot move between roots or masquerade as core handles. Synchronous Solid mutations coalesce into one queued/in-flight batch; changes arriving during acknowledgement become a subsequent snapshot. There is no unbounded per-property transaction queue.

The shared renderer retains native handles for keyed nodes, updates only changed properties, and moves retained descendants before deleting obsolete ancestors. Changed sibling orders retain a longest existing subsequence so a left rotation emits one move; unchanged lists skip ordering work and new containers append in order. Live callback registrations belong to the render root separately from immutable native snapshots, so removing and reinserting a node during acknowledgement cannot revive an already-revoked registration. Native planning, the single in-flight commit pump, listener reconciliation and window completion observation live in `@bun-native/renderer`; they are shared with React's adapter. Solid's small mount wrapper registers its owner disposer before evaluating the component. A native rejection leaves the old committed tree intact until cleanup; the shared renderer then disposes the framework owner/listeners and removes its committed subtree. Failed candidate handles are never published as committed. The failure remains observable through `ready`, `flush` and `closed`.

## JSX and native input intent

`box` accepts native children; `text` and `button` accept text children or a `text` property; `input` accepts `value` and `placeholder`. Styles derive from the corresponding shared native element type. Only boxes accept scrolling overflow modes; text, button and input styles allow visible or hidden overflow. The custom JSX types reject unknown browser tags, CSS strings and unsupported DOM properties.

All four native elements accept the typed event properties described below, including ancestor input observation on a box. Handler replacement and subtree removal release the previous registration and abort its signal. Native editing has its own revision, independent of the tree revision. An input's `value` therefore accepts either an initial string or an `InputState` object with `value` and `revision`:

```tsx
import type { InputState } from '@bun-native/core'
import { inputState, type SolidNode } from '@bun-native/solid'
import { createSignal } from 'solid-js'

const [value, setValue] = createSignal<InputState>({ value: '', revision: 0 })
let editor!: SolidNode
const field = <input ref={node => { editor = node }} value={value()}
  onInput={event => { setValue(event) }} />

// After the render root is ready, submit a new application value against the
// editing state observed at this moment. The adapter never upgrades this revision.
function replaceText(text: string) {
  const observed = inputState(editor)
  setValue({ value: text, revision: observed.revision })
}
```

Passing the **actual `onInput` event object** back into the signal records a native observation. It emits no value replacement, including when newer native input has already arrived before the older callback runs. An ordinary `{ value, revision }` object is an explicit replacement intent. Its fields are captured when the property is submitted, before asynchronous commit; later mutation of that object cannot change the intent. Copying an event into a new value/revision object makes an explicit intent and can legitimately be stale.

`inputState(ref)` reads the currently observed native value/revision of a committed input. It rejects an unmounted, forged or non-input reference. Use it when forming a **new** application intent; do not fetch a newer revision merely to authorize an older text replacement. A stale explicit intent rejects with the core's `NativeStateError('stale_revision')` and invokes the render root's documented failure/cleanup policy. This initial renderer does not silently retry it.

Changing an initial string after creation rejects with `UnsupportedFeatureError('input-value-requires-revision')`. A new input intent requires revision zero. Removing the value property stops submitting intents without resetting native text. Style/placeholder changes preserve the current native value; they do not replay the previous intent. An explicit full input set still advances its input revision under the shared core contract, even when the value is equal. Actual Home/Right insertion, Shift-selection replacement and Tab focus traversal are verified on the recorded Linux host. IME composition, programmatic selection/focus APIs, accessibility, complete text scrolling and other platforms remain separate acceptance work.

## Native event properties

Every event property also has a `Capture` form, such as `onKeyDownCapture` or
`onInputCapture`. A box can therefore observe a descendant's native event before
or after its target callbacks. Solid uses the framework-neutral private renderer
event table; React integrates that same table in its adapter. The public core
owns the propagation route and callback lifetime.

| Properties                              | Native fields beyond the shared event envelope |
| --------------------------------------- | ---------------------------------------------- |
| `onClick`, `onClickCapture`             | Native activation                              |
| `onInput`, `onInputCapture`             | `value`, input `revision`                      |
| `onKeyDown`, `onKeyDownCapture`         | Logical `key`, optional `keyChar`, modifiers   |
| `onKeyUp`, `onKeyUpCapture`             | Logical `key`, optional `keyChar`, modifiers   |
| `onPointerDown`, `onPointerDownCapture` | `button`, window-logical `x`/`y`, modifiers    |
| `onPointerUp`, `onPointerUpCapture`     | `button`, window-logical `x`/`y`, modifiers    |
| `onFocus`, `onFocusCapture`             | Actual native focus notification               |
| `onBlur`, `onBlurCapture`               | Actual native focus loss                       |

The shared envelope provides `type`, native `sequence`, `treeRevision`, target
`node`, `currentTarget`, immutable root-to-target `path`, `phase`, and an abort
`signal`. These are opaque public-core nodes, not adapter refs or DOM elements.
Modifier fields are `control`, `alt`, `shift`, `platform` and `function`.

`stopPropagation()` prevents traversal to further nodes. When called during
target capture, it still allows the target's non-capture callback;
`stopImmediatePropagation()` also stops that remaining callback. They control
JavaScript dispatch, and do not cancel native
activation, editing or focus. The verified Enter scenario still activates the
native button after its JavaScript key handler stops propagation. There is no
`preventDefault`, physical `code`, `repeat` or pointer-move prop in this increment.
Focus notifications follow the native GPUI update phase, which can occur after
click callbacks; no browser event ordering is promised.

A queued event keeps its native route when a keyed node moves. Removing its
target cancels the remaining callbacks instead of redirecting them to a remount.
Changing one event property does not replace unrelated types or phases. The
shared core handles these rules even when an earlier async handler is suspended.

## Validation and references

`bun test tests/solid tests/renderers tests/quality/boundaries.test.ts` covers reactive coalescing, keyed identity retention, repeated owner cleanup, typed event phases and queued-route revocation, input revision races, immutable intents, native-batch rejection, foreign nodes, the JSX transform and package boundaries. The independent keyed-order oracle and common public-core subprocess support live under `tests/renderers`. A deterministic window-lifetime test counts completion subscriptions and verifies released callbacks are inert, with deliberately broken negative controls. The existing explicit-GC/WeakRef regression is retained unchanged; its intermittent positives and no-framework controls are tracked in [#287](https://github.com/0xPlayerOne/bun-native/issues/287), without claiming a resolved retaining path. These adapter tests use a headless subprocess peer and do not establish rendering. A narrow test preload selects the exact installed reactive Solid source; it does not fabricate signals or native operations. It leaves other tooling on Node resolution because a global browser condition selects Oxc's browser/WASM build.

Actual native observations are recorded in [BN2 initial integration](../../docs/bn2-solid-integration.md). Source references: [official universal renderer guide](https://github.com/solidjs/solid/blob/main/packages/solid/universal/README.md), [pinned Solid distribution](https://registry.npmjs.org/solid-js/1.9.18), and [pinned official JSX preset](https://registry.npmjs.org/babel-preset-solid/1.9.16). The preset's Babel peer range is version 7; Babel 8 was not selected.
