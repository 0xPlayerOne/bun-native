# Portable desktop window controls

This is the first implementation increment for issue #34. It implements window
state, geometry and disposable notifications through the browser-independent
contract. Menus, tray, dialogs, clipboard, shortcuts, external URL/deep-link
handling and application reopen remain separate #34 work. This increment does
not close that issue or establish physical input, accessibility or display
qualification for #38.

## Contract and capability discovery

`BrowserBackend` contract version 3 adds the `window.state` and `window.geometry`
capabilities. The existing lifecycle floor is unchanged. CEF discovers these
capabilities from its running native host. The mock implements no OS
window system and rejects these calls with `UNSUPPORTED_CAPABILITY`; it never
returns invented focus, geometry or fullscreen observations. Future webview
adapters must advertise only the operations they implement.

| Capability        | Methods                                                                                                                                    |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `window.state`    | `windowState`, `showWindow`, `activateWindow`, `minimizeWindow`, `maximizeWindow`, `restoreWindow`, `setWindowFullscreen`, `onWindowEvent` |
| `window.geometry` | `windowBounds`, `setWindowBounds`, `resizeWindow`                                                                                          |

The private ABI 1 readiness receipt carries
`data.desktopCapabilities = { version: 1, capabilities: ['window.state', 'window.geometry', 'view.composition'] }`.
The independently negotiated `view.composition` facet is documented in
[native view composition](view-composition.md).
The transport validates a bounded allowlist, rejects duplicate names, unknown
names/versions and malformed metadata before readiness, and freezes the parsed
capabilities. `CefBackend.descriptor` exposes an immutable snapshot; a backend
constructed before readiness gains only the features in the validated receipt.
Build profile extensions describe the current implementation, while the running
backend descriptor describes the actual connected host.

A legacy ABI 1 host without this metadata advertises neither window capability.
Its existing CEF-specific state, minimize, restore, activate, show and resize
methods remain callable for compatibility. New maximize/fullscreen operations,
bounds queries/updates and portable event subscriptions reject with
`UNSUPPORTED_CAPABILITY` before sending a native command. New code should inspect
the running descriptor before using either portable capability.

`WindowState` is the unchanged five-boolean shape: `visible`, `active`,
`minimized`, `maximized`, `fullscreen`. The older `CefWindowState` export remains
a compatibility alias. Existing M5 `window.state` wire values and consumer
parsers retain their strict shape.

```ts
import type { BrowserBackend, WindowHandle } from '@bunly/contracts'

async function resizeWorkspace(backend: BrowserBackend, window: WindowHandle) {
  const actual = await backend.setWindowBounds(window, {
    x: 80,
    y: 80,
    width: 1100,
    height: 760,
  })
  const state = await backend.windowState(window)
  return { actual, state }
}
```

The operation uses an existing opaque window handle. Handle IDs are diagnostic
data; copied, foreign, wrong-kind, closing and disposed handles are rejected.
State/geometry requests recheck ownership after their asynchronous native
receipt. Native dispatch validates its own host-owned record before and after
reentrant CEF operations. Application consumers use a matching prebuilt host;
these APIs never invoke a systems compiler or silently fall back to shell tools.

## Actual observations and asynchronous transitions

Window actions return immediate native readback. An activation request does not
promise keyboard focus, a foreground window, or physical presentation. A
fullscreen request may return while the OS animation is still underway, and a
minimize/restore request may return before page visibility changes. CEF Restore
restores a minimized/maximized window; use `showWindow(window, true)` to unhide a
window. Do not replace an observed state with requested intent.

All geometry uses device-independent pixels. Requested coordinates must be
integers in `[-32768, 32768]`; requested dimensions must be integers in
`[1, 32768]`. The same checks apply to window creation, resize and bounds updates
in TypeScript and at the native boundary. The OS may constrain or adjust the
request, so `setWindowBounds` returns the actual rectangle. Native readback is
strictly validated as an `i32` rectangle with nonnegative dimensions; an empty
transitional rectangle remains an empty observation. It is not replaced by the
last requested size. No display selection, pixel scaling conversion or
multi-monitor support claim follows from these integer contracts.

The native CEF WindowDelegate explicitly enables resizing and maximization.
Bounds and fullscreen callbacks run on the native owner thread and read the
current live window; they do not trust the caller's desired geometry. No polling
loop, visibility spoof, altered background-throttling flag or longer shutdown
deadline is added.

## Disposable notifications

`onWindowEvent(window, listener, { signal })` returns an idempotent unsubscribe
function. The signal is optional, but allows a generation-owned cancellation
scope to retire its callbacks. Registration with an already aborted signal
fails before retaining the listener. A backend admits at most 128 window
subscriptions, reports `RESOURCE_IN_USE` at capacity, and returns capacity on
unsubscribe, abort, window close or backend shutdown.

The event union is:

- `state-changed`: an immutable `state` observation.
- `bounds-changed`: an immutable actual `bounds` observation.
- `fullscreen-transition`: `completed` from the CEF callback and an immutable
  `state` observation. Await `completed: true` for the desired state before
  requesting the opposite fullscreen transition.
- `closed`: the exact owned window closed; that subscription retires before
  its close callback is invoked.

Events carry no raw OS handle. State/bounds notifications are hints, not an
exhaustive event log or proof that a particular request completed. CEF has no
general minimize-completion callback; a caller needing a specific native/page
condition must correlate the appropriate independent observations under its own
finite deadline. A newly registered listener does not receive the event already
being delivered. Unsubscribing or aborting another listener during delivery
prevents that listener's later invocation. Listener exceptions are counted and
cannot break native transport processing.

Every asynchronous operation accepts an optional abort signal. Cancellation
rejects the wait and does not undo an operation already admitted by the native
host. Its native transport reservation remains held until the receipt or the
original deadline. Window closure racing a reply rejects stale state rather
than resurrecting the resource.

## Managed generations

`ManagedDesktopResources.registerWindow` supports the existing operations plus
`maximize`, `fullscreen`, `bounds` and `set-bounds`. Operations still require an
explicit host-side allowlist, a captured current native document/policy scope,
and a current application-generation attachment. Policy and generation are
rechecked before and after asynchronous work. The managed adapter keeps its
existing stricter maximum dimension of 16,384 for both resize and bounds updates.

Portable window events enter the existing bounded resource journal, including
actual bounds and the fullscreen completion discriminator. Only the current
generation can read/acknowledge that journal. Retirement cannot acknowledge a
successor's events, and overflow fails explicitly rather than losing events
silently. Events are indexed by the exact retained handle, avoiding a scan of
unrelated resources on every resize notification. This changes lookup cost,
not queue capacity or event ordering.

## Platform matrix and verification

The [M7 desktop and hardware matrix](m7-platform-qualification.md) defines the
separate physical keyboard, IME, display and assistive-technology records. Native
API receipts do not qualify those operator cases.

| Backend / platform               | Implementation                                        | Qualification boundary                                                                          |
| -------------------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| CEF / macOS arm64                | CEF Views owner-thread adapter                        | Current-head native controls fixture required; physical input/display/accessibility remain #38  |
| CEF / Windows x64                | Same CEF Views adapter                                | Standard-user current-head native controls fixture required; OS focus is observed, never forced |
| CEF / Linux x64                  | Same CEF Views adapter, declared X11/Xwayland profile | Disposable Xvfb plus a real window manager for hosted transitions; native Wayland unqualified   |
| Mock                             | Explicitly unavailable                                | Portable rejection/lifecycle tests only                                                         |
| WebView2 / WKWebView / WebKitGTK | Not implemented                                       | No implicit CEF or shell fallback                                                               |

The portable suite tests legacy and current capability negotiation,
malformed/overflowing/fractional arguments, independent
actual readback, forged/closed handles, cancellation ownership, subscription
retirement/capacity, fullscreen start/completion distinction and managed policy
revocation. These protocol tests do not launch CEF or establish OS behavior.

```sh
bun test tests/native-desktop-capabilities.test.ts tests/desktop-window-api.test.ts \
  tests/cef-window-state.test.ts \
  tests/managed-desktop.test.ts tests/contracts.test.ts tests/browser-profiles.test.ts
bun run typecheck
bun run typecheck:browser
bun run boundaries
```

Native qualification must use a rebuilt current-source host/helper and retain
its source, artifact identities, real event/readback receipts and ordinary
cleanup. Historical M5 minimize/restore evidence does not qualify newly added
maximize/fullscreen/geometry operations. Final platform results belong to the
implementation PR and its recorded native fixture; absent execution remains
unqualified, not an invented pass. Issue #124 and #129 remain separate open
native reliability investigations.
