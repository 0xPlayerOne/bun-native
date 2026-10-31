# @bun-native/solid

Experimental SolidJS universal renderer over the shared `@bun-native/core` window and element API. The internal `@bun-native/renderer` package implements staged nodes, native transactions, input intents and render-root lifetime for both Solid and React. Solid keeps its own universal-renderer and reactive-owner integration. It creates no browser, DOM tree, WebView or second native backend. Solid `1.9.18`, `babel-preset-solid` `1.9.16` and Babel `7.29.7` are pinned with package integrity in the workspace lockfile.

This implements the initial renderer in [BN2 #231](https://github.com/0xPlayerOne/bun-native/issues/231), depending on the BN1 core work in [#271](https://github.com/0xPlayerOne/bun-native/pull/271). Signals/effects, keyed moves/removal, event subscription replacement, unmount and OS-close cleanup are implemented. Native input observations and explicit value/revision intents cover the controlled-value part of [#234](https://github.com/0xPlayerOne/bun-native/issues/234). Fresh Linux software-GPU pointer, typing and delayed-input checks pass in development and machine-code AOT for source `657ac295`, including the listener/order source fixes. Their exact scope and hashes are recorded below; repeated performance measurements, hosted release qualification and broader event/input work remain open.

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

`box` accepts native children; `text` and `button` accept text children or a `text` property; `input` accepts `value`, placeholder and `onInput`. Props use the shared numeric native `Style` contract. The custom JSX types reject unknown browser tags, CSS strings and HTML event props.

Button `onClick` and input `onInput` receive the core's typed, cancellable native events. Handler replacement and subtree removal release the previous registration and abort its signal. Native editing has its own revision, independent of the tree revision. An input's `value` therefore accepts either an initial string or an `InputState` object with `value` and `revision`:

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

Changing an initial string after creation rejects with `UnsupportedFeatureError('input-value-requires-revision')`. A new input intent requires revision zero. Removing the value property stops submitting intents without resetting native text. Style/placeholder changes preserve the current native value; they do not replay the previous intent. IME, caret/selection, focus traversal, accessibility and complete text scrolling remain shared BN4 work.

## Validation and references

`bun test tests/solid tests/renderers tests/quality/boundaries.test.ts` covers reactive coalescing, keyed identity retention, repeated owner cleanup, input revision races, immutable intents, native-batch rejection, foreign nodes, the JSX transform and package boundaries. The independent keyed-order oracle and common public-core subprocess support live under `tests/renderers`. A bounded regression uses the pinned Bun's explicit GC plus weak references to detect disposed roots retained by an open window. These adapter tests use a headless subprocess peer and do not establish rendering. A narrow test preload selects the exact installed reactive Solid source; it does not fabricate signals or native operations. It leaves other tooling on Node resolution because a global browser condition selects Oxc's browser/WASM build.

Actual native observations are recorded in [BN2 initial integration](../../docs/bn2-solid-integration.md). Source references: [official universal renderer guide](https://github.com/solidjs/solid/blob/main/packages/solid/universal/README.md), [pinned Solid distribution](https://registry.npmjs.org/solid-js/1.9.18), and [pinned official JSX preset](https://registry.npmjs.org/babel-preset-solid/1.9.16). The preset's Babel peer range is version 7; Babel 8 was not selected.
