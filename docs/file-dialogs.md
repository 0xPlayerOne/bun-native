# Scoped native file dialogs

`CefBackend` exposes an optional `dialog.file` facet for trusted Bun application
code. It selects one file path through a native panel; it does not read a file,
write a file, authorize an upload, grant a download root, or create a filesystem
capability. A renderer never receives this API or its native scope token.

## Current platform scope

| Platform    | Implementation                                               | Native qualification                                       |
| ----------- | ------------------------------------------------------------ | ---------------------------------------------------------- |
| macOS ARM64 | Owned `NSOpenPanel` / `NSSavePanel` sheets, single selection | Pending actual native execution of the cancel-only fixture |
| Windows x64 | Explicit `UNSUPPORTED_CAPABILITY`                            | No dialog implementation claim                             |
| Linux x64   | Explicit `UNSUPPORTED_CAPABILITY`                            | No dialog implementation claim                             |

Mock and system-webview backends do not advertise the facet. The existing
window, clipboard, lifecycle, download and composition capabilities retain their
own platform matrices. This increment does not finish issue [#34](https://github.com/0xPlayerOne/bunly/issues/34)
or file-input/drag-and-drop issue [#36](https://github.com/0xPlayerOne/bunly/issues/36).
Native cancellation qualification will not qualify user selection, physical
keyboard behavior, assistive technology, or file-input uploads.

## Application API

Capture the scope after the native document is ready. The stable Bun host grants
only the operation it intends to expose:

```ts
const scope = await backend.capturePolicyScope(view)
await backend.grantNativeCapability(scope, { name: 'dialog-open' })
const cancellation = new AbortController()
const result = await backend.showOpenFileDialog(
  scope,
  { directory: ownedDirectory, title: 'Choose a file' },
  { signal: cancellation.signal }
)
if (result.status === 'selected') {
  // result.path is a path string, not a file-access grant.
}
```

`showSaveFileDialog` requires the separate `dialog-save` grant and a
`suggestedName` basename. Its result has the same shape. Choosing a path never
creates or overwrites that path. Any subsequent write or download must use its
own explicit authorization and overwrite policy.

The starting `directory` is explicit and absolute. It does not restrict where a
user may navigate inside the panel and is not advertised as a filesystem
sandbox. Titles are at most 256 UTF-8 bytes; suggested names are at most 255;
directory and returned path strings are at most 4096. Control characters, NUL,
unpaired UTF-16 surrogates, path traversal components, unexpected fields, and
separator-bearing suggested names are rejected. The initial surface has no
multiple selection, directory selection, filter grammar, arbitrary accessory
view, automatic file creation, or default-path fallback.

The owning native window must be visible and restored. A window menu and a file
dialog share one native modal reservation. Starting another panel or popup while
that reservation is held returns `RESOURCE_IN_USE`; a cancellation request does
not free it.

## Authority and completion

The scope is an opaque object tied to the exact native view, session, generation,
main frame, document and origin. Native grant checks run before panel
preparation, immediately before showing it, and before returning a selected
path. The SDK independently checks its captured scope when delivering a
selection. Fabricated or stale objects never become authority by copying IDs.

An abort returns `{ status: 'cancelled' }` only after actual native completion.
Aborting before admission still observes admission and sends a cancellation to
the exact operation. A late selected path is discarded after abort. Navigation,
view closure, window closure and application quit revoke the pending operation;
its result rejects with `PERMISSION_DENIED` and its path is withheld. View and
window destruction wait for the panel completion before releasing the owner.

`ManagedDesktopResources.registerFileDialogs` provides `open` and `save`
operations under schema `bunly.dialog:1`. A generation's abort signal cancels
its active panel. The managed owner keeps the request and resource charged until
the native completion event arrives, even though the retired generation's
application-facing promise has already rejected. Replacing a generation cannot
free the modal slot early or deliver an old selected path to the replacement.

AppKit documents that its sheet completion can run while the sheet is still
onscreen. The adapter calls `orderOut`, verifies visibility is false, then
releases the exact modal token and posts the owner-close continuation to a later
UI task. The panel and its `NSWindow` remain owned through that completion. The
completion block captures no CEF object. Host release fences late AppKit
callbacks before CEF shutdown; an outstanding owner at that point marks shutdown
failed and remains charged. Existing cleanup and shutdown deadlines are not
extended.

## Why CEF's default picker stays denied

The pinned CEF is `156.0.7+g47dbc1d+chromium-156.0.8078.17`, commit
`47dbc1df023e99f006fb9e850a8d83cc19b4fdd9`.
Its [RunFileDialog declaration](https://github.com/chromiumembedded/cef/blob/47dbc1df023e99f006fb9e850a8d83cc19b4fdd9/include/cef_browser.h)
provides an asynchronous dismissal callback without a public cancellation
handle. The [dialog handler](https://github.com/chromiumembedded/cef/blob/47dbc1df023e99f006fb9e850a8d83cc19b4fdd9/include/cef_dialog_handler.h)
receives a browser and dialog arguments, without the requesting frame or an
opaque trusted-operation token. Its [implementation](https://github.com/chromiumembedded/cef/blob/47dbc1df023e99f006fb9e850a8d83cc19b4fdd9/libcef/browser/file_dialog_manager.cc)
can invoke the handler twice while routing through Chromium's file chooser.
Authorizing whichever picker happens to arrive while a trusted call is pending
would not preserve document or request identity.

The AppKit adapter therefore owns its native panel directly. CEF renderer file
pickers, OS file drops, default Save/Print/View Source commands, and browser
uploads remain denied by `file_guards.rs`. The adapter resolves the CEF window
handle correctly: pinned [view_util_mac.mm](https://github.com/chromiumembedded/cef/blob/47dbc1df023e99f006fb9e850a8d83cc19b4fdd9/libcef/browser/views/view_util_mac.mm)
returns an `NSView*`; the adapter retrieves and retains its actual `NSWindow`.

AppKit references:
[beginSheetModal](<https://developer.apple.com/documentation/appkit/nssavepanel/beginsheetmodal(for:completionhandler:)>),
[cancel](<https://developer.apple.com/documentation/appkit/nssavepanel/cancel(_:)>),
and [NSOpenPanel](https://developer.apple.com/documentation/appkit/nsopenpanel).
The Rust bindings are the already pinned objc2/AppKit versions; `block2` 0.6.2
was already present in the lock and is now a direct target-specific dependency
for the native completion block. No upstream implementation was copied.

## Contributor qualification

Build a clean immutable contributor host with `packaging,rpc-qualification`
and the ordinary sandbox feature, then run:

```sh
bun scripts/qualify-desktop.ts PREPARED_APP --native-source=COMMIT --case=dialogs
bun scripts/qualify-desktop.ts --verify REPORT
```

On Linux the existing private Xvfb/Openbox wrapper accepts
`--desktop-case=dialogs`. This uses the existing 45-second process observer and
its existing outer guard; the fixed fixture has a 25-second deadline including
cleanup. It neither changes host timeout profiles nor launches an application
compiler for an ordinary consumer.

`examples/file-dialogs/fixture.ts` creates one private temporary directory and
never creates, selects, reads or writes a file. On macOS it observes six actual
visible native panels and their completion callbacks: open cancellation, save
cancellation, managed retirement, navigation, view disposal and application quit.
It requires missing-grant denial, all six native callbacks, zero selections,
three ordinary cancellations, three revocations, an empty unchanged directory,
and zero final native panel ownership. Windows/Linux require explicit unsupported
errors and zero admissions or callbacks.

The native contributor receipt contains counts and visibility only. Paths,
titles and selected file data are absent. A private shutdown receipt must match
the native stderr receipt; both precede the application receipt, which is emitted
after controlled backend disposal and before backend exit. The acceptor also
uses the existing source inventory, binary hashes, unchanged artifact,
standard-user, real CEF identity and descendant-cleanup checks. A failed attempt
must be retained and replayed as a failure. The temporary directory is removed
only after controlled native shutdown; failed cleanup retains an explicit failed
outcome.

The hosted `full` suite runs this profile after downloads on every declared
target and collects both failed and unsupported reports. The exact-source,
artifact and shutdown gates remain prerequisites for later provider checks.
Real native execution remains required before marking macOS qualified.
Separate disposable integration tests must validate selection
of only owned temporary files and independent reads/writes; this cancel-only
profile makes no selection-correctness claim. Windows `IFileDialog` and a Linux
portal adapter need independent cancellation and callback-lifetime proofs before
advertising support.
