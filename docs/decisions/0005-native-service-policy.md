# ADR 0005 — Native service policy and owned-window display reads

Status: accepted architecture; native qualification pending

Date: October 31, 2026

Related: [#255](https://github.com/0xPlayerOne/bun-native/issues/255),
[#252](https://github.com/0xPlayerOne/bun-native/issues/252),
[#250](https://github.com/0xPlayerOne/bun-native/issues/250)

## Context and decision

Solid and React require one shared native-service boundary. A rendering
capability does not grant access to files, processes or another application's
clipboard. Opaque window handles must also lose service authority when their
window or application closes. Trusted Bun applications retain their ordinary
OS authority; this policy does not claim to sandbox that code.

Use explicit immutable application launch permissions, reported by native
readiness and checked against the request. The first operation is
`NativeWindow.displaySnapshot()`, backed by GPUI's current display and scale
accessors on its UI thread. It is default-denied, scoped to the owned live
window and uses the existing serialized queue, bounded private channel and
shutdown lifecycle. Protocol 5 deliberately replaces protocol 4 and requires
`window_display_v1`. No wire command can self-grant a service.

The public capability record reports all requested desktop-service categories.
Only the implemented display method is callable. Unsupported services report
`not_implemented` and have no placeholder execution API. A specific allowed
display read may still be unavailable in the actual native environment.

## Alternatives and tradeoffs

Clipboard text was considered first. The pinned desktop default async reader
delegates to a synchronous call; X11 selection reads can wait and extend their
transfer timeout, while its void write API suppresses operation errors into
logging. It therefore cannot yet provide the intended bounded cancellation
and truthful result contract by merely forwarding GPUI calls. A focused
clipboard follow-up must solve that native integration, without browser APIs
or fabricated cached results.

Display information is smaller and does not change user data. It still
exercises policy, host dispatch, owner resolution, native data, strict response
validation, cancellation and teardown. The result intentionally follows
GPUI's platform display semantics. In the pinned X11 backend, a display is an
X screen spanning monitors; it is not a portable physical monitor identity.
Do not export extra display concepts before implementing and testing them.

Cancellation before dispatch sends no request. Cancellation after dispatch
drains and validates the response, then withholds delivery. It does not abort
synchronous OS work. Closing the owner has the same delivery-revocation
effect. This keeps the single channel coherent and avoids a speculative
native cancellation registry for a read that creates no persistent resource.

## Consequences and verification

Applications pin the shared packages and native host together. The runtime
rejects old versions, absent capabilities and mismatched launch policy. Both
parsers validate bounds and owner IDs. The public result is deeply frozen.
Policy denial is a recoverable typed service error; malformed responses fail
the channel even after caller cancellation.

The [service contract](../native-services.md) defines exact errors, permission
scope, platform status, deferred services and the Adea path. Shared parser
cases and real-process peer tests cover validation/lifecycle; the actual
native fixture separately requires an OS click, independently checked display
dimensions, matching complete native paint and clean shutdown in development
and inspected AOT. Native results are pending and may not be inferred from
the headless tests. No new runtime dependency or framework-specific native
implementation is introduced.
