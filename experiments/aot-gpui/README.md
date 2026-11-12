# Bun AOT and native interoperability probe

This is an executable compiler/native-boundary experiment for [#225](https://github.com/0xPlayerOne/bun-native/issues/225). It does **not** render a window, simulate GPUI, or satisfy native UI acceptance in #230/#227.

## Reproduce

Install the checksum-pinned Bun build and exact Rust toolchain described in [the toolchain documentation](../../docs/toolchain.md). Install a C compiler: `cc` on Linux/macOS, or Clang on Windows. `CC` can select an explicit compiler executable. Linux binary inspection needs `readelf` and `ldd`; macOS uses `otool`.

```sh
bun install --frozen-lockfile
bun experiments/aot-gpui/run.ts /absolute/path/to/empty-evidence-directory
```

The runner requires the exact `Bun.revision` from `toolchain.json`, so a stable release or another canary cannot accidentally stand in for the pinned compiler. It records every command, exit code, duration, stdout/stderr, source hashes, compiler and OS versions, native library/executable hashes and executable sizes in the output directory. Outputs stay outside the source tree. Durations are diagnostic samples, not a native application performance baseline.

## Actual checks

1. Compile the C fixture into an OS shared library and a native echo executable. Both use warnings as errors. The echo process is an IPC fixture only.
2. In Bun development mode, load the library with `bun:ffi`, call native arithmetic, call back synchronously into JavaScript, close the callback and library, and round-trip a Unicode JSON line through `Bun.spawn` stdin/stdout. The native subprocess must exit successfully after stdin closes.
3. Create a successful same-named `compile` package script and prove a control invocation executes it. Compile the **same TypeScript source** from that directory with `bun compile --no-script --production --explain=json`, require the package-script marker to remain absent, then run the emitted executable against the same native artifacts.
4. Compile a deliberately JIT-based control with `bun compile --no-aot`. A runtime mutation of a protected built-in is accepted in development/JIT and rejected with `TypeError` in AOT, as specified by the pinned compiler. This provides an execution witness alongside the explicit AOT build and binary inspection.
5. Require errors for a missing shared library and a TypeScript type mismatch. A rejected typecheck must emit no executable.
6. Inspect the standalone module graph using the pinned compiler's actual [`HAS_COMPILED_PROGRAM` flag](https://github.com/oven-sh/bun/blob/da867c60bf0bcbf9d6d36994f8ca0efa42075115/src/standalone_graph/StandaloneModuleGraph.rs). Require the flag in AOT and its absence in the JIT control. Reject malformed lengths, offsets, module records, entry points and unknown flags. This identifies a compiled program; it is not a general executable security validator.
7. On Linux, retain ELF sections and dynamic linkage. On macOS, retain Mach-O load commands/linkage. The `.bun_aot` section also exists in the JIT compiler runtime, so **that section alone does not prove AOT**. Windows footer inspection is implemented but remains unexecuted; native linkage inspection there is not yet implemented.
8. Decode the named `.bun_features` ELF, `__TEXT,__bun_features` Mach-O, or `.bunfeat` PE section and its relative virtual removed-range records. Require the JIT compiler to be removed in AOT and present in the actual `--no-aot` control. Preserve the interpreter's separate state. [Artifact inspection](../../docs/aot-inspection.md) documents the pinned source contract, format bounds, raw records and scope. The hosted matrix compiles and executes the controls on each target; synthetic parser fixtures alone do not qualify a target.

`Bun.spawn` uses a real native process. FFI uses a real shared library and real native function calls. These are **headless interoperability tests**, not GUI or OS input evidence. The synchronous callback test does not establish callbacks from arbitrary threads, asynchronous callback lifetime, Node-API support, crash isolation, GPUI main-thread correctness, or a safe public ABI. The production host initially uses the bounded subprocess transport implemented under #230/#228; FFI remains a measured alternative rather than a parallel public implementation.

## Initial evidence

See [the Linux record](evidence/linux-x64.json) for the checked source and exact outcomes. All successful checks used Bun `1.4.4-canary.1+da867c60b` / source `da867c60bf0bcbf9d6d36994f8ca0efa42075115`, Rust `1.98.1`, and Linux x64. A first restricted-sandbox attempt failed on a native pipe write with `EPERM`; the identical source passed in the authorized unrestricted execution environment. This was an environment restriction, not a compiler failure hidden by a mock.

The other archive targets are checksum-pinned, but their presence in the manifest does not assert successful AOT, GPUI or input testing. Cross-platform CI and actual-window evidence are tracked separately.

## Build the actual native window fixture

Once the native host and `examples/native-window/main.ts` are present, the release recipe compiles that same application, checks its compiled-program metadata, and copies an explicitly supplied prebuilt native host:

```sh
bun experiments/aot-gpui/build-window.ts \
  --host /absolute/path/to/bun-native-host \
  --host-profile release \
  --outdir /absolute/path/to/empty-package-directory
BUN_NATIVE_HOST=/absolute/path/to/empty-package-directory/bun-native-host \
  /absolute/path/to/empty-package-directory/native-window
```

Use `--host-profile dev` when qualifying a development host; omitting it records the profile as unverified. The helper does not invoke Cargo or claim that a supplied native binary was built from its current source. Match the recorded host SHA-256 to the native build and interaction evidence. `--source` selects another checked-out repository for coordinated development; ordinary use defaults to this repository. Windows output names end in `.exe`, and `BUN_NATIVE_HOST` must contain an absolute Windows path.

The package directory receives the AOT application, native host, compiler diagnostics, native linkage logs and a manifest with exact toolchain, source/lockfile hashes, dirty-worktree status, artifact hashes and sizes. Native rendering, OS input, teardown, installation and signing start as **not verified** in this build record; actual execution evidence is separate. The build itself cannot turn those checks into passes.

The React workload entry and the paired core/Solid workload runner share an
explicit source snapshot for `workload.ts`, its imported `ownership.ts` oracle,
and the snapshot helper itself. Missing shared inputs fail before compilation;
changed bytes are caught by the existing source comparisons. The
[preserved inventory gap](../../tests/native/evidence/react-workload-source-inventory-gap.json)
records the older React manifest's omitted oracle. Its failed retention result
is unchanged; recording the missing source does not establish a retention cause
or a new native result.

The same compiler and inspection pipeline supports these explicit entries:

| `--entry`                  | Source                                      | Executable                 | Native host placement                              |
| -------------------------- | ------------------------------------------- | -------------------------- | -------------------------------------------------- |
| `native-window` (default)  | `examples/native-window/main.ts`            | `native-window`            | Copied into the package                            |
| `input-race`               | `tests/native/input-race.ts`                | `input-race`               | Existing prebuilt host referenced by absolute path |
| `bridge`                   | `benchmarks/bridge.ts`                      | `bridge`                   | Existing prebuilt host referenced by absolute path |
| `javascript`               | `tests/native/javascript.js`                | `javascript`               | Existing prebuilt host referenced by absolute path |
| `core-lifecycle`           | `tests/native/public-lifecycle.ts`          | `core-lifecycle`           | Existing prebuilt host referenced by absolute path |
| `event-throughput`         | `tests/native/event-throughput.ts`          | `event-throughput`         | Existing prebuilt host referenced by absolute path |
| `fault`                    | `tests/native/fault.ts`                     | `fault`                    | Existing prebuilt host referenced by absolute path |
| `scheduling`               | `tests/native/scheduling.ts`                | `scheduling`               | Existing prebuilt host referenced by absolute path |
| `layout`                   | `tests/native/layout.ts`                    | `layout`                   | Existing prebuilt host referenced by absolute path |
| `layout-style`             | `tests/native/layout-style.ts`              | `layout-style`             | Existing prebuilt host referenced by absolute path |
| `interactions`             | `tests/native/interactions.ts`              | `interactions`             | Existing prebuilt host referenced by absolute path |
| `services`                 | `tests/native/services.ts`                  | `services`                 | Existing prebuilt host referenced by absolute path |
| `display-semantics`        | `tests/native/display-semantics.ts`         | `display-semantics`        | Existing prebuilt host referenced by absolute path |
| `display-platform`         | `tests/native/display-platform.ts`          | `display-platform`         | Existing prebuilt host referenced by absolute path |
| `display-wayland`          | `tests/native/display-wayland.ts`           | `display-wayland`          | Existing prebuilt host referenced by absolute path |
| `display-virtual-macos`    | `tests/native/display-virtual-macos.ts`     | `display-virtual-macos`    | Existing prebuilt host referenced by absolute path |
| `clipboard`                | `tests/native/clipboard.ts`                 | `clipboard`                | Existing prebuilt host referenced by absolute path |
| `global-shortcuts`         | `tests/native/global-shortcuts.ts`          | `global-shortcuts`         | Existing prebuilt host referenced by absolute path |
| `notifications`            | `tests/native/notifications.ts`             | `notifications`            | Existing prebuilt host referenced by absolute path |
| `filesystem-grants`        | `tests/native/filesystem-grants.ts`         | `filesystem-grants`        | Existing prebuilt host referenced by absolute path |
| `app-menu`                 | `tests/native/app-menu.ts`                  | `app-menu`                 | Existing prebuilt host referenced by absolute path |
| `processes`                | `tests/native/processes.ts`                 | `processes`                | Existing prebuilt host referenced by absolute path |
| `file-dialogs`             | `tests/native/file-dialogs.ts`              | `file-dialogs`             | Existing prebuilt host referenced by absolute path |
| `overlays`                 | `tests/native/overlays.ts`                  | `overlays`                 | Existing prebuilt host referenced by absolute path |
| `message-dialogs`          | `tests/native/message-dialogs.ts`           | `message-dialogs`          | Existing prebuilt host referenced by absolute path |
| `popups`                   | `tests/native/popups.ts`                    | `popups`                   | Existing prebuilt host referenced by absolute path |
| `wayland`                  | `tests/native/wayland.ts`                   | `wayland`                  | Existing prebuilt host referenced by absolute path |
| `drag-drop`                | `tests/native/drag-drop.ts`                 | `drag-drop`                | Existing prebuilt host referenced by absolute path |
| `solid-drag-drop`          | `tests/native/solid-drag-drop.tsx`          | `solid-drag-drop`          | Existing prebuilt host referenced by absolute path |
| `react-drag-drop`          | `tests/native/react-drag-drop.tsx`          | `react-drag-drop`          | Existing prebuilt host referenced by absolute path |
| `text-input`               | `tests/native/text-input.ts`                | `text-input`               | Existing prebuilt host referenced by absolute path |
| `ime`                      | `tests/native/ime.ts`                       | `ime`                      | Existing prebuilt host referenced by absolute path |
| `accessibility`            | `tests/native/accessibility.ts`             | `accessibility`            | Existing prebuilt host referenced by absolute path |
| `accessibility-platform`   | `tests/native/accessibility-platform.ts`    | `accessibility-platform`   | Existing prebuilt host referenced by absolute path |
| `input-states-platform`    | `tests/native/input-states-platform.ts`     | `input-states-platform`    | Existing prebuilt host referenced by absolute path |
| `screen-reader`            | `tests/native/screen-reader.ts`             | `screen-reader`            | Existing prebuilt host referenced by absolute path |
| `ime-platform`             | `tests/native/ime-platform.ts`              | `ime-platform`             | Existing prebuilt host referenced by absolute path |
| `solid-services`           | `tests/native/solid-services.tsx`           | `solid-services`           | Existing prebuilt host referenced by absolute path |
| `react-services`           | `tests/native/react-services.tsx`           | `react-services`           | Existing prebuilt host referenced by absolute path |
| `platform-smoke`           | `tests/native/platform-smoke.ts`            | `platform-smoke`           | Existing prebuilt host referenced by absolute path |
| `solid-platform`           | `tests/native/solid-platform.tsx`           | `solid-platform`           | Existing prebuilt host referenced by absolute path |
| `react-platform`           | `tests/native/react-platform.tsx`           | `react-platform`           | Existing prebuilt host referenced by absolute path |
| `solid`                    | `examples/solid-counter/main.tsx`           | `solid`                    | Existing prebuilt host referenced by absolute path |
| `solid-workspace`          | `examples/solid-workspace/main.tsx`         | `solid-workspace`          | Existing prebuilt host referenced by absolute path |
| `adea-components`          | `examples/adea-components/main.tsx`         | `adea-components`          | Existing prebuilt host referenced by absolute path |
| `solid-workspace-flow`     | `tests/native/solid-workspace.tsx`          | `solid-workspace-flow`     | Existing prebuilt host referenced by absolute path |
| `solid-workspace-soak`     | `tests/native/solid-workspace-soak.tsx`     | `solid-workspace-soak`     | Existing prebuilt host referenced by absolute path |
| `solid-workspace-terminal` | `tests/native/solid-workspace-terminal.tsx` | `solid-workspace-terminal` | Existing prebuilt host referenced by absolute path |
| `solid-input-intent`       | `tests/native/solid-input-intent.tsx`       | `solid-input-intent`       | Existing prebuilt host referenced by absolute path |
| `solid-interactions`       | `tests/native/solid-interactions.tsx`       | `solid-interactions`       | Existing prebuilt host referenced by absolute path |
| `solid-input-viewport`     | `tests/native/solid-input-viewport.tsx`     | `solid-input-viewport`     | Existing prebuilt host referenced by absolute path |
| `solid-streaming-list`     | `tests/native/solid-streaming-list.tsx`     | `solid-streaming-list`     | Existing prebuilt host referenced by absolute path |
| `solid-layout-style`       | `tests/native/solid-layout-style.tsx`       | `solid-layout-style`       | Existing prebuilt host referenced by absolute path |
| `react`                    | `examples/react-counter/main.tsx`           | `react`                    | Existing prebuilt host referenced by absolute path |
| `react-workspace`          | `examples/react-workspace/main.tsx`         | `react-workspace`          | Existing prebuilt host referenced by absolute path |
| `react-workspace-flow`     | `tests/native/react-workspace.tsx`          | `react-workspace-flow`     | Existing prebuilt host referenced by absolute path |
| `react-workspace-soak`     | `tests/native/react-workspace-soak.tsx`     | `react-workspace-soak`     | Existing prebuilt host referenced by absolute path |
| `react-workspace-terminal` | `tests/native/react-workspace-terminal.tsx` | `react-workspace-terminal` | Existing prebuilt host referenced by absolute path |
| `react-interactions`       | `tests/native/react-interactions.tsx`       | `react-interactions`       | Existing prebuilt host referenced by absolute path |
| `react-input-viewport`     | `tests/native/react-input-viewport.tsx`     | `react-input-viewport`     | Existing prebuilt host referenced by absolute path |
| `react-streaming-list`     | `tests/native/react-streaming-list.tsx`     | `react-streaming-list`     | Existing prebuilt host referenced by absolute path |
| `react-layout-style`       | `tests/native/react-layout-style.tsx`       | `react-layout-style`       | Existing prebuilt host referenced by absolute path |
| `react-behavior`           | `tests/native/react-behavior.tsx`           | `react-behavior`           | Existing prebuilt host referenced by absolute path |
| `react-workload`           | `benchmarks/solid/react.tsx`                | `react-workload`           | Existing prebuilt host referenced by absolute path |

All executable names gain `.exe` on Windows. The test entries avoid making another large host copy; their manifests record `host.placement: "external"` and the exact existing host path and hash. They are test artifacts, not standalone installation packages. Pass `--host-profile dev` or `release` for qualification. Only `native-window`, `input-race` and `javascript` accept an omitted profile, which is recorded as unverified; every other entry rejects the build without one. The [bridge benchmark runner](../../benchmarks/BRIDGE.md) verifies the actual running executable, host and source hashes against the supplied AOT manifest before collecting samples. The [native fixture guide](../../tests/native/README.md) describes each interaction/lifecycle scenario and its separate execution evidence.

```sh
bun experiments/aot-gpui/build-window.ts \
  --entry input-race \
  --host /absolute/path/to/bun-native-host \
  --host-profile release \
  --outdir /absolute/path/to/empty-input-race-directory

bun experiments/aot-gpui/build-window.ts \
  --entry bridge \
  --host /absolute/path/to/bun-native-host \
  --host-profile release \
  --outdir /absolute/path/to/empty-bridge-directory
```

The input-race fixture needs an actual native input session and a fresh evidence nonce; compiling it does not execute that regression. Each manifest identifies its selected entry and hashes the core, protocol and runtime sources, shared window content, native sources, package manifests and root build configuration. The helper checks those hashes before and after compilation and fails if the source changes during the build. Different entries cannot be substituted in a matched native-window baseline.

The React entry also hashes the React adapter and shared renderer source and package manifests. Its separate [native controller](../../tests/native/react-window.py) runs the keyed counter and input scenarios against the inspected executable; neither a successful compile nor the controller's declared execution mode is evidence by itself for the other half of qualification.

`--entry react-interactions` additionally hashes the common renderer-interaction
fixture oracle. Its inspected executable runs through
`tests/native/renderer-interactions.py --renderer React` with keyboard, caret and
selection scenarios. The native fixture separately verifies shared event phases,
input revisions and framework cleanup; artifact inspection does not supply that
input evidence.

`--entry react-behavior` fingerprints the same React/shared-renderer source and
the eight-case hook/error/lifetime fixture. Its independent
`tests/native/react-behavior.py` controller verifies actual native mount, update,
unmount, boundary recovery, terminal cleanup failures and non-suspending
transitions. Run all eight scenarios in both modes; an inspected executable alone
does not qualify their behavior. See the [React behavior matrix](../../docs/react-behavior.md).

The helper requires the emitted application to record JIT compiler removal and includes its full runtime-feature record in the manifest. ELF64, thin Mach-O64 and PE32+ have bounded decoders; unsupported or malformed metadata fails the build. An interpreter may remain present; this check does not claim otherwise. Actual target compilation/execution and GPUI input evidence remain separate from metadata parsing.

`--trim` is an explicit comparison option for measuring Bun's additional unused-runtime removal. Default AOT already removes the JIT; the separate `trimmedProgramFeatures` metadata flag can remain false for a correctly inspected AOT executable. Run the same native input and teardown suite against the trimmed executable before choosing it for distribution. Build duration and artifact bytes in the manifest are single-build diagnostics, not cold-start, RSS or input-latency claims. A development-profile native host is not a release performance baseline.

The initial shared-layout fixture is selected with `--entry layout`. It emits `layout` (`layout.exe` on Windows), references the explicitly supplied host without copying it, and includes the fixture plus shared core/protocol/runtime/native sources in its artifact manifest. Execute it through the actual `layout` diagnostic described in [the layout contract](../../docs/native-layout.md). Compilation and inspection alone do not establish wheel, clipping, resize or focus behavior.

`--entry interactions` uses the same compiler and external-host policy for the
public event fixture. The actual `interactions` diagnostic verifies pointer,
logical keys, focus, native caret/selection editing, public propagation and
queued-event lifetime across reparent/delete/remount. Follow the
[interaction contract](../../docs/native-events.md) for the exact development
and AOT commands. Inspecting the executable alone does not qualify those native
behaviors or any remaining adapter/platform acceptance.

`--entry platform-smoke` runs the portable three-window lifecycle and paint fixture.
The [native platform qualification](../../docs/native-platforms.md) records its
separate build, native paint, AOT and opt-in `--os-input` controller scope. The
same compiled fixture serves both modes; target OS input is qualified only by
the separate owned-window/event/paint run.

`--entry clipboard` fingerprints the core/native service fixture and independent
`native/gpui-host/examples/clipboard-peer.rs` source, requires an explicit host
profile, and references the existing host without copying it. Build the peer
once alongside the host, then run the same isolated-X11 clipboard diagnostic
against development Bun and the inspected executable. Its 26 outcomes include
independent readers, INCR, stalled-owner input/paint, malformed/flood responses,
cancellation and worker teardown. Compilation alone does not qualify any of
those behaviors; follow the [native fixture recipe](../../tests/native/README.md#isolated-clipboard-diagnostic).

## Solid development and AOT inputs

The Solid entries (`solid`, `solid-workspace`, `solid-workspace-flow`,
`solid-workspace-soak`, `solid-workspace-terminal`, `solid-input-intent`, `solid-interactions`, `solid-input-viewport`,
`solid-platform` and `solid-services`) first run the repository's pinned universal JSX transform,
then compile that exact generated `development/application.js` with the same Bun
machine-code AOT path and strict executable inspection. The generated module is
also the development entry; the helper records its size, hash, transform command
and transform duration under `application.developmentModule`. It checks that
module and all original Solid/shared-renderer/build sources stayed unchanged.
The module and source map are retained with hosted evidence. No Cargo process is
started, and `buildMs` remains AOT compiler duration, separate from transform time.

The transform selects the `browser` export condition for Solid reactivity and
explicitly defines `process.env.NODE_ENV` as `"production"`. Both execution modes
therefore use production `solid.js` and `universal.js`, independently of the
environment running the builder. The real bundler controls in
`tests/solid/build.test.ts` show that a `production` condition alone still selects
development exports on this pin under `NODE_ENV=test`. The Babel JSX preset's
`dev: false` controls transformation and does not choose dependency distributions.

The [production-module qualification](../../benchmarks/bn2/solid-production-recipe-linux.json)
records all twelve native scenarios against the exact generated modules and their
inspected AOT executables. Earlier source maps in the retained hosted-recipe local
record selected Solid's development distributions; that historical correctness
evidence keeps its original hashes and is not relabelled. These new runs still use
the immutable development-profile software-GPU host, not a release-host baseline.

```sh
bun experiments/aot-gpui/build-window.ts \
  --entry solid-interactions \
  --host /absolute/path/to/bun-native-host --host-profile release \
  --outdir /absolute/path/to/empty-solid-package
```

Run `bun /absolute/path/to/empty-solid-package/development/application.js` for
development and `/absolute/path/to/empty-solid-package/solid-interactions` for AOT,
with the same absolute `BUN_NATIVE_HOST`. These fixtures need the independent
native input controller described in `tests/native/solid-window.py`; merely
launching or compiling them does not satisfy their input, paint or cleanup gates.

## React development and AOT inputs

The React entries (`react`, `react-workspace`, `react-workspace-flow`, `react-workspace-soak`, `react-workspace-terminal`,
`react-interactions`, `react-input-viewport`, `react-behavior`,
`react-services`, `react-platform` and `react-workload`) use the pinned Bun bundler to transform their explicit
React JSX source into `development/application.js`. The helper invokes the built-in
`build --no-script --production --target=bun --format=esm --sourcemap=external`,
explicitly defines `process.env.NODE_ENV` as `"production"`, and uses an output
directory with a fixed `application.js` entry name. This selects production React,
reconciler and scheduler code regardless of the caller's environment. Both modes
use that framework configuration: development means running the generated module
through Bun, and AOT means running its machine-code executable. The helper supplies
the exact module to `bun compile --no-script --production --explain=json`. No DOM transform,
second native renderer or additional bundler dependency is introduced.

Each manifest records the generated module's bytes, SHA-256, exact transform
command and transform duration under `application.developmentModule`, separately
from AOT compilation. Original source/configuration and generated-module hashes
must remain unchanged across compilation. Source maps and generated modules are
retained with hosted evidence. `tests/toolchain/commands.test.ts` proves that the
bundler executes despite a same-named package script, selects the production
branch of a real dependency, emits an executable module and rejects malformed
source. A plain development bundle has already removed production dependency
branches; a later AOT compile cannot restore them.

For any React entry, run `bun PACKAGE/development/application.js` in development
and `PACKAGE/ENTRY` in AOT mode with the same prebuilt host and controller. The
required native lane applies this recipe to the counter, shared event scenarios,
eight behavior cases and unchanged 1,000-cycle workload. Compiling the workload
does not prove its cleanup or performance assertions; those remain independent
execution gates, including the existing fixed WeakRef observations.

The [local recipe record](../../tests/native/evidence/react-hosted-recipe-linux.json)
binds all four inspected applications and 26 passing counter/event/behavior runs
to the combined source. The unchanged workload was compiled but not rerun in
that local increment. The host is explicitly development profile; this record
does not substitute for required hosted release execution or settle the shared
retention investigation.
