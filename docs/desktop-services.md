# Desktop clipboard and application lifecycle

This issue #34 increment adds native text clipboard operations and observations
of application startup and shutdown. It builds on the [window APIs](desktop-window-api.md)
and the exact document authority introduced by [issue #21](m4-capability-policy.md).
Menus, tray, general dialogs, shortcuts, external URLs, deep links, relaunch and
application reopen remain separate work. This increment does not close #34.

## Capabilities and platform boundary

`ClipboardBackend` and `ApplicationLifecycleBackend` are optional, browser-safe
contract facets. They do not add required methods to every `BrowserBackend`.
The actual CEF host advertises their capabilities in the existing ABI 1 readiness
receipt, using the same bounded `desktopCapabilities` version 1 negotiation as
the window increment. Unknown names, duplicate names, unknown versions and
malformed metadata fail before readiness. The backend descriptor is immutable
and reflects that running host. An older host without these capabilities and
the mock reject the new operations with `UNSUPPORTED_CAPABILITY`.

| Capability       | macOS ARM64                            | Windows x64                            | Linux x64                              |
| ---------------- | -------------------------------------- | -------------------------------------- | -------------------------------------- |
| `clipboard.text` | AppKit `NSPasteboard` adapter          | Win32 `CF_UNICODETEXT` adapter         | Unsupported; never advertised          |
| `app.lifecycle`  | CEF initialization and native teardown | CEF initialization and native teardown | CEF initialization and native teardown |

This table describes implemented adapters. Real native execution qualification
requires a separate receipt for each target. Linux compilation and pure tests do
not qualify the macOS or Windows clipboard. No clipboard round trip has been
claimed merely because an API check or mock test passed.

Profile extension metadata includes explicit platforms for `clipboard.text`.
`profileProvidesCapability(profile, backend, capability, platform)` requires a
matching platform for such an extension; omitting the platform does not imply
clipboard support everywhere. Application code should use the connected
backend's descriptor for runtime decisions. An available adapter does not bypass
native document grants, OS pasteboard privacy decisions or clipboard contention.

Linux needs an X11 selection owner, request callbacks, bounded transfer and
shutdown handling before it can advertise clipboard support. There is no
`xclip`, `xsel`, shell, Electron or other fallback hidden behind the API.

## Text operations and authority

The private, trusted Bun backend captures an opaque `PolicyScope` from a ready
application document and grants only the necessary operations:

```ts
const scope = await backend.capturePolicyScope(view)
await backend.grantNativeCapability(scope, { name: 'clipboard-read' })
await backend.grantNativeCapability(scope, { name: 'clipboard-write' })

const text = await backend.readClipboardText(scope, { signal })
await backend.writeClipboardText(scope, 'Application text', { signal })
```

The scope carries the existing backend-private identity; its portable TypeScript
type does not make structural copies, renderer IDs or JSON values authoritative.
It identifies the native view, main frame, document, generation, origin and
session. Navigation, reload, native replacement, view/window closure and quit
revoke it. These methods never recapture a scope on behalf of a delayed caller.
Browser clipboard permissions are separate from these application-native grants.

| Method                                      | Result                                                             | Required native grant |
| ------------------------------------------- | ------------------------------------------------------------------ | --------------------- |
| `readClipboardText(scope, options?)`        | `string` or `null` when there is no accessible text representation | `clipboard-read`      |
| `writeClipboardText(scope, text, options?)` | Completion of the native write                                     | `clipboard-write`     |
| `clearClipboard(scope, options?)`           | Completion of removing all clipboard formats                       | `clipboard-write`     |

An empty text string remains `''`; it still has a native text format. A `null`
read is not a declaration that all clipboard formats are absent. For example,
an image-only clipboard has no text representation, and AppKit may be unable
to provide requested text. `clearClipboard` removes existing formats, including
images or other applications' custom data. Call it only as an explicit application
operation; resource disposal and handler replacement never clear the clipboard.

Text is limited to **8,192 UTF-8 bytes**, with no NUL or unpaired UTF-16 surrogates.
The same limit applies to reads and writes. The runtime validates input before
sending it; native code validates again before OS access. Native conversion and
return buffers are bounded, and oversized reads reject instead of truncating.
The limit also keeps worst-case JSON escaping within the existing private
64 KiB frame budget. It does not set memory limits inside the OS pasteboard
service or AppKit's own object creation.

The native UI-thread adapter checks the exact current scope and relevant grant
immediately before executing. It releases registry borrows before an OS call
that might reenter the native loop, and checks authority again before publishing
the result or success receipt. The Bun backend repeats its own local scope check
after awaiting the reply. A stale document cannot receive a delayed read result.

On Windows, every successful `OpenClipboard` has a corresponding close. The
adapter copies bounded Unicode data while the clipboard is open and never frees
OS-owned read memory. A successful `SetClipboardData` transfers its movable
allocation to Windows; failed writes release the untransferred allocation.
Clipboard contention returns `RESOURCE_IN_USE` without a polling loop. On macOS,
AppKit reads and writes the general pasteboard on the native owner thread. The
adapter uses public native APIs on both platforms and starts no subprocess.

Cancellation cancels the caller's wait and retains the existing transport
accounting until a real native receipt or teardown. It cannot undo an OS write
that already executed. Clearing and replacing content are separate OS actions;
a failed replacement may follow a successful clear. Neither policy revocation
nor application generation rollback restores external clipboard contents.

The existing `authorizeNativeOperation` method remains a policy-only diagnostic:
a matching grant produces `unavailable` and executes no adapter. Discover actual
adapter support through capabilities and invoke the corresponding operation.
The real operation independently performs the execution-time native gate.

## Application observations and quit

```ts
const started = await backend.whenApplicationReady({ signal })
const off = backend.onApplicationEvent((event) => {
  // Events contain only lifecycle observations and requested intent.
}, { signal })

await backend.quit()
const final = backend.applicationState()
off()
```

`whenApplicationReady` observes the native readiness receipt emitted after CEF's
context initialization. It rejects for unsupported legacy hosts or failed
startup. `applicationState()` returns a frozen snapshot with `phase`,
`quitRequested`, `quitReason` and `outcome`. It remains readable after closure so
the caller can inspect the final result. Subscriptions do not replay past events;
use the readiness promise and state snapshot when attaching after startup.

| Observation                       | Meaning                                                                                                           |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Readiness promise / running state | The native host reported initialized CEF readiness                                                                |
| `quit-requested`                  | This Bun backend requested its existing disposal path; shutdown is not yet observed                               |
| `quitting`                        | The actual native teardown path began, once, with `requested`, `last-window`, `native` or `failure` as its reason |
| `closed`                          | The native control transport and backend resource cleanup completed, with `orderly` or `failed` as the outcome    |

`quit()` coalesces with `dispose()` and uses its existing resource revocation,
bounded shutdown and cleanup path. It creates no independent shutdown mechanism
and offers no veto, relaunch or reopen promise. It is a trusted application-host
control operation, like `dispose()`; a renderer does not gain it through a
clipboard grant. Native-initiated shutdown fences new local calls before
application lifecycle callbacks run.

An abrupt transport failure can transition directly to `closed` without a
fabricated `quitting` event. A native failure during teardown remains a failed
closure even if shutdown began normally. The native failure bit is included in
the shutdown receipt; it does not increase existing queue, frame or deadline
budgets. Receipt ordering and final teardown diagnostics retain their existing
paths. An orderly control-channel closure does **not** prove that the OS process
has exited: native qualification separately requires actual process exit and
the existing shutdown diagnostics.

The contributor renderer-crash fixture now requires that failed-shutdown
rejection, the exact injected renderer exit status, and a non-forced backend
exit of 1. Its acknowledgment cannot turn the deliberately failed host into an
orderly close. Current fault reports use schema 8 so the final Linux/Windows aggregate also
requires the explicit rejection and backend exit 1. Schema 7 and earlier reports
keep their original expectations during historical replay.

There are at most 64 lifecycle subscriptions and 64 pending readiness waiters per
backend. Abort removes the associated listener/waiter, disposers are idempotent,
listener exceptions are isolated and counted, and final closure releases all
retained callbacks. Removing a listener during delivery prevents later delivery
to it in the same event snapshot.

## Managed application generations

`ManagedDesktopResources.registerClipboard(name, policy)` registers a scoped
adapter binding with schema `bunly.clipboard:1`. Its operation allowlist is
`read-text`, `write-text` and `clear`. Read and clear accept JSON `null`; write
accepts exactly `{ "text": "..." }`. Each invocation rechecks the managed
generation, its permission, host policy and exact native document scope before
execution and after asynchronous boundaries. Managed permission labels do not
create the separate native clipboard grant.

The resource owns this binding only. Retiring an application generation,
detaching the resource or disposing the managed owner does not own or clear
global clipboard content. Application lifecycle observers can use the existing
generation `AbortSignal`, `own('listener', disposer)` and guarded callbacks so
retired handlers receive no events. Tests exercise reattachment, stale calls,
explicit clear permission and generation-owned listener removal.

## Contributor fixture and validation

`examples/desktop-services/fixture.ts` is a bounded native contributor fixture.
The shared `qualify:desktop --case=services` runner launches its clipboard sequence through an outer qualifier that calls
`requireDisposableClipboardRunner` from
`scripts/cef-desktop-services-precondition.ts` **before native launch**. The
precondition requires explicit `--disposable-clipboard` opt-in and a disposable
GitHub-hosted macOS ARM64 or Windows x64 session. It rejects connected/local
desktops and self-hosted runners. This is a contributor launch precondition,
not an environment-based authorization rule in the runtime API.

Before any write or clear probe, a fixed read-only contributor operation checks
native clipboard item/format metadata. It rejects existing text, empty-string
text, images, custom formats and uncertain results. Ordinary native builds omit
this operation; the `rpc-qualification` feature enables it only on the trusted
private pipe, with the same exact scope and read grant. No renderer endpoint is
added. The disposable session must have no competing clipboard producer; a
metadata preflight is not an atomic reservation against other applications.

The fixture checks denied read/write/clear, oversized Unicode writes, pre-aborted
reads, Unicode round trips, the exact byte boundary, empty strings, true clearing,
stale scope rejection and native lifecycle/quit. It restores the initially empty
clipboard in `finally`, including after a failed write acknowledgment. It refuses
to snapshot and overwrite arbitrary user data because the text-only API cannot
faithfully restore every native format. Receipts contain fixed check results,
resource counts and lifecycle state; clipboard payloads never enter retained
reports. Linux exercises explicit unsupported clipboard results and the real
application lifecycle without clipboard OS access.

Portable tests cover scope forgery, asynchronous navigation/disposal races,
malformed native results, legacy capability negotiation, bounded observers,
native failure outcomes, managed ownership and fixture refusal/restoration.
Pure Rust tests cover Unicode bounds and the execution/read-result policy gates
without touching an OS clipboard. Strict Linux native compilation validates the
ordinary and contributor code paths. Real macOS/Windows compilation and
disposable native execution remain separately required platform checks.

The [desktop qualification guide](desktop-qualification.md#clipboard-and-application-lifecycle)
documents the exact launch commands and replay contract. The full hosted native
suite requires a distinct `desktop-services` report on every platform before
later credential/provider checks. Unsupported Linux clipboard behavior remains
separate from executed macOS/Windows clipboard evidence.

### Native API references

- [Apple NSPasteboard](https://developer.apple.com/documentation/appkit/nspasteboard)
- [Apple pasteboardItems failure semantics](https://developer.apple.com/documentation/appkit/nspasteboard/pasteboarditems)
- [Windows OpenClipboard](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-openclipboard)
- [Windows GetClipboardData ownership and untrusted data](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getclipboarddata)
- [Windows SetClipboardData ownership transfer](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setclipboarddata)
- [Windows EnumClipboardFormats empty/error distinction](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-enumclipboardformats)
