# Browser actions

Bunly's optional browser-action backend controls an existing native view through
engine-neutral methods. Navigation keeps the session's existing network policy.
Screenshots, approved evaluation, DOM/accessibility observation, and synthetic
DOM input additionally require a current document-scoped native grant.

This is a development capability. A normal packaged host does not advertise it.
The `browser-actions` Cargo feature is nondefault and requires both an exact
loopback `development_origin` and `development_browser_actions: true` in the
installed `runtime.json`. A feature build with either manifest gate absent exits
78 before starting Bun or creating a browser. A manifest opt-in paired with a
feature-disabled binary also exits 78. No environment variable enables control.

| Qualification profile | Native feature | Development origin | Manifest opt-in | Expected result      |
| --------------------- | -------------- | ------------------ | --------------- | -------------------- |
| enabled               | yes            | yes                | yes             | Real bounded actions |
| feature-disabled      | no             | yes                | yes             | Exit 78              |
| ordinary              | yes            | no                 | yes             | Exit 78              |
| manifest-denied       | yes            | yes                | no              | Exit 78              |

The normal feature-disabled, non-opted-in production profile remains supported.
Its ordinary native suite runs before the first feature build in the qualification
sequence. Existing source-mapped application errors, renderer log forwarding,
RPC/reload diagnostics and diagnostic redaction remain separate features; see
[Bun development tooling](bun-tooling.md).

## Public API and capabilities

`BrowserActionsBackend` is exported by `@bunly/contracts`; `CefBackend` implements
it when the native peer advertises the corresponding capability. Future webview
adapters must report unsupported capabilities explicitly.

| Method                                                | Capability                              | Native grant                                    | Behavior                                                                 |
| ----------------------------------------------------- | --------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------ |
| `navigate(view, url)`                                 | `view.navigate`                         | Existing session network policy                 | Existing native navigation policy; revokes old document grants           |
| `captureScreenshot(view, options)` / `snapshot(view)` | `view.snapshot`                         | `browser-snapshot`                              | PNG top-left viewport crop; `snapshot` returns its bytes                 |
| `evaluate(view, expression)`                          | `view.evaluate`                         | `browser-evaluate` with exactly that expression | Synchronous, bounded JSON value or explicit undefined                    |
| `observeDom(view)`                                    | `view.observe-dom`                      | `browser-observe-dom`                           | Bounded main-document tree; child frames are leaves                      |
| `accessibilityTree(view)`                             | `view.observe-accessibility`            | `browser-observe-accessibility`                 | Genuine native AX tree where representable; otherwise a capability error |
| `input(view, action)`                                 | `view.input` and `view.input.synthetic` | `browser-input`                                 | Synthetic DOM text or mouse dispatch                                     |

```ts
const scope = await backend.capturePolicyScope(view)
await backend.grantNativeCapability(scope, { name: 'browser-snapshot' })
await backend.grantNativeCapability(scope, {
  name: 'browser-evaluate',
  expression: 'document.title',
})
const image = await backend.captureScreenshot(view, {
  maxWidth: 640,
  maxHeight: 480,
  signal,
})
const title = await backend.evaluate(view, 'document.title', { signal })
```

A grant is held by trusted Bun application code. It is bound to the native view,
session, document generation, main frame and origin. A caller-supplied numeric
identifier, JavaScript boolean, or renderer message cannot create that authority.
Evaluation approval matches the exact source, with at most 4 KiB of UTF-8 per
expression. The existing policy limits each view to 64 native/browser grants.
Navigation or revocation invalidates the grants; capture and grant a new scope
for the replacement document.

Evaluation runs in an isolated main-frame world with normal browser origin
restrictions, no universal access, no user gesture and no CSP unsafe-eval bypass.
It never restores application trust or gives remote content application-native
RPC privileges. The expression can have page effects; approval is not a promise
of a read-only result. Promises, functions, symbols, cyclic/nonplain objects and
unbounded values are not returned as fabricated empty results.

Text input supports editable text/search/URL/telephone inputs and textareas.
It rechecks focus, connection, editability and input type after the page's
`beforeinput` handlers. Password/email fields, child frames, contenteditable surfaces,
trusted/hardware events, IME, selection gestures and OS clipboard input are
unsupported. Pointer input dispatches mouse down/up followed by click (left) or contextmenu
(right) at a main-document
element and rechecks the hit target before each event. It does not simulate a
physical mouse or claim `isTrusted`. Page event handlers may have run before a
later cancellation, rejection or navigation; actions do not offer rollback.

## Bounds and ownership

| Resource                     | Bound                                                                                                      |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Concurrent controllers       | At most 8 total; one per native view                                                                       |
| Joint owned-data reservation | 8 MiB across controllers on a transport                                                                    |
| Browser action reservation   | 3 MiB per action, including scope capture; permits two simultaneous browser actions under the byte ceiling |
| PNG result                   | At most 1 MiB decoded, 1024 × 768 output pixels                                                            |
| JSON result                  | At most 256 KiB UTF-8; callback JSON depth 20 and 8,192 structural tokens before parsing                   |
| DOM/AX observation           | At most 256 nodes, depth 4, 512 Unicode code points per text field, total serialized bound above           |
| Approved evaluation          | 1 second; at most 256 returned value nodes and depth 4                                                     |
| All operation ownership      | 8 seconds, including cleanup and unread result leases                                                      |
| Result read                  | 4 KiB binary chunk, at most 8 KiB hex, one serial read at a time                                           |
| Text input                   | At most 4 KiB UTF-8                                                                                        |

The 3 MiB reservation is a conservative envelope for live Bunly-owned payload
buffers across native and SDK halves, not an RSS claim. During PNG transfer the
native decoded PNG and the SDK destination can each own 1 MiB. The remaining
1 MiB covers the current hex/wire chunks, decoded chunk, parser/string temporary
buffers, bounded operation metadata and serialization headroom. The JSON path
has a 256 KiB serialized ceiling; the preallocation depth/token scan also bounds
map/array expansion before parsing. The native outer result, parsed inner result,
and serialized result do not overlap with SDK transfer: cleanup completes first.
During SDK decoding, the native result lease, destination, UTF-8/UTF-16 conversion
and parsed result remain within the same reservation. Allocation metadata and
CEF renderer/browser internals have their own lifetimes and are not a promise
that the total process uses only 8 MiB.

CEF owns the borrowed DevTools callback buffer. Bunly checks its length before
parsing or copying: the PNG base64 callback is at most 1,398,168 bytes, and other
results at most 256 KiB. PNG base64 is borrowed without an intermediate string
copy, canonical padding and decoded length are checked, then one bounded decoded
buffer is allocated. PNG signature, IHDR dimensions and the terminal IEND are
checked. The SDK verifies result length, dimensions and SHA-256 while reading
chunks. A byte lease records actual result bytes; no 1 MiB response is sent inside
the 64 KiB native control frame.

Each native operation owns its observer registration, browser identity, callback,
deadline worker and result lease. Native admission and each callback/read
revalidate the captured document, CEF main-frame identifier, current URL and
browser identity. The private transport obtains the CDP root frame and an isolated
execution context's system-unique ID. It never accepts a caller's frame/context ID.
The world is reused within the document, avoiding a new retained world per call.
Runtime notifications are filtered by the captured root frame before binding an
execution context. A same-named context in a child frame is ignored; it cannot
replace the main context or invalidate an operation on that main context. A change
to the main context's numeric or system-unique identity still revokes the operation.
Per-operation object groups are released, then `Runtime.disable` is acknowledged,
before the observer is dropped and a result becomes readable.

Cancellation acknowledgment does not release ownership. Navigation races discard
the result and drain cleanup. A detached or stuck callback remains owned until the
exact browser's actual `OnBeforeClose`; the operation deadline closes that view
when cleanup cannot finish. The normal production shutdown deadline is unchanged.
A successful but malformed admission receipt closes the transport before its SDK
quota is released. A completed native operation during an outstanding SDK read
keeps its local buffer reservation until that read unwinds.

Only bounded reason codes and owner counters enter diagnostics. Expressions,
DOM/AX contents, callback payloads, screenshots and raw protocol errors are not
logged. Raw CDP is a private CEF implementation detail, not a public SDK endpoint.
The existing native launch policy continues rejecting remote-debugging ports and
pipes.

## Qualification

First build and test the ordinary native host from the selected committed source.
Keep its prepared application directory. Then explicitly build a separate host
with `--features packaging,browser-actions` and prepare a separate application
from that same source. Application bundling does not compile native code.

```sh
bun scripts/qualify-browser-actions.ts \
  /absolute/ordinary-app-directory \
  /absolute/browser-actions-app-directory \
  --native-source=FULL_COMMIT_SHA
```

On macOS the directory arguments are the two `.app` bundles. The qualifier makes
its own copies and uses the existing ad-hoc fixture signing workflow. On Linux
and Windows they are directories containing `bunly_host` / `bunly_host.exe` and
its native siblings. Run as a standard user in a disposable actual GUI session.

The four process profiles enforce the build/manifest matrix. The enabled fixture
checks real PNG output, approved evaluation, bounded DOM and genuine AX or an
explicit unavailable result, synthetic input, page-driven `beforeinput` type and
editability changes, cross-origin frames, a foreign session, oversized evaluation
and high-entropy PNG output, in-flight cancellation, navigation revocation, and
closing a view with an active callback. Final native registrations, callbacks,
byte leases, reserved bytes and deadline workers must be zero. The report retains
source hashes, both immutable input inventories, prepared before/after hashes,
actual CEF identity, process cleanup and bounded fixed receipts. Portable protocol
tests and policy-model tests do not replace this native run. Physical input,
assistive technology, hardware DPI behavior and performance are not qualified.

Implementation references: the pinned CEF 156.0.7 SDK's
[`CefBrowserHost` observer/method contract](https://github.com/chromiumembedded/cef/blob/47dbc1df023e99f006fb9e850a8d83cc19b4fdd9/include/cef_browser.h),
[`CefDevToolsMessageObserver` callback lifetime](https://github.com/chromiumembedded/cef/blob/47dbc1df023e99f006fb9e850a8d83cc19b4fdd9/include/cef_devtools_message_observer.h),
and the upstream [Runtime](https://chromedevtools.github.io/devtools-protocol/tot/Runtime/),
[Page](https://chromedevtools.github.io/devtools-protocol/tot/Page/) and
[Accessibility](https://chromedevtools.github.io/devtools-protocol/tot/Accessibility/)
protocol definitions. DevTools methods are verified against the pinned runtime by
the actual fixture; an unavailable native method yields an explicit error.
