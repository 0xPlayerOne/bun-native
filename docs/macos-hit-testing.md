# macOS input target verification

> **Status (2026-11-05):** the hosted development and AOT macOS input scenarios
> described below have since passed; see
> [native platforms](native-platforms.md#hosted-paint-os-input-and-assigned-device-evidence).
> This record is otherwise kept as written.

The controller must authorize the exact native window that would receive a mouse-down, not the first rectangle containing the point. An opaque, on-screen window may explicitly ignore mouse events. Its rectangle can cover the application while the actual input target is still the application.

The macOS helper uses AppKit's documented `+[NSWindow windowNumberAtPoint:belowWindowWithWindowNumber:]` with window number zero. It converts the measured global Quartz point to global AppKit coordinates using the primary display's logical height. It independently matches the returned window number against current Quartz owner, bounds and opacity metadata. Unknown, stale, duplicate, inconsistent, foreign and same-process-but-different windows reject. Foreground and target checks run before each of the three pointer events. Posting remains `CGEventPost(kCGSessionEventTap)`; no permission is requested, no alternate posting route is attempted, and no application/input deadline changes.

## Controls and evidence

`tests/native/macos-input-events.m` verifies actual SDK event construction and bounded pure identity, geometry, coordinate-conversion and diagnostic controls without posting input. `tests/native/macos-window-hit.m` creates two small task-owned windows and verifies the actual WindowServer/AppKit distinction: an ignored overlay is accepted, an input-taking overlay from the same process is rejected, and the uncovered owned target is accepted. Both windows are closed on success or failure. The control does not post keyboard/pointer events or change another application's activation or system permissions.

The same owned-window control fails at the intended authorization boundary with the preceding rectangle-only helper and passes with the corrected helper. The first version of the _new control_ observed a hit before its ignored overlay had become visible, so both variants failed its visibility precondition. That failed attempt remains distinct from the corrected control's bounded visibility rendezvous. This does not extend any existing application deadline or retry a failed native test.

`tests/native/evidence/platform-macos-hit-testing.json` binds the source, actual SDK/compiler, controlled outcomes and raw result hashes. These results establish the guard's semantics on the connected Mac. **They do not establish GPUI input delivery.** Required hosted development and genuine AOT scenarios still require exact owned process/window identity, three pointer activations, 96 nonce edits, nine complete native paints, joined shutdown and zero ownership counters in each mode. Historical unsuccessful native attempts remain recorded separately.

Reference: Apple's `NSWindow.windowNumber(at:belowWindowWithWindowNumber:)` documentation explicitly describes mouse-down hit testing, including transparent pixels and windows with `ignoresMouseEvents`.
