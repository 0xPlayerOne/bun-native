# Application links and external URLs

The CEF adapter exposes a bounded application-link inbox and a separate HTTPS
submission API. Each needs native document authority. A link's routing match does
not make its query trusted, and neither operation grants access to the browser
bridge, arbitrary files, a shell, or another application's process.

## Configured inbound routes

An explicitly prepared native application's `runtime.json` may contain:

```json
{
  "application_links": {
    "schema": 1,
    "routes": [{ "scheme": "example-app", "host": "open", "path": "/item" }]
  }
}
```

The configuration is restart-only. The framework validates it before browser
startup. It allows up to eight distinct exact routes and 2,048 encoded bytes.
Schemes and hosts use bounded lowercase ASCII; paths exclude dot segments,
alternate encodings and repeated separators. Common web/file/script schemes are
reserved. URLs must be canonical ASCII, at most 2,048 bytes, with no credentials,
port, fragment, control characters, backslashes or malformed percent escapes.
The query remains untrusted input for the application to interpret.

The installed host accepts explicitly named `--bunly-link=URL` startup arguments.
On macOS, a configured host also owns an AppKit `application:openURLs:` delegate
when the application's delegate slot is empty. An occupied slot is an explicit
startup failure; the adapter does not overwrite or chain an unknown delegate.
Removal clears only its own delegate and precedes native shutdown.

This does not register an OS protocol handler, edit Launch Services or the Windows
registry, forward a second instance, or implement application reopen/relaunch.
Windows/Linux have the startup-input path; they have no live OS link callback in
this increment. The macOS callback adapter still requires actual platform
qualification. A declaration alone does not prove OS delivery.

## Reading and acknowledging

```ts
const scope = await backend.capturePolicyScope(view)
await backend.grantNativeCapability(scope, { name: 'application-links' })
const reader = await backend.createApplicationLinkReader(scope)
const batch = await backend.readApplicationLinks(reader)
for (const link of batch.links) {
  // Validate the query for this application's operation before processing it.
  await handleApplicationInput(link.url)
}
await backend.acknowledgeApplicationLinks(reader, batch)
await backend.disposeApplicationLinkReader(reader)
```

There is one native reader for the application. Its token is bound to the exact
native view, session, document, main frame and creation incarnation. Handles and
read batches are opaque SDK identities; copying an ID grants no authority. Read
and acknowledgment revalidate document authority natively. Only the latest
authentic batch can acknowledge its native snapshot; arrivals after that snapshot
remain queued. Disposal, cancellation, navigation and view closure release the
reader while preserving unacknowledged input for a later authorized reader.

The queue retains at most 16 entries and 16 KiB of URL text. It never evicts an
accepted entry to make room. Rejected arrivals at capacity increment the batch's
bounded overflow count; acknowledging a snapshot clears only that snapshot's
overflow. Diagnostic counters saturate at the protocol's largest safe integer.
No unbounded callback subscription or automatic polling is installed.

`ManagedDesktopResources.registerApplicationLinks` gives replacement generations
an `events`/`ack-events` journal. The stable owner copies the complete native
snapshot into its bounded journal **before** destructive native acknowledgment.
Insufficient journal capacity leaves native entries unacknowledged. A failed ACK
is retried using its original receipt before a new read; entries are not copied
again. Retiring a generation cannot erase the transfer. A replacement must read
its journal before acknowledging it; old generations cannot consume its events.
Native reader disposal still waits for its actual native cleanup reply.

## External HTTPS submission

```ts
await backend.grantNativeCapability(scope, {
  name: 'external-url',
  origins: ['https://example.com'],
})
await backend.openExternalUrl(scope, 'https://example.com/help')
```

The separate native grant permits exact HTTPS origins. The URL must already be
canonical and bounded, without credentials, fragments, controls or malformed
escapes. macOS submits through `NSWorkspace.openURL`; Windows uses the fixed
`open` verb with `ShellExecuteExW`, no parameters, environment expansion, chosen
application, process handle or security-zone bypass. Linux and the mock report
`UNSUPPORTED_CAPABILITY`. Success means the OS accepted submission, not that a
browser opened, navigated, or loaded the page. Applications must not replay this
external effect to simulate rollback or a managed reload.

## Validation boundary

Portable regressions cover canonical routing, exact authority, opaque latest-read
ACKs, queue bounds, cancellation and navigation, malformed native receipts,
managed retirement, overflow and ACK retry. Native registry tests independently
cover byte/entry capacity, late arrivals and stale reader incarnations.

`bun scripts/qualify-desktop.ts PREBUILT_APP --native-source=COMMIT --case=links`
prepares a copy of an explicitly selected prebuilt host, adds one fixed route and
passes three controlled startup arguments. The fixture requires two accepted and
one rejected argument, managed replay, denied external submissions, native
navigation retirement, and zero reader/delegate owners at shutdown. It never
registers a handler or opens a real external URL. The 25-second workload and
45-second observer deadlines are unchanged.

The bounded startup-link fixture passed on macOS; [PR #145](https://github.com/0xPlayerOne/bunly/pull/145)
records its exact source and native artifact, alongside earlier failed attempts.
Live OS URL delivery, successful external browser submission, second-instance
forwarding, physical input and release signing remain unqualified. A parser
regression or cross-compilation is not evidence that these platform operations ran.
