# Scoped native downloads

The first issue #36 increment implements backend-owned downloads through CEF's
normal download pipeline. `download.manage` is an additive capability negotiated
with the running native host. It is absent for old prebuilt hosts, the mock, and
backends without this adapter. The portable lifecycle contract stays at version
3; the new `DownloadManagementBackend` facet does not change an existing method
signature or expose CEF callbacks.

Uploads, native file input selection, and OS file drops remain unavailable.
Issue #36 remains open for those workflows and for the native platform
qualification evidence described below.

## Application API and ownership

The trusted backend chooses an existing, canonical, private destination root and
grants it to one ready document. The root is application configuration or an
already approved user choice; a renderer message is not a path grant. A native
picker that can make and revalidate such a choice is separate work.

```ts
requireCapability(backend.descriptor, 'download.manage')
const scope = await backend.capturePolicyScope(view)
await backend.grantNativeCapability(scope, { name: 'download', root })

const operation = await backend.startDownload(view, {
  url: 'https://downloads.example.test/report.csv',
  destination: { root, name: 'report.csv', overwrite: 'deny' },
  maxBytes: 8 * 1024 * 1024,
  timeoutMs: 30_000,
})
const unsubscribe = operation.onProgress((progress) => {
  // progress.bytesReceived is an actual CEF counter, not a committed file size.
  renderDownloadProgress(progress)
})
const result = await operation.completed
unsubscribe()
```

The session must already allow the exact network origin. HTTPS is supported;
numeric `http://127.0.0.1:port` is supported for explicit loopback applications and
fixtures. User credentials, URL fragments, control characters, and other URL
schemes are rejected. Redirects must continue to satisfy the live session's
network policy. TLS verification and browser network permissions stay enabled.

Each operation owns one view reservation until its terminal native callback and
owned-file cleanup have settled. There is at most one operation per view and
eight per host. Progress subscriptions are bounded to 32 per operation. Exceptions
in a subscriber cannot interrupt protocol progress and are counted in backend
diagnostics. The returned state and outcome are immutable snapshots.

`operation.cancel()` is idempotent and returns `operation.completed`. Its promise
does not resolve at cancellation-command acknowledgment. An `AbortSignal` passed
to `startDownload` has the same cancellation behavior after admission. If it
aborts while the short native admission reply is in flight, the backend still
obtains the native operation identity and cancels that owner. It does not make
capacity available for another transfer early.

Outcomes are `completed`, `cancelled`, or `failed`. A failure has one of
`network`, `destination`, `permission`, `limit`, or `timeout`. `bytesWritten` is
zero unless the final file was committed successfully. `bytesReceived` records
actual native transfer progress and may be positive for a cancelled or failed
transfer. Unknown response sizes use `totalBytes: null`.

The maximum accepted final size defaults to 64 MiB, with a configurable ceiling
of 1 GiB. CEF updates and known response lengths trigger cancellation when the
limit is exceeded, and final file size must match the native completion counter.
This is **not a strict temporary disk quota**: Chromium may buffer or write more
data between callbacks. Transfer timeout defaults to 60 seconds and supports
1–300 seconds. Cancellation then has the existing native shutdown settlement
bound; a missing terminal callback fails the host instead of inventing a
successful cancellation or retaining ownership indefinitely.

Cancelled and interrupted transfers retain the greatest byte count actually
observed from CEF, with zero bytes published. The pinned Chromium implementation
[discards partial state during cancellation](https://github.com/chromium/chromium/blob/156.0.8078.17/components/download/internal/common/download_item_impl.cc),
resetting its stored counter before notifying observers. That reset does not
undo previously reported transfer progress. A terminal total below the retained
count is reported as unknown, without inventing a replacement total.

The same pinned Chromium implementation can automatically resume an interrupted
download before notifying observers. Its internal resuming state is exposed as
in progress, and a restart can reset received bytes. CEF still exposes the last
interruption through
[`GetInterruptReason`](https://github.com/chromiumembedded/cef/blob/47dbc1df023e99f006fb9e850a8d83cc19b4fdd9/libcef/browser/download_item_impl.cc).
Bunly does not grant retries: a nonterminal interruption, regressing running
counter, or repeated target callback stops the operation with a `network`
failure. Existing authority, size-limit, and cancellation reasons keep precedence.
The request permit is revoked immediately; callback, view, and staging ownership
remain charged until an actual terminal callback and cleanup. Observed bytes
remain monotonic while it stops, with no repaired in-progress event or renewed
request/destination permission. Healthy running and successful-completion
counters remain raw; byte limits and final file-size verification continue to
use the exact current CEF observation. The SDK still rejects any regressing
counter received over the native protocol.

The existing `download(view, request)` convenience method remains available. Its
request now accepts an optional typed `destination`, and the native adapter
requires it explicitly. It returns the existing `{ status, bytesWritten }`
shape after settlement; failed outcomes throw. There is no implicit downloads
directory, automatic overwrite, or use of `suggestedName` as a path.

## Native admission and document lifetime

The existing [M4 native policy scope](m4-capability-policy.md) binds every
operation to view, session, generation, main frame, document, and origin. The
native adapter checks that scope and the actual browser/request-context identities
at admission and again at callbacks and final execution. Returning to an earlier
origin does not restore a grant. Navigation, reload, document replacement,
renderer loss, view/window closure, and quit revoke the request permit before
entering the corresponding CEF action.

`CefBrowserHost::StartDownload` does not call `CanDownload`; using that callback
as the sole admission gate would be incorrect. Bunly denies renderer-initiated
downloads in `CanDownload` and admits a backend operation with an unpredictable
native-only URL fragment. The fragment leaves the HTTP path and query unchanged.
The first IO handler accepts only that exact original URL and captures CEF's
opaque request identifier. Chromium's pinned `ResourceDownloader::Start` passes
**zero** for this identifier; `Some(0)` is a claimed request, while `None` is
unclaimed. This does not change Bunly's wire IDs or the separate nonzero CEF
download-item identity. The claim is one-shot even when the raw ID is repeated.
The pinned WebContents interceptor also has an advisory `is_download=false`
path. Routing recognizes the operation's secret independently of that flag.
A known secret with a revoked permit, stale/wrong URL or wrong request identity
is denied; the public URL never substitutes for it. Ordinary requests retain
their existing network policy.
The UI download callbacks must report that same original URL and CEF download
identity. A renderer link or default menu command cannot consume a pending
backend admission. If a future CEF version stops preserving this identity, the
adapter must fail closed, not fall back to matching the public URL alone.

CEF obtains a fresh resource handler on each redirect restart. Every handler
therefore holds a lease for one native hop epoch, its exact current URL and the
established request ID. An owned redirect callback checks that lease, GET method,
source URL and destination's exact session network policy before arming one next
hop. It replaces any server-provided fragment with the same private operation
fragment, preserving the HTTP path and query, and bounds both the original and
redirected tagged URLs to 4,096 bytes. The current/pending hop lives under one
mutex; claiming the next hop consumes its admission. Old handler callbacks,
duplicate claims and stale same-URL redirects cannot regain the new epoch.
Invalid redirects revoke the permit, and shutdown/navigation revocation cannot
reactivate it. UI callbacks still require an admitted permit, exact original URL,
current document/browser/session authority and the existing byte limits.
No renderer-provided filename or callback metadata can create a destination
grant. Native file dialogs cancel explicitly, and OS-file drag/drop is denied.
The default context menu retains navigation/edit/find commands only; file save,
print, developer/source, and unknown commands are consumed. Registered
application menus must preserve those fences.

CEF documents a significant close behavior: browser destruction stops download
callbacks but can allow the transfer to continue silently. Bunly therefore keeps
the browser, view, and session owners alive while cancellation settles. A close
continuation resumes only after the terminal callback, owned temporary-file
cleanup, callback release, and timer-worker release. Quit uses the existing global
deadline as well as the per-operation cancellation bound. Unexpected owner
destruction or an unacknowledged cancellation cannot produce a clean shutdown.

At the existing final UI fence, the host emits one bounded `download.shutdown`
private receipt and the independent `bunly.host.download-shutdown` diagnostic.
They count admissions, actual terminal callbacks, settled outcomes, and remaining
Bunly-owned transfers, callbacks, staging handles, and deadline workers. Successful
shutdown requires matching terminal/outcome counts and zero owned resources.
These are Bunly ownership counts, not a claim about every Chromium internal
reference. The ordinary process exit, CEF shutdown, and output-drain gates still
apply.

A newly denied native download callback emits one `bunly.host.download-denied`
diagnostic with fixed phase and reason labels. It distinguishes missing native
request admission, revoked authority, rejected network policy, and unavailable
staging without retaining URLs, destination paths, request secrets, payloads,
or filesystem exception text. It does not turn a denied transfer into a pass.
Fixture failure receipts additionally distinguish exact known protocol,
deadline, and readiness errors with fixed labels. Unknown error messages,
paths, URLs, stacks, causes, names, and codes are not exported by those receipts.

An operation deadline emits at most one `bunly.host.download-timeout` diagnostic
before normal cancellation. It records the last valid, exactly bound CEF
callback's fixed state flags, byte counters, percent complete, callback phase and
count. `pathState` is only `empty`, `owned-stage`, `other`, or `unavailable`; it
never contains a pathname. A missing callback is `null`, unknown percentages are
`null`, and native interruption reasons use a fixed label set. No CEF item is
retained or polled for this receipt.

`quarantineObservedLaunches` counts exact Chromium quarantine utility launches
observed anywhere in this application since the operation's admission. A
saturated/unavailable delta is `null`. The read-only child-launch callback
recognizes only `type=utility` and
`utility-sub-type=quarantine.mojom.Quarantine`; it retains neither switch text nor
argv. In a fixture with one transfer, an observed launch distinguishes entry to
Chromium's completion/annotation pipeline from earlier transfer gates. It does
not prove that Windows Attachment Services is blocked, that the service is still
running, or which transfer caused a launch when operations overlap. The native
deadline, cancellation, antivirus behavior and cleanup rules remain unchanged.

## Destination and filesystem guarantees

Destinations have a single 1–128 character portable ASCII filename. Separators,
traversal, leading dots, trailing dots, device names, and ambiguous case aliases
are rejected. Roots must exist and be owned by the current user. Unix roots
cannot be writable by another user. Windows roots must have an explicit DACL that
does not give write access to another unprivileged identity; System and
Administrators retain their normal privileged status. Windows volumes must
support persistent ACLs and named streams. Unsupported roots fail explicitly.

The adapter opens the root without following symlinks or reparse points and
creates an exclusive private staging directory inside it. CEF receives the empty
staging target, never the final user destination. Chromium creates its own initial
temporary file and later moves it to that target; pre-creating a placeholder would
cause Chromium's rename-and-uniquify behavior to select a different name. After a
terminal callback, Bunly opens and verifies the actual regular, single-link file,
checks its size, flushes it, and publishes it atomically within the pinned root.
Chromium applies umask-derived POSIX permissions during its move; a resulting
0644 file remains contained by the 0700 stage. Before publication, Bunly tightens
the verified open inode to 0600 with `fchmod`, revalidates the inode/path and mode,
and then flushes it. This preserves extended attributes and quarantine metadata.

`overwrite: 'deny'` uses an atomic no-replace operation. A destination that appears
during the transfer is preserved and the download fails. `overwrite: 'replace'`
is explicit and permits replacing only a regular single-link target. Directories,
links, reparse points, and aliases are rejected. Failed or cancelled downloads
never publish partial final content.

Unix placement and cleanup use directory-relative operations with no-follow
checks. Windows pins the root ancestors and staging directory against renaming,
uses a protected per-user staging DACL, and publishes through a source handle
with root-relative `FILE_RENAME_INFORMATION` through the documented user-mode
`NtSetInformationFile` entry point. This keeps the verified destination directory
handle authoritative. The hosted Windows Server 2022 run rejected the relative
form in the Win32 `SetFileInformationByHandle` wrapper. The move preserves the downloaded file
and its existing platform metadata, including extended attributes and Windows
named streams. The adapter does not strip quarantine metadata, claim to scan
downloads for malware, or claim that CEF creates quarantine metadata on every
platform and configuration.

The remaining race boundary is explicit: CEF accepts a pathname rather than an
already-open destination handle. These checks are not an isolation boundary
against a malicious process running as the same OS user, an administrator, or a
filesystem that does not honor the documented primitives. Such a process can
race pathname access or change owned directory permissions. Atomic no-replace
still protects an existing final target, and cleanup never recursively erases
unknown entries or follows a replacement link. If ownership cannot be verified,
cleanup fails under its deadline and preserves evidence. Bunly removes only its
exclusive staging directory and verified payload; Chromium owns any earlier
temporary files it created elsewhere.

## Qualification and remaining work

`tests/downloads.test.ts` tests portable parsing, immutable inputs, capability
negotiation, coalesced pipe delivery, stale document admission, cancellation
ownership, listener limits, transport loss, and native receipt validation. Native
unit tests use temporary directories for collisions, explicit replacement, links,
root renaming/pinning, unrelated-entry preservation, and platform metadata
retention. Linux extended attributes, macOS quarantine attributes, and Windows
`Zone.Identifier` streams are checked with the actual filesystem APIs.

`examples/file-downloads` is the native fixture. The shared desktop qualifier
selects it with `--case=downloads`, bundles `fixture.ts` as
`backend/application.js` and `client.ts` as `public/client.js`, and copies `public/`
alongside the ordinary bootstrap. It opens only its own numeric-loopback servers
and creates one private temporary directory. The remote page has no application
RPC grant. Scope capture waits for actual native `view.loaded` for the exact
document. No mock transfer, Bun fetch fallback, browser evaluation helper, or
synthetic byte counter substitutes for CEF.

The bounded fixture requires 14 admitted transfers: three successful files,
seven cancellations, and four failures. It checks actual bytes and SHA-256 for
successful small/large/redirected downloads, ignored malicious suggested names,
duplicate preservation, explicit overwrite, traversal and grant denial, blocked
redirects, limits, timeout, interrupted responses, AbortSignal, navigation,
renderer reload, view/window closure, and active-quit cancellation. A settled-zero
native baseline and final-zero SDK state are separate from `nativeBeforeQuit`,
which deliberately owns the last active transfer. The exact native terminal and
resource-release receipt must precede ordinary shutdown. The final application
receipt is `bunly.native.file-downloads` schema 1, emitted only after
`await backend.dispose()` and bounded to the existing 16 KiB diagnostic limit.
The application-quitting callback also requests cancellation of that last owned
transfer; its small id-bound control command remains available during shutdown
while new transfers, grants and other native work stay fenced.

The fixed workload deadline remains 25 seconds and the process-tree observer
remains 45 seconds. `benchmarks/desktop/downloads-acceptance.ts` checks every
ordered outcome, the known successful content digests, positive native progress
before cancellation, and the unique independent `bunly.host.download-shutdown`
receipt: exactly 14 admissions and terminal callbacks, three completed files,
seven cancellations, four failures, and zero owned transfers, callbacks, staging
handles and deadline workers. That native receipt must precede ordinary process
shutdown. Failed or missing callbacks cannot be replaced by a fixture success flag.

The `file-downloads` stage is required in the full hosted matrix on macOS ARM64,
Windows x64 and Linux x64 before later credential/provider stages. It uses the
same source fingerprints, artifact identity, metadata, output drain and native
shutdown gates as the other desktop cases, including the disposable Xvfb/Openbox
wrapper on Linux. The M4-only suite and historical desktop profile inventories
remain unchanged. Reports include bounded counters, fixed labels, opaque native
document identities and content digests; the workload receipt excludes payloads,
destination paths and source URLs. Failure labels identify a fixed workload phase
and error kind without exporting filesystem exception messages.

The disposable Windows worker creates a fresh protected temporary directory for
its standard user. It verifies the owner and DACL before launching the suite:
only that user, SYSTEM and Administrators receive inherited access. A temporary
directory beneath the shared checkout would otherwise retain the build account's
writable grant, which the native download policy correctly rejects. The fixture
does not relax that policy or change permissions on an existing user directory.

See [native desktop qualification](desktop-qualification.md#file-downloads) for
launch and offline replay commands.

Actual macOS, Windows, and Linux execution against the packaged pinned host is
required before advertising this increment as qualified. Cross-compilation and
CEF `dox` API checks only establish compilation. Physical input, hardware DPI,
assistive technology, antivirus integration, and performance remain unqualified.
Uploads/file inputs need a native picker with completion-time document/frame
revalidation; returning CEF's default dialog is insufficient because that callback
does not expose the requesting frame and does not provide the needed completion
ownership. OS-file drag/drop needs its own declared scoped access design.

## Pinned implementation references

The adapter was authored for Bunly; no upstream implementation was copied.

- [CEF download callback contract at g47dbc1d](https://github.com/chromiumembedded/cef/blob/47dbc1d/include/cef_download_handler.h)
- [CEF StartDownload at g47dbc1d](https://github.com/chromiumembedded/cef/blob/47dbc1d/libcef/browser/browser_host_base.cc)
- [CEF request classification at g47dbc1d](https://github.com/chromiumembedded/cef/blob/47dbc1d/libcef/browser/net_service/resource_request_handler_wrapper.cc)
- [CEF proxy request IDs and redirect restarts at g47dbc1d](https://github.com/chromiumembedded/cef/blob/47dbc1d/libcef/browser/net_service/proxy_url_loader_factory.cc)
- [CEF request identifier storage at g47dbc1d](https://github.com/chromiumembedded/cef/blob/47dbc1d/libcef/common/request_impl.cc)
- [Chromium 156.0.8078.17 zero-ID resource downloader](https://github.com/chromium/chromium/blob/156.0.8078.17/components/download/internal/common/resource_downloader.cc)
- [CEF download/browser ownership at g47dbc1d](https://github.com/chromiumembedded/cef/blob/47dbc1d/libcef/browser/download_manager_delegate_impl.cc)
- [Chromium 156.0.8078.17 download lifecycle and annotation](https://chromium.googlesource.com/chromium/src/+/refs/tags/156.0.8078.17/components/download/internal/common/download_item_impl.cc)
- [Chromium 156.0.8078.17 destination permission handling](https://chromium.googlesource.com/chromium/src/+/refs/tags/156.0.8078.17/components/download/public/common/download_file_utils.cc)
- [Windows FILE_RENAME_INFORMATION](https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/ntifs/ns-ntifs-_file_rename_information)
- [Windows NtSetInformationFile](https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/ntifs/nf-ntifs-ntsetinformationfile)
