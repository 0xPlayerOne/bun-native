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
qualifies one isolated scale-1 Xvfb screen; macOS, Windows, Wayland and
multi-monitor service behavior remain unverified. The earlier
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
import { createApplication, NativeServiceError } from '@bun-native/core'

const executable = process.env['BUN_NATIVE_HOST']
if (!executable) throw new Error('Set an absolute BUN_NATIVE_HOST path')
const app = await createApplication({
  executable,
  permissions: { windowDisplay: 'allow' },
})
try {
  const window = await app.openWindow({ title: 'Display information' })
  const display = await window.displaySnapshot()
  console.log(display.bounds, display.scaleFactor)
  await window.close()
} catch (error) {
  if (error instanceof NativeServiceError) console.error(error.code, error.service)
  else throw error
} finally {
  await app.shutdown()
  await app.closed
}
```

The default permission is `deny`. The accepted keys are `windowDisplay`,
`clipboardRead`, `clipboardWrite`, `globalShortcuts` and `notifications`, each
independently `allow` or `deny`; `filesystemRoots`, a list of launch
directories described under [filesystem grants](#filesystem-grants); and
`processes`, a list of launch executables described under
[owned processes](#owned-processes).
The runtime translates each explicit grant into its reserved native launch argument. The Rust process
parses that immutable policy before starting GPUI or its private channel.
Unknown or duplicate native arguments fail startup. A wire message cannot
grant, extend or change the policy.

Protocol 7 replaces protocol 6 without a compatibility decoder. Readiness must
include `window_display_v1` alongside the existing rendering capabilities and
explicit `window_display`, `clipboard_read`, `clipboard_write` and
`global_shortcuts` booleans in `service_policy`. The runtime requires the
reported policy to match its launch request exactly. Missing capabilities,
missing policy, conflicting policy or an older protocol fail launch and clean
up the child. Feature negotiation says what the host implements; permission
says which implemented service the application elected to expose.

`app.serviceCapabilities` is a frozen record. `windowDisplay` contains
`{ availability: 'available', permission: 'allow' | 'deny', scope: 'owned_window' }`.
The optional `clipboard_text_v1` feature is advertised only for the implemented
local Linux X11 backend. Its capability record reports independent `read` and
`write` permissions, `owned_window` scope and backend `x11`. Other targets and
backends report `unavailable` / `unsupported_platform` for clipboard text.
The other listed services contain
`{ availability: 'unavailable', reason: 'not_implemented' }`. An advertised
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
- Wayland: not qualified. Its GPUI backend does report output changes, but no
  compositor session is available in the Linux CI lane. macOS and Windows have
  their own fixture, below.

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
  permissions: { clipboardRead: 'allow', clipboardWrite: 'allow' },
})
const window = await app.openWindow({ title: 'Explicit clipboard operations' })
try {
  await window.writeClipboardText('Text the application intentionally copies')
  const result = await window.readClipboardText()
  if (result.kind === 'text') console.log(result.text)
} finally {
  await app.shutdown()
  await app.closed
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
    filesystemRoots: [{ id: 'workspace', path: '/home/me/project', access: 'read_write' }],
  },
})
const window = await app.openWindow({ title: 'Workspace' })
const grant = await window.openFileGrant('workspace', { access: 'read' })
const page = await grant.list('src')
const chunk = await grant.read('src/main.ts', { offset: 0, length: 16_384 })
await grant.close()
```

Each root has an ID of lowercase letters, digits, `-` and `_`, an absolute
normalized path and `read` or `read_write` access; at most eight are accepted.
A grant requests at most its root's access and defaults to `read`. Readiness
reports the same ordered roots, and the frozen capability record lists them by
ID with `backend: 'openat2'` on Linux or `backend: 'openat_walk'` on macOS.
The optional `filesystem_grants_v1` feature is advertised only by a host built
with one of those backends whose kernel probe succeeds: Linux with `openat2`
(5.6 and later) and macOS. Windows and other targets report `unavailable` /
`unsupported_platform`. No run-time path, dropped file name or model text can
create a root or a grant.

Paths are relative to the grant: `''` is the root itself and other paths are
`/`-joined names without empty, `.`, `..` or control-character components (at
most 1,024 bytes and 32 components). The host opens the root once as a
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
the hosted `macos-15` Native Platforms job; it has not been run on a local Mac. `stat` and
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
share the eight-request service bound; at most 32 grants are live per session.
Closing the grant, its window or the application revokes it: later calls reject
with `cancelled` without a native request, and a result that arrives after
revocation is withheld. An operation the worker has already started may still
take effect.

The [Native Linux workflow](../.github/workflows/native-linux.yml) runs
[`tests/native/filesystem-grants.ts`](../tests/native/filesystem-grants.ts) in
development and inspected AOT on an isolated display. It checks every effect
independently through `node:fs` on a private temporary tree, including a
sibling directory that must stay unchanged, and drives the private runtime to
confirm that the host rejects foreign, stale and reused grant IDs. See
[ADR 0010](decisions/0010-filesystem-grants.md). macOS and Windows remain
unavailable.

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

Each launch entry has an ID of lowercase letters, digits, `-` and `_` and an
absolute normalized executable path; at most eight are accepted and readiness
reports the same ordered list. No wire command names a program path, and there
is no command string or shell: `args` is an explicit array (at most 64 strings
of 4,096 bytes) and `env` is the **complete** environment (at most 64 entries;
nothing is inherited from the host), with arguments and environment together
at most 32,768 bytes. A working directory comes only from a live file grant of
the same window; the host resolves `path` beneath the grant descriptor with the
same `openat2` rules as file requests, so links are never followed. macOS
has no filesystem grants, so a process there cannot be given a working
directory and starts in the host's.

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
| `resize({ columns, rows })` | Terminal processes only (1–1,000 each)                                                           |
| `signal(name)`              | `interrupt`, `terminate`, `kill` or `hangup` to the whole process group                          |
| `release()`                 | Idempotent; stops delivery, kills the group and reaps it                                         |

Output is credited: the host reads at most four chunks a process has delivered
but the core has not acknowledged, and the core acknowledges a chunk only after
its callback settles, so a slow consumer pauses the child instead of growing a
queue. When the direct child exits, the host stops the rest of its process
group while the exited leader still holds the group ID, delivers the remaining
output, reaps the leader and then reports the exit. A descendant that leaves
the group (`setsid`) is outside this cleanup. An exited process stays
`active` until released; later `write`, `signal` or `resize` calls reject with
`invalid_state`.

Failures are `NativeServiceError` with service `processes` and a code:
`permission_denied` (not in the launch policy), `not_found` (missing executable
or directory), `path_denied` (the directory crosses a link), `wrong_kind`,
`access_denied`, `limit_exceeded` (at most eight live processes per session),
`invalid_state`, `service_unavailable`, `native_failure` or `cancelled`.
Releasing the process, closing its window or stopping the application kills
and reaps its group; no later output or exit is delivered. The optional
`processes_v1` feature is advertised on Linux with pidfd support and on macOS; the
frozen `ptyProcess` capability record lists the executables by ID with
`backend: 'posix'`, and other targets report `unavailable` /
`unsupported_platform`.

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
behavior is claimed from that CI job. Windows remains unavailable.

## Service and platform matrix

All services listed here share the core's policy boundary. The unavailable rows
are requirements for future work, not promises that an exported function
already exists. The linked follow-ups belong to
[#255](https://github.com/0xPlayerOne/bun-native/issues/255).

| Service           | Current public surface                                        | Linux X11                                                                                           | macOS                        | Windows                      | Required scope before exposing more operations                                                                                                                                                    |
| ----------------- | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ---------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Window/display    | Existing owned open/close; permission-gated `displaySnapshot` | Core/Solid/React dev+AOT verified with release host; X11 semantics fixture dev+AOT verified locally | Service execution unverified | Service execution unverified | X11 semantics qualified; change events, work area, identity and mixed DPI unavailable on X11. Other platforms and placement remain. [#299](https://github.com/0xPlayerOne/bun-native/issues/299). |
| Clipboard text    | `readClipboardText` / `writeClipboardText`; separate grants   | X11 dev+AOT verified with release host                                                              | Unavailable                  | Unavailable                  | Additional platforms/formats and extended lifecycle coverage. [#300](https://github.com/0xPlayerOne/bun-native/issues/300).                                                                       |
| Global shortcuts  | `registerGlobalShortcut`; `globalShortcuts` grant             | X11 dev+AOT verified with release host                                                              | Unavailable                  | Unavailable                  | macOS/Windows backends, Wayland portal design and keyboard-map change tracking. [#301](https://github.com/0xPlayerOne/bun-native/issues/301).                                                     |
| System menus      | Capability `systemMenus`; unavailable                         | Unavailable                                                                                         | Unavailable                  | Unavailable                  | Typed action identities, owned menu lifetime, keyboard/accessibility behavior and safe action revocation. [#239](https://github.com/0xPlayerOne/bun-native/issues/239).                           |
| Dialogs           | Capability `dialogs`; unavailable                             | Unavailable                                                                                         | Unavailable                  | Unavailable                  | Owned-window modality, explicit cancellation, shutdown and file selection distinct from a file grant. [#239](https://github.com/0xPlayerOne/bun-native/issues/239).                               |
| Notifications     | `postNotification`; `notifications` grant                     | Freedesktop D-Bus (dunst) dev+AOT verified                                                          | Unavailable                  | Unavailable                  | macOS/Windows backends, additional notification servers, named actions and replacement. [#302](https://github.com/0xPlayerOne/bun-native/issues/302).                                             |
| Drag/drop         | Capability `dragDrop`; unavailable                            | Unavailable                                                                                         | Unavailable                  | Unavailable                  | Bounded untrusted payload, owned target, native cancellation and explicit file-grant conversion. [#303](https://github.com/0xPlayerOne/bun-native/issues/303).                                    |
| Filesystem grants | `openFileGrant`; `filesystemRoots` launch roots               | openat2 dev+AOT verified locally                                                                    | `openat` walk; CI-only       | Unavailable                  | OS file selection and dropped files as explicit user grants, Windows confinement. [#304](https://github.com/0xPlayerOne/bun-native/issues/304).                                                   |
| PTY/process       | `spawnProcess`; `processes` launch executables                | Pipes and PTY dev+AOT verified locally                                                              | Dev+AOT in CI only; no `cwd` | Unavailable                  | macOS `cwd`, Windows backend (ConPTY), descendants that leave the group, resource limits. [#305](https://github.com/0xPlayerOne/bun-native/issues/305).                                           |

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
