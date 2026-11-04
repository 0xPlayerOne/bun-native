# Create your first Bun Native app

Create a Solid or React application inside a Bun Native checkout, run it against a supplied native host, and compile it with Bun's AOT compiler. TypeScript is the default; checked JavaScript with JSX is also supported. The checkout supplies the framework packages and build tools. Independently published packages and automatic native-host acquisition remain open under [#242](https://github.com/0xPlayerOne/bun-native/issues/242).

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

For Linux, the [Native Linux workflow](../.github/workflows/native-linux.yml) retains `unsigned-native-host.tar.gz` inside its `native-linux-X64` artifact. Match the extracted executable to `binary-sha256.txt` and that run's source/toolchain records before using it. Inspect the actual run's native checks as well as its build result. The archive is experimental and unsigned, has the workflow's limited retention period, and requires the platform libraries described in the [native host README](../native/gpui-host/README.md).

The `dev` and `build` commands require `--host` and validate the executable's format and CPU before bundling. The shared runtime checks the protocol when the app launches. Creation and source checks run with Bun; packaging copies the supplied host. Rust is needed when a framework contributor builds a host from source; those instructions are in the native host README.

## 3. Create and check an app

From the checkout root, create the default Solid TypeScript app:

```sh
bun run native create apps/my-app
cd apps/my-app
bun run check
cd ../..
```

For React, use `bun run native create apps/my-react-app --framework react`. Add `--language javascript` to either creation command for a checked `.jsx` entry; otherwise the entry is `.tsx`. Choose a new destination for each app and keep it inside the checkout. Subsequent examples use `apps/my-app`; substitute your chosen project path.

The generated entry contains a counter built with the public core and selected framework adapter. It owns the window, renderer root and application shutdown. `bun-native.json` selects the framework and entry file; the generated package includes `check`, `dev` and `build` scripts.

## 4. Develop on a native desktop

```sh
bun run native dev apps/my-app --host "$BUN_NATIVE_PREBUILT_HOST"
```

On a desktop with the host's platform prerequisites, this opens the native counter. Edit the entry and restart the command, or add `--watch` for source watching:

```sh
bun run native dev apps/my-app --host "$BUN_NATIVE_PREBUILT_HOST" --watch
```

Watch rebuilds and remounts the app and host after a successful edit, so component state resets. A rejected source edit leaves the working app running. Closing the native window or interrupting the command ends the session. Keep the template's lifecycle and optional IPC hooks when extending it. The [CLI reference](developer-tooling.md) explains the watch contract and exact native qualification boundaries.

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

No local GUI launch was attempted because the verification environment's process IDs and `/proc` did not share the namespace required by the native ownership checks. The manifests retain `nativeRendering`, `osInput` and `teardown` as `not-run`. This record does not qualify macOS/Windows templates, independent framework installation or signed distribution. Current hosted native evidence is described separately in [developer tooling](developer-tooling.md).

## Continue developing

Use the [public core API](../packages/core/README.md), [native layout contract](native-layout.md) and [compatibility guide](compatibility.md) when extending an app. Framework contributors should also read the [architecture](architecture.md), [engineering-quality policy](engineering-quality.md), [testing guide](testing.md) and [implementation handoff](bun-native-handoff.md).
