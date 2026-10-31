# Native desktop services

The shared public core exposes one implemented service in this branch:
`NativeWindow.displaySnapshot()`. It reads the display associated with that
owned native window through the pinned GPUI backend. Solid and React use this
same window method; neither adapter owns an OS implementation.

The implementation has not yet completed its native development/AOT
qualification. Parser and type checks are separate evidence. The platform
matrix below deliberately records that limit until the native fixture runs.

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

The default permission is `deny`. The only accepted permission key is
`windowDisplay`, and its value must be `allow` or `deny`. The runtime translates
an explicit grant into one reserved native launch argument. The Rust process
parses that immutable policy before starting GPUI or its private channel.
Unknown or duplicate native arguments fail startup. A wire message cannot
grant, extend or change the policy.

Protocol 5 replaces protocol 4 without a compatibility decoder. Readiness must
include `window_display_v1` alongside the existing rendering capabilities and
an explicit boolean `service_policy.window_display`. The runtime requires the
reported policy to match its launch request exactly. Missing capabilities,
missing policy, conflicting policy or an older protocol fail launch and clean
up the child. Feature negotiation says what the host implements; permission
says which implemented service the application elected to expose.

`app.serviceCapabilities` is a frozen record. `windowDisplay` contains
`{ availability: 'available', permission: 'allow' | 'deny', scope: 'owned_window' }`.
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
}
```

Bounds are the GPUI platform display's global logical pixels; `scaleFactor` is
the owning window's current native scale factor. The UI thread resolves the
still-live window and reads `window.display(cx)`, `display.bounds()` and
`window.scale_factor()`. The response contains the matching request and window
identities. Both language implementations reject nonfinite or excessive
geometry, unknown fields and malformed ownership. Origins are bounded to
±1,048,576 logical pixels, positive dimensions to 1,048,576 and scale to
0.125–16. Invalid native geometry fails as `native_failure` rather than being
clamped into an invented result.

The pinned X11 backend represents an **X screen spanning its monitors**, not a
physical monitor selected by the window's overlap. Its bounds originate at
zero and divide X screen pixels by the configured scale. The current API does
not promise physical monitor identity, refresh rate, work area, DPI, display
enumeration, display-change events or automatic window placement. Moving a
window after a read can make the snapshot stale. The isolated Xvfb check uses
one scale-1 screen; it cannot establish mixed-DPI or multi-monitor behavior.
These semantics follow the pinned
[X11 display implementation](https://github.com/zed-industries/zed/blob/ba63a022c9a22ca66d68ef2a8f0bb9b5b0a9984d/crates/gpui_linux/src/linux/x11/display.rs#L14-L55)
and [GPUI window accessors](https://github.com/zed-industries/zed/blob/ba63a022c9a22ca66d68ef2a8f0bb9b5b0a9984d/crates/gpui/src/window.rs#L3144-L3162).

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

## Service and platform matrix

All services listed here share the core's policy boundary. The unavailable rows
are requirements for future work, not promises that an exported function
already exists. The linked follow-ups belong to
[#255](https://github.com/0xPlayerOne/bun-native/issues/255).

| Service           | Current public surface                                        | Linux X11                 | macOS                        | Windows                      | Required scope before exposing more operations                                                                                                                                                          |
| ----------------- | ------------------------------------------------------------- | ------------------------- | ---------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Window/display    | Existing owned open/close; permission-gated `displaySnapshot` | Service execution pending | Service execution unverified | Service execution unverified | Display changes, physical-monitor/work-area semantics, placement and mixed-DPI evidence. [#299](https://github.com/0xPlayerOne/bun-native/issues/299).                                                  |
| Clipboard text    | Capability `clipboardText`; unavailable                       | Unavailable               | Unavailable                  | Unavailable                  | Separate read/write grants, byte limits, bounded native transfer, cancellation and truthful OS errors. [#300](https://github.com/0xPlayerOne/bun-native/issues/300).                                    |
| Global shortcuts  | Capability `globalShortcuts`; unavailable                     | Unavailable               | Unavailable                  | Unavailable                  | Explicit registration policy, conflict errors, revocable owned registrations and teardown. Window key listeners are not global shortcuts. [#301](https://github.com/0xPlayerOne/bun-native/issues/301). |
| System menus      | Capability `systemMenus`; unavailable                         | Unavailable               | Unavailable                  | Unavailable                  | Typed action identities, owned menu lifetime, keyboard/accessibility behavior and safe action revocation. [#239](https://github.com/0xPlayerOne/bun-native/issues/239).                                 |
| Dialogs           | Capability `dialogs`; unavailable                             | Unavailable               | Unavailable                  | Unavailable                  | Owned-window modality, explicit cancellation, shutdown and file selection distinct from a file grant. [#239](https://github.com/0xPlayerOne/bun-native/issues/239).                                     |
| Notifications     | Capability `notifications`; unavailable                       | Unavailable               | Unavailable                  | Unavailable                  | OS permission outcome, bounded payload, activation routing and late-callback revocation. [#302](https://github.com/0xPlayerOne/bun-native/issues/302).                                                  |
| Drag/drop         | Capability `dragDrop`; unavailable                            | Unavailable               | Unavailable                  | Unavailable                  | Bounded untrusted payload, owned target, native cancellation and explicit file-grant conversion. [#303](https://github.com/0xPlayerOne/bun-native/issues/303).                                          |
| Filesystem grants | Capability `filesystemGrants`; unavailable                    | Unavailable               | Unavailable                  | Unavailable                  | Scoped file/directory handles, allowed operations, path/symlink policy, revocation and OS failure mapping. [#304](https://github.com/0xPlayerOne/bun-native/issues/304).                                |
| PTY/process       | Capability `ptyProcess`; unavailable                          | Unavailable               | Unavailable                  | Unavailable                  | Executable/argument/environment policy, bounded streams, process identity, interruption and joined child cleanup. [#305](https://github.com/0xPlayerOne/bun-native/issues/305).                         |

The Adea port [#250](https://github.com/0xPlayerOne/bun-native/issues/250) must
gate terminal/file features on these explicit statuses.
[Filesystem grants #304](https://github.com/0xPlayerOne/bun-native/issues/304)
and [PTY/process #305](https://github.com/0xPlayerOne/bun-native/issues/305)
define the implementation path. Its future broker
should accept validated executable/argument arrays and scoped file handles;
displayed terminal text, model output or a dropped pathname must never create
authority by itself. An application choosing ordinary Bun process/filesystem
APIs uses its own trusted authority and must not describe that as a native
service grant or a sandbox supplied by this framework.

## Why the first slice is display information

Display reads give a small real operation with native ownership, explicit
denial, cancellation delivery and teardown, without changing user data. The
current clipboard methods need a separate implementation decision before
their errors and responsiveness can meet the same contract.

At the exact GPUI pin, the default
[`read_from_clipboard_async`](https://github.com/zed-industries/zed/blob/ba63a022c9a22ca66d68ef2a8f0bb9b5b0a9984d/crates/gpui/src/platform.rs#L586-L599)
wraps the synchronous call. The X11 implementation synchronously fetches a
foreign selection, with an initial four-second wait and incremental-transfer
waits that can reset. Its write method returns no operation result and logs
selection-write errors. Calling this from a service handler and reporting a
successful cancellable write would overstate what was observed. See the
pinned [X11 client](https://github.com/zed-industries/zed/blob/ba63a022c9a22ca66d68ef2a8f0bb9b5b0a9984d/crates/gpui_linux/src/linux/x11/client.rs#L1841-L1879)
and [clipboard transfer loop](https://github.com/zed-industries/zed/blob/ba63a022c9a22ca66d68ef2a8f0bb9b5b0a9984d/crates/gpui_linux/src/linux/x11/clipboard.rs#L396-L450).
This is a problem for the clipboard follow-up to solve, not a browser fallback
or permission to substitute cached content as a successful OS operation.

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

Actual development/AOT results, source/artifact identities and any unsupported
platforms must be recorded here before #255's first slice is declared complete.
