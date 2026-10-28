# Programmatic file interactions

The optional `ProgrammaticFilesBackend` facet transfers one bounded file from
trusted Bun application bytes into an explicitly approved element in the current
browser document. `CefBackend` implements file-input assignment and synthetic
DOM drag/drop. The contract carries a portable filename, MIME type and bytes;
it accepts no filesystem path, directory, CEF callback or raw protocol target.

This is the programmatic portion of issue #36. Native OS file selection, physical
file drags, directory uploads and shipping-adapter qualification remain separate
work. A page can distinguish the synthetic events through `isTrusted === false`.
Remote pages retain their remote trust classification and gain no native file
read capability or application RPC authority.

## Explicit development gates

The nondefault `programmatic-files` Cargo feature is independent of
`browser-actions`. It additionally requires an exact numeric-loopback
`development_origin` and `development_programmatic_files: true` in the installed
`runtime.json`. No command-line argument or environment variable enables it.

| Profile          | Native feature | Development origin | File manifest opt-in | Result                             |
| ---------------- | -------------- | ------------------ | -------------------- | ---------------------------------- |
| enabled          | yes            | yes                | yes                  | File facet is advertised           |
| feature-disabled | no             | yes                | yes                  | Exit 78 before Bun/browser startup |
| ordinary         | yes            | no                 | yes                  | Exit 78 before Bun/browser startup |
| manifest-denied  | yes            | yes                | no                   | Exit 78 before Bun/browser startup |

The ordinary host without a compiled feature or manifest opt-in retains its
existing behavior and advertises neither `view.file-input` nor `view.file-drop`.
Enabling both optional Cargo features requires both manifest opt-ins. The file
qualifier below uses a file-only feature artifact so it can test these gates
independently.

## Application API

```ts
const scope = await backend.capturePolicyScope(view)
await backend.grantNativeCapability(scope, {
  name: 'file-input',
  elementId: 'upload',
})
const operation = await backend.prepareFileInteraction(scope, {
  kind: 'file-input',
  elementId: 'upload',
  file: {
    name: 'notes.txt',
    type: 'text/plain',
    bytes: new TextEncoder().encode('Application-approved contents'),
  },
}, { signal })
const result = await operation.commit()
```

Preparation copies the caller's typed-array bytes synchronously, before the first
asynchronous call, and sends ordered chunks with an exact SHA-256. The returned
operation stages the file privately. `commit()` rechecks authority and submits
the synthetic interaction; `cancel()` and `completed` settle only after native
cleanup. Passing an abort signal requests the same cancellation, including when
admission is still in flight. Repeated commit/cancel calls retain one operation.

`file-input` and `file-drop` are separate native grants. Each matches one exact
element ID in one captured document; an upload grant cannot authorize a drop,
another element, another view or another session. IDs match
`[A-Za-z][A-Za-z0-9_-]{0,127}`. Selectors, child-frame targets and duplicate IDs are
rejected. Navigation, reload, revocation or close invalidates the captured scope;
returning to the same URL does not restore it.

A file-input target must be a connected, enabled main-document
`input[type=file]`, without `webkitdirectory`. The adapter assigns one File and
dispatches synthetic `input` then `change`. The drop target must be one connected
main-document element other than a frame, object or embed. It receives synthetic
`dragenter`, `dragover` and `drop` events containing that File. Target connection,
identity, document URL and input eligibility are rechecked between events. DOM
handlers may run, mutate the target and initiate network requests; those effects
cannot be rolled back.

Results distinguish `completed`, `cancelled` and `failed`. `failure` is one of
`stale-target`, `permission-denied`, `unsupported-capability`, `payload-too-large`,
`timeout` or `adapter-error` for failures, otherwise null. Every result explicitly
marks `synthetic: true` and conservatively sets `mayHaveExposedFile` after native
commit submission. A failed or cancelled commit can still have exposed a File or
started a request. Completion confirms the interaction and native cleanup; it is
not a server upload receipt or an application transaction guarantee.

## Bounds and native ownership

| Resource                     | Bound                                                                                                   |
| ---------------------------- | ------------------------------------------------------------------------------------------------------- |
| File bytes                   | One file, from zero through 1 MiB                                                                       |
| Filename                     | 1–128 portable ASCII characters; no path separators, controls, trailing dot or reserved device basename |
| MIME type                    | Explicit lowercase ASCII type/subtype, at most 127 characters; no parameters                            |
| Transfer                     | Ordered chunks of at most 8 KiB, SHA-256 checked before commit                                          |
| Joint byte reservation       | Twice the file size plus 256 KiB overhead                                                               |
| Shared view-control capacity | 8 MiB and at most eight operations per transport; one file or browser controller per view               |
| Native callbacks             | At most 16 KiB; depth 16 and 2,048 structural tokens checked before parsing                             |
| Operation ownership          | Eight seconds including staging and cleanup                                                             |

The SDK checks typed-array intrinsic length and brand, rejecting shared, detached
and forged buffers before copying. Admission is reserved before any asynchronous
scope capture or native operation. File and browser controllers use the same
capacity owner in both SDK and native registries.

The byte reservation covers Bunly-owned payloads across the two halves. Staging
holds the SDK snapshot and private-world bytes; the SDK drops its snapshot before
exposing the commit closure. Commit holds private-world bytes and the constructed
File. Bounded wire chunks, parsing and operation metadata fit the additional
overhead. Caller buffers, Files retained by the page, allocator metadata, garbage
awaiting collection and CEF internals have separate lifetimes. These accounting
bounds are not process RSS limits or promises of immediate garbage collection.

The CEF adapter discovers the actual main-frame ID and system-unique execution
context in an isolated world. It retains the native browser, exact document
scope, observer registration, outstanding callback, private controller and
deadline worker. No controller is installed as a global binding. Fixed private
methods cannot execute a caller-supplied expression or read a disk path.

After the final result, the private controller is cleared, its object group is
released, and `Runtime.disable` is acknowledged before the observer is removed
and the terminal receipt is sent. An unexpected detach or failed cleanup keeps
the owner charged until the exact browser's actual `OnBeforeClose`. The first
such transition schedules one UI continuation so an already parked view,
window or application close can progress. Duplicate detach callbacks cannot
queue unbounded retries. A stuck operation closes only its owned browser at the
existing eight-second operation deadline; production shutdown deadlines are
unchanged.

The SDK likewise holds capacity until both the native terminal receipt and all
outstanding local chunk/commit calls settle. Successful but malformed protocol
receipts fail the transport before releasing the reservation. Native diagnostics
contain fixed counters and reason codes, without file bytes, paths, callback
payloads or raw protocol errors.

## Qualification

First build and test the ordinary host from the committed source and preserve
its prepared application. Then build a separate host from the same native tree
with `--features packaging,programmatic-files`. Do not enable `browser-actions`
for this file-only artifact. Ordinary tests precede optional-feature checks;
CI additionally checks file-only and combined feature compilation/lifetimes.

```sh
bun run qualify:programmatic-files \
  /absolute/ordinary-app-directory \
  /absolute/programmatic-files-app-directory \
  --native-source=FULL_COMMIT_SHA
```

The qualifier accepts existing native applications and never compiles native
code. On macOS the two directories are `.app` bundles; other platforms use a
directory containing the prepared host and native siblings. Run in a standard
user's disposable actual GUI session. The qualifier copies its inputs and uses
the existing ad-hoc fixture signing workflow where required.

The enabled fixture requires five actual multipart HTTP uploads to a temporary
numeric-loopback server: text, the exact 1 MiB boundary, empty data, another
cookie partition and synthetic drop. It verifies filenames, MIME types, byte
lengths, hashes, cookie isolation and untrusted events. Additional cases exercise
missing/wrong grants, cancellation before commit, same-URL reload, navigation,
closing a prepared view and a page handler replacing the input between `input`
and `change`. The last case must report partial exposure without inventing
rollback or a sixth successful upload. All native callbacks, private controllers,
object groups, chunk buffers, deadlines and shared local reservations must return
to zero before final teardown.

The other three process profiles require exit 78 before the application fixture
starts. Reports retain source hashes, immutable input and prepared inventories,
actual CEF identity, bounded receipts and process cleanup. A portable receipt
validator test is not native execution evidence. This implementation checkpoint
does not claim actual GUI, OS picker, physical drag, assistive technology or
performance qualification; those results must be recorded separately.

Native observer and protocol references are the pinned CEF
[`CefBrowserHost`](https://github.com/chromiumembedded/cef/blob/47dbc1df023e99f006fb9e850a8d83cc19b4fdd9/include/cef_browser.h)
and
[`CefDevToolsMessageObserver`](https://github.com/chromiumembedded/cef/blob/47dbc1df023e99f006fb9e850a8d83cc19b4fdd9/include/cef_devtools_message_observer.h)
contracts. The implementation uses the private Runtime and Page methods already
described in [browser actions](browser-actions.md), with no public CDP endpoint.
