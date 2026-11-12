# ADR 0008 — Owned native global shortcuts

Status: accepted; local Linux X11 implementation qualified in development and
inspected AOT with a release-profile native host. Other platforms remain
unavailable.

Date: 2026-11-05.

Related: [#301](https://github.com/0xPlayerOne/bun-native/issues/301),
[shared services #255](https://github.com/0xPlayerOne/bun-native/issues/255),
[trust boundary](0003-bridge-security.md), [service policy](0005-native-service-policy.md)
and [clipboard worker](0007-native-clipboard.md).

## Context

Window key listeners only observe input sent to a focused owned window. A
desktop application also needs OS-wide activations that arrive while another
window or application is focused. GPUI's pinned platform layer has no global
hotkey API. Each OS has its own mechanism and conflict model: X11 passive key
grabs on the root window, Carbon/`CGEventTap` on macOS and `RegisterHotKey` on
Windows. Wayland deliberately has no client-side global grab; a portal-based
design is a separate future decision.

## Decision

Protocol 7 adds an immutable, default-denied `global_shortcuts` launch grant,
an optional `global_shortcuts_v1` capability, owned `register_global_shortcut`
and `unregister_global_shortcut` commands, typed registered/unregistered
responses, a sequenced `global_shortcut` activation event and a `conflict`
error code. The capability is advertised only for a **local Linux X11**
session, using the same local-display rules as the clipboard worker.

A combination is a key from a closed set (`a`-`z`, `0`-`9`, `f1`-`f12`) plus
explicit `control`, `alt`, `shift` and `platform` booleans. At least one of
control, alt or platform is required, so a global shortcut cannot swallow
ordinary typing. Anything outside that set fails validation in both language
implementations; nothing is approximated or remapped.

Each registration is owned by a live window and has a revocable public handle.
The host keeps its registry on the GPUI UI thread and decides delivery there.
A dedicated worker, with its own X connection, holds the passive grabs. It
resolves the key's unshifted keycode and the Alt/Super/Num Lock modifier bits
from the server's live keyboard and modifier maps, then grabs the combination
with every Caps Lock/Num Lock state. `BadAccess` from any variant releases
every variant this client acquired and returns `conflict`. A key that is not on
the keyboard map, or a modifier the server does not map, is
`service_unavailable`. An in-session duplicate combination is also `conflict`.

The worker sleeps on its notification socket and its X connection; there is no
idle polling. Core X11 autorepeat (a release and press with one timestamp)
does not produce repeated activations. Under UI backpressure an activation can
be dropped rather than queued without bound; registration and release results
are never dropped.

## Ownership and late delivery

Unregistration, owner close and shutdown remove the registration from the
UI-thread registry first, so a press already queued by the X server is never
published. The worker then ungrabs and completes a server round trip before an
unregistration is acknowledged. Owner close releases the grab without an
application request. Shutdown joins the worker; closing its connection makes
the X server drop every remaining grab. The public core independently revokes
handles on unregistration, window close and shutdown, aborts the
registration's signal, and ignores activations for released registrations. An
activation naming an unallocated registration is a protocol violation.

## Consequences

- The public surface is `window.registerGlobalShortcut(options, listener)`
  returning a frozen `NativeGlobalShortcut`; activations run on the same
  serialized callback queue as UI listeners.
- Window close is the owner boundary; there is no application-wide shortcut
  without a window.
- Keyboard map changes after registration are not tracked. A remapped key keeps
  its original keycode grab until it is unregistered.
- Windows, Wayland and remote X11 report
  `{ availability: 'unavailable', reason: 'unsupported_platform' }`.

## macOS addendum (2026-11-11)

macOS advertises `global_shortcuts_v1` with backend `carbon`. Each
registration is an exclusive Carbon `RegisterEventHotKey` on the main thread,
not a `CGEventTap`: a hot key needs no Accessibility or Input Monitoring
permission, sees no other typing, and the Event Manager itself refuses a
combination another process holds exclusively (`eventHotKeyExistsErr`, mapped
to `conflict`). Keys resolve through the current keyboard layout at
registration; the protocol, grant, ownership and late-delivery rules above are
unchanged. The hosted macOS check is described in
[native services](../native-services.md#macos-carbon-hot-keys); it has not yet
run.
