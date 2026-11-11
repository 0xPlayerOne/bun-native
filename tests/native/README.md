# Real native integration fixtures

These entry points launch the actual prebuilt GPUI host. They are separate from
the default headless `bun test tests` suite. The required Linux native CI job
builds one release host and reuses that artifact for development Bun and the
explicit inspected machine-code AOT entries below.

## Session modes

Run `scripts/quality/native-linux-session.sh` inside a dedicated Xvfb/DBus session.
Its output directory must be new, and the application command is explicit.

| Mode                   | Application command                      | Required behavior                                                                                                                                                        |
| ---------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `development`          | `bun examples/native-window/main.ts`     | Public API pointer, text and Enter events; full native tree paints; OS close/relaunch; five lower-level window lifecycle cycles and the development stale-input fixture. |
| `aot`                  | Compiled `native-window`                 | The same public API pointer, text, Enter and close scenarios.                                                                                                            |
| `aot-input-race`       | Compiled `input-race`                    | A real typed input rejects an outdated replacement revision and survives an unrelated tree update.                                                                       |
| `javascript`           | `bun tests/native/javascript.js`         | A strict-JSDoc JavaScript consumer creates and updates the native tree, handles click/input callbacks, observes input revisions and releases its resources.              |
| `aot-javascript`       | Compiled `javascript`                    | The same JavaScript consumer input and cleanup scenarios through Bun AOT.                                                                                                |
| `core-lifecycle`       | `bun tests/native/public-lifecycle.ts`   | One real click starts 1,000 public subtree/listener lifecycle cycles. OS close must abort the still-active callback and clear public resource counts.                    |
| `aot-core-lifecycle`   | Compiled `core-lifecycle`                | The same public lifecycle and cancellation scenario through Bun AOT.                                                                                                     |
| `event-throughput`     | `bun tests/native/event-throughput.ts`   | Exactly 1,000 OS-delivered input edits, every sequence/revision/value checked, no input echo, final native paint and clean close.                                        |
| `aot-event-throughput` | Compiled `event-throughput`              | The same fixed input stream through Bun AOT.                                                                                                                             |
| `services`             | `bun tests/native/services.ts`           | Native default denial, allowed display read checked against the isolated X server, cancellation, stale owners, actual button input, matching paint and shutdown.         |
| `aot-services`         | Compiled `services`                      | The same native service operation and lifecycle through Bun AOT.                                                                                                         |
| `solid-services`       | `bun PACKAGE/development/application.js` | A real native display read through the shared public core from a Solid button, independent native geometry/paint checks and framework/owner cleanup.                     |
| `aot-solid-services`   | Compiled `solid-services`                | The same Solid consumer and native service operation through Bun AOT.                                                                                                    |
| `react-services`       | `bun PACKAGE/development/application.js` | The same shared public-core display operation from a React button, complete native paint and effect/listener/owner cleanup.                                              |
| `aot-react-services`   | Compiled `react-services`                | The same React consumer and native service operation through Bun AOT.                                                                                                    |
| `--`                   | An explicit command                      | Create the isolated display environment for a benchmark runner, the diagnostics driver or a self-checking fixture; the supplied command defines its own checks.          |

`tests/native/text-input.ts` is self-driving: it qualifies grapheme editing,
Hebrew input, dead-key composition, selection/clipboard, read-only and disabled
inputs, Tab order, scale factor 1 or 2 and an AT-SPI tree read. See
[native text](../../docs/native-text.md) for its environment and support matrix.

`tests/native/accessibility.ts` is self-driving: an independent AT-SPI client
asserts the role, name, state and value of every element kind, a modal dialog
and the split divider, while real Tab, arrow, Home/End and pointer input move
the divider and its `split_resize` events. It also sends AT-SPI caret,
selection, click, focus and value requests and checks character bounds and the
tree beneath a modal dialog. It runs at GPUI X11 scale 1 or 2 and checks every
coordinate, capture pixel and AT-SPI extent in device pixels. See
[native text](../../docs/native-text.md#accessibility-roles-accessibility_v1).

`tests/native/solid-workspace-terminal.tsx` and
`tests/native/react-workspace-terminal.tsx` are self-driving through
`workspace-terminal.ts`: the actual workspace with its real `/bin/sh` on an
owned PTY, XTest clicks and keys into the terminal pane, the PTY round trip of
a command's output, its paint (host paint evidence and window pixels),
Interrupt and Alt+F4. They need `BUN_NATIVE_EVIDENCE_LOG` and
`BUN_NATIVE_EVIDENCE_NONCE` for the host's paint evidence.

`tests/native/accessibility-platform.ts` is the macOS and Windows counterpart:
an independent AX (`macos-accessibility-oracle.m`) or UI Automation
(`windows-accessibility-oracle.ps1`) client reads the same element kinds and
makes every change through assistive-technology requests only.

`tests/native/screen-reader.ts` drives a real screen reader with real OS keys
and asserts what it says: Orca through a capturing `speech-dispatcher` module on
Linux, and, experimentally on hosted CI, VoiceOver's last phrase on macOS and
NVDA's speech log on Windows. `tests/native/ime-platform.ts` repeats the Linux
Hangul composition with the macOS or Windows Korean input method (experimental).
See [native text](../../docs/native-text.md#screen-reader-speech).

The input driver verifies that the target window belongs to the launched
application, focuses it, injects XTest input and requires matching Bun events and
complete native paint snapshots. It waits for the mounted tree before injecting
input, so an earlier empty-root paint cannot qualify as a ready fixture. Each
scenario closes the window through the window manager and checks exit and
owned-process cleanup. Screenshots are retained for inspection; there is no
automated pixel/text assertion or physical-input measurement.

## Run development fixtures

Install the pinned toolchains and Linux prerequisites from
`.github/workflows/native-linux.yml`. Framework contributors deliberately build
the native artifact once; ordinary application changes reuse it.

```sh
cargo build --locked --release -p bun-native-host
mkdir -p .bun-native
run_dir=$(mktemp -d "$PWD/.bun-native/native-suite.XXXXXX")
export BUN_NATIVE_HOST="$PWD/target/release/bun-native-host"
export BUN_NATIVE_HOST_PROFILE=release

xvfb-run --auto-servernum --server-args='-screen 0 1280x800x24 -nolisten tcp' \
  dbus-run-session -- bash scripts/quality/native-linux-session.sh \
  "$run_dir/javascript-development" javascript bun tests/native/javascript.js

xvfb-run --auto-servernum --server-args='-screen 0 1280x800x24 -nolisten tcp' \
  dbus-run-session -- bash scripts/quality/native-linux-session.sh \
  "$run_dir/lifecycle-development" core-lifecycle bun tests/native/public-lifecycle.ts

xvfb-run --auto-servernum --server-args='-screen 0 1280x800x24 -nolisten tcp' \
  dbus-run-session -- bash scripts/quality/native-linux-session.sh \
  "$run_dir/events-development" event-throughput bun tests/native/event-throughput.ts
```

The repository's strict TypeScript check enables `allowJs` and `checkJs` and
includes the JavaScript consumer. Type checking alone does not establish its
native runtime behavior; the session modes above exercise that separately.

## Compile and run AOT entries

The shared build helper's [entry table](../../experiments/aot-gpui/README.md)
covers public-core, platform, Solid and React fixtures. It records
source/configuration and executable hashes, the exact compiler command,
compiled-program metadata and target-specific JIT omission evidence.
`native-window` bundles a copy of the native host for the
distribution/baseline package. The other entries reference the existing host by
path and hash.

```sh
bun experiments/aot-gpui/build-window.ts \
  --source "$PWD" --host "$BUN_NATIVE_HOST" --host-profile release \
  --entry javascript --outdir "$run_dir/javascript-package"

xvfb-run --auto-servernum --server-args='-screen 0 1280x800x24 -nolisten tcp' \
  dbus-run-session -- bash scripts/quality/native-linux-session.sh \
  "$run_dir/javascript-aot" aot-javascript "$run_dir/javascript-package/javascript"

bun experiments/aot-gpui/build-window.ts \
  --source "$PWD" --host "$BUN_NATIVE_HOST" --host-profile release \
  --entry core-lifecycle --outdir "$run_dir/lifecycle-package"

xvfb-run --auto-servernum --server-args='-screen 0 1280x800x24 -nolisten tcp' \
  dbus-run-session -- bash scripts/quality/native-linux-session.sh \
  "$run_dir/lifecycle-aot" aot-core-lifecycle "$run_dir/lifecycle-package/core-lifecycle"

bun experiments/aot-gpui/build-window.ts \
  --source "$PWD" --host "$BUN_NATIVE_HOST" --host-profile release \
  --entry event-throughput --outdir "$run_dir/events-package"

xvfb-run --auto-servernum --server-args='-screen 0 1280x800x24 -nolisten tcp' \
  dbus-run-session -- bash scripts/quality/native-linux-session.sh \
  "$run_dir/events-aot" aot-event-throughput "$run_dir/events-package/event-throughput"
```

Keep each build manifest beside its corresponding native evidence. The driver
records the requested execution mode and does not independently determine
whether an arbitrary supplied executable contains Bun AOT code.

The [native services recipe](../../docs/native-services.md#reproduction-and-evidence-boundaries)
builds and executes the core, Solid and React display-service consumers in
development and AOT modes. Each uses an explicit prebuilt host built for the
[current protocol](../../docs/native-abi.md); older retained protocol-4 and
protocol-5 artifacts cannot qualify these scenarios.
The framework modes execute the exact generated production modules recorded
by `--entry solid-services` and `--entry react-services` before compiling them
to AOT. They share the core operation, policy and native implementation.

## Release-host boundary, startup panic and offline AOT

`boundary.ts` writes raw frames to the actual host, bypassing the TypeScript
client: version mismatch, pre-hello and duplicate `hello`, invalid JSON, UTF-8
and BOM, empty, unknown-type and unknown-field frames, frames exactly at and one
byte over the 64 KiB limit, EOF inside a frame and on a frame boundary, frames
behind a terminal error, and fragmented or coalesced frames. Each case owns a
fresh host and a 10 s deadline, and must end with exit 0. With neither `DISPLAY`
nor `WAYLAND_DISPLAY`, GPUI runs its headless Linux platform: every protocol case
still runs and the real window case is reported under `skipped`.

`release-host.test.ts` runs only with `BUN_NATIVE_HOST` set to the prebuilt
host; otherwise each case is skipped with its reason in the test name. It runs
`boundary.ts` with no display at all, `startup-panic.ts` with an unreachable X
display (a real GPUI panic during startup, reported by the Bun launch as a typed
`panic` diagnostic in the `starting` phase with the inherited display value
redacted), and an inspected AOT build of `boundary.ts` under Xvfb inside
`unshare --map-root-user --net`. The offline case is skipped where unprivileged
user namespaces, `xvfb-run`, `dbus-run-session` or the pinned AOT compiler are
unavailable. `session-panic.ts` runs under its own Xvfb with the test-only
`BUN_NATIVE_TEST_FAULT=panic-in-batch`: the host opens a real window, then
panics inside the GPUI update of its first batch, and the pending batch, window
and application reject with one typed `panic` diagnostic in the `running` phase
located in `session.rs`. `RUST_BACKTRACE=1` makes the backtrace clip the
captured stderr, so the kept panic report is checked too. The variable is read
once at host startup; the launching application already controls the host's
environment, so it grants nothing new.

```sh
BUN_NATIVE_HOST="$PWD/target/release/bun-native-host" bun test tests/native/release-host.test.ts
```

## Evidence and limits

### Isolated clipboard diagnostic

The `clipboard` diagnostic uses the existing owned-process/window controller
and a separate foreground native X11 owner/requestor. It touches only the
task-owned Xvfb selection; never run it against a personal or shared display.

```sh
cargo build --locked --release -p bun-native-host --bin bun-native-host --example clipboard-peer
export BUN_NATIVE_HOST="$PWD/target/release/bun-native-host"
export BUN_NATIVE_CLIPBOARD_PEER="$PWD/target/release/examples/clipboard-peer"

xvfb-run --auto-servernum --server-args='-screen 0 1280x800x24 -nolisten tcp' \
  dbus-run-session -- bash scripts/quality/native-linux-session.sh \
  "$run_dir/clipboard-development-session" -- \
  python3 scripts/quality/native-diagnostics-linux.py \
  --output "$run_dir/clipboard-development" --scenario clipboard \
  --mode development --host-profile release -- bun tests/native/clipboard.ts

bun experiments/aot-gpui/build-window.ts --entry clipboard --source "$PWD" \
  --host "$BUN_NATIVE_HOST" --host-profile release --outdir "$run_dir/clipboard-package"

xvfb-run --auto-servernum --server-args='-screen 0 1280x800x24 -nolisten tcp' \
  dbus-run-session -- bash scripts/quality/native-linux-session.sh \
  "$run_dir/clipboard-aot-session" -- \
  python3 scripts/quality/native-diagnostics-linux.py \
  --output "$run_dir/clipboard-aot" --scenario clipboard \
  --mode aot --host-profile release -- "$run_dir/clipboard-package/clipboard"
```

Each run requires all 26 outcomes, the exact 22 normally joined foreground
peers, complete initial/intermediate/final native paints, an actual XTest edit
while an external owner stalls, OS close and seven zero public ownership
counters. It distinguishes empty selection from empty text, tests ordinary and
INCR reads, oversized/invalid/flooded transfers, default denial, stale owners,
read cancellation, pending close/shutdown, external reads of writes and
preservation of a newer external selection after host shutdown. Idle observations
cover post-read, retained ownership and ownership loss; they are bounded
diagnostics, not whole-system power or long-term performance measurements.

The result records the host and peer executable hashes and the controller's
source snapshot. Retain the AOT manifest separately to establish actual compiled
application provenance. The [recovery history](evidence/clipboard-recovery-history.json)
records prior execution whose unpublished source/raw files were lost; it is
not fresh qualification of reconstructed files. The separate
[recovered-source record](evidence/clipboard-linux-recovered.json) binds two
new successful development/AOT runs to their exact host, peer, application and
source hashes. It also records the actual compiler's official npm acquisition;
the older GitHub archive configuration in the source manifest is not a download
receipt. These local runs use the development Rust host profile, while the
hosted job builds and tests its own release host.

### Global shortcuts and notifications

`global-shortcuts.ts` ([ADR 0008](../../docs/decisions/0008-native-global-shortcuts.md))
and `notifications.ts` ([ADR 0009](../../docs/decisions/0009-native-notifications.md))
are self-checking fixtures run directly inside the isolated session, not through
the diagnostics driver. Both require an X11 `DISPLAY` without `WAYLAND_DISPLAY`,
an absolute existing evidence directory and an absolute `BUN_NATIVE_HOST`.
Shortcuts also need the `shortcut-peer` example as `BUN_NATIVE_SHORTCUT_PEER`
plus `BUN_NATIVE_SHORTCUT_EVIDENCE`/`BUN_NATIVE_SHORTCUT_MODE`; notifications
need the D-Bus session's `dunst` server plus
`BUN_NATIVE_NOTIFICATION_EVIDENCE`/`BUN_NATIVE_NOTIFICATION_MODE`. The mode is
`development` or `aot`; AOT runs the inspected `--entry global-shortcuts` or
`--entry notifications` executable. The Native Linux workflow's steps are the
exact recipe:

```sh
cargo build --locked --release -p bun-native-host --bin bun-native-host --example shortcut-peer
export BUN_NATIVE_HOST="$PWD/target/release/bun-native-host"
mkdir "$run_dir/global-shortcuts-development"
BUN_NATIVE_SHORTCUT_PEER="$PWD/target/release/examples/shortcut-peer" \
  BUN_NATIVE_SHORTCUT_EVIDENCE="$run_dir/global-shortcuts-development" \
  BUN_NATIVE_SHORTCUT_MODE=development \
  xvfb-run --auto-servernum --server-args='-screen 0 1280x800x24 -nolisten tcp' \
  dbus-run-session -- bash scripts/quality/native-linux-session.sh \
  "$run_dir/global-shortcuts-development-session" -- bun tests/native/global-shortcuts.ts
```

These cover local Linux X11 global shortcuts and the freedesktop.org
notification service against `dunst` only; macOS, Windows, Wayland and other
notification servers remain unqualified.

### Shared native desktop service

The [service qualification record](evidence/services-linux-development-aot.json)
binds six actual Linux runs to the protocol-5 host, each compiler manifest,
generated framework module and native controller. Core, Solid and React all
passed development and machine-code AOT scenarios using one immutable
development-profile host. The button reads the owned GPUI window's display,
the driver independently checks the X server's 1280×800 scale-1 geometry, and
the complete native tree must paint that result before OS close. Default
denial, queued cancellation, stale/unknown ownership and shutdown are checked
by the core fixture; each framework also proves owner disposal and empty
renderer resources. The CI step repeats all six cases on its release host.

These records cover a single Xvfb screen and actual Mesa software rendering.
They do not qualify another platform, mixed-DPI monitor placement, service
performance or long-term leak freedom. The [service contract](../../docs/native-services.md)
documents backend-specific display origins and the unavailable service matrix.

### React adapter

Build each fixture with the common AOT helper before executing its two modes.
Development uses `bun PACKAGE/development/application.js`, and AOT uses
`PACKAGE/ENTRY`. The manifest fingerprints the exact generated module supplied
to the machine-code compiler, as well as its original source and configuration.
The counter, interactions, behavior and workload entries all use this recipe.
The [integrated recipe record](evidence/react-hosted-recipe-linux.json) records
26 actual local counter/event/behavior runs on the unchanged protocol4 development
host. All four entries were compiled and inspected; the unchanged workload's
execution and fixed retention observations remain a separate hosted gate.

`tests/native/react-window.py` supplies independent complete-tree expectations for
`examples/react-counter/main.tsx`, then executes the existing owned-process input
driver. Its `counter-click` scenario requires one label update, one retained keyed
move and one deletion with React row cleanup. `counter-input` requires every native
edit revision and the final input/echo values. Both require OS close and effect/
listener cleanup. The required native job runs both with development Bun and the
inspected `--entry react` AOT executable against its already-built release host.
See the [adapter instructions](../../packages/react/README.md) and
[local source-bound evidence](evidence/react-linux-development-aot.json). That local
record uses a development-profile host and does not qualify release performance.

The protocol4 follow-up uses `tests/native/react-interactions.tsx` with the common
`renderer-interactions.ts` oracle. Run `tests/native/renderer-interactions.py
--renderer React --scenario keyboard|caret|selection --mode development|aot
--output NEW_DIRECTORY -- APPLICATION` inside the existing isolated native
session. Pass the inspected `--entry react-interactions` executable in AOT mode.
The scenarios require real pointer/focus/keyboard events, both JavaScript
propagation-stop policies, caret insertion or selection replacement, exactly two
native Sets and a complete expected paint tree. Every observed registration signal
must be revoked after OS close, with all public ownership counts zero. The helper
adds no process supervisor or framework event-dispatch implementation.

The [protocol4 event record](evidence/react-events-linux-development-aot.json) binds
those six development/AOT runs and the four counter regressions to exact
protocol4 source and binary hashes. Global native sequence numbers now include
focus, pointer and key notifications; typed edit counts remain independently
checked by input revisions. The shared core validates global ordering.

`react-behavior.tsx` supplies the separate eight-case React behavior qualification.
Run `python3 tests/native/react-behavior.py --scenario SCENARIO --mode
development|aot --output NEW_DIRECTORY -- APPLICATION` inside the same isolated
session; AOT uses the inspected `--entry react-behavior` executable. Cases cover
batched state/reducer updates and hook/ref lifetime, actual boundary fallback and
recovery, a transient concurrent retry, terminal recovery-reporter/effect/ref
errors, and a non-suspending transition. The last three failure cases require an
independent survivor root to update and paint after the failed root releases its
ownership. The controller asserts exact initial/final trees and the original
driver's OS-input and child-cleanup contract. `react-behavior.json` records bounded
effect traces, ref counts, error identity assertions and final ownership. See the
[behavior and concurrency matrix](../../docs/react-behavior.md) for every scenario
and the precise transition-completion limit.

Each input scenario writes a `result.json`, bounded stdout/stderr and event logs,
before/after screenshots, renderer details and owned process-tree RSS samples.
The lifecycle fixture also writes `public-lifecycle.json` beside the event log,
with raw cycle timings, Bun memory checkpoints, weak-reference observations,
public resource counts and callback cancellation results. Weak-reference or
finite lifecycle observations alone do not establish long-term leak freedom.

### Fixed event-throughput workload

The event-throughput modes reuse the same process ownership, window discovery,
nonce freshness, native paint, deadline and cleanup checks. Ordinary smoke input
remains capped at 16 keys and 200 characters after nonce expansion. The explicit
`--event-stress` driver flag accepts only the fixed fixture title, exactly 1,000
lowercase `x` characters, no additional key/click actions, and the complete
expected initial/final native trees. It does not enable arbitrary larger input
or targeting of an existing unrelated window. The 4 MiB evidence/log bounds
remain unchanged.

The input listener uses the public API and never echoes a value or sends a
per-edit tree update. Both the application and independent driver validate all
1,000 increasing input-event sequences, contiguous input revisions and exact
prefix values. The runtime independently validates the complete contiguous UI
sequence, including key and focus events between input callbacks. The final
native paint must contain the complete value at input revision 1,000 while the
tree revision remains 1. The fixture writes `event-throughput.json` beside the
event log, with every callback observation time, inter-callback gaps, observed
queue counts and final ownership state.

The driver requests a 1 ms character delay from `xdotool` and records the actual
text-injection command interval, including subprocess and X server enqueue
overhead. The application records `performance.now()` at each callback entry.
Its observed callback rate uses the 999 intervals between the first and last
of the 1,000 callbacks. Prefix assertions and synchronous evidence appends are
part of this instrumented workload. Callback gaps include the offered input
schedule, native input processing, IPC and Bun scheduling; they are **not**
per-event dispatch latency or input-to-presentation latency. The driver and Bun
clocks are not correlated, and this fixed offered load does not establish a
maximum sustainable event rate.

The [bridge runner](../../benchmarks/BRIDGE.md) records actual native
acknowledgement timings and semantic checks. Required CI runs development and
AOT bridge measurements with instrumentation disabled; those timings are not
display-presentation measurements. The
[repeated baseline](../../benchmarks/NATIVE_BASELINE.md) compares the same
public API fixture and release host across modes, retains every trial and uses
no guessed performance budget.

The session selects Mesa software Vulkan and the input driver verifies the
adapter actually reported by GPUI. This evidence covers Linux X11/XTest and
software rendering. It does not qualify hardware-GPU performance, physical
input, display-presentation latency or macOS/Windows GUI behavior.

## Shared layout diagnostics

`tests/native/overlays.ts` consumes only public core and drives itself with XTest (xdotool) inside the isolated session, reading click positions from the host's nonce-tagged paint evidence (`BUN_NATIVE_EVIDENCE_LOG`/`BUN_NATIVE_EVIDENCE_NONCE` must be set by the caller because the host inherits the launching environment). It covers modal focus trapping, backdrop pointer blocking, nested Escape, focus/selection return, popover z-order with screenshot pixels, end-anchored streaming scroll, an autofocus menu popover with arrow keys, type-ahead and a screenshot-verified focus ring, and programmatic focus, `scrollTo`, `scrollIntoView` and Tab reveal in development and through `--entry overlays` AOT. See the [overlay contract](../../docs/native-overlays.md).

`tests/native/message-dialogs.ts` (`BUN_NATIVE_MESSAGE_DIALOG_EVIDENCE`, `BUN_NATIVE_MESSAGE_DIALOG_MODE`, plus the evidence log and nonce) qualifies public core's message and confirm dialogs the same way and through `--entry message-dialogs` AOT: default focus with screenshot colors, the Tab trap, a covered control staying inert, real clicks, Enter, Escape and Space, backdrop dismissal, a listener awaiting a confirmation, queued dialogs, abort with focus return, owner close and shutdown. See [message and confirm dialogs](../../docs/native-services.md#message-and-confirm-dialogs).

`tests/native/popups.ts` (`BUN_NATIVE_POPUP_EVIDENCE`, `BUN_NATIVE_POPUP_MODE`, plus the evidence log and nonce) qualifies popup window overlays the same way and also through `--entry popups` AOT. Popup geometry, override-redirect state, `WM_TRANSIENT_FOR`, `_NET_WM_WINDOW_TYPE` and stacking come from the X server (`xwininfo`, `xprop`); it covers placement beyond the parent window, pointer routing and coordinates, Escape with focus kept in the parent, following a parent move, blur dismissal, display clamping with an upward flip and closing with the parent. See [popup windows](../../docs/native-overlays.md#popup-windows-beyond-the-parent-window).

`tests/native/wayland.ts` (`BUN_NATIVE_WAYLAND_EVIDENCE`, `BUN_NATIVE_WAYLAND_MODE`, `BUN_NATIVE_WAYLAND_INPUT_PEER`, plus the evidence log and nonce) runs inside `scripts/quality/native-wayland-session.sh` on headless sway with no X server, in development and through `--entry wayland` AOT. It requires an `xdg_shell` view (sway IPC) and a complete native paint within 10 s, a click from a persistent `zwlr_virtual_pointer_v1` ([`wayland-input-peer`](../../native/gpui-host/examples/wayland-input-peer.rs)), wtype text and Enter, grim pixels matching the painted tree, a display snapshot equal to the compositor's output, the Wayland service capability matrix, a dunst notification, an unparented portal file dialog closed by abort and by the compositor, a compositor close and clean shutdown. See [native platforms](../../docs/native-platforms.md#linux-wayland).

`tests/native/layout.ts` consumes only public core and is driven by the `layout` scenario in `scripts/quality/native-diagnostics-linux.py`. It uses the same isolated session and owned-window cleanup, with actual pointer/wheel/key/resize actions. Both development and the shared AOT helper's `--entry layout` must pass against the matching current host. The [layout contract](../../docs/native-layout.md) records exact commands, geometry bounds, source status and unsupported coverage. This diagnostic is separate from the repeated window baseline.

`tests/native/layout-style.ts` and its `solid-layout-style.tsx` / `react-layout-style.tsx` consumers mount one `layout-style-scene.ts` scene (`BUN_NATIVE_LAYOUT_EVIDENCE`, `BUN_NATIVE_LAYOUT_MODE`, `BUN_NATIVE_TEST_SCALE_FACTOR`, plus the evidence log and nonce). XTest clicks, divider drags, wheel and Tab drive it. The Native Linux job runs each adapter at scale 1 and 2 in development and AOT. Then `bun tests/native/layout-style-compare.ts REPORT.json...` requires one committed element tree and the same logical geometry across every adapter, mode and scale, within half a logical pixel.

## Display, drag-and-drop and process fixtures

These self-driving fixtures each run in development and through their own `--entry` AOT package. Each writes its report into the evidence directory its `*_EVIDENCE` variable names, and its `*_MODE` variable is `development` or `aot`. The Linux runs use the isolated Xvfb/DBus session. The macOS and Windows runs are steps of the hosted [Native Platforms workflow](../../.github/workflows/native-platforms.yml), and no evidence record from them is retained here, so their platform behavior is unverified. The [capability table](../../docs/native-platforms.md#advertised-capabilities-by-platform) shows which host advertises each feature.

| Fixture                                                      | Platforms and variables                                                                                                                                                                                                                                                                                    | Required behavior                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `display-semantics.ts`                                       | Linux X11 with two Xvfb screens (`-screen 0 1280x800x24 -screen 1 1024x768x24`); `BUN_NATIVE_DISPLAY_EVIDENCE`, `BUN_NATIVE_DISPLAY_MODE`.                                                                                                                                                                 | Snapshots match `xdpyinfo`/`xwininfo`: the whole X screen, independent of real X moves and resizes, and fixed per window. `details` and `changes` are unavailable. See [X11 display semantics](../../docs/native-services.md#qualified-x11-display-semantics-299).                                                                                                                                    |
| `display-wayland.ts`                                         | Headless sway with two outputs: `native-wayland-session.sh` with `BUN_NATIVE_WAYLAND_OUTPUTS=2`; `BUN_NATIVE_DISPLAY_EVIDENCE`, `BUN_NATIVE_DISPLAY_MODE`.                                                                                                                                                 | Snapshots and `onDisplayChange` against sway IPC: one change per migration between outputs of scale 1 and 2, none within an output, one per reconfiguration of the window's output, none on connecting or unplugging another output, and a fail-closed snapshot after the window's own output is unplugged. See [Wayland display changes](../../docs/native-services.md#wayland-display-changes-299). |
| `display-platform.ts`                                        | Hosted macOS and Windows only; the same two variables plus `BUN_NATIVE_MACOS_DISPLAY_HELPER` (compiled `macos-display-oracle.m`) or `BUN_NATIVE_WINDOWS_DISPLAY_ORACLE` (`windows-display-oracle.ps1`).                                                                                                    | Default denial, then bounds, work area, scale and `displayId` against the GPUI-free oracle. Two windows give identical snapshots. A real display-mode change and its restore reach the owned listeners, and close and shutdown revoke them. See [macOS and Windows display semantics](../../docs/native-services.md#macos-and-windows-display-semantics-299).                                         |
| `display-service-policy.ts`                                  | Helper module, not an entry point.                                                                                                                                                                                                                                                                         | The display fixtures grant only `windowDisplay`. [`display-service-policy.test.ts`](../quality/display-service-policy.test.ts) covers it headlessly.                                                                                                                                                                                                                                                  |
| `drag-drop.ts`, `solid-drag-drop.tsx`, `react-drag-drop.tsx` | Linux X11, hosted macOS and hosted Windows. `BUN_NATIVE_DRAG_SOURCE` is the independent source (x11rb `xdnd-source`, compiled `macos-drag-source.m` or `windows-drag-source.cs`); `BUN_NATIVE_DRAG_DROP_EVIDENCE`, `BUN_NATIVE_DRAG_DROP_MODE`. `drag-source.ts` and `drop-adapter.ts` are shared helpers. | A real OS drag from another process enters, leaves and drops on owned targets. No GPUI event is synthesized. Items resolve beneath launch roots, and on Linux and macOS a resolved item is read through a real grant; on Windows none resolves. Unmounting mid-drag and closing revoke targets. See [drag and drop](../../docs/native-services.md#drag-and-drop).                                     |
| `processes.ts`                                               | Linux X11 and hosted macOS; `BUN_NATIVE_PROCESS_EVIDENCE`, `BUN_NATIVE_PROCESS_MODE`.                                                                                                                                                                                                                      | Real children's output, exit status and working directory, plus process-group teardown on exit, release, owner close and shutdown, checked through `/proc` on Linux and `ps` on macOS. The macOS fixture starts its child in a grant directory, as on Linux. Raw protocol checks reject foreign, stale and reused handles. See [owned processes](../../docs/native-services.md#owned-processes).      |

## Shared interaction diagnostics

`tests/native/interactions.ts` also uses public core only. The diagnostics runner's
`interactions` scenario reuses the same owned-window checks, bounded nonce-tagged
logs, deadlines and cleanup. It supplies pointer/Enter activation, Tab focus,
caret movement and Shift-selection replacement. It verifies complete
capture/target/bubble traces, distinguishes both propagation controls at the
target, and proves that native activation still occurs after JS propagation
stops. While a callback deliberately awaits a private gate, real events queue;
reparenting preserves their captured ancestry, whereas target deletion cancels
delivery and remount does not inherit old callbacks. The final complete native
paint, OS close, revoked signals and zero ownership counters are required.

Use `--entry interactions` for the corresponding AOT executable and
`--scenario interactions` with development or AOT in the existing diagnostics
runner. The [interaction contract](../../docs/native-events.md) contains exact
commands, current evidence and unsupported scope. None of these finite tests
claims DOM event compatibility, native default cancellation or full IME support.

## Shared input viewport pixels

The `solid-input-viewport` and `react-input-viewport` entries share one public
input/lifetime fixture and one independent owned-X11 controller. Build each with
`experiments/aot-gpui/build-window.ts --entry ENTRY`; pass its exact generated
`development/application.js` or inspected AOT executable to
`scripts/quality/native-diagnostics-linux.py --scenario ENTRY --mode
development|aot --host-profile release --output NEW_DIRECTORY -- APPLICATION`
inside the existing isolated session. The runner enables bounded input paint
observations only for these two scenarios.

The complete native tree, input revision, stable node identity and completed
paint geometry must match every step. A long blank prefix followed by `TAIL`
makes missing horizontal translation observable: End must show the tail and
right-edge caret, while Home must show the left-edge caret and no tail pixels
either inside the input or in its visible right gutter. Independent screenshot
predicates check those pixels. Their deterministic RGB controls deliberately
omit translation, clipping, caret or selection; those synthetic controls are
not native execution evidence.

The scale-1 fixture identifies the caret by its actual opaque `gpui::blue()`
fill, RGB `(0,0,255)`. Blue-dominant LCD edges of white glyphs are not caret
pixels. The recorded 5×5 glyph neighborhood in
`tests/quality/fixtures/input-viewport-lcd-edge.json` preserves the original
false positive from run `41907537790`, artifact `13361963848`, together with
the failed head and full screenshot hash. Its regression composes those exact
pixels with synthetic controls; even one genuine misplaced caret pixel still
fails, and missing caret, untranslated text, unclipped glyphs and exterior
selection tint remain failures. Reclassifying retained pixels does not turn
that failed native run into a passed scenario or qualify its unexecuted phases.

Actual OS actions move one character left from the scrolled end, then click
back to the final byte. Both a fresh native GPUI down/up capture and the public
input listener's matching down/up sequence must arrive at that injected logical
pixel; stale events, missing pairs and half-pixel ties fail. Starting away from
the target also prevents a delivered but ignored click from preserving an
already-correct caret. Actions then insert `x`, replace a selected
character with `Y`, resize, change the font through F6, select and clear the
long value, and type `short`. The retained screenshots also check resized and
restyled carets, clipped selection and offset reset. The empty right gutter must
contain neither glyph pixels nor selection tint, including the darker alpha
blend over the exterior background. Final OS close must revoke
the observed callback signals, dispose the framework owner and join application
and native host exit with all seven public ownership counters zero. The driver
retains failed observations as it progresses.

These four development/AOT cases run after the existing native scenarios,
baseline and Solid workspace. The step collects independently after an earlier
failure only when the release host build succeeded and the run is not canceled;
earlier failures remain failures. Existing first-launch order, 30-second scenario
and 5-second exit bounds are unchanged. This is a partial #241 qualification
recipe, pending its own changed-head hosted results. It does not establish IME
composition, bidirectional text, accessibility, physical input, high-DPI behavior
or native macOS/Windows input acceptance.

The [source-bound compilation record](evidence/input-viewport-compile.json)
retains the release host build identity and both inspected AOT application
hashes. The host's native source is byte-identical across the explicitly named
host/application commits. Neither binary was executed during that compilation;
this record does not qualify the native recipe above.

## Streaming-list soak

The `solid-streaming-list` and `react-streaming-list` entries render one
app-level windowed model over a 10,000-message history and replay the
versioned `benchmarks/streaming-list-fixture.ts` stream. Build each with
`experiments/aot-gpui/build-window.ts --entry ENTRY`. Then pass its
`development/application.js` or AOT executable to `tests/native/streaming-list.py
--framework solid|react --mode development|aot --host-profile release --output
NEW_DIRECTORY -- APPLICATION`. Run it inside the isolated session.

The controller uses real XTest navigation, pointer selection, theme/density
keys, a window-manager resize and Alt+F4. The fixture requires an unmoved
detached window, visible-window node/listener bounds and zero owners after
close. `streaming-list.py summarize --output FILE REPORT...` requires one final
digest across runs and writes the compact baseline. See
[streaming lists](../../docs/native-lists.md) for the oracle, the opt-in
`BUN_NATIVE_FRAME_TRACE` record and unsupported scope.

## Portable target-host paint smoke

`tests/native/platform-smoke.ts` and `scripts/quality/native-platform-smoke.py`
exercise the real host through three public-core window/update/close lifecycles.
The controller reuses the existing bounded evidence parser and full-tree
expectations, requiring each native renderer and initial/update paint. Its
`--negative-paint-check` proves an incorrect expected native tree fails while
the fixture joins native shutdown. The shared AOT entry is `platform-smoke`.

The separate `--os-input` mode additionally requires independent owned-process
and visible-window identity, a native button pointer activation, Tab down/up and
focus traversal, all 32 nonce edits in exact input-revision order, and their full
native paint on every cycle. It uses target OS APIs and reuses the existing X11
helpers on Linux. A successful injection API return cannot satisfy delivery.
The macOS helper requires an explicit prebuilt `BUN_NATIVE_PLATFORM_HELPER`;
neither target controller requests permission or changes security settings.
The helper constructs global Quartz pointer events from the measured viewport
and independently observed frame. It requires the exact owned window to be the
first onscreen window at that point, then posts through the public session event
stream for WindowServer routing. Keyboard pairs recheck owned foreground state.
An obscured-target rejection retains only the first intersecting rectangle's
numeric identity, layer, opacity and geometry; unrelated titles and application
names are excluded. The SDK controls check the exact diagnostic fields and
reject malformed identity metadata. A rejection means no input was posted.
A separate SDK control inspects those objects and pure occlusion/identity guards
without posting input; it cannot qualify delivery. The previous PID-targeted
attempts remain failed, including the ready GPUI capture trace with no mouse
event in run 41245774144. The new routing requires its own hosted delivery proof.
Each OS observation is retained as soon as ownership is established, with the
requested logical point and a phase that distinguishes posting from actual
delivery and complete native paint. Failed runs keep that partial evidence.

Paint-only mode still leaves OS input/visibility unverified. Screenshots,
presentation, hardware input, OS close-button behavior and complete process-tree
observation remain outside both modes. See [native platform qualification](../../docs/native-platforms.md)
for exact target results, unsupported sessions and remaining #246/#256 work.
