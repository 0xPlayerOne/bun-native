# Native popup menus and window-local shortcuts

This is a bounded increment of [issue #34](https://github.com/0xPlayerOne/bunly/issues/34).
The optional `window.commands` facet uses CEF `MenuModel`, `Window.ShowMenu`,
`Window.SetAccelerator` and their native delegates. It registers declared command
tokens in one window. It does not implement a system menu bar, tray, global OS
shortcuts, Electron menu roles, or automatic replacement of Chromium context menus.
The combined desktop scope and qualification status for issue #34 are recorded
in the [M7 capability map](m7-status.md).

## Availability

| Backend / platform                          | Implementation                                                             | Qualification in this increment                                     |
| ------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| CEF / macOS arm64                           | Native CEF popup and accelerator primitives                                | Synthetic native menu fixture passed at historical source `efe4db3` |
| CEF / Linux x64                             | Native CEF popup and accelerator primitives; existing X11 host requirement | Synthetic native menu fixture passed at integrated source `ef6c3ca` |
| CEF / Windows x64                           | Native CEF popup and accelerator primitives                                | MSVC target API check passed; real native build/execution pending   |
| Legacy ABI 1 host without `window.commands` | Explicit `UNSUPPORTED_CAPABILITY`                                          | Protocol regression covered                                         |
| Mock and system webview profiles            | Explicit unsupported capability                                            | No fabricated menu or OS input observations                         |

The runtime advertises this facet only when the native version-1 desktop
capability receipt contains `window.commands`. ABI 1 is retained; older host
readiness does not authorize new methods. The profile metadata describes an
implementation extension; qualification is limited to the executed source and workload below.

## Registration and policy

```ts
const scope = await backend.capturePolicyScope(view)
await backend.grantNativeCapability(scope, { name: 'window-commands' })

const owner = new AbortController()
const commands = await backend.createWindowCommands(scope, {
  commands: [
    {
      id: 'show-sidebar',
      label: 'Show sidebar',
      shortcut: { key: 'K', control: true, shift: true },
    },
    { id: 'disabled-action', label: 'Unavailable action', enabled: false },
  ],
  menu: [
    { type: 'command', command: 'show-sidebar' },
    { type: 'separator' },
    {
      type: 'submenu',
      label: 'More',
      items: [{ type: 'command', command: 'disabled-action' }],
    },
  ],
}, { signal: owner.signal })

backend.onWindowCommandsEvent(commands, event => {
  if (event.type === 'command' && event.command === 'show-sidebar') {
    // Perform the application's declared sidebar action here.
    // Sensitive operations still require their own current policy grants.
  }
}, { signal: owner.signal })

await backend.showWindowMenu(commands, { x: 24, y: 40 })
// Later: request cancellation, or dispose the registration and its shortcuts.
await backend.cancelWindowMenu(commands)
await backend.disposeWindowCommands(commands)
```

Only the trusted Bun backend obtains `PolicyScope` and calls these methods. A
renderer cannot reconstruct the scope or registration handle from an ID. The
native registry binds the registration to its actual view, window, session,
main frame, document, origin and native generation. The native `window-commands`
grant is separate from browser permissions, clipboard, filesystem, processes,
downloads and external URLs. A menu command grants none of those other effects.

Every registration, popup opening and native command callback rechecks the exact
current document and grant. Navigation, context retirement, view/window close,
and application teardown retire registrations. Native callbacks also match a
monotonic registration incarnation and popup identity; an old delegate cannot
dispatch into a replacement registration, even if a private protocol peer reuses
a diagnostic token. Public handles require exact in-process object identity.

Definitions are immutable snapshots. To change labels, enabled state, tree shape
or shortcuts, dispose the old registration and create a new one. The initial
facet intentionally has no mutable menu model or implicit built-in commands.

## Bounds and shortcut semantics

| Resource            | Limit / validation                                                                                                                      |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Registrations       | 64 per backend, 8 per window, charged while native release is pending                                                                   |
| Commands            | 1–32 per registration; unique lowercase ASCII IDs of at most 32 characters                                                              |
| Popup tree          | 64 total items, 3 levels; no empty submenu, repeated command, or leading/repeated/trailing separator                                    |
| Labels              | Nonempty plain Unicode, at most 128 UTF-8 bytes; no unpaired surrogates, NUL/control characters or `&` mnemonic markup                  |
| Shortcuts           | `A`–`Z`, `0`–`9`, `F1`–`F12`; literal Control, Alt and Shift booleans                                                                   |
| Character shortcuts | Require Control or Alt; bare text and Shift-only text capture are rejected                                                              |
| Duplicate chords    | Rejected across all live registrations of the same window, including disabled commands and pending release                              |
| Popup menus         | One pending/open application popup per native host                                                                                      |
| Popup point         | Integer client-area DIPs, each axis 0–16383; native code checks the actual visible client area and checked screen-coordinate conversion |
| Listeners           | 16 per registration, each independently disposable / abort-owned                                                                        |

`control: true` means the Control key on macOS too. CEF's public accelerator
setter has no Command/Meta parameter. There is no `CmdOrCtrl` alias, implicit
platform substitution, arbitrary key sequence, or global keyboard registration.
Native high-priority accelerators run through the owning window's focus manager
before its WebContents handles the same chord. An application should choose
chords deliberately; OS-reserved shortcuts and physical keyboard layouts remain
outside the qualification claim.

Application popups can serve a context-menu interaction after a trusted backend
has authorized it. This facet does not install a renderer context-menu handler.
The independent default browser-menu guards continue to deny file, print, source,
and unknown/default-privileged commands. Application menu IDs are delivered only
through the registered native delegate and are never delegated to Chromium's
built-in command dispatcher.

## Observations, cancellation and disposal

`showWindowMenu()` resolves an admission receipt. The event `menu-shown` records
CEF's `MenuWillShow` callback: native menu opening has begun, not a screenshot or
proof of completed OS painting. `menu-closed` records the actual native closing
callback. `menu-failed` means `ShowMenu` returned without the native opening
callback; it never pretends that the menu became visible. `command` carries only
the declared command ID and the observed source, `menu` or `shortcut`. `revoked`
is a resource lifetime notification. Events have a monotonically increasing
sequence for their registration.

The signal passed to creation owns the registration after creation resolves.
Aborting it immediately fences SDK callbacks and starts native cleanup. If
creation is still pending, the reservation remains charged until its native
reply, and a late-created native registration is explicitly released. A signal
passed to `showWindowMenu` owns only that popup. Aborting it suppresses its
subsequent command callbacks and requests cancellation of the exact popup.

`cancelWindowMenu` requests cancellation. On macOS, an OS menu runs in a nested
loop, so a cancellation request can return before `MenuClosed`. The popup remains
charged until native closure. `disposeWindowCommands` resolves after its native
accelerators have been removed and its active popup has closed (or the owning
window has actually been destroyed). Cleanup releases only that registration's
accelerators; it never calls `RemoveAllAccelerators`. Small cancel/dispose frames
use the existing bounded control reserve without changing transport limits or
FIFO order. Oversized frames do not acquire the reserve.

Cocoa menu tracking suppresses ordinary CEF application tasks. The macOS host
therefore schedules one coalesced main-run-loop wake that can only request
cancellation of the currently tracked, actually shown popup. It revalidates the
pending cleanup's exact fields, registration, native document scope and popup
identity. The ordinary CEF task remains the sole command dispatcher and reply
owner; accelerators, views and windows are not destroyed inside the menu loop.
Pending cleanup is represented by weak references to already-admitted tasks,
bounded by the existing native command limit, with no second payload copy.
An early wake remains pending for `MenuWillShow`, and the tracking marker is
installed before the show admission reply. SDK navigation and view/window close
queue their scoped registration cleanup before native lifecycle work. Both
application quit and internal native quit can cancel the owned popup while their
ordinary shutdown tasks wait for the loop to return. Host release permanently
stops the wake before dropping native owners; a late run-loop block returns
without entering CEF, and clearing weak entries leaves queued task permits owned
by their ordinary CEF tasks.

Popup admission also reserves the host's single native modal slot. The slot has
an independently issued monotonic identity and is released only by the matching
native closure, destroyed owner, or an observed failure to open. Cancellation
requests and stale callbacks cannot free it. This coordinates popup ownership
with separately delivered native dialog adapters without overlapping OS modal
loops; it does not make dialogs available in this increment.

A local quit request fences callbacks immediately but does not release the
registration reservation until the native orderly shutdown receipt. A broken
control channel is a failed/unknown release, so explicit disposal rejects and
the bounded ownership record remains charged. Failure is never reported as a
successful zero-resource observation.

Listeners should perform synchronous dispatch into application-owned work. Their
AbortSignals fence future delivery; retiring a listener does not undo application
effects already performed by a callback. Listener exceptions are isolated and
counted by the existing backend diagnostics. Rejections from returned promises
are also counted in `listenerErrors`, including those that settle after the
subscription retires. Dispatch does not await asynchronous work or reorder later
listeners.

## Managed application generations

`ManagedDesktopResources.registerWindowCommands(name, handle, policy)` retains
the stable native registration and exposes only `show`, `cancel`, `events` and
`ack-events` through the managed resource boundary. Registration checks that the
managed authority belongs to the exact native document that created the command
resource. Native handles and callback closures never enter replacement Workers.

The stable owner records callbacks in the existing bounded event journal. A new
generation reads and acknowledges that journal only after scope and permission
revalidation. Retired generations cannot acknowledge another generation's
observations. Overflow reports `CAPACITY`; it does not silently drop events and
claim success. A generation can independently own an event listener with its
generation signal when persistence across reloads is unnecessary.

## Contributor validation

Use a clean source commit and a matching, explicitly prepared native host built
with `packaging,rpc-qualification`:

```sh
bun run qualify:desktop /absolute/path/to/prepared-app --native-source=COMMIT --case=commands
bun run qualify:desktop --verify /absolute/path/to/report.json
```

The independent `native-window-commands-v1` report lives in
`.bunly/m7/window-commands/run-*/report.json`. It retains every selected source
fingerprint, input and prepared binary inventory, actual CEF/Chromium and Bun
probes, prepared file identity and all native teardown phases. The fixed
25-second workload includes application cleanup; the process observer keeps its
45-second launch budget and existing outer cleanup guard. Failed native attempts
remain failures. The application receipt must follow the private shutdown
response, and physical input, hardware DPI, accessibility and performance flags
must remain false.

The full hosted suite adds this case after file downloads on each supported
target, before window-mode/terminal/managed/credential stages. Linux uses its
owned Xvfb/Openbox instance and Windows the existing standard-user launcher. This
does not change the M4-only suite or require any clipboard access.

`examples/window-commands/fixture.ts` is an explicit contributor entry for an
outer qualifier using a disposable runner and a native host compiled with
`rpc-qualification`. It checks missing-grant denial, forged scope, oversized
definitions, duplicate chords, a real native shortcut callback, popup selection,
popup cancellation, disposal while open, registration abort, document retirement,
and zero remaining native-owned command resources. Its bounded observation queue
rejects missing, extra and reordered callbacks. A fixed deadline and unexpected
backend close latch failure; there is no polling or synthetic success receipt.

Only the contributor feature admits `commands.qualification` and its count
snapshot. On macOS, synthetic selection queues a fixed Down/Return key-down and
key-up sequence in the owning application's AppKit event queue directly from
the real `MenuWillShow` callback. The driver revalidates the exact registration,
popup and document grant, requires the active CEF owner and its visible, restored,
key `NSWindow`, and constructs all four events before posting any of them. Every
event targets that owned window number; no delayed block or system-wide input is
used. Cocoa's native menu tracking disables nested application tasks, so a queued
CEF task cannot drive that loop. Linux and Windows retain their CEF task and
`Window.SendKeyPress` path. Shortcut input also uses that CEF testing API.

The macOS fixture passed at source `efe4db365e653425ffb0463683c265bb80ad7b67`;
[PR #139](https://github.com/0xPlayerOne/bunly/pull/139) records the actual menu,
shortcut and cleanup observations. That is historical-source evidence, not a
current-head execution.

On Linux x64, a standard-user Xvfb/Openbox run passed at source
`ef6c3cadf901321e03c29f5649662e1fa2430cf7`, with native tree
`287b418ed4e7dba5df106276baa2f1da3e71c596` and a host built with
`packaging,rpc-qualification`. The retained report SHA-256 is
`206a3ef3643953d3538b64e449b0f54ee0995c54d8e13d2193dd154b2d48b645`.
It recorded seven expected events, three popup openings, two selections, one
cancellation and one disposal, with native ownership released. The observations
are `syntheticNativeInput: true` and `physicalInputQualified: false`. The published integration
commit `823c66d` has the same source tree as `ef6c3ca`; this run is not a later
current-head execution. Windows native execution remains unqualified.

These paths never directly invoke the application delegate or fabricate a
callback: actual `ExecuteCommand` and `MenuClosed` callbacks remain required.
Ordinary builds do not expose the operation, and no renderer message can enable
it. The retained receipt explicitly records `syntheticNative: true` and
`physical: false`. It does not qualify a system menubar, global shortcuts,
physical input, accessibility, assistive technology, or OS shortcut conflicts.

Primary sources reviewed at the pinned versions:

- [CEF Window API](https://github.com/chromiumembedded/cef/blob/47dbc1df023e99f006fb9e850a8d83cc19b4fdd9/include/views/cef_window.h)
- [CEF MenuModel API](https://github.com/chromiumembedded/cef/blob/47dbc1df023e99f006fb9e850a8d83cc19b4fdd9/include/cef_menu_model.h)
- [CEF Window implementation](https://github.com/chromiumembedded/cef/blob/47dbc1df023e99f006fb9e850a8d83cc19b4fdd9/libcef/browser/views/window_impl.cc)
- [CEF menu delegate dispatch](https://github.com/chromiumembedded/cef/blob/47dbc1df023e99f006fb9e850a8d83cc19b4fdd9/libcef/browser/menu_model_impl.cc)
- [Chromium Views menu completion](https://github.com/chromium/chromium/blob/156.0.8078.17/ui/views/controls/menu/menu_runner_impl.cc)
- [Chromium macOS nested menu lifetime](https://github.com/chromium/chromium/blob/156.0.8078.17/ui/views/controls/menu/menu_runner_impl_cocoa.mm)
- [AppKit application event queue](<https://developer.apple.com/documentation/appkit/nsapplication/postevent(_:atstart:)>)
