# Experimental application updates and rollback

**Status:** Experimental tooling for [#249](https://github.com/0xPlayerOne/bun-native/issues/249). It verifies, installs, integrates, rolls back and uninstalls the output of `bun run native build` in a per-user installation directory. Packages are **unsigned experimental** at the OS level; no code signing or notarization is claimed. See [releasing](releasing.md) for the release policy.

The implementation is [`scripts/native/update-manifest.ts`](../scripts/native/update-manifest.ts) (manifest, trust and compatibility), [`scripts/native/installation.ts`](../scripts/native/installation.ts) (staging, commit, recovery, rollback and uninstall), [`scripts/native/installer.ts`](../scripts/native/installer.ts) (launchers, desktop integration and bundles) and the [`scripts/release-update.ts`](../scripts/release-update.ts) command. [`tests/tooling/update.test.ts`](../tests/tooling/update.test.ts) and [`tests/tooling/installer.test.ts`](../tests/tooling/installer.test.ts) cover the behavior below.

## Update manifest

An update manifest describes one build output directory: product ID, version, a monotonic `sequence`, declared trust mode, OS/CPU target, compatibility (`protocol` and pinned Bun revision) and every payload file with its byte count, SHA-256 and executable flag. Parsing is strict. Unknown fields, unsafe or non-portable paths, case-colliding paths, file/directory overlaps, an empty payload and a missing build `manifest.json` are rejected.

Trust comes from the installed updater at runtime, never from the download:

- **`ed25519`:** a detached base64 Ed25519 signature (`update.json.sig`) covers the exact manifest bytes, so no JSON canonicalization is involved. The caller supplies one or more trusted public keys. A missing, malformed or non-matching signature is rejected, as is a signed manifest that declares a different trust mode.
- **`unsigned-experimental`:** the manifest must declare this mode, and the caller must select it explicitly. A signed manifest cannot be installed in this mode. The installation records the release as `unsigned-experimental`, and the CLI prints a warning.

Before any download, the target OS/CPU, native protocol version and Bun revision must equal the updater's own. A mismatch fails as `incompatible`, so an update cannot leave a host and application with different ABIs.

## Installation layout and atomicity

```
INSTALL_DIR/
  state.json   committed current and previous release records (the commit point)
  current      derived one-line pointer to the current release, read by launchers
  bin/         generated launcher
  integration.json  menu entries and app wrappers created for this installation
  versions/    verified immutable release directories
  staging/     in-progress downloads
  data/        application user data; never written or removed by the updater
  lock         single-writer lock holding the owning process ID
```

`install` takes the lock, discards uncommitted work, rejects another product's installation and refuses an equal or lower sequence (replay/downgrade). It then streams each file into a fresh staging directory. A file that ends early, exceeds its declared size or has a different digest fails the install. The staged build `manifest.json` must agree with the signed inventory on target, Bun revision and executable application/host hashes. The staging directory is renamed into `versions/`, then a fully written and synced `state.json` replaces the old one by atomic rename. Until that rename the previous release remains current. Afterwards the prior current release is retained as `previous`, and older versions are removed. After a rollback, the newer release is the retained `previous`. Installing it again is refused even though its sequence is higher, so use `rollback` to roll forward.

A crash at any point leaves a stale lock and possibly staged or unreferenced files. The next `install`, `rollback` or `recover` takes over a lock whose process is no longer alive, removes those leftovers and leaves exactly the last committed release. A lock held by a live process fails as `busy`. Process ID reuse after a crash can make a stale lock look live. Remove it once you know no updater is running.

`rollback` re-hashes the retained previous release, refuses it if any file is missing or modified, and swaps current and previous with the same atomic commit. Running it again rolls forward. Neither operation touches `data/`. [update-lifecycle.md](update-lifecycle.md) adds a launcher contract that re-verifies the current release before returning its executable. `status` resolves the active directory from `state.json` and fails if that directory is missing. Generated launchers read the derived `current` pointer instead (see below). Payloads come from a local directory or an HTTPS base URL. Plain HTTP is accepted only for loopback test servers, and redirects are refused.

## Launchers, desktop integration and uninstall

`state.json` stays authoritative. After each commit, the installer atomically rewrites `current`, a one-line copy of the current release directory, because shell and `cmd` launchers cannot parse JSON safely. A crash between the two renames leaves `current` on the retained previous release, which is still complete and verified. The next `install`, `rollback`, `recover` or `uninstall` repairs or removes it.

`integrate` writes `bin/<product>`, or `bin/<product>.cmd` on Windows. The launcher reads `current`, sets `BUN_NATIVE_DATA_DIR` to `data/` and executes that release's `application` (`application.exe` on Windows). Both launchers refuse a pointer that is not exactly `versions/<name>`, where the name is letters, digits, `.` and `-` and not only dots; `state.json` validation applies the same rule. The Windows launcher strips the allowed characters from the pointer with delayed expansion before it compares or expands it, and its refusal and acceptance cases run on the hosted Windows job. `integrate` also creates one per-user menu entry:

- **Linux:** a `.desktop` file in the given applications directory, normally `~/.local/share/applications`.
- **macOS:** a minimal unsigned `Name.app` wrapper with `Info.plist` and `Contents/MacOS/<product>` in the given directory, normally `~/Applications`. Gatekeeper treats it as an app from an unidentified developer.
- **Windows:** a `Name.cmd` in the given Start-menu Programs directory.

Paths that end up inside shell, `.desktop`, plist or `cmd` text are limited to letters, digits, space, `_ . / : \ ~ -`. The display name is limited to letters, digits, space, `.`, `_` and `-`. On macOS an existing `Name.app` is replaced. Every created entry is recorded in `integration.json`.

`uninstall` takes the lock and removes the recorded entries. It then deletes `state.json`, which is the uninstall's commit point, followed by releases, staging, the pointer and launchers. `data/` is kept unless `--purge-data` is given; a purge removes the whole root. A kill before the commit leaves a working installation. A kill after it leaves orphaned releases, which `recover` removes; rerunning `uninstall` finishes the job. Reinstalling into a kept root reuses the preserved data.

`bundle` creates a new `<product>-<version>-<os>-<architecture>` directory inside an existing output directory and refuses one that already exists. It contains `update.json`, `update.json.sig` when the manifest is signed, `payload/` and a `README.txt` that labels the package unsigned at the OS level. Each payload file is checked against the manifest as it is copied. An `ed25519` manifest without a signature, or an unsigned manifest with one, is rejected. The signature is copied, not verified. Archive the directory with the platform's `tar` or zip tool.

`bundle --self-contained` also compiles the update tool into `bun-native-update` and the verifying launcher into `launcher` (each with `.exe` on Windows). Both are standalone executables for the build machine, so the release target must match it. With `--key-set keys.json`, the bootstrap key set is copied in too. The README then gives commands that need neither Bun nor this repository on the target:

```sh
./bun-native-update install update.json --payload payload --root ~/Apps/example --key-set keys.json
./bun-native-update integrate --root ~/Apps/example --name "Example App" --applications ~/.local/share/applications --verified-launcher launcher
```

A compiled tool cannot build executables itself, so its `launcher` command and `bundle --self-contained` refuse to run.

## Commands

```sh
bun scripts/release-update.ts manifest dist --product dev.example.app --version 1.2.0 --sequence 12 --signed --out update.json
bun scripts/release-update.ts sign update.json --private-key /absolute/ed25519-private.pem
bun scripts/release-update.ts install update.json --root ~/Apps/example --payload dist --public-key /path/public.pem
bun scripts/release-update.ts rollback --root ~/Apps/example
bun scripts/release-update.ts recover --root ~/Apps/example
bun scripts/release-update.ts status --root ~/Apps/example
bun scripts/release-update.ts bundle update.json --payload dist --out /absolute/existing/bundles
bun scripts/release-update.ts integrate --root ~/Apps/example --name "Example App" --applications ~/.local/share/applications
bun scripts/release-update.ts uninstall --root ~/Apps/example [--purge-data]
```

Keyed signing, rotation, health checks and verified starts ([update lifecycle](update-lifecycle.md)):

```sh
bun scripts/release-update.ts keygen --private-key /absolute/release-1.pem --public-key release-1.pub.pem
bun scripts/release-update.ts key-set --product dev.example.app --version 1 --minimum-sequence 1 --public-key release-1.pub.pem --out keys.json
bun scripts/release-update.ts sign update.json --private-key /absolute/release-1.pem --keyed
bun scripts/release-update.ts install update.json --root ~/Apps/example --payload dist --key-set keys.json [--rotation keys-2.json] [--health-limit 3]
bun scripts/release-update.ts rotate keys-2.json --root ~/Apps/example --key-set keys.json
bun scripts/release-update.ts launch --root ~/Apps/example [--key-set keys.json] -- --application-argument
bun scripts/release-update.ts confirm --root ~/Apps/example --release MANIFEST_SHA256
bun scripts/release-update.ts report-unhealthy --root ~/Apps/example --release MANIFEST_SHA256
bun scripts/release-update.ts launcher --out /absolute/example-launcher
bun scripts/release-update.ts integrate --root ~/Apps/example --name "Example App" --applications ~/.local/share/applications --verified-launcher /absolute/example-launcher
```

`manifest`, `keygen`, `key-set`, `sign`, `bundle` and `launcher` never overwrite an existing output. `install` reads the detached signature from `<manifest>.sig` beside the manifest when that file exists. `--payload` is a build directory or an `https://` base URL. `--public-key` can be repeated. `--private-key` must be an absolute path. For unsigned experimental releases, use `--unsigned-experimental` instead of `--signed`, skip `sign`, and pass `--unsigned-experimental` instead of `--public-key` to `install`. Keys are read from caller-supplied files at the time of the command. The tool neither stores nor prints them.

## Verified behavior

`bun test tests/tooling/update.test.ts tests/tooling/installer.test.ts` (Linux x64, pinned Bun `da867c60`) covers these cases with synthetic build outputs:

- signed install, update, rollback, roll-forward and eviction of older releases, with `data/` preserved
- unsigned, tampered, wrongly keyed, malformed-signature, empty-trust and trust-mode-downgrade manifests
- explicit unsigned experimental installation, which is recorded as such
- incompatible OS, CPU, protocol and Bun revision
- malformed manifests, oversized or non-JSON manifest bytes and non-Ed25519 trust keys
- a build output containing a symbolic link
- truncated, oversized, corrupted and failed downloads, with state, data and the current release unchanged
- a build manifest that disagrees with the signed inventory or is not JSON
- replay, downgrade and foreign-product updates
- rollback of a modified or incomplete retained release, and reinstalling a retained release
- corrupt or unsupported installation state
- a live lock
- an installer killed with `SIGKILL` at each of five phases, followed by recovery to exactly the old or the new release
- HTTP loopback and HTTPS-only enforcement
- the end-to-end CLI, including `bundle`, `integrate` and `uninstall`, its usage errors and its refusal to overwrite outputs
- `current` pointer maintenance and repair
- the POSIX launcher executing the current release with `BUN_NATIVE_DATA_DIR` and refusing a tampered pointer
- the Linux, macOS and Windows integration files, as generated text
- uninstall that keeps or purges data
- an uninstall killed with `SIGKILL` at each of three phases, then completed
- bundle contents, labels and mismatch rejection

The crash, launcher-execution and symbolic-link tests are skipped on Windows, because they rely on POSIX signals, `sh` and unprivileged symbolic links. On macOS and Windows, the integration files are checked as generated text only. No hosted or clean-machine run has opened them through Finder, Gatekeeper or the Start menu.

## Remaining for #249

- **Signing and notarization:** Apple Developer ID signing and notarization, Windows Authenticode, and Linux package signatures are not configured or verified. Ed25519 manifest signing is the updater's own trust root. It does not replace OS code signing.
- **Platform installers:** not implemented: native installer formats (`.dmg`, MSI/MSIX, `.deb`/AppImage), a single-file installer (a `--self-contained` bundle is a directory of standalone executables plus the payload), Windows `.lnk` shortcuts, real `.app` bundles holding the release. Automatic rollback after a failed health check is implemented experimentally; see [update lifecycle](update-lifecycle.md).
- **Native evidence:** these checks have not yet been run with real `native build` output on clean macOS and Windows machines, or with a running application. Windows replacement of running executables is not handled.
- **Key management:** key sets with key ids, rotation signed by a trusted key, permanent revocation and a minimum manifest sequence are implemented experimentally, with CLI commands (see [update lifecycle](update-lifecycle.md)). A release workflow that signs with a configured CI secret is not.
