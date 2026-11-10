# Create your first Bun Native app

Create a Solid or React application inside a Bun Native checkout, run it against a supplied native host, and compile it with Bun's AOT compiler. TypeScript is the default; checked JavaScript with JSX is also supported. This accepted [#242](https://github.com/0xPlayerOne/bun-native/issues/242) workflow uses the checkout's framework packages and build tools. The separate [standalone local-package route](standalone-projects.md) is tracked in [#382](https://github.com/0xPlayerOne/bun-native/issues/382), with its own installation and native qualification. Registry publication, automatic host acquisition and the wider support contract remain separate work.

Steps 1, 2, 4 and 5 are the same for both frameworks. Step 3 has one walkthrough for [SolidJS](#3a-solidjs-walkthrough) and one for [React](#3b-react-walkthrough). This page describes Bun Native 0.27.2; the [compatibility matrix](compatibility.md) lists what that version supports on each platform.

## 1. Prepare the checkout

Use Git, Node 22 or newer for the Bun bootstrap, and the exact Bun revision in [`toolchain.json`](../toolchain.json). These commands use a POSIX shell:

```sh
git clone https://github.com/0xPlayerOne/bun-native.git
cd bun-native
node scripts/install-bun.mjs --destination "$PWD/.bun-native/toolchain"
export PATH="$PWD/.bun-native/toolchain:$PATH"
bun install --frozen-lockfile
```

The installer checks the committed archive integrity and compiler revision. Keep the repository's lockfile unchanged. Install dependencies once at the checkout root; generated projects resolve those workspace packages and do not need a separate install. See [toolchain setup](toolchain.md) for the pin, bootstrap details and Windows paths.

For an existing populated package cache, the pinned Bun supports a cache-only installation:

```sh
bun install --frozen-lockfile --offline \
  --cache-dir /absolute/path/to/populated-bun-cache
```

The cache must already contain the locked packages for the target platform. An empty cache fails explicitly. This restores checkout dependencies; the pinned Bun executable and native host must already be supplied separately. To populate a chosen cache while online, use the same command without `--offline`.

## 2. Supply a native host

Set an absolute path to a prebuilt host for the same OS and CPU:

```sh
export BUN_NATIVE_PREBUILT_HOST=/absolute/path/to/bun-native-host
```

There are two sources of a Linux x64 host:

- **From CI.** The [Native Linux workflow](../.github/workflows/native-linux.yml) runs on `ubuntu-24.04`, builds `target/release/bun-native-host` with `cargo build --locked --release`, and, when that build succeeded, packs it with [`scripts/native/host-archive.ts`](../scripts/native/host-archive.ts) into `unsigned-native-host.tar.gz`. The archive and its `unsigned-native-host.tar.gz.sha256` are uploaded in the run's `native-linux-X64` artifact (14-day retention) together with `binary-sha256.txt`, `binary-size.txt` and `toolchain.txt`. The archive holds one flat member, `bun-native-host`, with mode 0755. `binary-sha256.txt` names the CI path `target/release/bun-native-host`, so compare its hash field with `sha256sum bun-native-host` after extraction rather than running `sha256sum --check` on it. The archive is retained even when later native checks in the same run fail, so inspect that run's check results as well as its build step. The same release executable is the `--host` for the workflow's own template, watch and standalone consumer cases, but those cases run from the build directory. Downloading the artifact and running it on another machine is not exercised by CI.
- **From source.** `bun run native:build` runs `cargo build --locked -p bun-native-host --release` and writes `target/release/bun-native-host`. It needs Rust and the platform libraries in the [native host README](../native/gpui-host/README.md). `bun run build` does **not** produce a host: it only bundles the TypeScript packages into `dist/` as JavaScript modules.

On macOS and Windows, `bun run native:build` also builds the host from source, with the pinned Rust toolchain and the platform SDK (Xcode command-line tools on macOS, MSVC build tools on Windows). The recorded macOS arm64 quick-start below built its host from source with that same Cargo command.

Either host is experimental and unsigned and needs the platform libraries described in the native host README. The [Native Platforms workflow](../.github/workflows/native-platforms.yml) likewise retains an `unsigned-native-host.tar.gz` for its `macos-15` and `windows-2022` release builds, in the `native-platform-<OS>-<arch>-<sha>` artifact beside `native-sha256.txt` (14-day retention). Using those archives outside their CI runs is not exercised either.

To check a candidate host without launching it, run `bun run native doctor --host "$BUN_NATIVE_PREBUILT_HOST"`. Like `dev` and `build`, it accepts only an absolute path to a readable executable whose header matches the current OS and CPU. A matching header does not prove the file is a Bun Native host. The shared runtime checks the protocol when the app launches. Creation and source checks run with Bun; packaging copies the supplied host. No CLI command downloads a host or runs Cargo.

## 3. Create and check an app

Both walkthroughs create an app inside the checkout, check it, and return to the checkout root. Choose a new destination for each app; `create` never writes into an existing directory. Add `--language javascript` to either creation command for a checked `.jsx` entry; otherwise the entry is `.tsx`. The rest of this page uses `apps/my-app`; substitute your chosen project path.

Every generated project contains:

| File              | Purpose                                                                                                  |
| ----------------- | -------------------------------------------------------------------------------------------------------- |
| `bun-native.json` | Selects the framework and entry file (`schemaVersion: 1`).                                               |
| `main.tsx`        | The counter app (`main.jsx` for JavaScript). It owns the window, renderer root and application shutdown. |
| `package.json`    | `check`, `format`, `format:check`, `lint`, `dev` and `build` scripts that call the checkout CLI.         |
| `tsconfig.json`   | Extends the checkout configuration and sets `jsxImportSource` to the selected adapter.                   |
| `README.md`       | The project's commands, the framework's native JSX rules and links back to this guide.                   |
| `.gitignore`      | Ignores `dist/` and `.bun-native/`.                                                                      |

### 3a. SolidJS walkthrough

```sh
bun run native create apps/my-app
cd apps/my-app
bun run check
cd ../..
```

Solid is the default framework. The entry imports `render` from `@bun-native/solid` and `createSignal` from `solid-js`. `App` runs once; reading `clicks()` inside the `text` expression subscribes that one native text node, so each click updates only that node. `render(App, window)` takes the component itself. The Solid compiler pairing is pinned (Babel 7 with `babel-preset-solid`; Babel 8 is excluded under [#316](https://github.com/0xPlayerOne/bun-native/issues/316)), and `solid-js/web` is not available: use native elements such as `box`, `text`, `button` and `input`, described in the [native layout contract](native-layout.md) and the [Solid adapter README](../packages/solid/README.md).

### 3b. React walkthrough

```sh
bun run native create apps/my-react-app --framework react
cd apps/my-react-app
bun run check
cd ../..
```

The entry starts with `/** @jsxImportSource @bun-native/react */`, imports `render` from `@bun-native/react` and `useState` from `react`. `App` re-renders on each click, and the reconciler sends only the changed native properties. `render(<App />, window)` takes an element. Hooks, refs, effect cleanup and error boundaries work as in React; `react-dom` and DOM-dependent components do not (see the [React adapter README](../packages/react/README.md) and [React behavior](react-behavior.md)). Use the same native elements as Solid.

For either framework the window, its `closed` promise and `application.shutdown()` come from the [public core API](../packages/core/README.md). Keep the template's `try`/`finally` shutdown and its optional development IPC hooks when extending the app: watch mode depends on them to tear down one session before the next starts.

## 4. Develop on a native desktop

```sh
bun run native dev apps/my-app --host "$BUN_NATIVE_PREBUILT_HOST"
```

On a desktop with the host's platform prerequisites, this opens the native counter. Edit the entry and restart the command, or add `--watch` for source watching:

```sh
bun run native dev apps/my-app --host "$BUN_NATIVE_PREBUILT_HOST" --watch
```

Watch rebuilds and remounts the app and host after a successful edit, so component state resets. A rejected source edit leaves the working app running. Closing the native window or pressing Ctrl-C ends the session. Since 0.27.2 the host runs in its own POSIX session, so Ctrl-C reaches only the application, which then shuts the host down ([#584](https://github.com/0xPlayerOne/bun-native/issues/584); covered by [`tests/runtime/host-exit.test.ts`](../tests/runtime/host-exit.test.ts), not yet re-run on a physical Mac). Keep the template's lifecycle and optional IPC hooks when extending it. The [CLI reference](developer-tooling.md) explains the watch contract and exact native qualification boundaries.

## 5. Build the AOT package

From the checkout root, choose a new or empty output directory and declare the supplied host's build profile:

```sh
bun run native build apps/my-app \
  --host "$BUN_NATIVE_PREBUILT_HOST" \
  --host-profile release \
  --outdir "$PWD/.bun-native/my-app-package"
```

Use `--host-profile dev` if you supplied a development host. The declaration is recorded provenance; it does not inspect the binary's optimization level.

The output contains the AOT `application`, its adjacent `bun-native-host`, a manifest with executable hashes and compiler inspections, and the bundled source plus compiler logs. Keep the two executables together. On the matching native desktop, launch:

```sh
.bun-native/my-app-package/application
```

The CLI uses the pinned `bun compile` path and requires compiled-program and JIT-omission evidence. It builds for the current OS and CPU. The generated package is unsigned; installation, signing, updates and target-platform GUI acceptance require their own qualification. Consult the [CLI reference](developer-tooling.md) for output layout, host resolution and error handling.

## Debug a failing app

| Symptom                                                              | What to check                                                                                                                                                                                                                       |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dev` or `build` rejects the host path                               | Run `bun run native doctor apps/my-app --host "$BUN_NATIVE_PREBUILT_HOST"`. The host must be an absolute path to a readable executable built for the current OS and CPU.                                                            |
| `Native protocol version mismatch` or `unsupported protocol version` | The host and the checkout's packages come from different sources. Rebuild or redownload the host from the same commit as the packages (see [Upgrade an app](#upgrade-an-app)).                                                      |
| `bun run check` fails                                                | Each step (type check, format, lint) prints its own output before its status line. `bun run format` applies the formatter.                                                                                                          |
| The window opens but a control does not respond                      | The native element may not support that property or event. Check the [native events](native-events.md) and [native layout](native-layout.md) contracts; DOM events and CSS are not available.                                       |
| A service call reports `unavailable` or `unsupported_platform`       | The host does not advertise that capability on this platform. See [capabilities by platform](native-platforms.md#advertised-capabilities-by-platform) and [native services](native-services.md).                                    |
| The host or app exits unexpectedly                                   | The runtime reports the host's exit status and a bounded diagnostic. [Native close diagnostics](native-close-diagnostics.md) and [startup diagnostics](native-startup-diagnostics.md) describe the traces CI keeps for these cases. |

## Upgrade an app

Bun Native pins exact versions and has no stable API yet; each release can change the public API and the native protocol. Upgrade the checkout, the toolchain, the packages and the host together:

```sh
git pull --ff-only
node scripts/install-bun.mjs --destination "$PWD/.bun-native/toolchain"
bun install --frozen-lockfile
bun run native doctor apps/my-app --host "$BUN_NATIVE_PREBUILT_HOST"
```

Then rebuild the host with `bun run native:build`, or take the CI artifact from a run on the new commit, because a host from an earlier protocol version fails at launch. Read the [changelog](../CHANGELOG.md) for API changes, run `bun run check` in each app, and rebuild its AOT package. The [compatibility matrix](compatibility.md#exact-pins) names the exact Bun, GPUI, Solid, React and protocol versions of each release.

## What the onboarding check proves

The [recorded Linux x64 onboarding check](../tests/native/evidence/checkout-cli-onboarding-linux.json) began with a clean worktree at `ef1c14a7973ddc907511ccd1a4ff62f6da990475` and no installed dependencies. Its [published equivalent source](https://github.com/0xPlayerOne/bun-native/tree/1406bd3fcbacf4dad3b06c55a270368206e9a4bb) has the identical Git tree `040abd1f0367f9f02ab7feda05060a181213a0b6`; commit metadata differs. It verified the exact compiler and restored 72 packages using `--frozen-lockfile --offline` from a populated cache. An independent empty-cache attempt failed with the expected cache-miss diagnostic. Both attempts preserved the lockfiles and toolchain pins.

| App              | Strict source check | Actual AOT build and inspection |
| ---------------- | ------------------- | ------------------------------- |
| Solid TypeScript | Passed              | Passed                          |
| Solid JavaScript | Passed              | Passed                          |
| React TypeScript | Passed              | Passed                          |
| React JavaScript | Passed              | Passed                          |

The same check verified TypeScript defaults for both frameworks, compared the supplied host's native sources and pins with the tested checkout, and recorded no invocation of owned `cargo`, `rustc` or `rustup` sentinels. It retained generated sources, command logs and package fingerprints. This is evidence for a clean checkout with an existing package cache and supplied toolchain/host. That check did not perform a network installation.

A [separate fresh-cache installation check](evidence/cli-fresh-local-cache-install-2026-11-04.json) used the committed Node bootstrap to download the pinned Bun archive, verify its checksum and install the same 72 locked packages with an initially empty local cache. It preserved the toolchain pins and lockfiles, invoked no native compiler, and removed its owned checkout, cache and toolchain afterward. This installation check did not repeat the AOT builds or exercise a native window.

### macOS arm64, physical Mac

On 2026-11-09 the same steps ran from a fresh clone at [`df7ffcf`](https://github.com/0xPlayerOne/bun-native/tree/df7ffcf) (release 0.27.2) on macOS 27.2 (26B123), Apple M2 Max (12 CPU), arm64 ([#254 comment](https://github.com/0xPlayerOne/bun-native/issues/254#issuecomment-6752594147)). The installer gave the pinned `1.4.4-canary.1+b1007f117`, `bun install --frozen-lockfile` passed, the release host built from source in 4 min 20 s, and `doctor` passed.

| Step                           | Solid TypeScript         | React TypeScript         |
| ------------------------------ | ------------------------ | ------------------------ |
| `create`                       | Passed                   | Passed                   |
| `bun run check`                | Passed                   | Passed                   |
| `dev --host`                   | One owned 640×512 window | One owned 640×512 window |
| `build --host-profile release` | Passed                   | Passed                   |
| AOT `application`              | One owned window         | One owned window         |

Window presence comes from CGWindowList only: the terminal had no Screen Recording permission, and no input was sent. JavaScript templates, Windows and signing were not run. Ending each session with Ctrl-C reported an unexpected host exit, fixed afterwards by [#584](https://github.com/0xPlayerOne/bun-native/issues/584) as described in step 4.

### Linux and hosted GUI launches

No local GUI launch was attempted in the Linux record because the verification environment's process IDs and `/proc` did not share the namespace required by the native ownership checks. The manifests retain `nativeRendering`, `osInput` and `teardown` as `not-run`. This record does not qualify macOS/Windows templates, independent framework installation or signed distribution. Current hosted native evidence is described separately in [developer tooling](developer-tooling.md).

## Continue developing

Use the [public API reference](api-reference.md), the [public core API](../packages/core/README.md), [native layout contract](native-layout.md) and [compatibility guide](compatibility.md) when extending an app. Framework contributors should also read the [architecture](architecture.md), [engineering-quality policy](engineering-quality.md), [testing guide](testing.md) and [implementation handoff](bun-native-handoff.md).
