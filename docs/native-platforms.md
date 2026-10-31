# Native platform build and paint qualification

This is an incremental implementation of [CI #256](https://github.com/0xPlayerOne/bun-native/issues/256)
and [target artifacts #246](https://github.com/0xPlayerOne/bun-native/issues/246).
Both issues remain open. Linux's existing owned-window/input suite stays required;
this lane adds genuine target-host compilation and a portable native lifecycle
fixture for macOS and Windows. It does not infer GUI interaction from compilation.

## Paint/lifecycle mode and its claims

The reusable [`Native Platforms` workflow](../.github/workflows/native-platforms.yml)
uses `macos-15` and `windows-2022`, a 60-minute per-target budget and independent
matrix outcomes. It preserves draft/billing guards and read-only repository
permissions. Caches contain dependency downloads, not build outputs or secrets.
Caller/gate integration is separate so existing required checks are not replaced
before target-native jobs have actual evidence.

Each target builds the real release GPUI executable with pinned Rust, Bun and
GPUI sources, runs host Clippy/tests, then executes the same public-core fixture
in development and inspected machine-code AOT. The fixture opens, updates and
closes three successive windows. The independent controller requires each
window's actual renderer record and complete initial/update native tree paint.
Adapter telemetry must be valid when present; the pinned macOS backend's explicit
unavailable result is recorded separately, as described below.
Input value replacement is an explicit application transaction, not OS typing.
Each close must revoke public resources; final shutdown joins the runtime's
native child exit.

| Observation              | Qualification in this first increment                                                                                     |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| Rust compilation         | Separate target tools, release command, build duration, binary bytes and SHA-256.                                         |
| GPUI execution           | Actual host, three native window protocol lifecycles, renderer records and six complete paint traversals.                 |
| Adapter telemetry        | Required on Linux/Windows; explicitly unavailable from the pinned macOS window API.                                       |
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
  owned foreground. This is a controller correction awaiting native delivery
  verification; an SDK event object or posting call cannot satisfy that gate.
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
unconditionally returns `None`. The host faithfully records that as `gpu: null`.
The controller requires this actual per-window renderer record, then writes
`rendererTelemetry.status: "unavailable"` with the pinned source and reason. It
does not infer the adapter name, hardware/software classification or driver.
The allowance applies only to Darwin and this reviewed GPUI revision; a changed
pin requires a new source review. Missing renderer records and malformed present
metadata fail on every platform. Linux and Windows still require valid actual
adapter telemetry, including the native software-emulation flag.
That flag is the backend's report, not an independent hardware qualification.
For example, the initial Windows run reported `Microsoft Basic Render Driver`
alongside `is_software_emulated: false`; both raw values are retained without
reclassifying the device.

An independent Metal default-device query would not establish which device the
window uses: the [pinned renderer's selection](https://github.com/zed-industries/zed/blob/ba63a022c9a22ca66d68ef2a8f0bb9b5b0a9984d/crates/gpui_apple/src/metal_renderer.rs)
prefers a non-removable, low-power device when enumerated devices are available.
Exposing its actual selected adapter remains [#292](https://github.com/0xPlayerOne/bun-native/issues/292).
This telemetry limitation does not waive complete native paints, lifecycle,
joined shutdown or any separately enabled OS-input checks.

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

Follow-up controllers must independently identify the owned window and its
process/executable before input, then attest actual keyboard/mouse/OS-close
results and screenshots where the session permits them. Unavailable hosted
desktop/GPU or permission capabilities must be reported precisely. No security
setting change or manual owner intervention is part of this workflow.

Remaining acceptance also includes clean-machine native library/resource
resolution, accessibility/IME, signing/install/update behavior and per-platform
cold-start/memory/artifact audits. Elapsed build/smoke observations have
uncontrolled cache/scheduler conditions; this increment establishes no
cross-platform performance ranking.
