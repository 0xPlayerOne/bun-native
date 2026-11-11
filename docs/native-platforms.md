# Native platform build and paint qualification

This is an incremental implementation of [CI #256](https://github.com/0xPlayerOne/bun-native/issues/256)
and [target artifacts #246](https://github.com/0xPlayerOne/bun-native/issues/246).
The wider CI acceptance in #256 remains open. Linux's existing owned-window/input suite stays required;
this lane adds genuine target-host compilation and a portable native lifecycle
fixture for macOS and Windows. It does not infer GUI interaction from compilation.
The [hosted evidence below](#hosted-paint-os-input-and-assigned-device-evidence)
qualifies paint/lifecycle and separately enabled OS input on the recorded targets.

## Scheduled finite native audit

[`Bun Native Scheduled Audit`](../.github/workflows/native-audit.yml) schedules
the existing full validation graph every **Tuesday at 05:23 UTC**. Manual
validation uses that same caller and is permitted only on `refs/heads/main`
when `CI_BILLING_PAUSED` is explicitly `false`. It accepts no source/runtime
ref or other input and never cancels an active audit. It grants exactly the
read permissions the nested jobs request plus CodeQL's `security-events: write`;
GitHub rejects a caller that grants less than any nested job requests, and a
rejected scheduled workflow never runs, which is why the first Tuesday audit
was missing (#620). `release-gating.test.ts` checks the grant against every
nested job. Scheduled and permitted manual audits share one concurrency
group. PR and main-push validation keep their existing triggers and gate.

The caller invokes [`bun-native.yml`](../.github/workflows/bun-native.yml)
through a local reusable reference, so both workflows use the same commit.
[GitHub schedules](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)
run from the default branch and can be delayed or dropped under load; the
main-only guard also rejects a manual request selecting another branch.
Billing-paused or non-main requests are skipped, not qualified. The separate
caller follows the managed audit policy while these native workflows remain
repository-owned under the preserved custom-workflow configuration.

This reuses every existing source, protocol, AOT, native and dependency-audit
job, with the same assertions, timeouts, caches, artifacts and failure gate.
The finite Linux checks include React's 1,000-update/rotation/mount workloads,
101 source-edit remounts per framework, and five measured startup/RSS trials
plus one warmup per mode. macOS and Windows retain their development/AOT
native paint, lifecycle and owned OS-input checks. These are **finite stress
checks**, not a long soak, physical-GPU qualification or measured regression
budget. Linux uses its existing software GPU; all other hardware, IME and
accessibility limits remain as documented below. Comparable trend/budget
automation and longer soaks remain [#259](https://github.com/0xPlayerOne/bun-native/issues/259).

### Qualification plan for the scheduling change

Publish the prepared source as a draft after workflow lint, formatting,
unchanged-job parity review and normal hooks. Qualification uses **one normal
required PR matrix for the exact prepared head**, preserving every failure,
skip and original artifact. Do not retry unchanged source to obtain a passing
result. No native workload or audit dispatch is part of local preparation.

After protected merge, retain separate evidence for the first actual caller
execution: event and scheduled expression, source commit/tree, run and attempt,
all job outcomes, the actual aggregate result and original native/AOT artifacts.
A PR run does not prove that the weekly trigger executed, and static checks do
not qualify an unexecuted caller. Keep that execution pending until its
source-bound record exists; regular scheduling does not resolve previously
retained startup, close or collectability failures.

## Paint/lifecycle mode and its claims

The reusable [`Native Platforms` workflow](../.github/workflows/native-platforms.yml)
uses `macos-15` and `windows-2022`, a 60-minute per-target budget and independent
matrix outcomes. It preserves draft/billing guards and read-only repository
permissions. Caches contain dependency downloads, not build outputs or secrets.
The main validation caller includes both native targets in the existing
`Validation / Gate`; any non-success dependency result fails that aggregate.

Each target builds the real release GPUI executable with pinned Rust, Bun and
GPUI sources, runs host Clippy/tests, then executes the same public-core fixture
in development and inspected machine-code AOT. The fixture opens, updates and
closes three successive windows. The independent controller requires each
window's actual renderer record and complete initial/update native tree paint.
Adapter telemetry must be valid when present. Current macOS qualification also
requires the identity of the Metal device assigned to the actual window layer;
unavailable driver and emulation information stays explicit, as described below.
Input value replacement is an explicit application transaction, not OS typing.
Each close must revoke public resources; final shutdown joins the runtime's
native child exit.

| Observation              | Qualification in this first increment                                                                                     |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| Rust compilation         | Separate target tools, release command, build duration, binary bytes and SHA-256.                                         |
| GPUI execution           | Actual host, three native window protocol lifecycles, renderer records and six complete paint traversals.                 |
| Adapter telemetry        | GPUI adapter record on Linux/Windows; actual layer-assigned Metal device on macOS, with driver/emulation unverified.      |
| Bun AOT                  | Exact fixture compiled through pinned `bun compile`; compiled-program and JIT-removal evidence required before execution. |
| Public lifecycle         | Native acknowledgement/closed events, joined shutdown and zero public resource counters.                                  |
| OS-visible window        | **Unverified:** no independent native window enumeration yet.                                                             |
| OS keyboard/mouse/close  | **Not attempted:** programmatic edits and public `close()` do not qualify these.                                          |
| Screenshots/presentation | **Not attempted:** a paint callback is not a display-presentation timestamp or screenshot.                                |
| Complete process tree    | **Unverified:** the public runtime joins its native child, but this controller does not enumerate every OS descendant.    |

The controller reuses the existing native diagnostic driver's pure nonce/log,
fingerprint and full-tree expectation helpers. It never calls that module's
Linux `/proc`, X11 injection or cleanup functions on another platform. Logs stay
bounded at 4 MiB, output directories are fresh, and native executable/source
hashes must remain unchanged during a run. On failure, fixture abort joins the
runtime's bounded native shutdown. Forced application termination is a failure
and does not imply descendant cleanup.

One actual run deliberately expects an incorrect native paint. It must exit
nonzero with `NativePaintMismatch`, joined native shutdown and no forced
application termination. An arbitrary startup failure cannot satisfy this
negative check. The ordinary development and AOT runs must pass their correct
complete tree expectations.

## Owned native OS input extension

`native-platform-smoke.py --os-input` adds a separate phase to the same public
fixture and bounded controller. Every cycle independently identifies the
launched application's native child and a visible window. It uses the host's
actual paint geometry to select the button, delivers a pointer click, sends Tab
to focus the editor, then types a fresh 32-character hexadecimal run nonce. The
controller requires the native pointer-down/up and click route, Tab down/up,
native input focus, every input prefix with its independent revision, and the
complete final native paint. Injection API success alone never qualifies input.
The subsequent programmatic replacement uses the observed revision and must
advance it exactly once. All three windows still close and release their public
resources before final joined native shutdown.

- **Windows:** SDK-compatible `ctypes` declarations call Toolhelp32,
  `GetProcessTimes`, `QueryFullProcessImageNameW`, `EnumWindows` and User32. Query
  handles retain each process identity. A matching child must have been created
  at or after this launched application, excluding older orphans that retain a
  recycled numeric parent PID. Every input rechecks the expected native
  executable/window and foreground state. Visible windows must be uncloaked and
  unminimized, on a visible window station and the controller's current input
  desktop. The controller queries these objects without switching desktops;
  borrowed handles remain borrowed and the input-desktop query handle is closed.
  Pointer coordinates use the actual client rectangle with a
  thread-local, temporarily selected per-monitor DPI context. The controller
  refuses held external modifiers and checks `SendInput` counts. A partial
  insertion attempts to release only the down event it just inserted, then
  fails. Missing interactive desktop/foreground/UIPI capability is reported as
  unsupported, without attempting to change security settings.
- **macOS:** A small Objective-C helper is compiled against the actual Xcode SDK.
  It checks `libproc` creation identity, same-user ownership, direct parentage,
  executable path and Quartz onscreen window ownership. Window titles are
  verified when Quartz exposes them; absent title access does not replace the
  required PID/image/creation identity. Input requires read-only
  `CGPreflightPostEventAccess`, owned foreground activation and no external held
  modifiers. Pointer events use global Quartz coordinates derived from the
  observed frame and the measured GPUI viewport. Before posting, the first
  visible window containing that point in Quartz's front-to-back list must be
  the exact owned window; even a same-process overlay rejects. Events enter
  the public login-session stream with `CGEventPost(kCGSessionEventTap)` so
  WindowServer performs ordinary routing. Keyboard down/up pairs recheck the
  owned foreground. The recorded hosted input cases verify delivery through
  this route; an SDK event object or posting call alone cannot satisfy that gate.
  The helper never requests permissions or changes privacy settings.
- **Linux:** The same fixture can be checked in the existing isolated Xvfb/DBus
  session. Its small adapter reuses the established process-identity and XTest
  helpers. This exercises the common assertions locally without claiming that
  Linux behavior qualifies another OS.

OS controllers retain no application event handlers or renderer implementation.
Each command and observation has a bounded deadline, all logs retain the common
nonce and size checks, and macOS helper source/executable hashes join the run's
provenance. The workflow runs development and AOT input as separate commands
after paint-only qualification. An unsupported input session exits nonzero and
retains its exact reason; it is never counted as a pass. Programmatic close is
still not an OS close-button test. Screenshots, presentation, hardware input,
accessibility/IME and complete process-tree enumeration remain unverified by
this extension.

### macOS pointer association regression

The [subsequent hosted macOS run](https://github.com/0xPlayerOne/bun-native/actions/runs/41238698609/job/124647813058)
passed complete development native paint/lifecycle and owned-window/permission
checks, then failed OS-input qualification. The initial six-node tree painted
and its input received focus, but no pointer event reached the application.
The fixture reached its unchanged controller-command deadline and joined
native shutdown with zero public resources. That failed result is retained.

A bounded SDK diagnostic created event objects without posting input. The old
`CGEventCreateMouseEvent` path yielded `NSEvent.windowNumber == 0`; setting the
two public window-under-pointer fields did not establish an AppKit window
association. Apple's [mouse-event factory](https://developer.apple.com/documentation/appkit/nsevent/mouseevent%28with%3Alocation%3Amodifierflags%3Atimestamp%3Awindownumber%3Acontext%3Aeventnumber%3Aclickcount%3Apressure%3A%29)
preserved the supplied window number and window-local coordinates through
CoreGraphics conversion. That correction used the factory, with the pinned
[GPUI conversion](https://github.com/zed-industries/zed/blob/ba63a022c9a22ca66d68ef2a8f0bb9b5b0a9984d/crates/gpui_macos/src/events.rs)
inverted explicitly: `nativeX = gpuiX`, `nativeY = viewportHeight - gpuiY`.
Its historical SDK regression inspected nine such conversions without posting;
those construction passes did not prove actual native delivery.

OS observations are now retained immediately after ownership is established.
Their phase distinguishes an observed window, a bounded pointer target, posted
events, actual delivery and a complete native paint. A failed activation retains
the window identity, geometry and posting result instead of losing them while
waiting for later keyboard steps. Three pure controller regressions cover
missing geometry, rejected posting and posted events without native delivery;
none claims to exercise macOS input.

The [compact correction record](../tests/native/evidence/platform-macos-pointer-association.json)
preserves that hosted failure, the event-object diagnostic, and a subsequent
connected-Mac attempt using the exact hosted **release** executable. Its SDK
build and nine association checks passed. The actual development run observed
the owned window and initial native paint, then failed the strict snapshot
comparison before delivery. The historical helper did not retain the current
comparison snapshot, so the changed field is unknown. Its read-only
`CGPreflightPostEventAccess` result was also explicitly false: this machine
cannot qualify permitted event posting. No permission was requested or granted,
no native input was observed, all public counters returned to zero, and native
shutdown joined without forced termination. The original failed result is not
reclassified as a pass, and AOT input was not attempted there.

The controller now rejects an observed false posting capability before invoking
any input helper and reports that capability as unavailable. A true observation
still requires all current native identity, geometry, foreground and permission
checks. Snapshot failures distinguish application identity, native-process
identity and window metadata/geometry, retaining the current window metadata
for comparison with the original observation. These diagnostics do not relax
ownership. Corrected macOS event delivery remains subject to the hosted
development and AOT checks; SDK conversion and Linux runs cannot establish it.

The [next hosted attempt](https://github.com/0xPlayerOne/bun-native/actions/runs/41242660014/job/124659569247)
passed the corrected SDK controls and native paint-only fixture, then still
failed actual pointer activation. Its retained observation shows posting access
was true, the exact owned window and process identities matched, and three
PID-targeted events were posted. The application recorded its initial focus
but no pointer or click event before the unchanged controller-command deadline.
Shutdown joined with all six public ownership counters zero. AOT input did not
run after this failure. The [source-verified failure record](../tests/native/evidence/platform-macos-delivery-failure.json)
retains all observations and trace records; it rehashes the archived release
host and checks all 61 source fingerprints against the actual tested merge.
The delivery failure remains unattributed. The SDK object conversion is not
evidence that AppKit received or dispatched those events.

The diagnostic enables `BUN_NATIVE_POINTER_TRACE=1` only for the hosted
macOS input commands. With the existing nonce-bound evidence log, a non-hitbox
canvas registers window-global GPUI capture observers before the native body
is painted. They record readiness once per live window and raw move/down/up
positions, button, viewport and active state, including positions outside the
viewport. They never stop propagation, change focus or replace input. The
process-wide limit is 64 records including readiness; the last record marks
the exhausted limit, and closing a window does not reset that budget.

This distinguishes GPUI delivery from the later target/viewport filters. It
cannot observe events dropped before GPUI dispatch, and absent records only
become meaningful after a readiness record and before the limit is reached.
The flag is off for paint-only, baseline and allocation-profile runs. No
diagnostic result qualifies the required native button/text observations or
changes their original deadlines.

The [Linux diagnostic controls](../tests/native/evidence/platform-pointer-diagnostics-linux.json)
passed ordinary Bun with tracing on and off, plus inspected AOT with tracing
on. Each case completed three windows, three clicks, all 96 ordered edits and
nine complete paints with joined shutdown and zero public resources. The
enabled cases emitted 12 trace records each; the disabled case emitted none.
An initial diagnostic-only layout-index defect is preserved separately: the
new first canvas was incorrectly recorded as the model root's bounds. Explicit
child indexing fixed that evidence mapping, and the corrected controls require
the full root and target geometry. The actual pointer coordinates retain X11's
fractional representation; they are checked against the native target bounds,
not assumed to equal integer injection coordinates exactly. These use a
development-profile Linux host and do not qualify macOS delivery.

### WindowServer routing correction

[Run 41245774144](https://github.com/0xPlayerOne/bun-native/actions/runs/41245774144/job/124668770902)
again passed paint-only lifecycle but failed the unchanged macOS input gate.
The trace emitted its ready marker at index 1 of 64, then no mouse move, down
or up record. The initial native tree painted, posting permission was true,
the observed identity remained valid, and all three PID-targeted events were
submitted. The fixture failed after 10.232 seconds, then joined native shutdown
with all six public resource counts zero. AOT input did not run after failure.
The [verified record](../tests/native/evidence/platform-macos-pointer-trace-failure.json)
checks all 63 source files against the actual merge and rehashes both archived
native host and helper bytes. The marker's inactive state belongs to initial
paint; it does not contradict or replace the later foreground check.

The missing event is before the installed GPUI capture observer; the underlying
PID-posting failure is still unattributed. The controller now uses Apple's
documented [global-coordinate mouse events](<https://developer.apple.com/documentation/coregraphics/cgevent/init(mouseeventsource:mousetype:mousecursorposition:mousebutton:)?language=objc>)
and [session event stream](<https://developer.apple.com/documentation/coregraphics/cgevent/post(tap:)?language=objc>).
The [onscreen list](https://developer.apple.com/documentation/coregraphics/cgwindowlistoption/optiononscreenonly)
is ordered front-to-back, enabling a conservative exact-window occlusion check
before ordinary WindowServer routing. It refuses obscured/absent targets and
preserves process creation, executable, geometry, permission, foreground and
external-modifier checks. There is no automatic alternate posting path or retry.

The SDK control constructs nine global-coordinate events and exercises eight
pure window-target cases plus the four identity guards without posting input.
The hosted job must compile and execute that control, then independently pass
real development and AOT button/text input. This correction has no native
macOS success claim until those results exist. The GPUI capture trace remains
enabled to distinguish subsequent delivery from targeting failures.

[Run 41247808999](https://github.com/0xPlayerOne/bun-native/actions/runs/41247808999/job/124674782271)
passed native paint and the actual SDK controls, then rejected the development
pointer target before posting any event: the first intersecting WindowServer
rectangle did not match the exact owned window. The window remained visible,
posting access was available, and the application joined native shutdown with
all six public resource counts zero. AOT input was not attempted. The
[verified rejection record](../tests/native/evidence/platform-macos-target-rejection.json)
checks the 63 source files and rehashes the archived release host and SDK helper.
The rejecting rectangle's identity and layer were absent from that artifact;
its cause and whether it was transient remain unknown.

Rejection evidence now includes only that first rectangle's numeric window ID,
owner PID, layer, alpha and frame, along with the expected owned IDs and global
point. It never records another window's title, application name, image path or
contents. Three SDK cases require those exact fields and two reject malformed
identity metadata. This diagnostic changes no posting route, target rule,
foreground wait, retry behavior or native acceptance criterion. Its SDK build
and subsequent real input attempt remain hosted checks, not local successes.

## Advertised capabilities by platform

The host builds its `ready` capability list in
[`session.rs`](../native/gpui-host/src/session.rs) from compile-time `cfg`
selections and run-time probes. Protocol 11 needs the first five on every
target; every other row is an optional feature that core checks before use.
Advertised means only that the host offers the feature. The **Qualification**
column says what checks it natively. A step in the hosted
[Native Platforms](../.github/workflows/native-platforms.yml) workflow
compiles and runs on `macos-15` / `windows-2022`. This repository keeps no
source-bound evidence record from a passing run of the steps added in #481,
so their Windows behavior counts as **unverified** here and not as
supported. Linux claims are scoped to the isolated Xvfb session.

On macOS, every gating step named below is followed in the same shard by
**Record source-bound macOS feature evidence**
([`macos-feature-evidence.ts`](../scripts/quality/macos-feature-evidence.ts)).
It requires each step's report to name macOS, its mode and a pass. It checks
that every AOT package was built from the checked-out sources and the release
host, and it hashes those sources, the oracles and this workflow into
`macos-feature-record.json` in the shard's retained artifact. A missing,
failed or unbound report fails the job. These rows say **pending first hosted
run** until such a record from a passing run is retained in
[`tests/native/evidence`](../tests/native/evidence/). The macOS steps use a
real GPUI window, CoreGraphics input through the bounded helper
([`macos-window-input.ts`](../tests/native/macos-window-input.ts)) and
independent macOS oracles. They run on a hosted VM, not on physical input
hardware or GPUs.

| Capability             | Linux                                | macOS                                       | Windows                                               | Qualification                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------- | ------------------------------------ | ------------------------------------------- | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tree`                 | Always                               | Always                                      | Always                                                | Required. Linux native suite; macOS/Windows paint and lifecycle [evidence](#hosted-paint-os-input-and-assigned-device-evidence).                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `input_revisions`      | Always                               | Always                                      | Always                                                | Required. As `tree`, including the hosted OS-input cases.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `layout_v1`            | Always                               | Always                                      | Always                                                | Required. As `tree`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `interactions_v1`      | Always                               | Always                                      | Always                                                | Required. As `tree`, including the hosted OS-input cases.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `window_display_v1`    | Always                               | Always                                      | Always                                                | Required. X11 semantics in [`display-semantics.ts`](../tests/native/display-semantics.ts); Wayland in [`wayland.ts`](../tests/native/wayland.ts) and [`display-wayland.ts`](../tests/native/display-wayland.ts); macOS/Windows in the hosted `display-platform.ts` step, unverified.                                                                                                                                                                                                                                                                                                                           |
| `split_v1`             | Always                               | Always                                      | Always                                                | Linux `layout-style` scenes at scale 1 and 2. macOS: the same core, Solid and React scenes in development and AOT, with CoreGraphics clicks, drags, wheel and Tab, an Accessibility window resize, and `screencapture` pixels at the display's backing scale. All six reports must match one tree and one geometry. Pending first hosted run. Not run on Windows.                                                                                                                                                                                                                                              |
| `style_decoration_v1`  | Always                               | Always                                      | Always                                                | As `split_v1`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `overlays_v1`          | Always                               | Always                                      | Always                                                | Linux [`overlays.ts`](../tests/native/overlays.ts). macOS: the same fixture in development and AOT, with CoreGraphics keys, clicks and wheel and `screencapture` pixels. Pending first hosted run. Not run on Windows.                                                                                                                                                                                                                                                                                                                                                                                         |
| `scroll_anchor_v1`     | Always                               | Always                                      | Always                                                | As `overlays_v1`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `focus_v1`             | Always                               | Always                                      | Always                                                | As `overlays_v1`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `scroll_control_v1`    | Always                               | Always                                      | Always                                                | As `overlays_v1`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `overlay_keyboard_v1`  | Always                               | Always                                      | Always                                                | As `overlays_v1`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `input_states_v1`      | Always                               | Always                                      | Always                                                | Linux [`text-input.ts`](../tests/native/text-input.ts) read-only and disabled inputs. macOS: [`input-states-platform.ts`](../tests/native/input-states-platform.ts) in development and AOT, with CoreGraphics keys, `pbpaste`, and AX enabled, focusable and focused states. Pending first hosted run. Not run on Windows.                                                                                                                                                                                                                                                                                     |
| `app_menu_v1`          | Never                                | Always                                      | Never                                                 | Hosted macOS [`app-menu.ts`](../tests/native/app-menu.ts) against an accessibility-tree oracle ([`macos-menu-oracle.m`](../tests/native/macos-menu-oracle.m)). The step fails unless the oracle is trusted and the report is `verified`. Source-bound record pending first hosted run. GPUI stores menus only on Linux and Windows.                                                                                                                                                                                                                                                                            |
| `task_dialogs_v1`      | Never                                | Always (`NSAlert` sheets)                   | When Common Controls 6 resolves `TaskDialogIndirect`  | Hosted Windows and macOS [`task-dialogs.ts`](../tests/native/task-dialogs.ts) against independent UI Automation ([`windows-dialog-oracle.ps1`](../tests/native/windows-dialog-oracle.ps1)) and Accessibility ([`macos-alert-oracle.m`](../tests/native/macos-alert-oracle.m)) oracles. macOS source-bound record pending first hosted run. See [native services](native-services.md#os-message-dialogs-windows-task-dialogs-macos-alert-sheets).                                                                                                                                                               |
| `context_menus_v1`     | Never                                | Always (`NSMenu` pop-ups)                   | Always (`TrackPopupMenuEx`)                           | Hosted macOS and Windows [`context-menus.ts`](../tests/native/context-menus.ts) against independent Accessibility ([`macos-context-menu-oracle.m`](../tests/native/macos-context-menu-oracle.m)) and UI Automation ([`windows-context-menu-oracle.ps1`](../tests/native/windows-context-menu-oracle.ps1)) oracles. macOS source-bound record pending first hosted run. See [native services](native-services.md#os-context-menus).                                                                                                                                                                             |
| `split_resize_v1`      | Always                               | Always                                      | Always                                                | Linux X11 divider drag and keyboard cases in the native [layout contract](native-layout.md#keyboard-divider-and-resize-events-split_resize_v1). macOS: [`accessibility.ts`](../tests/native/accessibility.ts) in development and AOT, covering AX value requests, Tab order, arrow, Shift, Home and End steps, a held CoreGraphics drag and the focus-ring pixels. Pending first hosted run. Not run on Windows.                                                                                                                                                                                               |
| `accessibility_v1`     | Always                               | Always                                      | Always                                                | Linux AT-SPI roles in [`accessibility.ts`](../tests/native/accessibility.ts) ([native text](native-text.md#accessibility-roles-accessibility_v1)). macOS: the same fixture against the AXUIElement client ([`macos-accessibility-oracle.m`](../tests/native/macos-accessibility-oracle.m)), plus [`accessibility-platform.ts`](../tests/native/accessibility-platform.ts). Pending first hosted run. Windows: `accessibility-platform.ts` through UI Automation, unverified.                                                                                                                                   |
| `display_details_v1`   | Never                                | Always                                      | Always                                                | Compile-time `DISPLAY_DETAILS` (the work area). Hosted `display-platform.ts` against NSScreen/CoreGraphics and `System.Windows.Forms.Screen` oracles. macOS source-bound record pending first hosted run; Windows unverified.                                                                                                                                                                                                                                                                                                                                                                                  |
| `display_identity_v1`  | GPUI compositor is Wayland (not X11) | Always                                      | Always                                                | Runtime `services::display_identity` (`displayId`). Linux Wayland: [`display-wayland.ts`](../tests/native/display-wayland.ts) against v5(DNS, sway output name), development and AOT. macOS/Windows: hosted `display-platform.ts` and macOS `display-virtual-macos.ts`; unverified.                                                                                                                                                                                                                                                                                                                            |
| `display_changes_v1`   | GPUI compositor is Wayland (not X11) | Always                                      | Always                                                | Runtime `services::display_changes`. Linux Wayland: [`display-wayland.ts`](../tests/native/display-wayland.ts) on two headless sway outputs of different scale (migration, integer and fractional output reconfiguration, hotplug), development and AOT. macOS/Windows: the hosted `display-platform.ts` step makes a real display-mode change; it records `displayChange` as unavailable if the runner offers no other mode. macOS also runs [`display-virtual-macos.ts`](../tests/native/display-virtual-macos.ts) with a CGVirtualDisplay second display (migration, mixed DPI, removal). Unverified there. |
| `popup_windows_v1`     | Local X11 connection                 | Never                                       | Never                                                 | Linux [`popups.ts`](../tests/native/popups.ts).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `clipboard_text_v1`    | Local X11 connection                 | Always (`NSPasteboard` plain text)          | Never                                                 | Linux X11 [native services](native-services.md#clipboard-text-and-lifecycle). macOS: hosted [`clipboard-macos.ts`](../tests/native/clipboard-macos.ts) against `pbcopy`/`pbpaste`/`osascript`, development only; pending first hosted run.                                                                                                                                                                                                                                                                                                                                                                     |
| `global_shortcuts_v1`  | Local X11 connection                 | Always (exclusive Carbon hot keys)          | Never                                                 | Linux X11. macOS: hosted [`global-shortcuts-macos.ts`](../tests/native/global-shortcuts-macos.ts) against an independent Event Manager oracle ([`macos-hot-key-oracle.m`](../tests/native/macos-hot-key-oracle.m)), development only; pending first hosted run.                                                                                                                                                                                                                                                                                                                                                |
| `notifications_v1`     | D-Bus session bus configured         | Never                                       | Never                                                 | Linux against `dunst`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `file_dialogs_v1`      | D-Bus session bus configured         | Always (`NSOpenPanel`/`NSSavePanel` sheets) | Never                                                 | Linux xdg-desktop-portal (GTK). macOS: hosted [`file-dialogs-macos.ts`](../tests/native/file-dialogs-macos.ts) against an independent Accessibility oracle ([`macos-file-panel-oracle.m`](../tests/native/macos-file-panel-oracle.m)), development only; pending first hosted run.                                                                                                                                                                                                                                                                                                                             |
| `filesystem_grants_v1` | `openat2` probe succeeds (5.6+)      | `openat` walk probe succeeds                | `NtCreateFile` walk probe succeeds (Windows 10 1709+) | Linux [`filesystem-grants.ts`](../tests/native/filesystem-grants.ts). The hosted macOS and Windows steps run the same fixture. macOS source-bound record pending first hosted run; Windows unverified.                                                                                                                                                                                                                                                                                                                                                                                                         |
| `processes_v1`         | `pidfd_open` probe succeeds          | Always                                      | Always                                                | Linux [`processes.ts`](../tests/native/processes.ts). Hosted macOS and Windows unit tests and the same fixture (macOS without a working directory; Windows job object and ConPTY). macOS source-bound record pending first hosted run; Windows unverified.                                                                                                                                                                                                                                                                                                                                                     |
| `drag_drop_files_v1`   | GPUI compositor is X11 (not Wayland) | Always                                      | Always                                                | Linux XDND [`drag-drop.ts`](../tests/native/drag-drop.ts) and Solid/React fixtures. Hosted macOS `NSDraggingSession` and Windows `DoDragDrop` sources run the same fixtures. macOS source-bound record pending first hosted run; Windows unverified.                                                                                                                                                                                                                                                                                                                                                           |

`app.serviceCapabilities` derives each service record from this list. A missing
capability reports `unavailable` / `unsupported_platform`, or `details` /
`identity` / `changes: 'unavailable'` for the display. Readiness never adds a
capability that the table leaves out. Linux Wayland offers display identity
and display changes without display details. Windows offers display details,
display identity, display changes,
filesystem grants (Windows drive-path launch roots), processes and file drops
as optional OS services; a POSIX launch root never matches a Windows drop. The
application menu bar is macOS only, and message and confirm dialogs need no
capability because core draws them on the modal overlay. See the
[service matrix](native-services.md#service-and-platform-matrix).
[`platforms-capabilities.test.ts`](../tests/quality/platforms-capabilities.test.ts)
fails when this table, the TypeScript capability list, the Rust enum or the
host's unconditional set disagree.

## Linux Wayland

GPUI uses its Wayland backend whenever `WAYLAND_DISPLAY` is set, so most Linux
desktops run the host on Wayland. [`tests/native/wayland.ts`](../tests/native/wayland.ts)
qualifies that backend on a real compositor in the Native Linux job, in
development and inspected AOT at scale 1 and in development at output scale 2
([ADR 0017](decisions/0017-wayland.md)).

[`native-wayland-session.sh`](../scripts/quality/native-wayland-session.sh)
starts headless sway 1.9 (wlroots 0.17 `headless` backend, pixman renderer,
no libinput devices) with one 1280×800 logical output, XWayland disabled and
`DISPLAY` removed. The application renders on Mesa lavapipe through Vulkan.
Each check has an oracle independent of the host:

| Check                      | Input or oracle                                                                                                                                                                            |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Window opens and paints    | sway IPC `get_tree` maps an `xdg_shell` view of the requested size within 10 s; nonce-tagged paint evidence holds the tree                                                                 |
| Renderer                   | Paint evidence reports llvmpipe, software-emulated; the startup log selects it as a Vulkan adapter                                                                                         |
| Pointer click              | One persistent `zwlr_virtual_pointer_v1` ([`wayland-input-peer`](../native/gpui-host/examples/wayland-input-peer.rs)) moves and clicks                                                     |
| Keyboard text and Enter    | `zwp_virtual_keyboard_v1` through wtype, with a second idle wtype keeping the seat's keyboard; ASCII and `é`                                                                               |
| Editing and focus          | Backspace over a combining mark and a ZWJ family, Hebrew in logical order, Tab/Shift+Tab between field and button ([native text](native-text.md))                                          |
| IME composition            | The same peer is the seat's `zwp_input_method_v2`: preedit, replacement, commit and cancel reach GPUI's `zwp_text_input_v3`                                                                |
| Accessibility              | AT-SPI client over the session bus: entry, button and label roles, character bounds, caret move, focus, press                                                                              |
| Pixels                     | grim (wlr-screencopy) reads the painted swatch and the native button background                                                                                                            |
| Display snapshot           | Equals the compositor's output bounds and scale from `get_outputs`                                                                                                                         |
| Two outputs (separate run) | [`display-wayland.ts`](../tests/native/display-wayland.ts): migration, mixed scale, output reconfiguration and hotplug ([native services](native-services.md#wayland-display-changes-299)) |
| Service capability matrix  | See [native services](native-services.md#wayland)                                                                                                                                          |
| Notification, file dialog  | dunst displays and withdraws; the portal's GTK dialog maps as its own view, closes on abort and on a compositor close                                                                      |
| Compositor close, shutdown | `[title=…] kill` (xdg_toplevel.close) resolves `window.closed`; all public ownership counts return to zero                                                                                 |

The input devices must outlive each action: with no device, the seat has no
capabilities, and a per-command tool's first event races the client's
`wl_pointer`/`wl_keyboard` binding (observed as a lost click and a lost first
character). No host defect was found; no host code changed.

A separate run on two headless outputs (1280×800 at scale 1 and 2048×1536 at
scale 2) qualifies display migration, per-window scale on mixed-scale
outputs, output reconfiguration and output hotplug, and found one defect: a
window whose output was unplugged kept a stale display that a later output
could impersonate. The host now fails closed for that window; see
[Wayland display changes](native-services.md#wayland-display-changes-299).

Not qualified: GNOME (Mutter) and KDE (KWin), fractional scaling, physical
monitors and DRM hotplug, a real IME engine and the IME cursor rectangle (sway 1.9
has no input popups), physical input and GPUs,
decorations on other compositors, Wayland clipboard, global shortcuts, drag
and drop and popup windows (unavailable), file dialog parenting, and the
modal, divider and element-role accessibility rows under Wayland.

## Pinned native requirements

Requirements come from GPUI revision
`ba63a022c9a22ca66d68ef2a8f0bb9b5b0a9984d`:

- **macOS:** The [Apple renderer build script](https://github.com/zed-industries/zed/blob/ba63a022c9a22ca66d68ef2a8f0bb9b5b0a9984d/crates/gpui_apple/build.rs)
  compiles and links Metal shaders with `xcrun -sdk macosx metal` and `metallib`.
  The job records Xcode/SDK versions and requires both tools before Cargo. It
  does not switch to runtime shaders or change privacy/security settings.
- **Windows:** The [Windows build script](https://github.com/zed-industries/zed/blob/ba63a022c9a22ca66d68ef2a8f0bb9b5b0a9984d/crates/gpui_windows/build.rs)
  uses the Windows SDK's `fxc.exe` for release HLSL. The job selects an installed
  x64 compiler, records version/hash and supplies `GPUI_FXC_PATH`. The
  [device implementation](https://github.com/zed-industries/zed/blob/ba63a022c9a22ca66d68ef2a8f0bb9b5b0a9984d/crates/gpui_windows/src/directx_devices.rs)
  enumerates DXGI adapters and requires its stated Direct3D features. A usable
  software adapter or interactive desktop is not assumed.

### Renderer telemetry availability

At this exact revision, the [macOS window's `gpu_specs()`](https://github.com/zed-industries/zed/blob/ba63a022c9a22ca66d68ef2a8f0bb9b5b0a9984d/crates/gpui_macos/src/window.rs)
unconditionally returns `None`. The host preserves that as `gpu: null` and adds a
separate `metal_device` observation from the existing private macOS surface bridge.
It borrows this window's AppKit view, checks the main thread and backing-layer
type, then reads [`CAMetalLayer.device`](https://developer.apple.com/documentation/quartzcore/cametallayer/device).
The [pinned renderer](https://github.com/zed-industries/zed/blob/ba63a022c9a22ca66d68ef2a8f0bb9b5b0a9984d/crates/gpui_apple/src/metal_renderer.rs)
assigns its selected device to this layer during construction, and the
[native view](https://github.com/zed-industries/zed/blob/ba63a022c9a22ca66d68ef2a8f0bb9b5b0a9984d/crates/gpui_macos/src/window.rs)
exposes that renderer's layer as its backing layer. No default-device selection
occurs in the production bridge.

The observation copies the device's name and unsigned 64-bit registry ID (encoded
as a decimal string to preserve its full range). `is_software_emulated`,
`driver_name` and `driver_info` remain `null`: Metal device identity supplies none
of those classifications. No borrowed native object escapes the call. Invalid
thread/handle/layer/device states produce an explicit unavailable reason.

Current macOS development and AOT paint/input CI passes `--require-metal-device`;
absence or unavailability fails qualification. The owned native control checks
that the returned identity matches the device assigned to its test layer and
that clearing the assignment fails without selecting a fallback. Historical
records without this observation remain explicitly unavailable only for Darwin
and the reviewed GPUI pin. A changed pin needs a new source review. Missing
renderer records and malformed present metadata fail on every platform. Linux
and Windows still require valid actual adapter telemetry, including the native
software-emulation flag.
That flag is the backend's report, not an independent hardware qualification.
For example, the initial Windows run reported `Microsoft Basic Render Driver`
alongside `is_software_emulated: false`; both raw values are retained without
reclassifying the device.

The [hosted evidence below](#hosted-paint-os-input-and-assigned-device-evidence)
qualifies the assigned-device identity scope of
[#292](https://github.com/0xPlayerOne/bun-native/issues/292): all four positive
macOS paint/input cases require and report the actual layer's Metal device.
That identity does not prove GPU utilization, display presentation or hardware
performance. Complete native paints, lifecycle, joined shutdown and separately
enabled OS-input checks remain required.

The Bun installer receives its scoped repository token only during installation
and verifies the pinned archive hash/revision. The test neither requests macOS
accessibility/screen permissions, changes Windows security policy, nor replaces
GPUI with a browser or protocol peer.

## Reproduction and artifacts

On a target host with native prerequisites:

```sh
bun install --frozen-lockfile
cargo build --locked --release -p bun-native-host
# Windows adds .exe; use an absolute native executable path.
export BUN_NATIVE_HOST="$PWD/target/release/bun-native-host"
python3 scripts/quality/native-platform-smoke.py --output /absolute/new/development \
  --mode development --host-profile release -- bun tests/native/platform-smoke.ts

bun experiments/aot-gpui/build-window.ts --entry platform-smoke \
  --host "$BUN_NATIVE_HOST" --host-profile release --outdir /absolute/new/aot-package
python3 scripts/quality/native-platform-smoke.py --output /absolute/new/aot \
  --mode aot --host-profile release -- /absolute/new/aot-package/platform-smoke
```

The workflow includes equivalent PowerShell commands and per-platform executable
and Python names. `--mode aot` is a declaration, not independent inspection;
retain the matching build manifest. CI additionally requires actual
compiled-program metadata and nonempty removed JIT ranges on that target format.
An interpreter may remain present.

Add `--os-input` to the controller command to request independent native window,
pointer and keyboard qualification. On macOS, first compile the checked-in SDK
helper and supply its explicit absolute path:

```sh
xcrun clang -fobjc-arc -Wall -Wextra -Werror -framework AppKit -framework CoreGraphics \
  -framework ApplicationServices \
  scripts/quality/native-platform-macos.m -o /absolute/owned/native-platform-macos
export BUN_NATIVE_PLATFORM_HELPER=/absolute/owned/native-platform-macos
```

On Linux, run these commands only inside the existing isolated Xvfb/DBus session
wrapper, as the native CI does. The new input mode retains the same small fixed
workload: three windows and 32 hexadecimal characters per window.

Artifacts retain toolchain/SDK/build logs, source hashes, native binary hash/size,
actual paint/application records, AOT inspection/build metadata and controller
results. A successfully built unsigned native host is archived with executable
permission preserved even when later qualification fails. This is a test
artifact, not an installer, signed application bundle or clean-machine
distribution claim. The large fixture AOT executable is omitted from ordinary
evidence upload; its hash and rebuild recipe remain.

## Evidence and remaining work

### Hosted paint, OS input and assigned-device evidence

[Validation 41904934340](https://github.com/0xPlayerOne/bun-native/actions/runs/41904934340)
passed all twelve required jobs for PR head
`5bbce3c1c964baae42ef768126c5736b96a4cfaf`. The actual tested merge was
`4e12e5b5199cc07e7e1e84186bea39ce2fdfdb71`, tree
`ffa162ed31576260d47ccde23913795a1b800502`. Accepted main later combined that
change with the CLI integration; this record does not represent a fresh run of
that combined tree.

| Hosted target             | Native job                                                                                          | Retained artifact                                                                                          |
| ------------------------- | --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| macOS 15.8.2 / ARM64      | [126836941712](https://github.com/0xPlayerOne/bun-native/actions/runs/41904934340/job/126836941712) | `13359239800`, 3,481,699 bytes, SHA-256 `df1706b2e97eb20351487959ce40057d5e61dd4ff60e2b4a0c34c51580011ba4` |
| Windows Server 2022 / x64 | [126836941557](https://github.com/0xPlayerOne/bun-native/actions/runs/41904934340/job/126836941557) | `13360845884`, 4,015,772 bytes, SHA-256 `8952714a13a10f1030bd4e3d9b5f121611f0d4641e75a8f6a63438006a66c379` |

Each target passed four actual cases: development and inspected AOT, each with
paint-only and separately enabled OS-input modes. Every case completed three
windows. Paint-only cases observed six complete populated-tree paints; input
cases observed nine, three pointer activations and all 96 nonce text edits with
native Tab/focus delivery. All seven public ownership counters reached zero,
application exit was zero and native shutdown joined without forced termination.
The input controllers also completed their cleanup. Both archive digests and all
122 unique recorded source paths per target were checked against the tested
merge. Each AOT manifest independently requires compiled-program metadata and
nonempty removed JIT ranges; its execution-mode label alone supplies no proof.

All four positive macOS cases required `--require-metal-device` and reported
`CAMetalLayer.device`, including its name and canonical unsigned registry ID.
The observed name was `Apple Paravirtual device`; driver and emulation fields
remain unavailable. Windows retained `Microsoft Basic Render Driver` and the
backend's `is_software_emulated: false` without treating that combination as
independent hardware evidence.

Each target's deliberate wrong-paint case separately returned exit 1 with
`NativePaintMismatch`, zero public owners and joined shutdown. CI accepts that
precise expected failure; it proves oracle rejection, not a deliberately failed
aggregate job. The separate aggregate-failure acceptance in #256 remains open.
Screenshots, display presentation, physical input, IME/accessibility, OS close
buttons and complete descendant enumeration remain unqualified by these cases.

### Earlier records and remaining coverage

Actual Linux development and inspected AOT runs of this portable fixture passed
three cycles and six complete paints, joined native shutdown, and cleared all
six public resource counters. The deliberate wrong-paint run exited 1 with the
expected `NativePaintMismatch`, joined native shutdown, and needed no forced
application termination. These establish the controller/fixture on Linux and
**do not qualify macOS or Windows**. The compact source-bound record is
[platform-smoke-linux-development-aot.json](../tests/native/evidence/platform-smoke-linux-development-aot.json).

The owned-input extension also passed actual Linux development and inspected
AOT runs: each exercised three pointer activations, native Tab key/focus
traversal, all 96 ordered text edits and nine complete paints. Every public
resource counter returned to zero and native shutdown joined without forced
application termination. An AOT paint-only control still passed six paints with
no input callbacks. The exact source, executable, renderer and raw-report hashes
are in [platform-input-linux-development-aot.json](../tests/native/evidence/platform-input-linux-development-aot.json).
These runs used the immutable **dev-profile** host; hosted jobs require the
release host. macOS SDK compilation and macOS/Windows input are not qualified by
these Linux results. The Windows pure guards cover ABI sizes, clipped geometry,
edit ordering, callback exception containment, borrowed/owned desktop handles,
partial input release and recycled parent-PID rejection; they are headless tests.

After integrating the current bootstrap, cross-format AOT inspector and locked
dependencies, the same actual Linux development/AOT input checks passed again.
The [integration record](../tests/native/evidence/platform-input-integrated-linux.json)
binds both runs to their 61 current compiler/controller source fingerprints and
the newly compiled application. It retains the dev-host and software-GPU scope;
these correctness runs are not comparative timing measurements.

The [hosted paint matrix](https://github.com/0xPlayerOne/bun-native/actions/runs/41238694201)
passed all twelve required jobs. Its [source-bound target record](../tests/native/evidence/platform-smoke-hosted-macos-windows.json)
verifies both target archives and every recorded source against the actual tested
merge. On both macOS ARM64 and Windows x64, development and independently
inspected AOT each completed three window lifecycles, six populated-tree paints,
joined native shutdown and zero public ownership counters. Each target also
rejected the deliberate wrong-paint expectation with the required error and
clean shutdown. This establishes the build, paint and lifecycle scope above;
OS input and the other explicitly unverified capabilities remain separate.

The initial [macOS run](https://github.com/0xPlayerOne/bun-native/actions/runs/41236725102)
passed the release host build, Clippy and native unit tests, then failed the old
controller's unconditional adapter requirement. Its retained evidence contains
the actual `gpu: null` record, an empty-root paint and an acknowledged populated
tree, but no complete populated-tree paint before the abort. That historical
result remains failed. The later successful hosted run described above supplies
the separate complete native paint/lifecycle evidence.

The [telemetry correction record](../tests/native/evidence/platform-renderer-telemetry.json)
retains that failed macOS result and its offline validator replay. Fresh Linux
controls passed six development paints, required the deliberate wrong-paint
failure, and passed nine paints plus all 96 OS text edits in both development
and AOT input modes. All windows closed, public ownership counters cleared and
native shutdown joined. Those runs use the unchanged dev-profile host and
actual reported Linux adapter metadata; they validate this controller change
without qualifying macOS or Windows input. The reused AOT executable and all 49
build-source hashes were reverified, and each current controller source hash is
bound to its own report.

The current input cases independently identify the owned window and its
process/executable before verifying pointer and keyboard delivery. Follow-up
coverage must establish OS-close results, screenshots and complete descendant
cleanup where the session permits them. Unavailable hosted desktop/GPU or
permission capabilities must be reported precisely. No security setting change
or manual owner intervention is part of this workflow.

Remaining acceptance also includes clean-machine native library/resource
resolution, accessibility/IME, signing/install/update behavior and per-platform
cold-start/memory/artifact audits. Elapsed build/smoke observations have
uncontrolled cache/scheduler conditions; this increment establishes no
cross-platform performance ranking.
