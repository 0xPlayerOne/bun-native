# Bun Native application CLI

`scripts/native.ts` implements the checkout workflow accepted in [BN5 #242](https://github.com/0xPlayerOne/bun-native/issues/242). By default it creates and runs **projects inside an existing Bun Native checkout**. Install the exact Bun pin and run `bun install --frozen-lockfile` at the repository root once. Those generated applications use the installed workspace dependencies. The explicit `--packages` mode uses a [standalone local package set](standalone-projects.md), developed and separately qualified under [#382](https://github.com/0xPlayerOne/bun-native/issues/382); neither mode implies registry publication.

For the end-to-end setup sequence and verified offline-cache onboarding record, start with [Create your first Bun Native app](getting-started.md). This page is the command and lifecycle reference.

## Create a project

```sh
bun run native create apps/my-app
bun run native create apps/react-app --framework react
bun run native create apps/javascript-app --framework solid --language javascript
```

The default is Solid with TypeScript. `--framework` accepts `solid` or `react`; `--language` accepts `typescript` or `javascript`. The templates use only the public core and selected renderer, include a native counter, and dispose the renderer and owned application explicitly. JavaScript uses JSX with JSDoc and the same strict checker as TypeScript.

Without `--packages`, the destination must be new and inside the checkout. Existing directories are rejected, including empty ones. A parent symlink cannot redirect checkout generation outside the checkout. `bun-native.json` identifies the renderer and relative entry file; unsupported keys, renderer names and entries outside the project are rejected. A standalone project also identifies its contained package-set manifest. Paths containing spaces are supported.

The generated package scripts are:

```sh
cd apps/my-app
bun run check
bun run format
bun run format:check
bun run dev --host /absolute/path/to/bun-native-host
bun run build --host /absolute/path/to/bun-native-host --host-profile release
```

For this default checkout mode, do not run a separate dependency install inside the generated project. Keep it in the checkout so its relative script, TypeScript configuration and public workspace imports continue to resolve. The [standalone mode](standalone-projects.md) instead writes its own dependency declarations, strict configuration, local archives and installed-CLI scripts.

## Check, format and diagnose a project

```sh
bun run native check apps/my-app
bun run native format apps/my-app [--check]
bun run native lint apps/my-app
bun run native doctor [apps/my-app] [--host /absolute/path/to/bun-native-host]
```

`check` validates `bun-native.json` (and, for a standalone project, its installed package set), then runs three steps in the project directory and reports each as `passed` or `failed`: Bun's built-in type checker (`bun --no-install check --no-script --no-pretty`), the built-in formatter in check mode (`bun --no-install fmt --no-script --no-color --check .`) and the CLI's pinned oxlint (`lint`, also available alone as `native lint`; see [Linting generated projects](consumer-linting.md)). Each step's output is printed before its status line. All steps always run, and any failure exits with status 1; a failed format step also prints a hint to apply formatting. `--no-script` keeps a same-named package script from replacing the built-in. `format` applies the same formatter; `--check` only reports differences. Each command takes exactly one project directory, and unknown options are rejected. The generated `format` and `format:check` scripts call these commands; the generated `check` script remains the type checker alone.

The formatter uses whatever config Bun discovers for the entry file; when none is found it adds `--config` with the template style packaged with the CLI. Checkout projects inherit the repository `.oxfmtrc.json` and `.gitignore`, so a project placed inside an ignored directory such as `dist/`, `build/` or `.bun-native/` has no formatter targets and fails the format step with Bun's ignore-rule error. Standalone projects without their own config therefore use the template style; every standalone project also passes `--ignore-pattern vendor/**`, so the digest-verified package set is never formatted. Linting uses the CLI's own pinned `oxlint`, never one from `PATH`, and never lints `vendor/`, `dist/`, `.bun-native/` or `node_modules/`.

`doctor` reports `ok`, `failed` or `skipped` for the running Bun revision against `toolchain.json`, a pinned Bun distribution for the current OS/CPU, an optional `--host` check (absolute path to a readable file whose executable header matches the current OS and CPU) and an optional project directory, which it reads exactly as `check` and `dev` do, including verification of a standalone project's installed package set. Each line is printed as the padded status, the check name and a detail. It accepts at most one project directory and never launches the host, so a passing host line is not a protocol handshake; the runtime still decides that on launch. Any failed line exits with status 1.

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

The optional watcher observes TS/JS/TSX/JSX and JSON files recursively inside the project, including imported local components and `bun-native.json`. It ignores dependency, Git, build, distribution and temporary directories. Notifications are debounced for 50 ms, with at most one build running and one pending rescan. Each scan compares one digest of relevant file paths and contents with the latest attempted build; unchanged inputs and ignored edits do not remount the app, including when the platform omits a notification's filename. Directory rename/delete notifications also request a rescan. Edits arriving during scanning or compilation remain pending. File symlinks contribute their resolved target and bytes; directory symlinks are not traversed. Imports outside the project, imports reached only through directory symlinks, and changes to the host executable, native ABI, toolchain or installed dependencies require stopping and restarting the command.

Each successful edit performs a **full app and host remount**. Component state, native handles and window state reset. The CLI builds the candidate module while the current app stays live; syntax/configuration errors leave that app running and display the error. After a successful build, it requests shutdown through Bun IPC, requires a zero-resource acknowledgement, joins the app process exit and IPC disconnection, and only then starts a fresh app process against the same supplied host. Ordinary source changes never run Cargo.

Keep the generated template's optional IPC handlers. They report readiness after `view.ready`, and report zero public application/renderer resources after disposal and host shutdown. They do not require a CLI import in application code, and are inactive without a parent IPC channel. The template closes that channel after cleanup. Window close, SIGINT or SIGTERM ends a watched session. A startup/runtime failure or missing/unclean shutdown acknowledgement fails the session; an app that ignores shutdown is terminated after the bounded wait, and no replacement starts.

The CLI prints one `bun-native:ready` JSON record per successful generation, with its process ID, temporary bundle path, build/shutdown/mount durations and elapsed edit-to-ready time. After a replacement, `previous` contains the joined app's process ID and validated zero application/renderer resource counters. One final `bun-native:stopped` record contains those validated counters for the final app; it is printed only after joining app exit and IPC disconnection and removing the owned temporary root. Missing, nonzero or invalid acknowledgements remain errors and never produce a successful teardown record. Overall watch success also requires exit status zero: a clean final resource teardown can follow an unrelated watcher error.

Readiness is the renderer's bridge acknowledgement. It is not a measurement of GPU paint or usable OS input. Shutdown and readiness waits are bounded to five seconds each; compilation time is not included in those bounds. No state-preservation or physical native performance claim is made by these reports.

Watch bundles live in a fresh, session-owned OS temporary directory. At rest there is one live generation; a candidate can coexist with it during compilation. Failed candidates and joined old generations are removed, and closing the session removes its owned temporary directory. Closing also cancels and joins any active source scan. The source directory is only watched and read by this reload machinery.

### Controller memory

The watch controller is one persistent Bun process that calls `Bun.build` for every generation. With the pinned runtime's default mimalloc `purge_delay` of 100 ms, pages freed by the bundler's idle worker threads stay resident after each build, so controller RSS grows across reloads even though the JavaScript heap stays small (about 7 MB for React) and no build output is retained. A full `Bun.gc(true)`, which also runs the allocator's collection, bounds it; a JavaScriptCore-only full collection does not. Setting `MIMALLOC_PURGE_DELAY=0` returns those pages promptly without any forced collection.

The checkout `native` script and both generated templates' `dev` scripts therefore start the CLI with `MIMALLOC_PURGE_DELAY=0`. The `bun run` launcher keeps its default; generated `build` scripts are unchanged, and AOT application binaries do not inherit this setting. Watch-mode app processes inherit the CLI environment. Invoking `bun scripts/native.ts dev --watch` directly uses whatever the caller sets.

[`benchmarks/tooling/controller-allocator.ts`](../benchmarks/tooling/controller-allocator.ts) is the matched compiler-only control: fresh processes, the production `bundleProject` path, one distinct edit per build and no app, host or forced collection. Its [Linux results](../benchmarks/tooling/README.md) show that React's 401-build final RSS roughly halves and Solid's drops by about a fifth, at about 6–8 ms more median bundle time. The remaining Solid growth comes mostly from the Babel transform stage while its live JS heap stays bounded; a [stage decomposition](../benchmarks/tooling/results/solid-transform-linux-x64/README.md) found that reusing the loaded Babel preset does not reduce it, and this setting does not address it. These are finite observations; no plateau or leak-freedom claim follows.

The [Bun pin comparison](evidence/cli-watch-bun-pin-comparison-2026-11-06.json) re-reads eight retained hosted Linux runs of that 101-edit scenario: six on the previous pin `da867c60b` and two on `1.4.4-canary.1+b1007f117`. Each run's Solid and React invocation passed with exactly one live app and one native host at a time. The CLI-reported edit-to-ready median ranged from 170 to 260 ms on the old pin across runs; the new pin gave 208 to 243 ms (Solid) and 223 to 264 ms (React), so run-to-run variation on shared runners is larger than any pin difference these samples can resolve. Controller RSS grew by 25–33 MB (Solid) and 7–13 MB (React) over the 101 edits on both pins. These are eight finite observations with diagnostic overhead, produced by `python3 scripts/quality/watch-run-summary.py` from each run's `result.json`; they are not a controlled A/B, a plateau claim or a physical latency measurement.

The native watch scenario below supplies separate input, paint and repeated-cycle evidence when its hosted run passes. [#243](https://github.com/0xPlayerOne/bun-native/issues/243) also tracks qualification on the other supported platforms, matched performance measurements and any finer-grained reload strategy.

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
- `manifest.json`, with OS/CPU, exact toolchain, application/module/source-map/launcher/host SHA-256 and byte sizes, the compiler revision and executable digest, the compiler command (paths relative to the output directory), executable inspections, validation status and a `reproducibility` file inventory.
- The bundled development module and source map, generated launcher, and compiler logs for reproduction and diagnosis.
- `build-metrics.json`, with the compilation duration.

Equal sources and pins produce byte-identical files listed in `manifest.reproducibility.deterministic`, independent of the checkout location, output directory, working directory and build time. Compiler logs and `build-metrics.json` are diagnostics and are not reproducible. See [reproducible builds](reproducible-builds.md).

The application resolves its host next to its own executable, so the output directory can be moved and launched from another working directory. `BUN_NATIVE_HOST` is an explicit runtime override. Keep the application and bundled host together. Changed host or bundled-module bytes during packaging cause a failure. On failure, inspect the retained logs and use a new empty output directory for a retry.

Only the current OS and CPU are supported by this command; no `--target` or cross-compilation flag is accepted. Packaging checks do not launch a GUI. The manifest explicitly records native rendering, OS input and teardown as `not-run`, installation as `not-tested` and signing as `unsigned`. A native desktop and the required platform libraries are still needed to run the app. This is not a signed installer or proof of platform qualification.

## Verification and remaining work

`bun test tests/tooling/cli.test.ts` exercises all four generated templates through the actual checker and bundler, source edits/restarts, malformed source/configuration, host/destination errors, source containment, a real small AOT compilation, artifact hashes, output non-overwrite and relocated launch. `bun test tests/tooling/cli-quality.test.ts` runs `check`, `format` and `doctor` against generated projects with the real checker and formatter, including formatter-config precedence, the template-style fallback and doctor's failed host/project lines. The AOT packaging test deliberately uses a headless program and Bun itself as the supplied executable: it proves compiler/packager behavior and never claims native-host acceptance.

Generated-template lifecycle tests also compile the existing headless protocol peer into the supplied executable. All four templates mount through the real IPC runtime, then close the window or invoke their registered SIGINT/SIGTERM path. The tests assert zero remaining application windows/nodes/callbacks/queued work, zero renderer nodes, restored signal-listener counts and removed temporary bundles. Signal events are emitted inside the process; these checks establish handler/ownership behavior, not OS signal delivery or GPUI rendering.

`bun test tests/tooling/reload` (`reload.test.ts` plus `reload-remount-{solid,react}.test.ts`) performs 101 replacements for each of Solid and React against the real headless protocol peer. It checks acknowledgement of zero owned resources, app-process exit, paired peer start/exit records with no overlap, updated source execution and a bounded temporary-bundle count. It also tests preserved apps after malformed edits, serialized reloads, refusal to reload after close, bounded termination of an uncooperative app, recursive imported-component watching, rapid saves and watcher shutdown on app-window close. Timing output is explicitly labelled headless acknowledgement evidence.

The Native Linux workflow also runs a separate generated-template qualification after its existing scenarios and baseline, preserving their launch order and cache history. `tests/native/cli-templates.py prepare` uses the actual CLI to create, check and build all four templates against the job's one release GPUI host. It retains their unchanged source, full checkout file fingerprints, exact compiler/host hashes, compiler logs and inspected AOT manifests. Each native development case copies that exact source into a fresh owned project inside the checkout, then runs `bun scripts/native.ts dev <project> --host <release-host>` under the IPC owner from an unrelated working directory. The AOT case runs the prepared executable with its adjacent bundled host and no host override.

At readiness, the development owner fingerprints and preserves the actual temporary module and source map that the CLI loaded. After joining CLI exit and IPC disconnection, it requires that the CLI already removed the temporary module; only then does it remove the test project. Owned `cargo`, `rustc` and `rustup` PATH sentinels reject and record any attempted native-tool invocation. The lifecycle report retains the command, source and module hashes, sentinel result and both cleanup observations. Earlier module-only qualification artifacts remain evidence for their recorded commands; they do not establish exact CLI execution. `bun test tests/tooling/cli-dev-owner.test.ts` checks this owner with all four real CLI/template combinations against the headless protocol peer, plus malformed-source and native-tool invocation failures. Those source tests do not establish GPUI rendering or OS input.

One shared X11 scenario then requires the complete initial counter tree, an OS-injected click with native GPUI down/up capture, and the complete counter tree changing from zero to one. The templates contain no injected test callback. Their existing optional IPC hooks let a small owner require exactly one ready/stopped pair, zero application and renderer resources, process exit and IPC disconnection after the driver requests native window close. The existing driver also joins the observed app/host process tree and retains screenshots, native paint, adapter details and cleanup results. Pointer capture is reported separately from application callback instrumentation. A successful package build alone never marks these native checks as passed.

Pointer coordinates must lie strictly within half a logical pixel of each injected integer coordinate; an exact half-pixel tie, a different pixel, or a non-finite/non-numeric coordinate fails. This accommodates the pinned GPUI X11 conversion, which divides 16.16 event coordinates by `u16::MAX` before applying the scale factor. At the session's scale of one, `(100, 130)` becomes the exact observed `f32` pair `(100.00152587890625, 130.00198364257812)`. Window identity, nonce, fresh read offset, ordered down/up capture, trace bounds, button and complete paint expectations remain required.

The [preserved first template failure](../tests/native/evidence/template-pointer-x11-quantization.json) records PR #360 head `96a12a6974b35f66d574996cac8ecb21981f3fe5`, run `41873565470` attempt 1, job `126726856543` and artifact `13346018870`. All eight cases failed the original exact coordinate comparison while complete initial/updated paint, native OS close and joined zero-resource cleanup passed. The summary retains raw down/up records, per-case file hashes and the archive SHA-256; its original failed outcome remains unchanged. Replaying those records against the corrected same-pixel predicate is a regression check, and current native qualification still requires a new changed-head run.

These are eight bounded Linux cases: Solid/React × TypeScript/JavaScript × development/AOT. The workflow's `cli-templates` evidence directory contains preparation provenance plus each case's `result.json` and `lifecycle.json`; development cases also retain their actual `native-dev-module`. Exact `native dev` qualification requires these changed-command cases to pass on the current source head. Native qualification of `native dev --watch`, 100 native reload cycles, hardware GPU or physical-input behavior, macOS/Windows template qualification, and installation outside the checkout remain separate work. Assess the actual run's statuses before claiming qualification.

Linux native artifacts now also retain `unsigned-native-host.tar.gz`, containing the executable from that job's release build. It is packed by `scripts/native/host-archive.ts` with fixed metadata and the commit time, so the archive bytes depend only on the executable ([reproducible builds](reproducible-builds.md)). Match the extracted executable to `binary-sha256.txt` and the source/toolchain records in the same artifact before supplying its absolute path to `--host`. The archive is an experimental reproducibility artifact, is retained for the workflow's normal 14-day artifact lifetime, and still needs the documented Linux native libraries. It does not provide an automatic download/cache policy or a standalone application installer.

### Native watch qualification

The separate `tests/native/cli-watch.py` scenario runs the exact `bun run native dev PROJECT --host HOST --watch` command for Solid and React TypeScript projects. Each run predeclares **one initial launch and 101 successful source-edit remounts**, plus one rejected malformed edit. It changes only the generated app's visible heading and window title; the normal counter and lifecycle code remain intact. A distinct token appears in every retained source version and complete native paint expectation.

Each generation must reset to `Clicks: 0`, accept an OS-injected click and paint the complete `Clicks: 1` tree. The observer binds the current ready record to the app's PID/start ticks and the exact native host PID/start ticks behind its X11 window. Immutable previous identities must be absent before the next generation is accepted, and the CLI must supply the previous app's validated zero-resource teardown. A separate bounded sampler checks for overlapping hosts and app processes; sampled observations complement the CLI's enforced joined transition. At rest, exactly one owned generation directory is allowed.

Fresh byte offsets, the session nonce, complete node arrays and the unique heading prevent earlier generations' paint from satisfying a later edit. Concurrent native-paint readers start before the edit and before the click, so retained observations distinguish file edit to ready-record receipt, matching initial native paint, and input-confirmed native paint. Their intervals include bundling, teardown, process startup, input commands, monitoring and evidence I/O; they are not display-presentation timestamps or matched framework benchmarks. The raw process snapshots and sampled peak RSS are diagnostics, without forced collection or a claim of long-term leak freedom.

The malformed edit must report a build error while preserving the same app, native host and bundle; another real click must still update that working app. Final native OS close must produce a clean stopped record, exit status zero, absent app/host identities and removal of the session-owned temporary root. A private PATH sentinel rejects Cargo/Rust tool invocations, and the original host/compiler/source hashes must remain unchanged. The product's five-second readiness/shutdown bounds remain intact; the observer has a twenty-second generation observation bound and a six-minute overall experiment bound, with no failed-generation retries.

This step runs after all existing native scenarios, baselines and template cases. Artifacts retain `cli-watch-solid` and `cli-watch-react` reports, source versions, raw native/CLI logs, process transitions and first/final screenshots. Qualification requires the actual hosted run to pass both fixed-count experiments. JavaScript syntax is covered by the separate four-template checks; native watch behavior on macOS/Windows, physical input, sustained workloads and finer-grained/state-preserving reload remain separate work for #243.

The accepted checkout scope of #242 is complete. Standalone local-package installation is tracked in #382, and the wider onboarding/support contract remains in #254. #243 and #372 retain resource-behavior and wider watch-qualification work; finite RSS observations and zero public ownership counters do not prove a memory plateau or heap collectability. Signing, installers and updater qualification remain BN6 work. No existing native CI or adapter retention requirement is reduced by this tooling slice.
