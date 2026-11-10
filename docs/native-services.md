# Native desktop services

The shared public core exposes owned-window display reads and a bounded
clipboard text worker. `NativeWindow.displaySnapshot()` reads the display
associated with that window through GPUI. `readClipboardText()` and
`writeClipboardText(text)` use the actual local X11 selection protocol off the
UI thread. Solid and React use the same public window methods; neither adapter
owns an OS implementation.

The protocol-6 core, Solid and React display consumers passed all six actual
Linux development/AOT cases with a release-profile host at main
`c9ada928eb86ee44abeb85ba13721a68af0057d6` in
[run 41831891686](https://github.com/0xPlayerOne/bun-native/actions/runs/41831891686/job/126580888949).
The [hosted source-bound record](../tests/native/evidence/services-linux-hosted-release.json)
binds the artifact, compiler manifests, raw results and source hashes. This
qualifies one isolated scale-1 Xvfb screen; macOS, Windows and multi-monitor
service behavior remain unverified. The display snapshot alone also runs on a
headless Wayland compositor (see [Wayland](#wayland)). The earlier
[protocol-5 development-host record](../tests/native/evidence/services-linux-development-aot.json)
remains separate historical evidence. Parser and type checks do not substitute
for either native run.

The recovered protocol-6 clipboard increment passed fresh source, isolated-X11
development and inspected AOT checks on November 2, 2026. Each native run
completed 26 outcomes and joined 22 independent peers with no forced cleanup.
The [fresh record](../tests/native/evidence/clipboard-linux-recovered.json)
binds the new source and binaries, separately from the
[historical recovery note](../tests/native/evidence/clipboard-recovery-history.json)
whose prior raw artifacts were lost. These local runs use a development-profile
Rust host. A separate [hosted release-host qualification](../tests/native/evidence/clipboard-linux-hosted-release.json)
on November 4, 2026 passed development and inspected AOT at main
`c9ada928eb86ee44abeb85ba13721a68af0057d6`. Both modes completed all 26 outcomes,
joined all 22 peers and returned all seven public ownership counts to zero.
The downloaded artifact's checksum, all 75 scenario source fingerprints and
all 69 compiler source fingerprints were verified against that commit. This
qualifies the bounded local Linux X11 text implementation in #300; macOS,
Windows, Wayland, remote X11 and richer clipboard formats remain unavailable.
Other native services retain the explicit deferrals in the matrix below.

## Policy and capability contract

```ts
import { createApplication, NativeServiceError } from "@bun-native/core";

const executable = process.env["BUN_NATIVE_HOST"];
if (!executable) throw new Error("Set an absolute BUN_NATIVE_HOST path");
const app = await createApplication({
  executable,
  permissions: { windowDisplay: "allow" },
});
try {
  const window = await app.openWindow({ title: "Display information" });
  const display = await window.displaySnapshot();
  console.log(display.bounds, display.scaleFactor);
  await window.close();
} catch (error) {
  if (error instanceof NativeServiceError)
    console.error(error.code, error.service);
  else throw error;
} finally {
  await app.shutdown();
  await app.closed;
}
```

The default permission is `deny`. The accepted keys are `windowDisplay`,
`clipboardRead`, `clipboardWrite`, `globalShortcuts`, `notifications`,
`dragDrop` and `fileDialogs`, each independently `allow` or `deny`;
`filesystemRoots`, a list of launch directories described under
[filesystem grants](#filesystem-grants); and `processes`, a list of launch
executables described under [owned processes](#owned-processes). The
`file_dialogs` policy field is optional on the wire and omitted when denied.
The runtime translates each explicit grant into its reserved native launch argument. The Rust process
parses that immutable policy before starting GPUI or its private channel.
Unknown or duplicate native arguments fail startup. A wire message cannot
grant, extend or change the policy.

Each protocol replaced its predecessor without a compatibility decoder:
protocol 7 added global shortcuts, 8 notifications, 9 `filesystem_roots`, 10
`processes` and the current protocol 11 `drag_drop`. Readiness must include
`window_display_v1` alongside the other required rendering capabilities and a
`service_policy` with explicit `window_display`, `clipboard_read`,
`clipboard_write`, `global_shortcuts`, `notifications` and `drag_drop`
booleans plus the `filesystem_roots` and `processes` lists. Display details,
display changes and file dialogs are optional capabilities that kept protocol
11; `file_dialogs` is the only optional policy field. The runtime requires the
reported policy to match its launch request exactly. Missing capabilities,
missing policy, conflicting policy or an older protocol fail launch and clean
up the child. Feature negotiation says what the host implements; permission
says which implemented service the application elected to expose.

`app.serviceCapabilities` is a frozen record. `windowDisplay` contains
`{ availability: 'available', permission: 'allow' | 'deny', scope: 'owned_window', details, changes }`,
where `details` and `changes` are `'available'` only when the host advertises
`display_details_v1` / `display_changes_v1`.
The optional `clipboard_text_v1` feature is advertised only for the implemented
local Linux X11 backend. Its capability record reports independent `read` and
`write` permissions, `owned_window` scope and backend `x11`. Other targets and
backends report `unavailable` / `unsupported_platform` for clipboard text.
Every other optional service has the same shape: available with its
grant, scope and backend when its capability is advertised, otherwise
`unavailable` / `unsupported_platform`. `messageDialogs` is available with
backend `modal_overlay` whenever the host advertises `overlays_v1` and
`focus_v1` (`unavailable` / `unsupported_host` otherwise) and needs no grant;
`appMenu` is available on macOS only.
[Advertised capabilities by platform](native-platforms.md#advertised-capabilities-by-platform)
lists which host advertises each one. An advertised
implementation does not certify the current display environment: an allowed
read can still return `service_unavailable`. There are no callable placeholder
methods for the unavailable services.

This is a native-host policy, **not an operating-system sandbox**. Application
code, dependencies and the selected host executable are trusted. Ordinary Bun
filesystem, process and network APIs remain outside this broker, and a caller
can launch a different process using its own authority. Readiness is not an
artifact authenticity check. See [ADR 0003](decisions/0003-bridge-security.md).
No OS permission prompt or system setting is changed by this display service.

## Display snapshot and lifecycle

The result is a deeply frozen object:

```ts
interface NativeDisplaySnapshot {
  readonly bounds: Readonly<{ x: number; y: number; width: number; height: number }>
  readonly scaleFactor: number
  // Only when serviceCapabilities.windowDisplay.details is 'available' (macOS, Windows):
  readonly visibleBounds?: Readonly<{ x: number; y: number; width: number; height: number }>
  readonly displayId?: string
}
```

`visibleBounds` and `displayId` exist only where the host advertises the
optional `display_details_v1` capability, and `window.onDisplayChange()` only
where it advertises `display_changes_v1`; see
[macOS and Windows display semantics](#macos-and-windows-display-semantics-299).
Neither changes `PROTOCOL_VERSION`; a host that sends a detail or a change
without advertising it fails the session as a protocol error.

Bounds are the GPUI platform display's reported logical pixels; coordinate
origins depend on its backend. `scaleFactor` is the owning window's current
native scale factor. The UI thread resolves the
still-live window and reads `window.display(cx)`, `display.bounds()` and
`window.scale_factor()`. The response contains the matching request and window
identities. Both language implementations reject nonfinite or excessive
geometry, unknown fields and malformed ownership. Origins are bounded to
±1,048,576 logical pixels, positive dimensions to 1,048,576 and scale to
0.125–16. Invalid native geometry fails as `native_failure` rather than being
clamped into an invented result.

The pinned X11 backend represents an **X screen spanning its monitors**, not a
physical monitor selected by the window's overlap. Its bounds originate at
zero and divide X screen pixels by the configured scale. The API does not
promise refresh rate, raw DPI, display enumeration or automatic window
placement anywhere, and offers a work area, display identifier and
display-change events only through the macOS/Windows capabilities below. A
snapshot is a read at one instant: moving a window afterwards can make it
stale.
These semantics follow the pinned
[X11 display implementation](https://github.com/zed-industries/zed/blob/ba63a022c9a22ca66d68ef2a8f0bb9b5b0a9984d/crates/gpui_linux/src/linux/x11/display.rs#L14-L55)
and [GPUI window accessors](https://github.com/zed-industries/zed/blob/ba63a022c9a22ca66d68ef2a8f0bb9b5b0a9984d/crates/gpui/src/window.rs#L3144-L3162).
The pinned [macOS implementation](https://github.com/zed-industries/zed/blob/ba63a022c9a22ca66d68ef2a8f0bb9b5b0a9984d/crates/gpui_macos/src/display.rs#L114-L125)
also returns a zero origin, retaining the size from `CGDisplayBounds` but not
its global origin. This API therefore does not promise a global monitor
arrangement or suitable coordinates for cross-display window placement.

### Qualified X11 display semantics (#299)

[`tests/native/display-semantics.ts`](../tests/native/display-semantics.ts)
qualifies the snapshot against independent X clients in an isolated
**two-screen** Xvfb (1280×800 and 1024×768) with openbox. `xdpyinfo` and
`xwininfo -root` supply every expected geometry; window movement, resizing,
OS close and resource changes are real X requests (`xdotool`, `xrdb`). Each
scenario launches the same prebuilt host through an `exec` wrapper that fixes
only `DISPLAY` / `GPUI_X11_SCALE_FACTOR`. The fixture requires, in development
and inspected AOT:

| Semantic                  | Observed native result                                                                                                                                                              |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Whole X screen            | Two windows of different sizes report the same `{0, 0, 1280, 800} @1`. An X server move to the opposite corner and resize leaves the snapshot unchanged.                            |
| Logical pixels            | `GPUI_X11_SCALE_FACTOR=2` reports `640×400 @2`: X screen pixels divided by the scale.                                                                                               |
| Scale source and lifetime | With the override unset, `Xft.dpi: 144` reports `853.33×533.33 @1.5`. Changing it to 192 at runtime changes neither an existing nor a newly opened window; a new host reports `@2`. |
| Window's X screen         | A host connected to `:N.1` reports the 1024×768 second screen, not screen 0.                                                                                                        |
| Revocation                | Default denial, `close()`, window-manager close (`WM_DELETE_WINDOW`) and shutdown each end the capability; every application returns all ownership counters to zero.                |

So on X11 a snapshot is a property of the host's X connection: the X screen
size from the connection setup and one process-wide scale factor resolved at
connection time from `GPUI_X11_SCALE_FACTOR`, `Xft.dpi` or RandR. The
[client](https://github.com/zed-industries/zed/blob/ba63a022c9a22ca66d68ef2a8f0bb9b5b0a9984d/crates/gpui_linux/src/linux/x11/client.rs#L478-L480)
reads the resource database and scale once; each
[window](https://github.com/zed-industries/zed/blob/ba63a022c9a22ca66d68ef2a8f0bb9b5b0a9984d/crates/gpui_linux/src/linux/x11/window.rs#L826)
stores an `X11Display` built from that setup. A window cannot migrate to
another X screen, and moving it within a screen cannot change its snapshot.

**No display-change subscription is added.** The pinned X11 window's
[`on_display_changed`](https://github.com/zed-industries/zed/blob/ba63a022c9a22ca66d68ef2a8f0bb9b5b0a9984d/crates/gpui_linux/src/linux/x11/window.rs#L1728-L1730)
is a no-op and the X11 platform reports `displays_changed` only when the
backend connection is
[replaced](https://github.com/zed-industries/zed/blob/ba63a022c9a22ca66d68ef2a8f0bb9b5b0a9984d/crates/gpui_linux/src/linux/platform.rs#L442-L470),
not on RandR changes. A subscription on this backend would never fire for a
real monitor change, so exposing one would overstate the platform. The
following remain **unavailable** and are not part of the public result:

- Display-change events and runtime geometry changes: Xvfb's RandR exposes a
  single fixed mode and silently ignores `--setmonitor`, so no actual change
  can be produced here; GPUI would not observe one anyway.
- Monitor hotplug: Xvfb has no physical outputs.
- Work area: the X11 display does not override
  [`visible_bounds`](https://github.com/zed-industries/zed/blob/ba63a022c9a22ca66d68ef2a8f0bb9b5b0a9984d/crates/gpui/src/platform.rs#L655-L661),
  which therefore equals `bounds`; `_NET_WORKAREA` is not read.
- Monitor identity: the X11 display id is the X screen index and its UUID is
  all zeros, so there is no persistent identity to expose.
- Mixed DPI: one scale factor per host process; per-monitor scale is not
  exposed by the X11 backend.
- Wayland: `displaySnapshot` matches the compositor's output (bounds and
  integer scale 1 or 2) on headless sway; see [Wayland](#wayland). Change
  events stay unadvertised on all of Linux. macOS and Windows have their own
  fixture, below.

### macOS and Windows display semantics (#299)

On macOS and Windows the host advertises two optional capabilities, behind the
same `windowDisplay` launch grant; Linux advertises neither, and
`serviceCapabilities.windowDisplay.details` / `.changes` report
`'unavailable'` there:

| Capability           | Public result                                | GPUI source (pinned)                                                                                                                                                                                                                                                                                                          |
| -------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `display_details_v1` | `visibleBounds` (work area) and `displayId`  | macOS [`visible_bounds`/`uuid`](https://github.com/zed-industries/zed/blob/ba63a022c9a22ca66d68ef2a8f0bb9b5b0a9984d/crates/gpui_macos/src/display.rs#L85-L149), Windows [`rcWork`/`szDevice`](https://github.com/zed-industries/zed/blob/ba63a022c9a22ca66d68ef2a8f0bb9b5b0a9984d/crates/gpui_windows/src/display.rs#L39-L77) |
| `display_changes_v1` | `window.onDisplayChange(listener) => remove` | [`observe_window_display`](https://github.com/zed-industries/zed/blob/ba63a022c9a22ca66d68ef2a8f0bb9b5b0a9984d/crates/gpui/src/window.rs#L2867-L2918), fed by [App `displays_changed`](https://github.com/zed-industries/zed/blob/ba63a022c9a22ca66d68ef2a8f0bb9b5b0a9984d/crates/gpui/src/app.rs#L1699-L1721)                |

- **Work area.** macOS: `NSScreen.visibleFrame` relative to the screen's
  top-left, so the menu bar and Dock are excluded. Windows: `rcWork` from
  `GetMonitorInfoW` divided by the monitor's effective DPI scale, in the same
  global logical coordinates as `bounds`.
- **Identity.** macOS: `CGDisplayCreateUUIDFromDisplayID`, lowercased.
  Windows: GPUI derives a v5 UUID from the GDI device name (`\\.\DISPLAYn`,
  the whole 32-unit `szDevice` buffer), so it identifies an adapter output,
  not a physical monitor, and can follow a different monitor after
  reconfiguration. `displayId` is omitted if the OS returns no identifier.
- **Display changes.** The host observes each owned window, only with the
  launch grant, and sends `display_changed { sequence, window_id, snapshot }`
  when GPUI reports that the window moved to another display or that its
  display's bounds or refresh interval changed (`windowDidChangeScreen` and
  `NSApplicationDidChangeScreenParametersNotification` on macOS;
  `WM_DISPLAYCHANGE` on Windows). A change of only the work area or only the
  scale factor is **not** reported by the pinned GPUI. The subscription
  belongs to the window entry: closing the window (by `close()` or the OS)
  drops it in the host, and `close()`, OS close and shutdown revoke every
  listener in the core, aborting its event `signal`. Removing a listener is
  immediate and idempotent; queued deliveries for it are dropped.
- **Subscribing.** `onDisplayChange` checks synchronously, in this order: a
  closed window or stopped application throws `NativeStateError`, a
  non-function listener `TypeError`, a host without `display_changes_v1`
  `NativeServiceError` `service_unavailable`, and a denied launch grant
  `permission_denied`. A listener receives a frozen
  `{ type: 'display_change', sequence, snapshot, signal }`. Its `snapshot`
  has the same shape and capability check as `displaySnapshot()`. A
  `display_changed` from a host that did not advertise the capability, or a
  snapshot whose details do not match `display_details_v1`, fails the session
  with `ProtocolError` even when no listener is registered.

[`tests/native/display-platform.ts`](../tests/native/display-platform.ts) runs
in the **Native Platforms** workflow on the hosted `macos-15` and
`windows-2022` runners, in development and inspected AOT, against the release
host. Expected values come from oracles that never load GPUI:
[`macos-display-oracle.m`](../tests/native/macos-display-oracle.m) (NSScreen
and CoreGraphics), cross-checked by an `osascript` JXA NSScreen read, with
`system_profiler SPDisplaysDataType` recorded; and
[`windows-display-oracle.ps1`](../tests/native/windows-display-oracle.ps1)
(`System.Windows.Forms.Screen` in a per-monitor-DPI-aware process and
`GetDpiForMonitor`). The fixture asserts the default denial, bounds, work
area, scale, identity, identical snapshots for two windows on one display,
then makes a **real display-mode change** (`CGConfigureDisplayWithDisplayMode`
for the session; `ChangeDisplaySettingsExW`), requires a `display_change`
matching the OS's new geometry for both owned windows, removes one listener,
restores the original mode, requires a change back for the other, and checks
close and shutdown revocation and zero ownership counters.

**This evidence is CI-only.** It was written on Linux, where only the shared
protocol, core and host code compile and run; the macOS/Windows paths are
selected by `cfg!` constants rather than separate code, but their native
behavior is established only by the hosted run's `display-platform.json`
artifact. If a hosted display offers no other desktop mode or refuses every
change, the fixture records `displayChange` as unavailable with the mode list
instead of claiming it. Always unavailable on hosted runners: window migration
between displays and mixed DPI (one virtual display) and hotplug (no physical
output).

Reads share the public application's bounded serialized transaction queue.
`displaySnapshot({ signal })` accepts a real `AbortSignal`; unknown options or
a forged signal fail locally. An already-aborted or queued-aborted operation
never reaches the host. After submission, cancellation suppresses delivery
only after the bounded transport response has been drained and validated.
It does not interrupt synchronous native code or undo a completed OS read.
There is no asynchronous native side effect to roll back in this slice.

Window close, OS close and application shutdown revoke ownership immediately.
A result received after revocation is not delivered to the caller, and a
stale public handle cannot submit a new read. The Rust host separately rejects
closed or unknown window identities for an allowed session. Denied sessions
receive `permission_denied` before any display read. Requests retain the
normal transport deadline and channel-failure cleanup. A malformed response
still fails the channel even if the caller cancelled in the meantime.

| Error                                                     | Meaning                                                                                                                         |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `NativeServiceError`, `permission_denied`                 | Immutable native launch policy denied the read.                                                                                 |
| `NativeServiceError`, `service_unavailable`               | The allowed owned window has no display available from the native backend.                                                      |
| `NativeServiceError`, `cancelled`                         | Caller cancellation prevented dispatch or result delivery. `service` is `window_display`.                                       |
| `NativeStateError`, `invalid_handle` / `invalid_state`    | Window/application ownership ended or the call was invalid locally.                                                             |
| `NativeCommandError`, `invalid_handle` / `native_failure` | Native owner lookup failed or actual native geometry was invalid.                                                               |
| `ProtocolError` or transport failure                      | Incompatible readiness, malformed/wrong-owner response, timeout, native exit or broken channel. No fallback result is supplied. |

## Clipboard text and lifecycle

```ts
const app = await createApplication({
  executable,
  permissions: { clipboardRead: "allow", clipboardWrite: "allow" },
});
const window = await app.openWindow({ title: "Explicit clipboard operations" });
try {
  await window.writeClipboardText("Text the application intentionally copies");
  const result = await window.readClipboardText();
  if (result.kind === "text") console.log(result.text);
} finally {
  await app.shutdown();
  await app.closed;
}
```

The result is a frozen `{ kind: 'empty' }` when the native selection has no
owner, or `{ kind: 'text', text }`. An owned empty string is text, not absence.
The read requests `UTF8_STRING`; unsupported formats do not turn into empty
text, file paths or cached application data. Payloads are capped at 8,192 UTF-8
bytes and reject NUL/invalid Unicode. Worst-case JSON escaping remains below
the private frame cap.

The implementation supports a **local Linux X11 connection** selected by the
actual GPUI environment. Wayland, macOS, Windows, remote/TCP X11, nontext
formats, clipboard history and persistence after host exit remain unavailable
or unimplemented. Granting a permission does not invent backend support.
Read and write denial is enforced before native owner lookup or clipboard I/O.

Clipboard operations do not occupy the application's serialized tree queue.
There are at most eight pending service requests, observable through
`app.diagnostics.serviceRequests`. The native worker's total two-second deadline
starts at request submission, includes queue time and is never extended by
an incremental-transfer chunk. Native owner replies and server I/O are polled
with cancellation checks. Ordinary updates and input can progress while a
clipboard request waits; the real fixture requires both an unrelated commit and
native input/paint before a deliberately stalled external owner times out.

The stream admits at most 262,144 inbound protocol bytes across the transfer,
including all INCR chunks, before x11rb can queue those bytes. The same bound
applies to an owned-selection service burst. MULTIPLE request lists must have
actual `ATOM_PAIR` type, format 32 and an even bounded atom count. When idle, the
worker waits on its notification socket and any owned selection connection;
it does not keep waking on a timer. The native fixture separately observes idle
worker CPU/context-switch deltas after reads, during ownership and after loss.

Authority matching uses the attributed pinned xauth parser over one opened,
validated regular descriptor, read with a fixed 1 MiB plus oversize-sentinel
limit. The local filesystem, X server and launch environment remain trusted.
This is not a hard wall-clock filesystem I/O guarantee or a defense against
malformed server packet lengths; credentials never enter diagnostics.

Read cancellation before dispatch sends nothing. After dispatch, the bounded
reply is drained and validated before cancellation suppresses delivery.
Window closure revokes its pending native requests. Shutdown cancels pending
work, joins the worker off the UI thread and only then acknowledges terminal
completion, including teardown already initiated by a notification failure.
A malformed response still fails the channel under cancellation.

`writeClipboardText` has no cancellation option. The acknowledgement verifies
that the X server made the worker's private window the selection owner. It does
not claim that another process has read the data. Qualification requires an
independent external reader. Selected text survives closing the requesting
window while the host remains alive; replacement by another clipboard owner
or host exit ends that ownership. A submitted copy cannot be rolled back by
later window revocation. Worker teardown never restores old clipboard contents
or clears a newer external owner.

Clipboard `NativeServiceError.service` is `clipboard_read` or `clipboard_write`.
The codes are `permission_denied`, `service_unavailable`, `cancelled`,
`operation_timed_out`, `payload_too_large`, `native_failure` and native
`limit_exceeded`. Local queue/ownership errors remain `NativeStateError` and
malformed transport data remains `ProtocolError`. An owner change during a
read fails explicitly; it does not return a possibly mixed snapshot.

## Global shortcuts

`window.registerGlobalShortcut(options, listener)` registers an owned OS-wide
combination under the separate `globalShortcuts` grant. The optional
`global_shortcuts_v1` feature is advertised only for a local Linux X11 session.
The worker holds passive grabs on the root window through its own X
connection, resolving keycodes and the Alt, Super and Num Lock bits from the
server's live keyboard and modifier maps. Each combination is grabbed with
every Caps Lock/Num Lock state, so lock state never changes the shortcut.

Keys are the closed set `a`-`z`, `0`-`9` and `f1`-`f12`; at least one of
control, alt or platform (Super) is required. Unsupported combinations fail
validation in both language implementations before any native request. A
combination another X11 client already grabs returns `conflict`, and every
variant this client acquired is released first. A duplicate within the
application is also `conflict`. A key missing from the keyboard map or an
unmapped modifier is `service_unavailable`. At most 16 registrations exist per
session.

Unregistration, owner close and shutdown remove a registration from the
UI-thread registry before the worker ungrabs, so a press the X server already
queued is never published. Unregistration resolves only after the ungrab and a
server round trip. Owner close releases grabs without an application request.
Shutdown joins the worker, and closing its connection releases any remaining
grab. Core X11 autorepeat does not repeat an activation.

The [Native Linux workflow](../.github/workflows/native-linux.yml) runs
[`tests/native/global-shortcuts.ts`](../tests/native/global-shortcuts.ts) in
development and inspected AOT on an isolated Xvfb with openbox. It requires
default denial with no grab, XTEST delivery while a different owned window is
focused, no activation for the unmodified key, Num Lock independence, a real
`BadAccess` refusal for an independent X11 client
([`shortcut-peer`](../native/gpui-host/examples/shortcut-peer.rs)), `conflict`
for both a foreign and an in-session holder, and an independent client
successfully grabbing the same combination after unregistration, owner close
and shutdown. macOS, Windows, Wayland and remote X11 remain unavailable. See
[ADR 0008](decisions/0008-native-global-shortcuts.md).

## Notifications

`window.postNotification(options, listener)` posts an owned plain-text desktop
notification under the separate `notifications` grant. The optional
`notifications_v1` feature is advertised on Linux when a D-Bus session bus is
configured; the host talks to the freedesktop.org `org.freedesktop.Notifications`
service on that bus. There is no OS permission prompt on this platform, so the
launch grant is the only permission state. Whether a notification server is
running is only known when posting: a bus without one rejects with
`service_unavailable`. Every bus operation, including connection setup, is
bounded to two seconds (`operation_timed_out`).

The title is one nonempty line of at most 256 UTF-8 bytes and the body at most
2048 bytes with line feeds as the only control characters; both language
implementations reject anything else before a native request. Content is plain
text: when the server supports body markup the host escapes `&`, `<` and `>`.
A notification has no action strings, URLs or commands. The host offers the
server's default action only when it advertises `actions`, and the posted
response reports that as `activatable`. Activation is a typed sequenced event
naming the owned notification. At most 32 notifications are live per session.

The UI-thread registry decides delivery. Only signals from the bus connection
that answered `Notify` are accepted for that notification, so another client on
the session bus cannot forge an activation or dismissal. When the server
removes a notification first, its final `notification_dismissed` event reports
`expired`, `dismissed` (by the user) or `closed` (any other server reason), and
the handle ends. Withdrawal, owner close and shutdown remove the registration
first, so an activation the server already queued is never published, then ask
the server to close the notification; shutdown waits, within the bound, for
those closes. A notification therefore never outlives its owner window in a
running host. If the host process dies, the server keeps showing it, but no
process remains to receive its activation.

The [Native Linux workflow](../.github/workflows/native-linux.yml) runs
[`tests/native/notifications.ts`](../tests/native/notifications.ts) in
development and inspected AOT on an isolated Xvfb with openbox and its own
D-Bus session bus, against the real dunst notification server. It requires
default denial with nothing shown, `service_unavailable` from the same host on
an isolated bus without a server, a displayed notification, activation through
the server's own action (`dunstctl action`), a user dismissal (`dunstctl
close`), forged `ActionInvoked`/`NotificationClosed` signals from an
independent bus client ignored, and the server's displayed count returning to
zero after withdrawal, owner close and shutdown. macOS and Windows remain
unavailable, and other notification servers are not qualified. See
[ADR 0009](decisions/0009-native-notifications.md).

## Filesystem grants

`window.openFileGrant(root, { access })` opens a scoped grant on one of the
directories the application named in its immutable `filesystemRoots` launch
permission:

```ts
const app = await createApplication({
  executable,
  permissions: {
    filesystemRoots: [
      { id: "workspace", path: "/home/me/project", access: "read_write" },
    ],
  },
});
const window = await app.openWindow({ title: "Workspace" });
const grant = await window.openFileGrant("workspace", { access: "read" });
const page = await grant.list("src");
const chunk = await grant.read("src/main.ts", { offset: 0, length: 16_384 });
await grant.close();
```

Each root has an ID of 1–32 lowercase ASCII letters, digits, `-` and `_` that
starts with a letter, an absolute
normalized path (POSIX, or a Windows drive path such as `C:\data` without UNC
or `\\?\` forms; each host accepts only its own form) and `read` or
`read_write` access; at most eight are accepted, with unique IDs. A grant requests at most its
root's access and defaults to `read`. Readiness reports the same ordered
roots, and the frozen capability record lists them by ID with
`backend: 'openat2'` on Linux, `backend: 'openat_walk'` on macOS or
`backend: 'ntcreatefile_walk'` on Windows. The optional `filesystem_grants_v1`
feature is advertised only by a host built with one of those backends whose
probe succeeds: Linux with `openat2` (5.6 and later), macOS, and Windows 10
1709 or later (`OBJ_DONT_REPARSE`). Other targets report `unavailable` /
`unsupported_platform`. No run-time path, dropped file name or model text can
create a root or a grant.

Paths are relative to the grant: `''` is the root itself and other paths are
`/`-joined names without empty, `.`, `..` or control-character components (at
most 1,024 bytes and 32 components, each name at most 255 bytes). The host opens the root once as a
directory descriptor and resolves every request beneath it, so symbolic links
are never followed, inside or out of the grant. Linux uses
`openat2(RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS | RESOLVE_NO_MAGICLINKS)`. macOS
has no `openat2`; it walks the validated path one name at a time, each step an
`openat(dirfd, name, O_NOFOLLOW | O_NOFOLLOW_ANY | O_CLOEXEC)` relative to the
descriptor the previous step returned (intermediate steps add `O_DIRECTORY`),
so no step can name anything but a direct child of a directory reached from the
grant. On macOS every intermediate directory must be readable, not only
searchable, and names resolve as the volume does (APFS is usually
case-insensitive), always within the grant. macOS evidence comes only from
the hosted `macos-15` Native Platforms job; it has not been run on a local Mac.
Windows walks the same way with `NtCreateFile` relative to the previous
handle, `OBJ_DONT_REPARSE` and `FILE_OPEN_REPARSE_POINT`, so symbolic links,
junctions and mount points are opened as themselves and refused. It also
refuses names Windows would read as a second spelling or another object
(`\`, `:` streams and drives, reserved characters, trailing dots and spaces,
`CON`, `NUL`, `COM1.txt` and the other device names) and checks that each
opened handle's final path is the root's plus exactly the requested names,
which refuses 8.3 short names. Windows evidence comes only from the hosted
`windows-2022` Native Platforms job. `stat` and
`list` report link entries as `symlink`; `remove` deletes the link, not its
target. Renaming the root after a grant opens keeps that grant on the same
directory. Reads and writes refuse anything but a regular file before any byte
moves, so FIFOs and devices are never opened for I/O.

| Method                   | Result                                                                                           |
| ------------------------ | ------------------------------------------------------------------------------------------------ |
| `stat(path)`             | `{ kind, size, modifiedMs }`; `kind` is `file`, `directory`, `symlink` or `other`                |
| `list(path?, { after })` | Up to 64 entries sorted by UTF-8 name, `complete`, and `omitted` unrepresentable names           |
| `read(path, options)`    | `{ bytes, endOfFile }` for at most 16,384 bytes at `offset`                                      |
| `write(path, bytes, …)`  | Bytes written; `mode` is `create` (default, exclusive), `truncate` or `append`; one 16 KiB chunk |
| `createDirectory(path)`  | Creates one directory; the parent must exist                                                     |
| `remove(path)`           | Removes a file, link or empty directory                                                          |
| `close()`                | Idempotent; revokes locally first, then closes the native descriptor                             |

Writes, `createDirectory` and `remove` need a `read_write` grant; the host
enforces that before any I/O. Failures are `NativeServiceError` with service
`filesystem_grants` and a code: `permission_denied`, `not_found`,
`already_exists`, `path_denied` (a link or escape), `wrong_kind`, `not_empty`,
`access_denied` (the OS refused), `limit_exceeded`, `service_unavailable`,
`native_failure` or `cancelled`. Requests run on one host worker thread and
share the eight-request service bound (a ninth concurrent call rejects locally
with `NativeStateError` `limit_exceeded`); at most 32 grants are live per
session. Closing the grant, its window or the application revokes it: later
calls reject with `cancelled` without a native request, and a result that
arrives after revocation is withheld. `window.close()` starts that revocation
immediately, so a call still in flight rejects with `cancelled` too, not with
the window's `invalid_handle`. An operation the worker has already started may still
take effect.

The [Native Linux workflow](../.github/workflows/native-linux.yml) runs
[`tests/native/filesystem-grants.ts`](../tests/native/filesystem-grants.ts) in
development and inspected AOT on an isolated display. It checks every effect
independently through `node:fs` on a private temporary tree, including a
sibling directory that must stay unchanged, and drives the private runtime to
confirm that the host rejects foreign, stale and reused grant IDs. See
[ADR 0010](decisions/0010-filesystem-grants.md). The
[Native Platforms workflow](../.github/workflows/native-platforms.yml) runs the
same test, with `mklink` links and junctions and a Windows alias check, on its
`macos-15` and `windows-2022` jobs; that hosted CI is the only macOS and
Windows evidence.

## Owned processes

`window.spawnProcess(executable, options, listener)` starts a child process
from an executable the application named in its immutable `processes` launch
permission, by ID:

```ts
const app = await createApplication({
  executable,
  permissions: {
    processes: [{ id: 'shell', executable: '/bin/sh' }],
    filesystemRoots: [{ id: 'workspace', path: '/home/me/project', access: 'read' }],
  },
})
const window = await app.openWindow({ title: 'Terminal' })
const grant = await window.openFileGrant('workspace')
const child = await window.spawnProcess(
  'shell',
  {
    args: ['-i'],
    env: { PATH: '/usr/bin:/bin', TERM: 'xterm-256color' },
    cwd: { grant, path: 'src' },
    terminal: { columns: 80, rows: 24 },
  },
  async (event) => {
    if (event.type === 'process_output') await terminalView.write(event.bytes)
    else console.log('exited', event.exit)
  }
)
await child.write(new TextEncoder().encode('ls\n'))
await child.resize({ columns: 120, rows: 40 })
await child.release()
```

Each launch entry has an ID with the same rules as a filesystem root ID (1–32
lowercase ASCII letters, digits, `-` and `_`, starting with a letter) and an
absolute normalized executable path; at most eight unique IDs are accepted and
readiness reports the same ordered list. No wire command names a program path, and there
is no command string or shell: `args` is an explicit array (at most 64 NUL-free strings
of 4,096 bytes) and `env` is the **complete** environment (at most 64 entries;
nothing is inherited from the host). Environment names are ASCII letters,
digits and `_`, not starting with a digit, of at most 128 bytes; values are
NUL-free strings of at most 4,096 bytes. Arguments, names and values together
are at most 32,768 bytes. A `cwd` without `path` is the grant's root. A working directory comes only from a live file grant of
the same window; the host resolves `path` beneath the grant descriptor with the
same descriptor-relative rules as file requests, so links are never followed.
Linux starts the child through the open descriptor's `/proc/self/fd` path; macOS
runs `fchdir` on the descriptor in the child before `exec`; Windows walks the
grant with NT handles. A path string is never the authority.

### Resource limits

A launch entry may carry `limits`, which apply to every child started from it:

```ts
processes: [{ id: 'build', executable: '/usr/bin/make', limits: { cpuSeconds: 60, openFiles: 256 } }]
```

| Limit         | Range        | Linux           | macOS           | Windows                          |
| ------------- | ------------ | --------------- | --------------- | -------------------------------- |
| `cpuSeconds`  | 1 to 604,800 | `RLIMIT_CPU`    | `RLIMIT_CPU`    | job per-process user time        |
| `memoryBytes` | 2^20 to 2^48 | `RLIMIT_AS`     | refused         | job per-process committed memory |
| `openFiles`   | 3 to 2^20    | `RLIMIT_NOFILE` | `RLIMIT_NOFILE` | refused                          |

On POSIX each limit is set in the forked child before `exec`. The CPU limit
delivers `SIGXCPU` (the exit reports `{ signal: 24 }`), and a child that
ignores it is killed one second later. An address-space or descriptor limit
makes the allocation or `open` fail inside the child. On Windows the job ends a
process that exceeds its CPU time, and an allocation past the memory limit
fails. A limit the platform cannot enforce is never ignored: `spawnProcess`
rejects with `service_unavailable`. The limits travel with the executable on
the host's private `--bun-native-process-limits=<id>:...` launch argument,
readiness reports them, and `serviceCapabilities.ptyProcess.executables`
lists them per ID.

Without `terminal`, standard input, output and error are three pipes and output
events name `stdout` or `stderr`. With `terminal: { columns, rows }` the child
runs as a session leader on its own sized pseudo-terminal, which is its
controlling terminal; output events name `terminal`, and `closeInput()` sends
the terminal's end-of-file character. Either way the child leads its own
process group.

| Method / event              | Behavior                                                                                         |
| --------------------------- | ------------------------------------------------------------------------------------------------ |
| `process_output` event      | `{ stream, bytes }`, at most 16,384 bytes, in order; the next chunk waits for this callback      |
| `process_exited` event      | `{ exit: { code } \| { signal } }`, always last, after the group is stopped and output delivered |
| `write(bytes)`              | Queues 1–16,384 bytes of input; at most 64 KiB may wait unread                                   |
| `closeInput()`              | Closes standard input, or sends end-of-file on a terminal                                        |
| `resize({ columns, rows })` | Terminal processes only (1–1,000 each); a pipes process answers `wrong_kind`                     |
| `signal(name)`              | `interrupt`, `terminate`, `kill` or `hangup` to the whole process group                          |
| `release()`                 | Idempotent; stops delivery, kills the group and reaps it                                         |

Output is credited: the host reads at most four chunks a process has delivered
but the core has not acknowledged, and the core acknowledges a chunk only after
its callback settles, so a slow consumer pauses the child instead of growing a
queue. When the direct child exits, the host stops the rest of its process
group while the exited leader still holds the group ID, delivers the remaining
output, reaps the leader and then reports the exit. A descendant that leaves
the group (`setsid`) is outside this cleanup, and that is a deliberate limit
rather than a gap to close (#305, 2026-11-06): once its leader exits, such a
process is reparented away from the owned tree, and attributing it to one
owned process again would need either a marker in the child's environment,
which changes the explicit environment policy, or a subreaper that cannot tell
one owner's orphans from another's. Applications that must stop a daemon should
signal it by its own means before releasing the process. An exited process stays
`active` until released; later `write`, `closeInput`, `signal` or `resize`
calls reject with `invalid_state`, as does `closeInput` or `write` after the
pipes input was closed. Controls share the eight-request service bound with
other service calls; a ninth concurrent call rejects locally with
`NativeStateError` `limit_exceeded`.

Failures are `NativeServiceError` with service `processes` and a code:
`permission_denied` (not in the launch policy), `not_found` (missing executable
or directory), `path_denied` (the directory crosses a link), `wrong_kind`,
`access_denied`, `limit_exceeded` (at most eight live processes per session,
more than 64 KiB of unread input, or no OS capacity), `invalid_state`, `service_unavailable`, `native_failure` or `cancelled`.
Releasing the process, closing its window or stopping the application kills
and reaps its group; no later output or exit is delivered. Like every
application callback, a process listener that throws or rejects ends the
application with that error. So does a delivery acknowledgement the host
refuses for any reason other than `invalid_handle` (a released process or
closed window): the stream could not continue without its credit. The optional
`processes_v1` feature is advertised on Linux with pidfd support, on macOS
and on Windows; the frozen `ptyProcess` capability record lists the
executables by ID with `backend: 'posix'`, or `backend: 'windows_job'` on
Windows, and other targets report `unavailable` / `unsupported_platform`.

The [Native Linux workflow](../.github/workflows/native-linux.yml) runs
[`tests/native/processes.ts`](../tests/native/processes.ts) in development and
inspected AOT on an isolated display with real `/bin/sh` children. It checks
outputs, exit statuses and the working directory independently, confirms
through `/proc` that descendants stop with their group on exit, release, owner
close and shutdown, and drives the private runtime to confirm that the host
rejects foreign, stale and reused process IDs. See
[ADR 0011](decisions/0011-owned-processes.md).

The macOS backend (a pipe wake and a `waitid(WNOWAIT)` exit watcher in place of
eventfd and pidfd; the same process groups and `pty-process` terminals) runs the
host unit tests and the same native test in development and AOT in the
[Native Platforms](../.github/workflows/native-platforms.yml) macOS 15 job,
checking groups through `ps`. It is compile-checked locally only; macOS
behavior is claimed from that CI job.

The Windows backend runs each child inside its own job object with
`KILL_ON_JOB_CLOSE`, with exactly its pipe ends inherited or on a ConPTY
pseudo-console (Windows 10 1809 or later). Launch paths may be Windows drive
paths. The granted executable is held open while it starts and must be its
own canonical final path. The command line is the exact inverse of
`CommandLineToArgvW` with no shell, and the environment holds only the given
variables. `terminate` and `kill` end the whole job and report that signal.
`interrupt` types ^C into a terminal, and into a pipe child's hidden console
through a short-lived helper (the host binary started as the interrupt helper,
so the host never attaches to a child's console); `hangup` has no Windows
equivalent and is refused with `service_unavailable`. A grant working directory is walked with the Windows
grant rules and held open while the child starts there. The host unit tests
and the same native test, with real `cmd.exe` children, run in development and
AOT in the Native Platforms `windows-2022` job. It is type-checked locally
only; Windows behavior is claimed from that CI job. See
[ADR 0011](decisions/0011-owned-processes.md).

## File dialogs

```ts
const app = await createApplication({
  executable,
  permissions: { fileDialogs: "allow" },
});
const window = await app.openWindow({ title: "Editor" });
const opened = await window.showOpenDialog({
  title: "Open a document",
  select: "file", // 'files' for several, 'directory' for a folder
  filters: [{ name: "Text", patterns: ["*.txt", "*.md"] }],
});
if (opened.kind === "selected") console.log(opened.paths); // data, not a grant
const saved = await window.showSaveDialog({
  title: "Save as",
  name: "notes.txt",
});
```

`showOpenDialog` and `showSaveDialog` show the operating system's file
chooser, owned by the window, under the separate `fileDialogs` grant. The
optional `file_dialogs_v1` feature is advertised on Linux when a D-Bus session
bus is configured; the host talks to `org.freedesktop.portal.FileChooser`
(xdg-desktop-portal) on that bus. A bus without a portal, or a portal without
a file chooser backend, rejects with `service_unavailable` when a dialog is
shown. Every bus call is bounded to two seconds; waiting for the user is not.

Options are bounded and validated by both language implementations: a
one-line `title` of at most 256 UTF-8 bytes, an optional `acceptLabel` of at
most 64, an optional absolute POSIX starting `folder` of at most 4,096 bytes
(a hint), an optional save `name` that is one path component of at most 255
bytes, and at most 16 `filters`, each a one-line name of at most 128 bytes
with 1-16 glob patterns of at most 64 bytes. A folder dialog takes no
filters. Invalid options reject with a `TypeError` and show nothing.

The result is frozen: `{ kind: 'selected', paths }` from an open dialog,
`{ kind: 'selected', path }` from a save dialog, or `{ kind: 'cancelled' }`
when the user dismisses it (Cancel, Escape or the window manager's close
button). **Paths are data, not authority.** A selection attaches no handle and
grants nothing through Bun Native; a save selection does not create or write
the file. A chosen path cannot become a scoped filesystem grant: grants open
only on launch-policy roots (see [filesystem grants](#filesystem-grants)), and
converting a user selection into one
([#304](https://github.com/0xPlayerOne/bun-native/issues/304)) would be a
separate, explicit operation. Non-local URIs, NUL bytes and non-UTF-8 names fail the
whole selection with `native_failure`; more than 256 paths, or a result that
would not fit one frame, fails with `payload_too_large`. No partial selection
is returned.

A window owns at most one file dialog and a session at most 16
(`limit_exceeded` otherwise). The OS
dialog is parented to the owner's X11 window. Aborting the request's
`signal` before dispatch sends nothing; after the dialog is shown it rejects
with `cancelled` immediately and closes the OS dialog through the portal.
Owner close rejects with `NativeStateError` `invalid_handle` and shutdown
rejects pending dialogs; both close the OS dialog. Only a portal response from
the bus connection that answered the request is accepted, so another bus
client cannot forge a selection.

The [Native Linux workflow](../.github/workflows/native-linux.yml) runs
[`tests/native/file-dialogs.ts`](../tests/native/file-dialogs.ts) in
development and inspected AOT on an isolated Xvfb with openbox and its own
D-Bus session, against xdg-desktop-portal with the GTK backend. It requires
default denial with no dialog, `service_unavailable` on a bus without a portal,
a real GTK dialog transient for the owner window with the requested title,
folder, filter and accept label, forged `Response` signals ignored, real
keyboard selection of one file, several files and a folder, a save selection
that creates no file, Escape cancellation, and the OS dialog closed after an
aborted signal, owner close and shutdown. On Wayland the same portal dialog
opens unparented (no xdg-foreign handle is exported) and closes on abort and
on a compositor close; selection through it was not run there
([Wayland](#wayland)). Flatpak/Snap document-portal paths, other portal
backends, macOS and Windows are not qualified. Message and confirm dialogs are not OS alerts; they are drawn on
the modal overlay, [below](#message-and-confirm-dialogs). See
[ADR 0013](decisions/0013-native-file-dialogs.md).

## Message and confirm dialogs

```ts
const choice = await window.showMessageDialog(
  {
    title: "Unsaved changes",
    message: "Save the document before closing?",
    detail: "Unsaved edits are lost.",
    buttons: [
      { id: "save", label: "Save", kind: "primary" },
      { id: "discard", label: "Discard", kind: "destructive" },
      { id: "cancel", label: "Cancel" },
    ],
    cancelButton: "cancel", // Escape activates it
  },
  { signal },
);
if (choice.kind === "button" && choice.id === "save") await save();
const remove = await window.showConfirmDialog({
  title: "Delete file",
  message: "Delete report.txt?",
  confirmLabel: "Delete",
  destructive: true, // red confirm button, Cancel focused by default
});
```

`showMessageDialog` and `showConfirmDialog` draw a dialog in the window with
public core's own [modal overlay](native-overlays.md), on every platform. They
need no launch grant: the dialog is ordinary UI in the application's own
window. `serviceCapabilities.messageDialogs` is `available` with backend
`modal_overlay` when the host advertises `overlays_v1` and `focus_v1` (the
current GPUI host always does); otherwise it reports
`unsupported_host` and a call rejects with `service_unavailable` before
anything is staged.

One batch appends a window-anchored modal layer to the window root with a
fixed panel (title, message, optional detail, right-aligned buttons) in the
`defaultTheme` colors and sizes, at most 420 logical pixels wide, and focuses
the default button (the first one unless `defaultButton` names another). The
overlay traps Tab and Shift-Tab inside it and blocks pointer input beneath it.
Options are validated before staging: a one-line `title` of at most 256 UTF-8
bytes, a `message` of at most 2,048 and an optional `detail` of at most 4,096
(both may contain line feeds), 1-4 buttons with unique `id`s of at most 64
bytes and one-line labels of at most 64 bytes, optional `kind`
(`normal`, `primary`, `destructive`), and `defaultButton`/`cancelButton` that
name a button. Unknown options are rejected.

The result is frozen: `{ kind: 'button', id }`, or `{ kind: 'dismissed' }`
from a `dismissible: true` dialog. A click, or Enter/Space on the focused
button, chooses that button. An unmodified Escape activates `cancelButton`;
without one it dismisses a `dismissible` dialog and is otherwise ignored. A
press on the backdrop dismisses only a `dismissible` dialog.
`showConfirmDialog` shows Cancel then OK (labels configurable), Escape
cancels, and it resolves `true` only for OK. The promise settles after the
layer has been removed, so focus has already returned to the control focused
before the dialog opened.

Input routed through a dialog's layer is handled by core as it arrives and is
not delivered to application listeners, including root capture listeners.
Because of that, a listener may await a dialog (callbacks otherwise run one at
a time) without blocking the dialog's own buttons.

A window shows one message dialog at a time: later calls wait unseen and open
in call order once the previous layer is removed, at most 8 per window
(`limit_exceeded`). An aborted `signal` before the call stages nothing; a
queued dialog is rejected with `cancelled` at once and never shown; an
opening or shown dialog is removed and then rejected with `cancelled`.
Closing the owner window or shutting down rejects every shown and queued
dialog of that window with `NativeStateError` `invalid_handle`. A layer batch
that fails, for example under a deeper application modal where the focus
request is outside the active modal (`invalid_state`), rejects that call and
the next queued dialog is tried.

Solid and React components call the same methods on the window they render
into; there is no adapter-specific helper. See
[ADR 0014](decisions/0014-message-dialogs.md).

### OS message dialogs (Windows task dialogs, macOS alert sheets)

On Windows and macOS, `permissions: { taskDialogs: 'allow' }` asks for an OS
dialog instead of the overlay. Core uses it when the host advertises the
optional `task_dialogs_v1` capability, and
`serviceCapabilities.messageDialogs.backend` then reads `'task_dialog'`
(Windows) or `'alert_sheet'` (macOS); without the grant or the capability the
overlay is used and nothing else changes. The public options, validation,
queueing, abort, owner-close and result shape are the same. See
[ADR 0018](decisions/0018-windows-task-dialogs.md) and
[ADR 0019](decisions/0019-macos-alert-sheets.md).

On Windows:

- The host shows each dialog with `TaskDialogIndirect` on a dedicated thread,
  parented to the window's `HWND`; the OS disables the owner while it is open
  and GPUI's UI thread never enters the dialog's message loop.
- `title` is the window title, `message` the main instruction and `detail` the
  content. Button `kind` has no OS equivalent and is ignored. Escape and the
  close box end the dialog only when it has a `cancelButton` (that button is
  the result) or is `dismissible`; otherwise they do nothing.
- Abort, owner close and shutdown end the dialog by posting `TDM_CLICK_BUTTON`
  to it; a result that races the close is dropped.
- `TaskDialogIndirect` is in Common Controls 6, which the manifest GPUI embeds
  in the host already requests. The entry point is resolved at run time, so a
  host without it reports the capability absent instead of failing to start.
- Evidence is hosted only: [`task-dialogs.ts`](../tests/native/task-dialogs.ts)
  reads and presses the real dialog through a UI Automation oracle. Nothing
  has been run on a physical Windows desktop.

On macOS:

- The host attaches an `NSAlert` sheet to the owner window
  (`beginSheetModalForWindow:completionHandler:`) on GPUI's main thread. A
  sheet runs no nested event loop: other windows, commands and timers keep
  running, and only the owner window is blocked.
- A sheet has no title bar, so `title` is the alert's bold message text and
  `message` and `detail` are its informative text, a blank line apart. Button
  `kind` is ignored. AppKit places the first button rightmost.
- Return presses `defaultButton` and Escape presses `cancelButton`. AppKit's
  own key assignments (Return to the first button, Escape to a button titled
  Cancel, Command-D to Don't Save) are replaced. Each button owns one key, so
  when `cancelButton` is also `defaultButton` Escape does nothing. A sheet has
  no close box, so a `dismissible` dialog without a `cancelButton` cannot be
  dismissed from the keyboard and only its buttons end it.
- Abort, owner close and shutdown end the sheet with
  `endSheet:returnCode:` (`NSModalResponseAbort`); the application hears no
  button for it.
- Evidence is hosted only: the same [`task-dialogs.ts`](../tests/native/task-dialogs.ts)
  reads the sheet, presses its buttons and types real Return and Escape keys
  through an independent Accessibility oracle
  ([`macos-alert-oracle.m`](../tests/native/macos-alert-oracle.m)) on the
  hosted `macos-15` runner. Nothing has been run on a physical Mac.

The [Native Linux workflow](../.github/workflows/native-linux.yml) runs
[`tests/native/message-dialogs.ts`](../tests/native/message-dialogs.ts) in
development and inspected AOT. It uses only public core, real XTest input and
nonce-tagged native paint evidence (focus and geometry):

```sh
export BUN_NATIVE_HOST="$PWD/target/release/bun-native-host"
for mode in development aot; do
  command=(bun tests/native/message-dialogs.ts)
  if [[ "$mode" == aot ]]; then
    bun experiments/aot-gpui/build-window.ts --entry message-dialogs --host "$BUN_NATIVE_HOST" \
      --host-profile release --outdir "$PWD/.bun-native/message-dialogs-package"
    command=("$PWD/.bun-native/message-dialogs-package/message-dialogs")
  fi
  evidence="$PWD/.bun-native/message-dialogs-$mode"; mkdir -p "$evidence"
  BUN_NATIVE_MESSAGE_DIALOG_EVIDENCE="$evidence" BUN_NATIVE_MESSAGE_DIALOG_MODE="$mode" \
    BUN_NATIVE_EVIDENCE_LOG="$evidence/native-evidence.jsonl" \
    BUN_NATIVE_EVIDENCE_NONCE="$(python3 -c 'import secrets; print(secrets.token_hex(16))')" \
    xvfb-run --auto-servernum --server-args='-screen 0 1280x800x24 -nolisten tcp' \
    dbus-run-session -- bash scripts/quality/native-linux-session.sh "$evidence-session" -- "${command[@]}"
done
```

Locally both modes passed on Linux X11 (Xvfb 1280×800 + openbox, XTest via
xdotool, Mesa lavapipe, scale 1) with a release host; the AOT manifest
recorded the JIT as unused. Observed in one run:

| Outcome                  | Observed                                                                                                                                                                                 |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Default focus and paint  | Opening moved native focus to `Save`; screenshot pixels showed the panel surface `ffffff` and the primary button accent `2255cc`.                                                        |
| Tab trap                 | Tab, Tab, Tab, Shift-Tab focused `Discard, Cancel, Save, Cancel`; the editor beneath was never reached.                                                                                  |
| Covered control          | A real click on the covered `Delete file` button produced no application click.                                                                                                          |
| Click                    | A real click on `Discard` resolved `{ kind: 'button', id: 'discard' }`; no application listener saw it, and focus returned to the editor.                                                |
| Enter, Escape, Space     | Enter resolved the default `save`; Escape resolved `cancel`; without a cancel button Escape left the dialog open and Space on the focused button chose it.                               |
| Backdrop                 | A real press outside the panel resolved `{ kind: 'dismissed' }` for a `dismissible` dialog.                                                                                              |
| Awaiting listener        | A real click on `Delete file` whose listener awaited a destructive `showConfirmDialog` opened it focused on `Keep`; a real click on `Delete` resolved `true`.                            |
| Queue                    | The second dialog stayed unrendered until the first was answered, then opened focused on `OK`.                                                                                           |
| Abort                    | Aborting removed the shown dialog, rejected with `cancelled`, returned focus to the editor, and typing continued (`note` → `note!`).                                                     |
| Owner close and shutdown | Closing the window rejected a shown and a queued dialog with `invalid_handle`; shutdown rejected a dialog in another window the same way. All seven ownership counters returned to zero. |

Only Linux X11 at scale 1 with software rendering is exercised. macOS and
Windows run the same core code over the same overlay host code, unqualified.
The dialog exposes no accessibility role or announcement, is modal only within
its window, and is not an OS alert (no system sound or title-bar sheet).

## Drag and drop

`window.registerDropTarget(node, listener)` makes a committed node an owned
drop target for local files. It needs the separate `dragDrop: 'allow'`
permission. Solid and React export `registerDropTarget(ref, listener)` for a
mounted element; it calls the same window method.

```ts
const app = await createApplication({
  executable,
  permissions: {
    dragDrop: 'allow',
    filesystemRoots: [{ id: 'workspace', path: '/home/me/project', access: 'read' }],
  },
})
const window = await app.openWindow({ title: 'Drop files' })
const target = await window.registerDropTarget(zone, async (event) => {
  if (event.type !== 'drop') return
  for (const item of event.items) {
    const { root, path } = await item.resolve('workspace') // path_denied if outside
    const grant = await window.openFileGrant(root)
    console.log(item.name, (await grant.stat(path)).size)
    await grant.close()
  }
})
```

Listeners receive frozen `drag_entered`, `drag_left`, `drop` and
`drop_rejected` events. Each has a `sequence`, the `target` handle and an
`AbortSignal`. A `drop` carries 1 to 64 items. Each item has only an untrusted
display `name` (the final path component, lossily decoded, with control
characters replaced, at most 255 bytes) and `resolve(root)`. Dropped paths
never reach the application. `resolve` asks the host to match the path it
retained for that drop beneath a launch root. It returns `{ root, path }` with
a relative path, and file access still goes through `openFileGrant` and its
confinement (`openat2` on Linux, the `openat` walk on macOS). A drop grants no
authority.

`drop_rejected` reports `empty` (plain text or no files, on X11) or
`limit_exceeded` (more than 64 items or, on X11 only, a URI list long enough
that GPUI's 4,096-byte read may have truncated it). A drop outside every
target produces no event.

The capability's `backend` is `x11`, `appkit` or `ole`. On macOS and Windows a
drag that carries no files never reaches a target: GPUI's AppKit and OLE
destinations start no drag for it, and the button release they still
synthesize for its drop is not reported as a `pointer_up`. A launch root
matches a dropped path by lexical prefix in the host's own path syntax, so a
POSIX root never matches a Windows drop (`path_denied`); only a Windows drive
root can. On the hosted windows-2022 runner the core drag fixture
(`tests/native/drag-drop.ts`) declares drive-path launch roots and resolves the
dropped items through them; the Solid and React drag fixtures still declare no
roots. macOS has filesystem grants, so there the fixture reads a resolved item
through a real `openFileGrant`, as on Linux. See [ADR 0012](decisions/0012-native-drag-drop.md) for
each backend's delivery quirks.
Failures are `NativeServiceError` with service `drag_drop`:
`permission_denied` (no `dragDrop` grant, or a root not in the launch policy),
`service_unavailable`, `conflict` (the node already has a target),
`limit_exceeded` (32 live targets), `path_denied`, `not_found` (no item at
that index) and `cancelled`. `resolve` rejects a malformed root ID (1-32
lowercase ASCII letters, digits, `-` or `_`, starting with a letter; never a
path) with a `TypeError` and sends nothing.

`close()` is idempotent and revokes locally first. Removing the node, closing
the window or stopping the application does the same. The handle becomes
inactive, its signal aborts, later host events are discarded and older items
reject with `cancelled` without a native request. A newer drop or rejection on
the same target also retires the previous drop's items.

Hover follows the target's painted bounds, so nested targets can both report
`drag_entered`. A drop goes to the innermost live target under the pointer,
or to the nearest live ancestor when the frame still shows a removed element.
Pointer down and up events are not delivered while a drag is active, so a
drop is never a click.

The pinned GPUI X11 backend always answers the drag source with accept and
copy, so a source may report a copy for a drop the application rejected or
ignored. If the window under a drag closes before the drop, the next drag on
that X connection is not converted until its source leaves. The
`drag_drop_files_v1` capability is advertised on Linux when GPUI's compositor
is X11, and always on macOS and Windows. Wayland reports `unavailable` /
`unsupported_platform`. The macOS and Windows paths run only in the hosted
Native Platforms job, with an `NSDraggingSession` or `DoDragDrop` source
process, and have no retained evidence record. See
[ADR 0012](decisions/0012-native-drag-drop.md).

The [Native Linux workflow](../.github/workflows/native-linux.yml) runs
[`tests/native/drag-drop.ts`](../tests/native/drag-drop.ts) and the Solid and
React fixtures in development and inspected AOT on an isolated display. An
independent x11rb XDND source process grabs and warps the real pointer and
speaks XDND to the host. No GPUI event is synthesized.

## Wayland

GPUI selects its Wayland backend whenever `WAYLAND_DISPLAY` is set. Each
service picks its backend from the live GPUI session when the host starts, and
advertises a capability only for a backend it implements:

| Service                                     | Backend under Wayland                         | Reported                                                                                             |
| ------------------------------------------- | --------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Clipboard text, global shortcuts, drag/drop | X11 selections, X11 key grabs, GPUI XDND only | `unavailable` / `unsupported_platform`; clipboard and shortcut requests reject `service_unavailable` |
| Popup windows (`surface: 'window'`)         | X11 override-redirect only                    | `popup_windows_v1` absent; core throws `UnsupportedFeatureError`                                     |
| Notifications                               | Freedesktop D-Bus, display-independent        | `available`                                                                                          |
| File dialogs                                | xdg-desktop-portal, unparented                | `available`                                                                                          |
| Display snapshot                            | GPUI's Wayland output                         | `available`; no details or change events                                                             |
| Filesystem grants, processes                | Display-independent                           | `available` (not run under Wayland)                                                                  |

[`tests/native/wayland.ts`](../tests/native/wayland.ts) checks this matrix on
headless sway in development and inspected AOT, together with the window,
input, paint and close behavior described in
[native platforms](native-platforms.md#linux-wayland). Clipboard, shortcut,
drag-and-drop and popup backends for Wayland, and dialog parenting through
xdg-foreign, are planned in [ADR 0017](decisions/0017-wayland.md); GNOME and
KDE compositors are not qualified.

## Application menu bar

```ts
const app = await createApplication({
  executable,
  permissions: { appMenu: "allow" },
});
if (app.serviceCapabilities.appMenu.availability === "available") {
  const bar = await app.setMenuBar(
    [
      {
        title: "Notes", // shown under the process name on macOS
        items: [
          { kind: "item", id: "app.quit", label: "Quit Notes", shortcut: { key: "q", platform: true } },
        ],
      },
      {
        title: "File",
        items: [
          { kind: "item", id: "file.open", label: "Open…", shortcut: { key: "o", platform: true } },
          { kind: "separator" },
          { kind: "submenu", label: "Recent", items: [{ kind: "item", id: "recent.1", label: "notes.txt" }] },
          { kind: "item", id: "file.export", label: "Export", enabled: false },
        ],
      },
    ],
    async (event) => {
      if (event.itemId === "app.quit") await app.shutdown();
    },
  );
  await bar.clear(); // or app.clearMenuBar(), or set another bar
}
```

`setMenuBar` installs the application's menu bar under the separate
`appMenu` grant. It belongs to the application, not to a window: closing a
window leaves it installed. The optional `app_menu_v1` capability is
advertised on macOS only, where GPUI installs an `NSMenu` main menu; GPUI's
Linux and Windows backends only store menus, so `serviceCapabilities.appMenu`
reports `unsupported_platform` there and core rejects with
`NativeServiceError` `service_unavailable` (or `permission_denied` without
the grant) before any request.

The model is closed and bounded, validated by both language implementations:
at most 16 menus and 128 entries in all, submenus at most two levels below a
top-level menu, titles and labels of 1-64 UTF-8 bytes without control
characters, item `id`s of 1-64 bytes of `A-Z a-z 0-9 . _ : -` unique in the
bar, and shortcuts from a closed key set (`a`-`z`, `0`-`9`, `f1`-`f12`,
``, . / ; ' [ ] - = ` \`` and `enter`, `escape`, `tab`, `space`, `backspace`,
`delete`, the arrows, `home`, `end`, `pageup`, `pagedown`) with explicit
`control`, `alt`, `shift` and `platform` (Command) flags. Every key except
`f1`-`f12` needs control, alt or platform, and shortcuts are unique in the
bar. `enabled` defaults to true and `checked` to false; both are fixed per
bar, so changing them means setting a new bar.

Selecting an item calls the listener with a frozen `app_menu_item` event:
the item's `itemId`, the `menuBar` handle and a `signal` aborted when the bar
is replaced, cleared or the application stops. No application string becomes
a native action name: the host gives each item an opaque registry slot of the
current bar. Setting or clearing a bar revokes the previous handle at once;
a selection of a replaced bar, even one AppKit queued before the replacement,
is never delivered. Shutdown removes the bar.

On macOS the first menu is shown under the process name. A menu titled
exactly `Window` becomes AppKit's Windows menu, to which AppKit appends its
window list. The host adds no standard items (About, Services, Hide, Quit):
an application that wants Quit adds it, as above. Menu shortcuts are bound in
the owned window's root key context, so a focused text input keeps its own
editing keys. A disabled submenu still opens, with every item disabled.

The macOS job of the [native platforms workflow](../.github/workflows/native-platforms.yml)
runs [`tests/native/app-menu.ts`](../tests/native/app-menu.ts) in development
and inspected AOT. An independent Accessibility oracle
([`macos-menu-oracle.m`](../tests/native/macos-menu-oracle.m)) reads the
host's `AXMenuBar` and performs `AXPress` by title: it checks titles,
separators, check marks, enabled state and key equivalents, selections of the
current bar, that a replaced bar is gone and delivers nothing, that a
disabled item never reports, and that clearing removes the menus. When the
runner does not trust the oracle for Accessibility the report is
`unverified` and the step warns. This is hosted-CI evidence only; no local
Mac run, keyboard-driven selection or VoiceOver check has been made. See
[ADR 0015](decisions/0015-application-menu-bar.md).

## OS context menus

```ts
if (app.serviceCapabilities.contextMenus.availability === "available") {
  const chosen = await window.showContextMenu(
    [
      { kind: "item", id: "edit.copy", label: "Copy", shortcut: { key: "c", platform: true } },
      { kind: "separator" },
      { kind: "submenu", label: "Share", items: [{ kind: "item", id: "share.mail", label: "Mail" }] },
      { kind: "item", id: "view.wrap", label: "Word Wrap", checked: true },
    ],
    { x: event.x, y: event.y }, // logical pixels of the window's content
    { signal }, // optional: abort closes the menu
  );
  if (chosen === "edit.copy") copy();
}
```

`showContextMenu` opens the platform's own pop-up menu at a point of the
window and resolves the chosen item's `id`, or `null` when the user
dismissed it. It needs no grant: the menu is user-initiated UI on the
application's own window. The host advertises the optional
`context_menus_v1` capability on macOS (`NSMenu`, `backend: 'appkit'`) and
Windows (`TrackPopupMenuEx`, `backend: 'win32'`); on Linux
`serviceCapabilities.contextMenus` reports `unsupported_platform` and the
call rejects with `UnsupportedFeatureError` before any request.

Items use the [menu bar](#application-menu-bar) model and limits, with ids
unique within the menu. Shortcuts are shown beside the item (as a key
equivalent on macOS, a right-aligned hint such as `Ctrl+C` on Windows) and
bind nothing. Only one menu is live per application; a second call while one
is open rejects with `NativeServiceError` `limit_exceeded`. An abort closes
the menu and rejects with `cancelled`; closing the owner window rejects with
`NativeStateError` `invalid_handle`; shutdown closes it. A menu that was
closed never reports a late choice.

The macOS and Windows jobs of the
[native platforms workflow](../.github/workflows/native-platforms.yml) run
[`tests/native/context-menus.ts`](../tests/native/context-menus.ts) against
independent accessibility oracles that read the open menu and press its
items: the shown items, a top-level and a nested choice, Escape, abort, owner
close and shutdown. This is hosted-CI evidence only. See
[ADR 0020](decisions/0020-os-context-menus.md).

## Service and platform matrix

All services listed here share the core's policy boundary. The unavailable rows
are requirements for future work, not promises that an exported function
already exists. The linked follow-ups belong to
[#255](https://github.com/0xPlayerOne/bun-native/issues/255).

| Service           | Current public surface                                        | Linux X11                                                                                           | Linux Wayland                                                      | macOS                                                           | Windows                                                      | Required scope before exposing more operations                                                                                                                                                                                                                                           |
| ----------------- | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | --------------------------------------------------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Window/display    | Existing owned open/close; permission-gated `displaySnapshot` | Core/Solid/React dev+AOT verified with release host; X11 semantics fixture dev+AOT verified locally | Snapshot dev+AOT verified on headless sway (scale 1 and 2)         | Service execution unverified                                    | Service execution unverified                                 | X11 semantics qualified; change events, work area, identity and mixed DPI unavailable on X11. Other platforms and placement remain. [#299](https://github.com/0xPlayerOne/bun-native/issues/299).                                                                                        |
| Clipboard text    | `readClipboardText` / `writeClipboardText`; separate grants   | X11 dev+AOT verified with release host                                                              | Unavailable (`unsupported_platform`)                               | Unavailable                                                     | Unavailable                                                  | Additional platforms/formats and extended lifecycle coverage. [#300](https://github.com/0xPlayerOne/bun-native/issues/300).                                                                                                                                                              |
| Global shortcuts  | `registerGlobalShortcut`; `globalShortcuts` grant             | X11 dev+AOT verified with release host                                                              | Unavailable (`unsupported_platform`)                               | Unavailable                                                     | Unavailable                                                  | macOS/Windows backends, Wayland portal design and keyboard-map change tracking. [#301](https://github.com/0xPlayerOne/bun-native/issues/301).                                                                                                                                            |
| Application menu  | `setMenuBar` / `clearMenuBar`; `appMenu` grant                | Unavailable (GPUI stores menus only)                                                                | Unavailable (GPUI stores menus only)                               | AppKit `NSMenu` bar; hosted CI only (AX oracle)                 | Unavailable                                                  | Dock menus, dynamic validation, Linux/Windows menu bars drawn by the application. [#239](https://github.com/0xPlayerOne/bun-native/issues/239).                                                                                                                                          |
| Context menus     | `window.showContextMenu`; no grant                            | Unavailable                                                                                         | Unavailable                                                        | AppKit `NSMenu` pop-up; hosted CI only (AX oracle)              | `TrackPopupMenuEx`; hosted CI only (UIA oracle)              | Dock menu, dynamic validation, icons, element-relative positioning. [#239](https://github.com/0xPlayerOne/bun-native/issues/239).                                                                                                                                                        |
| File dialogs      | `showOpenDialog` / `showSaveDialog`; `fileDialogs` grant      | xdg-desktop-portal (GTK) dev+AOT verified                                                           | Portal (GTK) opens unparented; abort and compositor close verified | Unavailable                                                     | Unavailable                                                  | macOS/Windows panels, Wayland parenting, sandboxed document-portal paths and explicit file-grant conversion. [#239](https://github.com/0xPlayerOne/bun-native/issues/239).                                                                                                               |
| Message dialogs   | `showMessageDialog` / `showConfirmDialog`; no grant           | Modal overlay dev+AOT verified locally                                                              | Modal overlay (same core code); unqualified on Wayland             | Modal overlay, or opt-in `NSAlert` sheet (hosted CI, AX oracle) | Modal overlay, or opt-in task dialog (hosted CI, UIA oracle) | Opt-in `taskDialogs` backends: `NSAlert` sheets (macOS) and task dialogs (Windows), hosted evidence only. [#239](https://github.com/0xPlayerOne/bun-native/issues/239).                                                                                                                  |
| Notifications     | `postNotification`; `notifications` grant                     | Freedesktop D-Bus (dunst) dev+AOT verified                                                          | Freedesktop (dunst) post and withdraw verified                     | Unavailable                                                     | Unavailable                                                  | macOS/Windows backends, additional notification servers, named actions and replacement. [#302](https://github.com/0xPlayerOne/bun-native/issues/302).                                                                                                                                    |
| Drag/drop         | `registerDropTarget`; `dragDrop` grant                        | XDND dev+AOT verified locally (core/Solid/React)                                                    | Unavailable (`unsupported_platform`)                               | AppKit; hosted CI only (NSDraggingSession source)               | OLE; hosted CI only (DoDragDrop source)                      | Other payload kinds and file promises, refusal (GPUI always accepts), Wayland, physical devices and real file managers, Windows resolution in the Solid/React fixtures (core resolves drive roots on hosted windows-2022). [#303](https://github.com/0xPlayerOne/bun-native/issues/303). |
| Filesystem grants | `openFileGrant`; `filesystemRoots` launch roots               | openat2 dev+AOT verified locally                                                                    | Advertised; display-independent, not run on Wayland                | `openat` walk; CI-only                                          | `NtCreateFile` walk; CI-only                                 | OS file selection and dropped files as explicit user grants. [#304](https://github.com/0xPlayerOne/bun-native/issues/304).                                                                                                                                                               |
| PTY/process       | `spawnProcess`; `processes` launch executables                | Pipes and PTY dev+AOT verified locally                                                              | Advertised; display-independent, not run on Wayland                | Dev+AOT in CI only; `cwd` through `fchdir`                      | Job object and ConPTY; CI-only                               | Descendants that leave the group (POSIX), `hangup` on Windows, resource limits. [#305](https://github.com/0xPlayerOne/bun-native/issues/305).                                                                                                                                            |

For the deferred rows, the exported typed contract is the frozen availability
record in `ServiceCapabilities`. There is no callable operation, configurable
grant or promised invocation result for those services yet. Their matrix
requirements and linked issues define the work needed before exposing an
invocation API. An unavailable capability must not be replaced with a fake
success, an adapter-specific OS implementation or a browser fallback.

The Adea port [#250](https://github.com/0xPlayerOne/bun-native/issues/250) must
gate terminal/file features on these explicit statuses.
[Filesystem grants #304](https://github.com/0xPlayerOne/bun-native/issues/304)
and [PTY/process #305](https://github.com/0xPlayerOne/bun-native/issues/305)
define the implementation path: the process service accepts validated
executable IDs, argument arrays and scoped file handles;
displayed terminal text, model output or a dropped pathname must never create
authority by itself. An application choosing ordinary Bun process/filesystem
APIs uses its own trusted authority and must not describe that as a native
service grant or a sandbox supplied by this framework.

## Foundation acceptance and remaining scope

[Desktop-service foundation #255](https://github.com/0xPlayerOne/bun-native/issues/255)
permits one real minimal slice plus explicit deferrals. The owned display read
provides that slice: a typed public result, default-deny native launch policy,
request/window identity validation, typed denial/unavailability, cancellation
delivery rules and joined teardown. The core and both framework fixtures use
the same public window method and native implementation.

The hosted record above contains six passed cases: core, Solid and React,
each under development Bun and inspected AOT. An XTest click triggers the
real GPUI display read, its result matches independent `xdpyinfo` geometry,
and a complete six-node native paint changes from `Display ready` to
`Display: 1280x800 @1`. Each case then OS-closes, exits without forced cleanup,
and reports all seven application ownership counters at zero. The two core
cases also require native denial, queued cancellation, native unknown/stale
owner rejection, shutdown before dispatch and public stale-handle rejection.
Both framework cases in each mode require exactly one owner disposal and zero
renderer nodes/listeners with no pending commit.

This is finite evidence for the shared contract and chosen slice. The AOT
manifests verify a compiled program and unused JIT; the input driver itself
does not certify compilation. The original archive excludes the application
and host binaries, so its recorded binary hashes cannot be independently
recomputed from that archive. It does not establish physical input, hardware
rendering, presentation timing, broad platform support or long-term leak
freedom. [Display follow-up #299](https://github.com/0xPlayerOne/bun-native/issues/299),
the separate [clipboard acceptance #300](https://github.com/0xPlayerOne/bun-native/issues/300),
[first-open failure #296](https://github.com/0xPlayerOne/bun-native/issues/296),
[stress-close failure #358](https://github.com/0xPlayerOne/bun-native/issues/358)
and the other deferred-service tickets remain independent work.

## Why the first slice is display information

Display reads give a small real operation with native ownership, explicit
denial, cancellation delivery and teardown, without changing user data. The
clipboard worker now supplies a separate native implementation for bounded
selection transfers; [ADR 0007](decisions/0007-native-clipboard.md) records its
explicit scope and verification requirements.

At the exact GPUI pin, the default
[`read_from_clipboard_async`](https://github.com/zed-industries/zed/blob/ba63a022c9a22ca66d68ef2a8f0bb9b5b0a9984d/crates/gpui/src/platform.rs#L586-L599)
wraps the synchronous call. The X11 implementation synchronously fetches a
foreign selection, with an initial four-second wait and incremental-transfer
waits that can reset. Its write method returns no operation result and logs
selection-write errors. Calling this from a service handler and reporting a
successful cancellable write would overstate what was observed. See the
pinned [X11 client](https://github.com/zed-industries/zed/blob/ba63a022c9a22ca66d68ef2a8f0bb9b5b0a9984d/crates/gpui_linux/src/linux/x11/client.rs#L1841-L1879)
and [clipboard transfer loop](https://github.com/zed-industries/zed/blob/ba63a022c9a22ca66d68ef2a8f0bb9b5b0a9984d/crates/gpui_linux/src/linux/x11/clipboard.rs#L396-L450).
The clipboard worker uses the pinned native X11 protocol library to solve
these transfer/result limits. It does not substitute a browser or cached
content for a native operation.

Native editor copy/paste caused by user keyboard actions remains a distinct
interaction from a programmatic clipboard service. The service fixture never
reads or overwrites the owner's clipboard.

## Reproduction and evidence boundaries

`tests/fixtures/native-services.json` is consumed by the TypeScript and Rust
parsers. `tests/core/services.test.ts` starts a real Bun subprocess peer for
denial, cancellation before/after submission, shutdown, stale ownership,
missing readiness and wrong-owner responses. Those deterministic responses
are explicitly headless and do not prove GPUI behavior.

`tests/native/services.ts` uses the actual prebuilt host. Its Linux session
mode opens default-denied and allowed applications, checks native unknown and
stale owners, cancels queued reads, checks shutdown, then requires an actual
OS button activation and complete native paint of the returned display
dimensions. The driver compares them with independent `xdpyinfo` dimensions
in its owned scale-1 Xvfb session. It OS-closes the final window and requires
zero public ownership counters plus joined native termination. The inspected
`--entry services` executable exercises the same source in AOT mode. Neither
compilation nor the deterministic peer counts as this native acceptance.

`tests/native/solid-services.tsx` and `tests/native/react-services.tsx` mount the
same display button and label through their respective adapters. Both call
the public `NativeWindow.displaySnapshot({ signal: event.signal })`; the
shared test helper owns the allowed application, checks the frozen result,
and verifies stale-window rejection, framework cleanup and zero public
ownership after OS close. Neither fixture adds an adapter-specific native
service. Their complete native tree expectations are independent of the
framework snapshots.

Build all three entries with the existing prebuilt host, then run each in its
own display session. The framework development command executes the generated
production module recorded by the same compiler recipe; AOT executes that
module's inspected machine-code output. `BUN_NATIVE_HOST_PROFILE` describes
the actual host build and must match the recipe's explicit profile.

```sh
export BUN_NATIVE_HOST="$PWD/target/release/bun-native-host"
export BUN_NATIVE_HOST_PROFILE=release
mkdir -p .bun-native
run_dir=$(mktemp -d "$PWD/.bun-native/services.XXXXXX")

for entry in services solid-services react-services; do
  bun experiments/aot-gpui/build-window.ts \
    --source "$PWD" --host "$BUN_NATIVE_HOST" --host-profile release \
    --entry "$entry" --outdir "$run_dir/$entry-package"
  development_entry="$run_dir/$entry-package/development/application.js"
  if [ "$entry" = services ]; then development_entry=tests/native/services.ts; fi
  xvfb-run --auto-servernum --server-args='-screen 0 1280x800x24 -nolisten tcp' \
    dbus-run-session -- bash scripts/quality/native-linux-session.sh \
    "$run_dir/$entry-development" "$entry" bun "$development_entry"
  xvfb-run --auto-servernum --server-args='-screen 0 1280x800x24 -nolisten tcp' \
    dbus-run-session -- bash scripts/quality/native-linux-session.sh \
    "$run_dir/$entry-aot" "aot-$entry" "$run_dir/$entry-package/$entry"
done
```

The Linux CI lane reuses its single release host for these six scenarios.
Each retains the independent X screen oracle, actual pointer activation,
native paint, screenshot, application cleanup and driver process ownership
report. The adapter fixtures additionally retain
`service-adapter-result.json` with the framework owner disposal and renderer
resource counts. This is correctness evidence; the instrumented sessions do
not establish service throughput, hardware presentation latency or a memory
leak bound.

## Local native qualification

The [recorded six-scenario qualification](../tests/native/evidence/services-linux-development-aot.json)
uses the same 111,861,288-byte development-profile native host in every case.
Its SHA-256 is `69b748ebca2c5784cbd235564efaacb999eb0cd127c53b27a235e32066767f47`.
The actual GPUI window reports Mesa llvmpipe software rendering. Each fresh
owned Xvfb session independently reports a 1280×800 screen at forced scale 1.

| Consumer    | Development | Inspected machine-code AOT | Required native result                                                                                                                                                                        |
| ----------- | ----------- | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Public core | Passed      | Passed                     | Default denial; allowed read; queued cancellation; native stale/unknown owner rejection; shutdown before dispatch; actual pointer activation; matching paint; stale public owner after close. |
| Solid       | Passed      | Passed                     | Same shared service from the native button; immutable display result; matching paint; one framework owner disposal; stale-owner rejection and zero resources after OS close.                  |
| React       | Passed      | Passed                     | Same shared service from the native button; immutable display result; matching paint; one effect cleanup; stale-owner rejection and zero resources after OS close.                            |

Every run ended with application exit 0, no forced termination, no remaining
or unreaped owned process and all six public ownership counts at zero. The
framework renderers also report zero nodes/listeners and no pending work.
All three Linux AOT applications carry compiled-program metadata and 27
removed JIT ranges; their interpreter remains present. The record binds each
binary, generated production framework module, source file and raw report
to its SHA-256. Screenshots of the core and React result were visually
inspected; the automated oracle checks complete native paint reports, not
pixel recognition or presentation timestamps.

The retained initial attempt failed before application launch because the
driver correctly rejected a custom `service-snapshot` expectation. The
fixture now records the actual button `click` with its display result. The
driver's existing event restrictions and all geometry, ownership, paint and
deadline requirements remain intact. That rejected attempt is recorded
separately from the six successful native scenarios.

The complete #255 service matrix remains open. This evidence does not qualify
the release-host profile, other platforms, mixed-DPI/multi-monitor semantics,
the unavailable services, performance budgets or long-term leak freedom.
