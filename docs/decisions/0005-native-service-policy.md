# ADR 0005 — Native service policy and owned-window display reads

Status: accepted architecture; core/Solid/React Linux development/AOT service
qualification passed locally with a development-profile host, and later with a
hosted release-profile host (see the
[hosted source-bound record](../../tests/native/evidence/services-linux-hosted-release.json)
and [native services](../native-services.md)). Other-platform service
qualification remains pending.

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
and inspected AOT. The [source-bound native record](../../tests/native/evidence/services-linux-development-aot.json)
reports six successful core/Solid/React scenarios on one isolated Xvfb
screen with a development-profile host. It does not qualify release-host,
other-platform or mixed-DPI/global-monitor behavior; those checks remain
separate from the headless tests. No new runtime dependency or
framework-specific native implementation is introduced.

## Display semantics follow-up (#299)

Date: 2026-11-05.

The snapshot keeps its two fields. On the pinned X11 backend it is defined as
the host connection's X screen in logical pixels plus the process-wide scale
resolved at connection time; window movement within a screen and later
`Xft.dpi` changes do not alter it. A real two-screen Xvfb fixture checks this
against `xdpyinfo`/`xwininfo` in development and inspected AOT
([contract](../native-services.md#qualified-x11-display-semantics-299)).

No display-change subscription, work area, monitor identity or per-monitor
scale is added. The pinned X11 backend does not deliver display changes to a
window, reports no work area distinct from the screen bounds, exposes only the
screen index with an all-zero UUID, and has a single scale per process. Adding
those fields would publish values the platform layer cannot supply. They
remain unavailable until a backend that reports them (for example GPUI's
Wayland output events, macOS or Windows) can be exercised natively.

### macOS and Windows (#299)

GPUI's macOS and Windows backends do supply a work area, an OS display
identifier and window display notifications, so they are added there as two
optional capabilities instead of a protocol version change:
`display_details_v1` (optional `visible_bounds` / `display_uuid` snapshot
fields) and `display_changes_v1` (a sequenced `display_changed` event per
owned window). Both sit under the existing `window_display` launch grant, so
no new permission or wire command exists; the host observes a window only
when that grant is present, and drops the observation with the window. The
core rejects either from a host that did not advertise it. Linux keeps the
two-field snapshot. Native acceptance is the hosted macOS/Windows workflow run
only ([contract](../native-services.md#macos-and-windows-display-semantics-299)).
The hosted runners have one display; on macOS a separate step adds a
CoreGraphics virtual display for window migration, mixed DPI and display
removal ([contract](../native-services.md#macos-virtual-second-display-299)),
while on Windows they stay unverified.

### Display identity (#299)

The display identifier was first part of `display_details_v1`. GPUI's Wayland
backend names each output (v5 of its `wl_output.name`) but has no work area,
so the identifier moved to its own optional `display_identity_v1` capability
(`serviceCapabilities.windowDisplay.identity`), advertised on macOS, Windows
and when GPUI's compositor is Wayland. `display_details_v1` now carries only
the work area. Like the others it sits under the `window_display` grant and
did not change the protocol version; the core rejects an identity from a host
that did not advertise it. X11 advertises neither: its display is the X screen
and its UUID is all zeros.

### Linux Wayland (#299)

GPUI's Wayland backend reports a window's move between outputs and output
connection, removal and reconfiguration, so the host also advertises
`display_changes_v1` when GPUI's compositor is Wayland, chosen at runtime
because one Linux build serves both backends. `display_details_v1` stays
macOS/Windows only: Wayland has no client-visible work area. Because the
pinned backend keeps a removed output as a window's display when the
compositor sends no `wl_surface.leave`, the host treats a window whose display
was removed as disconnected until GPUI reports a move elsewhere: its snapshot
fails closed and no change is reported. Two headless sway outputs of different
scale exercise migration, mixed scale, reconfiguration and hotplug
([contract](../native-services.md#wayland-display-changes-299)); physical
monitors remain unverified.
