# Experimental application updates and rollback

**Status:** Experimental tooling for [#249](https://github.com/0xPlayerOne/bun-native/issues/249). It verifies, installs and rolls back the output of `bun run native build` in an updater-owned installation directory. It is not a platform installer, and no production signing or notarization is claimed. See [releasing](releasing.md) for the release policy.

The implementation is [`scripts/native/update-manifest.ts`](../scripts/native/update-manifest.ts) (manifest, trust and compatibility), [`scripts/native/installation.ts`](../scripts/native/installation.ts) (staging, commit, recovery and rollback) and the [`scripts/release-update.ts`](../scripts/release-update.ts) command. [`tests/tooling/update.test.ts`](../tests/tooling/update.test.ts) covers the behavior below.

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
  versions/    verified immutable release directories
  staging/     in-progress downloads
  data/        application user data; never written or removed by the updater
  lock         single-writer lock holding the owning process ID
```

`install` takes the lock, discards uncommitted work, rejects another product's installation and refuses an equal or lower sequence (replay/downgrade). It then streams each file into a fresh staging directory. A file that ends early, exceeds its declared size or has a different digest fails the install. The staged build `manifest.json` must agree with the signed inventory on target, Bun revision and executable application/host hashes. The staging directory is renamed into `versions/`, then a fully written and synced `state.json` replaces the old one by atomic rename. Until that rename the previous release remains current. Afterwards the prior current release is retained as `previous`, and older versions are removed.

A crash at any point leaves a stale lock and possibly staged or unreferenced files. The next `install`, `rollback` or `recover` takes over a lock whose process is no longer alive, removes those leftovers and leaves exactly the last committed release. A lock held by a live process fails as `busy`. Process ID reuse after a crash can make a stale lock look live. Remove it once you know no updater is running.

`rollback` re-hashes the retained previous release, refuses it if any file is missing or modified, and swaps current and previous with the same atomic commit. Running it again rolls forward. Neither operation touches `data/`. The launcher resolves the active directory from `state.json` (`currentRelease`). Payloads come from a local directory or an HTTPS base URL. Plain HTTP is accepted only for loopback test servers, and redirects are refused.

## Commands

```sh
bun scripts/release-update.ts manifest dist --product dev.example.app --version 1.2.0 --sequence 12 --signed --out update.json
bun scripts/release-update.ts sign update.json --private-key /absolute/ed25519-private.pem
bun scripts/release-update.ts install update.json --root ~/Apps/example --payload dist --public-key /path/public.pem
bun scripts/release-update.ts rollback --root ~/Apps/example
bun scripts/release-update.ts recover --root ~/Apps/example
bun scripts/release-update.ts status --root ~/Apps/example
```

For unsigned experimental releases, use `--unsigned-experimental` instead of `--signed`, skip `sign`, and pass `--unsigned-experimental` instead of `--public-key` to `install`. Keys are read from caller-supplied files at the time of the command. The tool neither stores nor prints them.

## Verified behavior

`bun test tests/tooling/update.test.ts` (Linux x64, pinned Bun `da867c60`) covers these cases with synthetic build outputs:

- signed install, update, rollback, roll-forward and eviction of older releases, with `data/` preserved
- unsigned, tampered, wrongly keyed, malformed-signature, empty-trust and trust-mode-downgrade manifests
- explicit unsigned experimental installation, which is recorded as such
- incompatible OS, CPU, protocol and Bun revision
- malformed manifests
- truncated, oversized, corrupted and failed downloads, with state, data and the current release unchanged
- a build manifest that disagrees with the signed inventory
- replay, downgrade and foreign-product updates
- rollback of a modified retained release
- a live lock
- an installer killed with `SIGKILL` at each of five phases, followed by recovery to exactly the old or the new release
- HTTP loopback and HTTPS-only enforcement
- the end-to-end CLI

The crash test is skipped on Windows because it relies on POSIX signals.

## Remaining for #249

- **Signing and notarization:** Apple Developer ID signing and notarization, Windows Authenticode, and Linux package signatures are not configured or verified. Ed25519 manifest signing is the updater's own trust root. It does not replace OS code signing.
- **Platform installers:** `.app`/`.dmg`, MSI/MSIX and `.deb`/AppImage packaging, a launcher that reads `state.json`, and automatic rollback after a failed health check are not implemented.
- **Native evidence:** these checks have not yet been run with real `native build` output on clean macOS and Windows machines, or with a running application. Windows replacement of running executables is not handled.
- **Key management:** key rotation, revocation and a release workflow that signs with a configured CI secret are not implemented.
