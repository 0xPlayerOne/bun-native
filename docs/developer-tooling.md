# Checkout application CLI

`scripts/native.ts` implements the first usable slice of [BN5 #242](https://github.com/0xPlayerOne/bun-native/issues/242). It creates and runs **projects inside an existing Bun Native checkout**. Install the exact Bun pin and run `bun install --frozen-lockfile` at the repository root once. Generated applications use those installed workspace dependencies; they are not independent published packages.

## Create a project

```sh
bun run native create apps/my-app
bun run native create apps/react-app --framework react
bun run native create apps/javascript-app --framework solid --language javascript
```

The default is Solid with TypeScript. `--framework` accepts `solid` or `react`; `--language` accepts `typescript` or `javascript`. The templates use only the public core and selected renderer, include a native counter, and dispose the renderer and owned application explicitly. JavaScript uses JSX with JSDoc and the same strict checker as TypeScript.

The destination must be new and inside the checkout. Existing directories are rejected, including empty ones. A parent symlink cannot redirect generation outside the checkout. `bun-native.json` identifies the renderer and relative entry file; unsupported keys, renderer names and entries outside the project are rejected. Paths containing spaces are supported.

The generated package scripts are:

```sh
cd apps/my-app
bun run check
bun run dev --host /absolute/path/to/bun-native-host
bun run build --host /absolute/path/to/bun-native-host --host-profile release
```

Do not run a separate dependency install inside the generated project. Keep it in the checkout so its relative script, TypeScript configuration and public workspace imports continue to resolve.

## Develop against a prebuilt host

```sh
bun run native dev apps/my-app --host /absolute/path/to/bun-native-host
```

`--host` is mandatory and must identify a readable executable for the running OS and CPU. The CLI checks its executable format and architecture before bundling; the existing native runtime performs the actual protocol handshake when the application launches. A matching binary header alone does not prove that a supplied executable is a Bun Native host. Host ABI/startup failures remain errors from the shared runtime.

The command bundles Solid through the existing official universal transform, or React through Bun's JSX bundler. Both use production framework module selection, matching the AOT build path. It starts the resulting module under Bun and removes its temporary bundle when execution finishes, including a failed build or startup. Generated apps handle window close and SIGINT/SIGTERM by disposing the framework root before shutting down the application. A failed root disposal still enters application shutdown.

Without `--watch`, this command starts once. Stop and rerun after edits; state is recreated.

## Watch source with a full remount

```sh
bun run native dev apps/my-app --host /absolute/path/to/bun-native-host --watch
```

The optional watcher observes TS/JS/TSX/JSX and JSON files recursively inside the project, including imported local components and `bun-native.json`. It ignores dependency, Git, build, distribution and temporary directories. Saves are debounced for 50 ms, with at most one build running and one pending rebuild. Imports outside the project and changes to the host executable, native ABI, toolchain or installed dependencies require stopping and restarting the command.

Each successful edit performs a **full app and host remount**. Component state, native handles and window state reset. The CLI builds the candidate module while the current app stays live; syntax/configuration errors leave that app running and display the error. After a successful build, it requests shutdown through Bun IPC, requires a zero-resource acknowledgement, joins the app process exit and IPC disconnection, and only then starts a fresh app process against the same supplied host. Ordinary source changes never run Cargo.

Keep the generated template's optional IPC handlers. They report readiness after `view.ready`, and report zero public application/renderer resources after disposal and host shutdown. They do not require a CLI import in application code, and are inactive without a parent IPC channel. The template closes that channel after cleanup. Window close, SIGINT or SIGTERM ends a watched session. A startup/runtime failure or missing/unclean shutdown acknowledgement fails the session; an app that ignores shutdown is terminated after the bounded wait, and no replacement starts.

The CLI prints one `bun-native:ready` JSON record per successful generation, with its process ID, temporary bundle path, build/shutdown/mount durations and elapsed edit-to-ready time. The endpoint is the renderer's bridge acknowledgement. It is not a measurement of GPU paint or usable OS input. Shutdown and readiness waits are bounded to five seconds each; compilation time is not included in those bounds. No state-preservation or physical native performance claim is made by these reports.

Watch bundles live in a fresh, session-owned OS temporary directory. At rest there is one live generation; a candidate can coexist with it during compilation. Failed candidates and joined old generations are removed, and closing the session removes its owned temporary directory. The source directory is only watched and read by this reload machinery.

[#243](https://github.com/0xPlayerOne/bun-native/issues/243) remains open for native edit-to-usable qualification, native repeated-cycle resource/performance evidence and any finer-grained reload strategy.

No app command invokes Cargo, downloads a host, installs dependencies or changes toolchain pins. With the pinned Bun, installed dependency tree and supplied host already present, these commands operate offline. Building a native host from source remains a separate framework-contributor task documented in [getting started](getting-started.md).

## Produce an AOT application

```sh
bun run native build apps/my-app \
  --host /absolute/path/to/bun-native-host \
  --host-profile release \
  --outdir /absolute/path/to/empty-output
```

`--outdir` defaults to the project's `dist` directory. It must be empty; the CLI does not erase a previous package. `--host-profile dev|release` is required as caller-declared provenance. It does not prove the binary's optimization level. Match the recorded host hash with the native build and acceptance evidence you used to obtain the binary.

The build reuses the fixture packager's pinned `bun compile` implementation and executable inspectors. A successful build proves that the generated executable has a compiled-program record and records removal of the JIT compiler. It produces:

- `application` (`application.exe` on Windows), the actual AOT executable.
- `bun-native-host` (`bun-native-host.exe` on Windows), copied from the explicit input.
- `manifest.json`, with OS/CPU, exact toolchain, application/module/host SHA-256 and byte sizes, compiler command, compilation duration, executable inspections and validation status.
- The bundled development module and source map, generated launcher, and compiler logs for reproduction and diagnosis.

The application resolves its host next to its own executable, so the output directory can be moved and launched from another working directory. `BUN_NATIVE_HOST` is an explicit runtime override. Keep the application and bundled host together. Changed host or bundled-module bytes during packaging cause a failure. On failure, inspect the retained logs and use a new empty output directory for a retry.

Only the current OS and CPU are supported by this command; no `--target` or cross-compilation flag is accepted. Packaging checks do not launch a GUI. The manifest explicitly records native rendering, OS input and teardown as `not-run`, installation as `not-tested` and signing as `unsigned`. A native desktop and the required platform libraries are still needed to run the app. This is not a signed installer or proof of platform qualification.

## Verification and remaining work

`bun test tests/tooling/cli.test.ts` exercises all four generated templates through the actual checker and bundler, source edits/restarts, malformed source/configuration, host/destination errors, source containment, a real small AOT compilation, artifact hashes, output non-overwrite and relocated launch. The AOT packaging test deliberately uses a headless program and Bun itself as the supplied executable: it proves compiler/packager behavior and never claims native-host acceptance.

Generated-template lifecycle tests also compile the existing headless protocol peer into the supplied executable. All four templates mount through the real IPC runtime, then close the window or invoke their registered SIGINT/SIGTERM path. The tests assert zero remaining application windows/nodes/callbacks/queued work, zero renderer nodes, restored signal-listener counts and removed temporary bundles. Signal events are emitted inside the process; these checks establish handler/ownership behavior, not OS signal delivery or GPUI rendering.

`bun test tests/tooling/reload.test.ts` performs 101 replacements for each of Solid and React against the real headless protocol peer. It checks acknowledgement of zero owned resources, app-process exit, paired peer start/exit records with no overlap, updated source execution and a bounded temporary-bundle count. It also tests preserved apps after malformed edits, serialized reloads, refusal to reload after close, bounded termination of an uncooperative app, recursive imported-component watching, rapid saves and watcher shutdown on app-window close. Timing output is explicitly labelled headless acknowledgement evidence.

This increment leaves #242 open for independently installable packages, supported prebuilt-host acquisition/cache policy and complete generated-app native/AOT evidence across supported platforms. #243 retains the native acceptance gaps described above. Signing, installers and updater qualification remain BN6 work. No existing native CI or adapter retention requirement is reduced by this tooling slice.
