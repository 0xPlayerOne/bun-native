# Native React renderer

`@bun-native/react` is the experimental React adapter over the shared Bun Native
renderer and public core. It uses React **19.3.1**, `react-reconciler` **0.34.0** and
matching reconciler declarations **0.34.1**. The official reconciler package
[declares React ^19.3.0 as its peer](https://registry.npmjs.org/react-reconciler/0.34.0).
Its [host integration API](https://github.com/facebook/react/blob/v19.3.1/packages/react-reconciler/README.md)
is version-specific; these exact versions are pinned and qualified together.

This package uses one shared GPUI host and no React DOM, browser, WebView or CEF.
Its JSX elements are native `box`, `text`, `button` and `input`. Web component
libraries that require DOM nodes, CSS or browser APIs are not supported.

```tsx
/** @jsxImportSource @bun-native/react */
import { createApplication } from '@bun-native/core'
import { render } from '@bun-native/react'
import { useState } from 'react'

function Counter() {
  const [count, setCount] = useState(0)
  return <box style={{ direction: 'column', gap: 12, padding: 24 }}>
    <text>Clicks: {count}</text>
    <button onClick={() => setCount((value) => value + 1)}>Increment</button>
  </box>
}

const application = await createApplication({ executable: '/absolute/prebuilt/native-host' })
const window = await application.openWindow({ title: 'React native counter' })
const root = render(<Counter />, window)
await root.ready
try {
  await window.closed
} finally {
  await root.dispose()
  await application.shutdown()
  await application.closed
}
```

Application changes use Bun or the pinned Bun AOT compiler. They do not compile
Rust. The application supplies an existing native host with the matching protocol.

## Commit, refs and effect semantics

React reconciles into staged native nodes in mutation mode. Create/update/delete,
keyed insertion/reorder and text children use the same shared native planner as
Solid. Render-phase instances never acquire native handles or subscriptions.
The initial React commit completes before `ready` can observe a native
acknowledgement.

`render(children, window)` returns a root with `ready`, `closed`, `render(next)`,
`flush()`, `dispose()` and mutation diagnostics. `render(next)` submits a new tree.
`flush()` commits already-scheduled ordinary React work and awaits staged native
acknowledgements. It does not wait for future asynchronous application work or
lower-priority transitions. Its commit-barrier queue is bounded at 128.

Refs contain an opaque `NativeRef`, not a DOM node or an exposed core handle.
Object refs and callback refs follow React's attach/detach lifecycle. Native input
state can be read through `inputState(ref)` after `ready` or a successful flush;
before acknowledgement there is no usable native handle.

React layout and passive effects follow the **JavaScript commit**, which precedes
the asynchronous native acknowledgement. Neither an effect nor an acknowledgement
proves display presentation. Explicitly await the root when native completion is
required. Disposal unregisters callbacks, runs React effect/ref cleanup and removes
the shared subtree without closing another renderer's root or the native window.

## Events and input revisions

React consumes the same immutable event-property table and public-core dispatcher
as Solid. Each native element accepts these handlers and their capture variants:

| Handler pair                            | Native payload in addition to the event context       |
| --------------------------------------- | ----------------------------------------------------- |
| `onClick`, `onClickCapture`             | Button activation                                     |
| `onInput`, `onInputCapture`             | Committed input `value` and `revision`                |
| `onKeyDown`, `onKeyDownCapture`         | Logical `key`, optional `keyChar`, modifiers          |
| `onKeyUp`, `onKeyUpCapture`             | Logical `key`, optional `keyChar`, modifiers          |
| `onPointerDown`, `onPointerDownCapture` | Button, logical window coordinates `x`/`y`, modifiers |
| `onPointerUp`, `onPointerUpCapture`     | Button, logical window coordinates `x`/`y`, modifiers |
| `onFocus`, `onFocusCapture`             | Native focus gained                                   |
| `onBlur`, `onBlurCapture`               | Native focus lost                                     |

The core routes the native ancestry through capture, target and bubble phases.
`event.node` remains the native target; `currentTarget` identifies the current
registration. The frozen `path`, `treeRevision` and global `sequence` describe the
native event's committed route. Each type/phase registration has its own
cancellation `signal`. Ancestor input handlers receive the same branded input
observation contract as target handlers.

All currently supported event families dispatch as discrete React updates.
React retains one stable wrapper per node/type/phase and updates its latest
committed callback on rerender. Updating a closure therefore preserves an active
callback and queued events; removing one capture handler revokes only that
registration, while independent target/bubble handlers remain active. Removing
the node or closing its owner revokes all its registrations. Native ingestion,
ordering, propagation and queue bounds remain owned by the public core.

`stopPropagation()` and `stopImmediatePropagation()` control subsequent JavaScript
callbacks. They cannot undo a native action that has already occurred; Enter can
still activate a native button after its key notification stops propagating.
These are typed native events, without DOM synthetic events, `event.target`,
`preventDefault()`, physical keyboard codes or repeat metadata. A throwing
callback follows the public core's terminal application-error policy; observe
`application.closed` to receive that failure.

An input accepts an initial string or `{ value, revision }`. Store the actual
`onInput` event in state to observe native typing without writing it back:

```tsx
const [input, setInput] = useState<InputState>({ value: '', revision: 0 })
return <input value={input} onInput={setInput} />
```

`InputState` is imported from `@bun-native/core`. To replace text intentionally,
take `inputState(ref)` and submit a new `{ value, revision }`. The shared driver
retains that expected revision. A stale replacement fails rather than overwriting
a newer edit. Changing an initial string after mount is rejected because it lacks
an observed revision.

## Failures and current limits

Render-phase errors can be caught by React error boundaries. Uncaught renderer
errors and asynchronous native commit failures reject the root's completion and
clean its owned resources. A native rejection occurs outside React's synchronous
render phase, so a React error boundary does not handle that promise for the
application. Observe `ready`, `render`/`flush` and `closed` as appropriate.

React may recover a failed concurrent attempt by retrying synchronously. That
recovered error does not invalidate the root. The optional third argument to
`render` accepts `onRecoverableError(error, info)`, a synchronous diagnostic
callback receiving a frozen React error-info object. Its default is
`console.error`. If the reporter itself throws, that error terminates only this
root. Uncaught effect or ref-cleanup errors reject `dispose()` and `closed`
after the shared cleanup path releases owned native resources. Handled React
error boundaries retain their usable fallback and root.

Hydration, portals, host form actions, hidden Suspense/Activity subtrees, view
transitions, fragment refs, DOM selectors and presentation-timing callbacks are not
implemented. Unsupported native tags and properties fail explicitly; unknown
fields are rejected even when their values are `undefined`. Layout, focus, IME,
accessibility and platform-service support remain exactly the shared host's scope.

Source tests exercise actual React and public-core subprocess IPC, with state
batching, keyed identity, refs/effect cleanup, bounded commit barriers, disposal
during a layout effect, error boundaries, invalid elements/properties, native
rejection, callback failure, input revision races and window close. The peer is
headless. Shared renderer tests independently verify ownership, subtree rescue,
atomic failure cleanup and one observer per native window.

## Real native development and AOT fixture

`examples/react-counter/main.tsx` mounts a real counter, editable input and keyed
list through the public adapter. The [native controller](../../tests/native/react-window.py)
uses the existing owned-process X11 driver, requiring complete expected native
trees and matching application events. The first click must update one label,
move one retained row and remove one row without recreating the remaining nodes.
Typing must preserve every native edit revision while updating the echo label.
OS close must run all row/effect cleanup and leave no observed child process.

```sh
export BUN_NATIVE_HOST="$PWD/target/release/bun-native-host"
export BUN_NATIVE_HOST_PROFILE=release
mkdir -p .bun-native
run_dir=$(mktemp -d "$PWD/.bun-native/react.XXXXXX")

xvfb-run --auto-servernum --server-args='-screen 0 1280x800x24 -nolisten tcp' \
  dbus-run-session -- bash scripts/quality/native-linux-session.sh "$run_dir/session-dev" -- \
  python3 tests/native/react-window.py --scenario counter-click --mode development \
    --output "$run_dir/development" -- bun examples/react-counter/main.tsx

bun experiments/aot-gpui/build-window.ts --source "$PWD" --host "$BUN_NATIVE_HOST" \
  --host-profile release --entry react --outdir "$run_dir/aot-package"
xvfb-run --auto-servernum --server-args='-screen 0 1280x800x24 -nolisten tcp' \
  dbus-run-session -- bash scripts/quality/native-linux-session.sh "$run_dir/session-aot" -- \
  python3 tests/native/react-window.py --scenario counter-input --mode aot \
    --output "$run_dir/aot" -- "$run_dir/aot-package/react"
```

Use both scenarios in each mode; required native CI does so with its one release
host build. The build helper pins compiler identity, records all React/shared
renderer source hashes, and verifies a compiled-program record and actual JIT
range removal. The controller's declared `--mode aot` alone is not that proof.

The [local evidence record](../../tests/native/evidence/react-linux-development-aot.json)
records four passing scenarios on Linux X11 with a development-profile protocol-2
host and Mesa llvmpipe software rendering. Screenshots show actual rendered pixels;
the full-tree paint records are not display-presentation timestamps. These runs
do not qualify macOS/Windows GUI, physical input, hardware GPU, HiDPI/IME or release
performance. The later [native lifecycle diagnostic](../../benchmarks/REACT.md)
passed 1,000 complete mount/update/dispose cycles in development and inspected AOT,
with 32,000 row owners cleaned and all 3,000 sampled WeakRef targets absent at both
fixed checkpoints. Its separate evidence record identifies that newer source
snapshot. A matched, repeated release-host direct-core/Solid/React comparison is
still pending; issue #236 remains open for the remaining acceptance work.

## Native event acceptance

`tests/native/react-interactions.tsx` supplies a React view to the common
`renderer-interactions.ts` fixture oracle. Its keyboard, caret and selection
scenarios require actual pointer, focus, key and committed-input notifications,
all expected capture/target/bubble routes, both propagation-stop policies, and
exact final native trees. Keyboard Enter activates the button; caret insertion
changes `ABCD` to `AxBCD`; replacing the selected `B` changes it to `AYCD`.
The two application state changes emit exactly two native Sets. Input observations
at every phase never replace the native widget value or advance its edit revision.
OS close must dispose the effect and ref, revoke every observed callback signal
and leave all public ownership counts at zero.

```sh
xvfb-run --auto-servernum --server-args='-screen 0 1280x800x24 -nolisten tcp' \
  dbus-run-session -- bash scripts/quality/native-linux-session.sh "$run_dir/events-session" -- \
  python3 tests/native/renderer-interactions.py --renderer React --scenario selection \
    --mode development --output "$run_dir/events-development" -- \
    bun tests/native/react-interactions.tsx

bun experiments/aot-gpui/build-window.ts --source "$PWD" --host "$BUN_NATIVE_HOST" \
  --host-profile release --entry react-interactions --outdir "$run_dir/events-package"
```

Run `keyboard`, `caret` and `selection` in both modes; for AOT, pass the inspected
`react-interactions` executable and `--mode aot`. The required native lane does
this with its existing release host. The [protocol4 local record](../../tests/native/evidence/react-events-linux-development-aot.json)
binds ten passing development/AOT scenarios to exact source, compiler, application
and development-host hashes: the six event scenarios and four counter regressions.
It preserves the earlier protocol2 records as history. Local XTest/software-GPU
input and paint evidence do not establish physical input, display-presentation
latency, release performance or macOS/Windows native support.
