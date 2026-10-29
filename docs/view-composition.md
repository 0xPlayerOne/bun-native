# Native view composition

This is the first composition increment for [issue #35](https://github.com/0xPlayerOne/bunly/issues/35).
It adds explicit native pane placement, visibility, focus traversal, and an
application-owned overlay to the CEF adapter. Existing windows retain their
equal-flex vertical stack unless they choose `viewLayout: 'manual'` at creation.
The layout mode stays fixed for that window's lifetime.

## Contract and capability

`view.composition` identifies the optional browser-safe `ViewCompositionBackend`
facet. The CEF adapter advertises it only when the connected native host reports
support in its validated readiness metadata. Older prebuilt hosts and the mock
adapter do not claim this feature. Application builds never compile a host or
switch to an alternative rendering mode to satisfy the capability.

```ts
requireCapability(backend.descriptor, 'view.composition')
const window = await backend.createWindow({
  title: 'Workspace',
  bounds: { x: 40, y: 40, width: 1000, height: 720 },
  viewLayout: 'manual',
})
const editor = await backend.createView({
  window,
  session,
  url: 'app://ui/editor.html',
  trust: { kind: 'application', origin: 'app://ui' },
  presentation: {
    bounds: { x: 16, y: 16, width: 600, height: 640 },
    visible: true,
    focusable: true,
    tabIndex: 0,
  },
})
const observed = await backend.setViewPresentation(editor, {
  bounds: { x: 16, y: 16, width: 480, height: 640 },
  tabIndex: 0,
})
```

Manual windows require a `presentation` for every view. Stack windows reject
presentation/layer options instead of silently ignoring them. A presentation
update replaces the desired presentation; omitted fields use the defaults below.

| Field       | Meaning and limits                                                                             | Default   |
| ----------- | ---------------------------------------------------------------------------------------------- | --------- |
| `bounds`    | Client-area integer DIPs; x/y from -32768 through 32768; positive width/height at most 32768   | Required  |
| `clip`      | Optional client-area rectangle intersected with bounds and the window; zero dimensions allowed | `null`    |
| `visible`   | Whether to show a nonempty native viewport                                                     | `true`    |
| `focusable` | Whether the view can receive focus                                                             | `true`    |
| `tabIndex`  | View-level traversal order, integer 0 through 127; equal values use creation order             | `0`       |
| `layer`     | Creation-time semantic layer: `content` or `overlay`                                           | `content` |

All handles retain the existing opaque owner checks. Closing windows reject
operations on their children; late replies cannot revive a disposed handle.
Presentation updates and queries accept an abort signal. Cancellation does not
pretend an admitted native operation was never executed: its transport admission
stays charged until native acknowledgement or confirmed transport teardown.

`viewPresentation()` returns the requested presentation separately from actual
native `viewport`, `visible`, `drawn`, `focusable`, and `focused` observations.
A hidden or fully clipped view reports zero visible viewport dimensions. This
does not imply that its document's last layout size is zero. Window activation
and rendering may transition asynchronously; immediate readback is not an
animation-completion receipt.

## What clipping means

The supported primitive is a CEF Views `CUSTOM` overlay controller. The host
intersects the desired rectangle with the optional clip and current client area,
then applies that intersection as the native browser viewport. A partial
intersection **resizes the viewport and can cause page reflow**. It does not
retain a full-sized page behind a crop, and it does not adjust the document's
scroll position to simulate cropping. A zero intersection hides the view and
removes it from focus traversal without allocating a fake one-pixel surface.

For example, a 300-DIP-wide view intersected with a 200-DIP-wide clip has a
200-DIP page viewport. Application code that needs CSS overflow, transformed
content, or scrolling within that viewport should implement it inside the page.
The host reapplies stored intent when the window client area changes, so growing
the window restores the originally requested bounds instead of retaining a
previous clipped size.

## Native and DOM stacking

Each BrowserView is a separate native view. CSS `z-index`, transforms, opacity,
and DOM dialogs inside one page do not place that page above a sibling native
view. The host uses CEF's real overlay widgets for manual placement. Content
panes must be created before semantic overlays. Creation order determines overlap
within each layer; dynamic z-order reordering is not part of this increment.

An overlay is another view created with `layer: 'overlay'`, its own presentation,
and exact `app://ui` application trust. Create it after content panes, then show
or hide it with `setViewPresentation`. It can overlap the panes' native surfaces.
Its native navigation policy rejects attempts to leave the application origin,
including page-initiated main-frame navigations. Creating additional content
while a live semantic overlay exists is rejected; dispose overlays before
rebuilding the pane hierarchy.

This is a rectangular application UI overlay. It does not supply modality,
click-through regions, backdrop effects, OS menu semantics, drag regions,
accessibility-modal state, or transparent composition across arbitrary pages.
`focusable: false` prevents focus; it does not promise pointer-event passthrough.
A popover that should yield focus when dismissed must explicitly choose a live
eligible destination. Context menus and OS dialogs need their own policy and
lifecycle handling; this view API does not implement them.

## Focus and generation ownership

`focusView` rejects hidden, fully clipped, disabled, and nonfocusable targets.
`focusNextView(window, reverse)` chooses an eligible view in declared order and
returns its opaque handle, or `null` when no transfer is available. The same
ordering is connected to CEF's browser `OnTakeFocus` boundary callback. DOM tab
order remains the page's responsibility. A focus request does not guarantee OS
window activation, and the returned handle does not replace actual focus
readback. Physical Tab/Shift-Tab, pointer routing, IME, and assistive technology
require separate desktop qualification.

An explicit focus request also shows the already-visible native overlay to
activate its widget before requesting browser focus. This matters on macOS,
where moving the shared Views focus manager alone does not make an overlay's
native window key. Ordinary bounds updates avoid that activation path so a pane
resize does not steal a sibling's focus. The fixture checks both native focus and
authenticated renderer focus/blur observations.

On macOS, a drawn owner window also supplies a neutral native focus target when
an overlay becomes hidden, clipped or nonfocusable but CEF's shared focus manager
still selects it. The host requests actual focus on the owner View and verifies
that the old BrowserView no longer has focus. This Mac path does not activate a
background application, and it does not redirect input to an arbitrary sibling.
It makes the owner View focusable; physical Tab behavior and accessibility of
that native traversal stop remain unqualified. Windows/Linux retain their native
focusability behavior because requesting an inactive owner there can activate it.

`ManagedDesktopResources.registerView` supports the policy-scoped `presentation`
and `present` operations alongside existing state/focus/navigation operations.
Reattaching a view across application generations retains the BrowserView,
document, session, presentation, and form state. Retired generations cannot
change it, and each managed invocation revalidates current native document
authority. Native lifecycle notifications are observations, not permission
grants. Reattachment is distinct from navigating or reloading the document;
normal document navigation still follows its existing authority revocation rules.

Hiding a pane preserves its browser/session. Disposal destroys its overlay
controller, releases the owned BrowserView, and waits for ordinary CEF browser
close before completing. It does not call the Alloy browser's top-level close
operation to remove a sibling pane. The native fixture checks sibling survival
and zero remaining view/session and queued-delivery counters. Those counters do
not measure released GPU memory or renderer cache residency.

Closing a parent window keeps every live browser and BrowserView owned until
CEF delivers its actual `OnBeforeClose` callback. The host first asks every
browser to accept closing as one guarded batch. A synchronous nested close is
deferred once on the UI thread if the batch remains pending; pending browsers
without a nested request are not polled. Once all browsers accept, live overlay
contents are detached and added to the same parent's ordinary child hierarchy
so parent destruction reaches those BrowserViews. If an overlay widget is
already closing and cannot detach, the parent remains pending with its owners
intact until the actual browser callback allows another attempt. This does not
create close receipts, release browser owners early, or extend native deadlines.

## Why windowed CEF Views remains the renderer

CEF's supported overlay primitive provides the required first increment without
an off-screen-rendering compositor. A switch to OSR would also require an owned
surface composition path, pointer/keyboard forwarding, IME and accessibility
integration, DPI handling, damage tracking, and lifecycle measurements. No such
rewrite or automatic fallback is included. Memory, GPU residency, latency, and
resize-throughput differences have not been benchmarked; the functional fixture
is explicitly ineligible for performance comparisons.

The separate [composition resource protocol](composition-measurement.md) supplies
an executable descriptive windowed-CEF CPU/RSS baseline with fixed idle, resize,
overlay and close/reopen phases. It keeps GPU measurements, OSR comparisons and
physical input/IME/accessibility qualification separate and open.

The implementation follows the pinned upstream contracts at CEF `47dbc1d`:
[CefWindow](https://github.com/chromiumembedded/cef/blob/47dbc1d/include/views/cef_window.h),
[CefOverlayController](https://github.com/chromiumembedded/cef/blob/47dbc1d/include/views/cef_overlay_controller.h),
[overlay placement implementation](https://github.com/chromiumembedded/cef/blob/47dbc1d/libcef/browser/views/overlay_view_host.cc),
and [CefFocusHandler](https://github.com/chromiumembedded/cef/blob/47dbc1d/include/cef_focus_handler.h).
They are design references; no upstream implementation is copied into this module.

## Executable qualification and remaining work

`examples/view-composition` is the fixed native M7 fixture. The shared desktop
runner bundles its backend, browser client, and public assets against an explicitly
selected immutable native prebuilt. One 25-second fixture deadline covers three
independent application documents, two content panes and one overlay. Renderer
RPC observations and native readback must agree on visible viewport dimensions.
The fixture exercises partial/full clipping, window resize, 16 rapid pane-size
changes, hidden/nonfocusable focus rejection, forward/reverse view traversal,
overlay show/hide/close, generation reattachment, stale handles, sibling survival,
and ordinary shutdown. It emits its structured receipt only after native shutdown.

Run it with `bun run qualify:desktop PREPARED_APP --native-source=COMMIT
--case=composition`; the [shared runner and replay contract](desktop-qualification.md#view-composition)
describes source/artifact binding and the hosted stage. A passing receipt requires
all 28 ordered observations and exact retained identities; an incomplete or
reordered sequence cannot be promoted to native acceptance.

`examples/view-parent-close` is a separate regression selected with
`--case=parent-close`, using profile `native-view-parent-close-v1`. It closes a
manual-layout parent while four independently loaded panes and their sessions
are still live. Each distinct native `view.closed` callback and the parent's
native `window.closed` callback must arrive before session disposal. Native
readback through the retained control-window handle proves that the intended
control window survived, then diagnostics require no views, sessions or queued
deliveries. The receipt is emitted only after final native shutdown. This case
retains the 25-second fixture and 45-second observer budgets and does not change
the historical composition receipt. It exercises API parent close; an OS-quit
action still requires its own fresh native observation.

Portable tests cover malformed geometry/readback, ownership and close races,
cancellation admission, managed authority, bounded renderer receipts, legacy
layout behavior, and explicit unsupported backends. Those tests are protocol
evidence; native behavior requires the shared runner on each supported platform.

For deliberate operator input and equipment tests, use the separate
[interactive native workbench](hardware-workbench.md). It prepares an explicitly
selected prebuilt without launching it, opens only with `run ... --launch`, and
stays alive until explicit close. Its two remote previews and application overlay
exercise this composition API under the
[M7 twelve-case protocol](m7-platform-qualification.md); all physical hardware
and assistive-technology results remain not run or explicitly unsupported.

Issue #35 remains open until the complete desktop matrix is qualified. In
particular, physical keyboard/pointer and IME paths, context-menu/dialog focus,
assistive technology, hardware multi-monitor/DPI behavior, transparent or modal
overlay needs, and GPU-memory release require explicit evidence. The fixture
always records `physicalInputQualified`, `hardwareDpiQualified`,
`assistiveTechnologyQualified`, and `performanceEligible` as `false`.
