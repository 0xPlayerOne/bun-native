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
window's actual renderer metadata and complete initial/update native tree paint.
Input value replacement is an explicit application transaction, not OS typing.
Each close must revoke public resources; final shutdown joins the runtime's
native child exit.

| Observation              | Qualification in this first increment                                                                                     |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| Rust compilation         | Separate target tools, release command, build duration, binary bytes and SHA-256.                                         |
| GPUI execution           | Actual host, three native window protocol lifecycles, renderer device metadata and six complete paint traversals.         |
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
  modifiers. Events use `CGEventPostToPid` for the verified native child. The
  click location is bounded within the Quartz frame using the actual GPUI
  viewport; the content origin is inferred, so actual native target delivery is
  required. The helper never requests permissions or changes privacy settings.
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

The first hosted matrix results must be recorded before either new platform is
marked supported. Failures retain their exact compile, startup, renderer or
missing-paint reason; a missing capability never becomes a pass.

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
