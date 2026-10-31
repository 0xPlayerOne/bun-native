# Native platform build and paint qualification

This is an incremental implementation of [CI #256](https://github.com/0xPlayerOne/bun-native/issues/256)
and [target artifacts #246](https://github.com/0xPlayerOne/bun-native/issues/246).
Both issues remain open. Linux's existing owned-window/input suite stays required;
this lane adds genuine target-host compilation and a portable native lifecycle
fixture for macOS and Windows. It does not infer GUI interaction from compilation.

## First increment and its claims

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

The [hosted matrix](https://github.com/0xPlayerOne/bun-native/actions/runs/41238694201)
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
