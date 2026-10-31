# Native desktop services

The shared public core exposes owned-window display reads and a bounded
clipboard text worker. `NativeWindow.displaySnapshot()` reads the display
associated with that window through GPUI. `readClipboardText()` and
`writeClipboardText(text)` use the actual local X11 selection protocol off the
UI thread. Solid and React use the same public window methods; neither adapter
owns an OS implementation.

The protocol-5 core, Solid and React display consumers passed actual Linux development/AOT
qualification on one isolated Xvfb screen with a development-profile host.
Hosted release-host acceptance is configured separately; macOS and Windows
service execution remains unverified. Parser and type checks are separate
evidence. See the [source-bound record](../tests/native/evidence/services-linux-development-aot.json).
The protocol-6 clipboard increment currently has source and headless contract
checks; actual isolated-X11 and AOT clipboard qualification is pending.

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
`clipboardRead` and `clipboardWrite`, each independently `allow` or `deny`.
The runtime translates each explicit grant into its reserved native launch argument. The Rust process
parses that immutable policy before starting GPUI or its private channel.
Unknown or duplicate native arguments fail startup. A wire message cannot
grant, extend or change the policy.

Protocol 6 replaces protocol 5 without a compatibility decoder. Readiness must
include `window_display_v1` alongside the existing rendering capabilities and
explicit `window_display`, `clipboard_read` and `clipboard_write` booleans in
`service_policy`. The runtime requires the
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
}
```

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
zero and divide X screen pixels by the configured scale. The current API does
not promise physical monitor identity, refresh rate, work area, DPI, display
enumeration, display-change events or automatic window placement. Moving a
window after a read can make the snapshot stale. The isolated Xvfb check uses
one scale-1 screen; it cannot establish mixed-DPI or multi-monitor behavior.
These semantics follow the pinned
[X11 display implementation](https://github.com/zed-industries/zed/blob/ba63a022c9a22ca66d68ef2a8f0bb9b5b0a9984d/crates/gpui_linux/src/linux/x11/display.rs#L14-L55)
and [GPUI window accessors](https://github.com/zed-industries/zed/blob/ba63a022c9a22ca66d68ef2a8f0bb9b5b0a9984d/crates/gpui/src/window.rs#L3144-L3162).
The pinned [macOS implementation](https://github.com/zed-industries/zed/blob/ba63a022c9a22ca66d68ef2a8f0bb9b5b0a9984d/crates/gpui_macos/src/display.rs#L114-L125)
also returns a zero origin, retaining the size from `CGDisplayBounds` but not
its global origin. This API therefore does not promise a global monitor
arrangement or suitable coordinates for cross-display window placement.
The follow-up must qualify those semantics instead of inferring them from
the field names.

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
clipboard request waits; actual validation of that scheduling property remains
part of the pending native fixture.

Read cancellation before dispatch sends nothing. After dispatch, the bounded
reply is drained and validated before cancellation suppresses delivery.
Window closure revokes its pending native requests. Shutdown cancels pending
work, joins the worker off the UI thread and only then acknowledges terminal
completion. A malformed response still fails the channel under cancellation.

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

## Service and platform matrix

All services listed here share the core's policy boundary. The unavailable rows
are requirements for future work, not promises that an exported function
already exists. The linked follow-ups belong to
[#255](https://github.com/0xPlayerOne/bun-native/issues/255).

| Service           | Current public surface                                        | Linux X11                                                      | macOS                        | Windows                      | Required scope before exposing more operations                                                                                                                                                          |
| ----------------- | ------------------------------------------------------------- | -------------------------------------------------------------- | ---------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Window/display    | Existing owned open/close; permission-gated `displaySnapshot` | Core/Solid/React dev+AOT verified locally; release CI pending  | Service execution unverified | Service execution unverified | Display changes, physical-monitor/work-area semantics, placement and mixed-DPI evidence. [#299](https://github.com/0xPlayerOne/bun-native/issues/299).                                                  |
| Clipboard text    | `readClipboardText` / `writeClipboardText`; separate grants   | Implemented local X11 worker; native/AOT qualification pending | Unavailable                  | Unavailable                  | Independent-reader proof, bounded INCR/stalled-owner/cancellation checks, additional platforms/formats. [#300](https://github.com/0xPlayerOne/bun-native/issues/300).                                   |
| Global shortcuts  | Capability `globalShortcuts`; unavailable                     | Unavailable                                                    | Unavailable                  | Unavailable                  | Explicit registration policy, conflict errors, revocable owned registrations and teardown. Window key listeners are not global shortcuts. [#301](https://github.com/0xPlayerOne/bun-native/issues/301). |
| System menus      | Capability `systemMenus`; unavailable                         | Unavailable                                                    | Unavailable                  | Unavailable                  | Typed action identities, owned menu lifetime, keyboard/accessibility behavior and safe action revocation. [#239](https://github.com/0xPlayerOne/bun-native/issues/239).                                 |
| Dialogs           | Capability `dialogs`; unavailable                             | Unavailable                                                    | Unavailable                  | Unavailable                  | Owned-window modality, explicit cancellation, shutdown and file selection distinct from a file grant. [#239](https://github.com/0xPlayerOne/bun-native/issues/239).                                     |
| Notifications     | Capability `notifications`; unavailable                       | Unavailable                                                    | Unavailable                  | Unavailable                  | OS permission outcome, bounded payload, activation routing and late-callback revocation. [#302](https://github.com/0xPlayerOne/bun-native/issues/302).                                                  |
| Drag/drop         | Capability `dragDrop`; unavailable                            | Unavailable                                                    | Unavailable                  | Unavailable                  | Bounded untrusted payload, owned target, native cancellation and explicit file-grant conversion. [#303](https://github.com/0xPlayerOne/bun-native/issues/303).                                          |
| Filesystem grants | Capability `filesystemGrants`; unavailable                    | Unavailable                                                    | Unavailable                  | Unavailable                  | Scoped file/directory handles, allowed operations, path/symlink policy, revocation and OS failure mapping. [#304](https://github.com/0xPlayerOne/bun-native/issues/304).                                |
| PTY/process       | Capability `ptyProcess`; unavailable                          | Unavailable                                                    | Unavailable                  | Unavailable                  | Executable/argument/environment policy, bounded streams, process identity, interruption and joined child cleanup. [#305](https://github.com/0xPlayerOne/bun-native/issues/305).                         |

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
clipboard worker now supplies a separate native implementation for bounded
selection transfers; [ADR 0006](decisions/0006-native-clipboard.md) records its
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
