# ADR 0009 — Owned desktop notifications

Status: accepted; Linux freedesktop.org implementation qualified against the
dunst server in development and inspected AOT with a release-profile native
host. Other platforms remain unavailable.

Date: 2026-11-05.

Related: [#302](https://github.com/0xPlayerOne/bun-native/issues/302),
[shared services #255](https://github.com/0xPlayerOne/bun-native/issues/255),
[trust boundary](0003-bridge-security.md), [service policy](0005-native-service-policy.md)
and [global shortcuts](0008-native-global-shortcuts.md).

## Context

Applications need to tell the user about work that finished while they were
elsewhere, and to bring them back when they click the notification. Each OS has
its own service: the freedesktop.org notification specification over the D-Bus
session bus on Linux desktops (X11 and Wayland alike), `UNUserNotificationCenter`
on macOS and toast notifications on Windows. A browser-style notification
fallback would bypass the native trust boundary and is not offered.

The common risks are executable action strings (a notification that runs a
command or opens a URL when clicked), markup injection, unbounded payloads,
callbacks that outlive their owner, and other processes forging activations.

## Decision

Protocol 8 adds an immutable, default-denied `notifications` launch grant, an
optional `notifications_v1` capability, owned `post_notification` and
`withdraw_notification` commands, typed posted/withdrawn responses, and
sequenced `notification_activated` and `notification_dismissed` events. The
capability is advertised on Linux when a D-Bus session bus is configured.

Content is plain text: a nonempty single-line title of at most 256 UTF-8 bytes
and a body of at most 2048 bytes whose only control character is the line feed.
Both language implementations validate it. When the server supports body
markup, the host escapes `&`, `<` and `>`. There are no action strings, icons,
URLs or hints from the application. The host offers only the server's default
action, and only when the server advertises `actions`; the posted response
reports this as `activatable`. Activation is an event naming the owned
notification, so the application decides what it means.

The freedesktop specification has no permission prompt, so the launch grant is
the only permission state on Linux. A bus without a running notification
server is reported at post time as `service_unavailable`; the host never starts
or configures a server. Every bus operation, including connection setup, is
bounded to two seconds.

The host keeps the registry on the GPUI UI thread and decides delivery there.
It uses its own bus connection and accepts a signal for a notification only from
the unique bus name that answered its `Notify` call, so another client on the
session bus cannot forge activations or dismissals. A closure that arrives
before the `Notify` reply is processed is remembered, within a fixed bound, and
applied once the reply lands.

## Ownership and lifetime

Each notification is owned by a live window and has a revocable public handle.
Withdrawal, owner close and shutdown remove it from the UI-thread registry
first, so an activation the server already queued is never published, then ask
the server to close it. Shutdown waits, within the bound, for every outstanding
bus operation. A notification therefore does not outlive its owner window in a
running host. If the host process dies, the server may keep showing it; no
process remains to receive its activation.

When the server removes a notification first, the listener receives one final
`notification_dismissed` event with reason `expired`, `dismissed` (by the user)
or `closed` (any other server reason), and the handle ends. The public core
independently revokes handles on withdrawal, window close and shutdown, aborts
the handle's signal and ignores events for released notifications. An event
naming an unallocated notification is a protocol violation.

## Consequences

- The public surface is `window.postNotification(options, listener)` returning a
  frozen `NativeNotification`; events run on the same serialized callback queue
  as UI listeners.
- Window close is the owner boundary; there is no application-wide notification
  without a window.
- Named actions, replacement of a live notification, icons, urgency and sound
  are not part of this decision.
- Servers differ in when they close an activated notification. dunst 1.9 keeps
  it until its timeout, so the qualification records whichever closure reason
  the server reports.
- macOS and Windows report `{ availability: 'unavailable', reason: 'unsupported_platform' }`.
