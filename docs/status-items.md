# Text status items

The `status.item` facet provides a bounded text item in the macOS system status
bar. Windows, Linux, the mock backend and the planned system-webview adapters
report `UNSUPPORTED_CAPABILITY`. Implementation and native qualification are
separate: this source adds the adapter and its contributor fixture; successful
execution must be recorded against its exact source and artifact before claiming
platform qualification. This is part of [M7 issue #34](https://github.com/0xPlayerOne/bunly/issues/34).

## Authority and lifetime

The trusted Bun owner captures the ready view's opaque `PolicyScope` and explicitly
grants the separate `status-item` native capability. The scope binds the native
view, session, main frame, document, generation and exact origin. A menu grant,
public handle ID or status callback grants no status-item authority.

```ts
const scope = await backend.capturePolicyScope(view)
await backend.grantNativeCapability(scope, { name: 'status-item' })
const item = await backend.createStatusItem(scope, {
  title: 'Ready',
  tooltip: 'Background work is complete',
})
const stop = backend.onStatusItemEvent(item, (event) => {
  if (event.type === 'click') showExistingWindow()
})
await backend.updateStatusItem(item, { title: 'Working', tooltip: 'Task in progress' })
stop()
await backend.disposeStatusItem(item)
```

The handle is an opaque in-process object. Copies and handles from another backend
are rejected. Creation's optional abort signal owns the item after creation too.
Disposal is idempotent for an authentic handle. Its promise completes after the
native `NSStatusBar.removeStatusItem` call returns. A failed control channel keeps
the bounded reservation as unknown native ownership instead of reporting zero.

There are at most four items globally, one per view, and sixteen callback listeners
globally. Titles are nonempty plain Unicode text of at most 64 UTF-8 bytes; optional
tooltips are at most 256 UTF-8 bytes. Controls, unpaired surrogates and unknown
definition fields are rejected. Each update supplies a complete text definition.
The API does not accept an image path, icon payload or menu definition.

Listeners run synchronously in registration order. Exceptions and rejections from
returned promises are isolated and counted in backend `listenerErrors`, including
rejections that settle after the listener is removed. Dispatch never waits for a
listener's asynchronous work, and aborting a subscription only fences future
delivery; it does not cancel work the application has already started.

The native owner validates the grant immediately before creation, update and
click delivery. Navigation and view closure retire the registration immediately;
AppKit removal runs on the native UI thread outside host-registry borrows. The
retained item and action target outlive that removal, and the action target holds
only a weak Rust callback owner. Every actual action rechecks the registration's
incarnation and current document grant. No delayed callback can target a replacement.

`ManagedDesktopResources.registerStatusItem` lets the stable owner retain an item
across backend generations. Replacement handlers consume a bounded `events` /
`ack-events` journal and may call `update` when granted. An acknowledgement must
match a read by the current generation. Overflow is an explicit `CAPACITY` failure;
it neither silently drops accepted callbacks nor recreates the native item.

Status items do not keep the application alive. The existing last-window and quit
paths remain authoritative, and the final native UI fence removes all owned items
before acknowledging shutdown. There are no new shutdown phase names.

## Qualification and limits

```sh
bun run qualify:desktop /absolute/path/to/prebuilt-app --native-source=COMMIT --case=status
```

The contributor host must include `rpc-qualification`. On macOS the fixture creates
four actual items, drives two actions through AppKit's `NSControl.performClick`,
checks a text update, native policy denial, duplicate/forged input rejection,
managed-generation journal replay, explicit removal, view-close removal and quit
removal. It requires zero item, delegate and weak callback owners in the native
shutdown receipt, before process-stop begins. Windows and Linux execute explicit
unsupported-capability checks and require zero native status owners.

The fixture does not simulate action receipts or directly invoke the delegate.
Its input is synthetic native input; it does not qualify physical clicks,
assistive technology, status-bar placement or appearance. AppKit can hide status
items when space is unavailable, so applications must keep another route to their
functions. Tray menus, icons, global shortcuts, reopen/relaunch and application
keepalive remain outside this facet.

Primary API references: [NSStatusBar](https://developer.apple.com/documentation/appkit/nsstatusbar),
[removeStatusItem](<https://developer.apple.com/documentation/appkit/nsstatusbar/removestatusitem(_:)>),
and [NSControl performClick](<https://developer.apple.com/documentation/appkit/nscontrol/performclick(_:)>).
The implementation uses pinned `objc2-app-kit` 0.3.2 typed bindings.
