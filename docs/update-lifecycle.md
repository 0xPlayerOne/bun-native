# Update key rotation, launcher contract and health-checked rollback

**Status:** Experimental tooling for [#249](https://github.com/0xPlayerOne/bun-native/issues/249), building on the update manifest, staged installation and rollback in [updates](updates.md). Everything here is TypeScript that runs with Bun and is verified on Linux x64 with synthetic payloads only. Nothing here signs executables, builds platform installers, replaces running Windows executables or runs on macOS or Windows hardware. No network access is used, and no OS signing is involved.

The implementation is [`scripts/native/update-keys.ts`](../scripts/native/update-keys.ts) (key sets, keyed signatures, rotation and revocation), [`scripts/native/lifecycle.ts`](../scripts/native/lifecycle.ts) (launcher contract and health checks) and additions to [`scripts/native/installation.ts`](../scripts/native/installation.ts). Tests are in [`tests/tooling/update-keys.test.ts`](../tests/tooling/update-keys.test.ts) and [`tests/tooling/update-lifecycle.test.ts`](../tests/tooling/update-lifecycle.test.ts). The existing `verifyUpdate` trust policy, with keys supplied at runtime, and its tests are unchanged.

## Key sets, rotation and revocation

A key set is a strict JSON document for one product:

```json
{
  "schemaVersion": 1,
  "product": "dev.example.app",
  "version": 3,
  "minimumSequence": 12,
  "keys": [{ "id": "3f9c0d1e2a4b5c6d", "publicKey": "MCowBQYDK2VwAyEA…" }],
  "revoked": ["a1b2c3d4e5f60718"]
}
```

- `id` is `keyId(publicKey)`: the first 16 hex digits of the SHA-256 of the SPKI DER encoding. The parser recomputes it, so a mislabeled key is rejected. `publicKey` is the base64 SPKI DER encoding of an Ed25519 key.
- `version` orders key sets. `minimumSequence` is the lowest manifest `sequence` that may still be installed or rolled back to. `revoked` lists key ids that may never sign again.
- Parsing rejects unknown or missing fields, an empty or oversized key list (1 to 16 keys), more than 256 revocations, duplicate ids, an id that is both trusted and revoked, non-Ed25519 keys and documents over 64 KiB. Entries are sorted so that equal sets compare equal.

A keyed signature is a detached one-line envelope, `<key id> <base64 Ed25519 signature>`, over the exact bytes of a manifest or key set (`signWithKey`). The id only selects the key. A signature relabeled with another id fails verification. `verifyKeyedUpdate(bytes, signature, keySet, requirements)` checks, in this order, with a fixed error message for each:

1. size bound, then a well-formed envelope (`untrusted`)
2. signer not revoked: `Manifest signer <id> is revoked` (`untrusted`), even when the signature is genuine
3. signer present in the key set: `Manifest signer <id> is not a trusted key` (`untrusted`)
4. signature valid for that key (`untrusted`)
5. the usual strict manifest parse, `ed25519` trust mode and host compatibility from `verifyUpdate` (`malformed`, `untrusted`, `incompatible`)
6. manifest product equal to the key set's product (`untrusted`)
7. `sequence >= minimumSequence`: `Manifest sequence <n> is below the minimum <m>` (`downgrade`)

The result is an ordinary `VerifiedUpdate` whose trust records the signing key id, so `install` is unchanged. `install` still refuses an equal or lower sequence than the current release.

**Rotation.** A new key set is accepted by `rotateKeySet(current, bytes, signature)` only when:

- a key in the current set, not revoked, signed its exact bytes
- it is for the same product
- its `version` is higher
- its `minimumSequence` does not decrease
- it keeps every existing revocation

Revocation is therefore permanent. A revoked key cannot sign its way back in, and an older key set cannot be replayed. To rotate, sign a set that adds the new key with a current key, then sign a later set that drops or revokes the old key with the new one. One set may also add and revoke at once.

**Persistence.** `acceptKeySet(root, bootstrap, bytes, signature)` takes the installation lock, rotates from the effective set and atomically writes `keys.json` in the installation root, using the temporary file, `fsync` and rename sequence that `state.json` uses. `trustedKeySet(root, bootstrap)` returns the effective set. That is the stored set or the caller's bootstrap set, whichever has the higher version, and the newer one must be a valid successor of the older one. Two different sets with the same version, or an unreadable `keys.json`, fail as `state`. The bootstrap set is supplied by the installed updater at runtime, as public keys are today. `keys.json` has the same integrity assumption as `state.json`: only the user's file permissions protect it. `uninstall` removes it with the other updater-owned files.

**Retained releases.** `rollback(root, { keys })` and `launch(root, { keys })` refuse a release that is unsigned, was signed by a revoked key, or has a sequence below `minimumSequence`. A key that was dropped without being revoked is retired, not distrusted, so its releases stay usable. Without `keys`, `rollback` behaves as before.

Known limits: one signature authorizes a rotation, so a stolen current key can rotate until it is revoked by a set that the installation has already accepted. There are no thresholds, expiry times or transparency logs. The CLI exposes keyed signing (`keygen`, `key-set`, `sign --keyed`), rotation (`rotate`, or `install --rotation`) and keyed installs (`install --key-set`).

## Launcher contract

`launch(root, { keys? })` resolves exactly what to start:

1. It reads and strictly parses `state.json`. Nothing installed, or an invalid state, fails as `state`.
2. It advances or resolves a pending health check (below). Only this step takes the installation lock, so a confirmed release starts even while an update is downloading.
3. With `keys`, it applies the retained-release policy to the current release.
4. It re-hashes every file of the current release against the digests recorded at install time, using the same `verifyRelease` as `rollback`. A missing or modified file fails as `integrity`.
5. It reads the release's build `manifest.json`, rechecks its digest and takes `application.file`. That file must be recorded as executable with the same SHA-256, and on POSIX must have its execute bit. Otherwise it fails as `integrity`.

It returns the absolute `executable`, the release `directory`, the `data` directory to pass as `BUN_NATIVE_DATA_DIR`, the release record, the health status and, when this launch rolled back, the failed release. The guarantee holds at verification time. A same-user process that changes files between `launch` and `exec` is outside the threat model, and every file is hashed on each start. The generated shell and `cmd` launchers in [updates](updates.md) still follow the `current` pointer without verification.

## Verified launcher and application health

`release-update.ts launch --root R [-- args]` runs this contract and then starts the application. `release-update.ts launcher --out PATH` compiles the same code (`scripts/native/verified-launcher.ts`) with `bun build --compile` into a standalone executable for the build machine's platform. `integrate --verified-launcher PATH` installs it as `bin/<product>` (`bin/<product>.exe` on Windows) in place of the pointer script. The menu entries start it, and the macOS `.app` wrapper delegates to it, because the launcher derives the installation root from its own location. On every start the launcher does the following:

1. It resolves the release with `launch`. That counts a pending start, or rolls back an unconfirmed release and says so on stderr.
2. It applies the key set persisted by the last accepted rotation, or the `--key-set` bootstrap set from the CLI.
3. It starts the application with `BUN_NATIVE_DATA_DIR`, `BUN_NATIVE_INSTALL_ROOT` and `BUN_NATIVE_RELEASE`, the manifest SHA-256 that `confirm` and `report-unhealthy` take.
4. It forwards `SIGTERM` and `SIGHUP`, and exits with the application's code, or 128 plus the signal number.

A refusal exits 1 without starting anything.

While the release awaits its health check, the launcher also sets `BUN_NATIVE_HEALTH_FILE` to a file of its own, `health/<release>.<random>` in the installation root. Concurrent starts of the same release never share or erase each other's file, and each launch removes its own when the application exits. The application calls `reportHealthy()` from `@bun-native/core` once its own check passes, for example when its first window has opened with its data loaded. That writes the release's SHA-256 to the file. The launcher polls for it while the application runs and once more after it exits. When the content matches, it calls `confirmHealthy` and removes the file. A failed confirmation is reported on stderr and never stops the application. `installedRelease()` gives the application the data directory, root and release, or undefined when it was not started by the verifying launcher. Applications generated by `native create` call it after their first render. A supervisor script can still confirm through `release-update.ts confirm`. `uninstall` removes `health/`.

## Health-checked activation and automatic rollback

`install(root, update, source, { health: { limit } })` with `limit` from 1 to 16 activates the new release as pending-health. `state.json` gains `health: { status: "pending", attempts: 0, limit }`. The release is committed and the previous release is retained exactly as before. A first install cannot be pending, because it has no release to fall back to. States written before this change have no `health` or `failed` fields and read as confirmed.

- **Start:** each `launch` of a pending release first commits `attempts + 1` with the atomic state write, then verifies and returns it. A start that crashes, hangs or is killed before confirming has used its attempt.
- **Confirm:** the application calls `confirmHealthy(root, manifestSha256)` after its own health check, which ends the pending state. A confirmation for a release that is not current fails as `state`, so a late report from an old process cannot confirm a newer release. Repeating it is a no-op.
- **Explicit failure:** `reportUnhealthy(root, manifestSha256)` rolls back at once with reason `failed`. A confirmed release cannot be failed this way. Use `rollback`.
- **Unconfirmed:** a `launch` that finds `attempts == limit` rolls back with reason `unconfirmed` and starts the retained release.

An automatic rollback re-verifies the retained release, and checks it against `keys` when they are given, before it commits `current = previous`, `previous = null`, `health = null` and `failed = { version, sequence, manifestSha256, reason }`. The failed release directory is then swept, and `data/` is never touched. If the retained release is modified, the rollback fails as `integrity` and leaves the state unchanged, so the installation fails closed rather than starting either release. Afterwards, `install` refuses any sequence at or below the failed one as `downgrade`, so an updater cannot loop on the same broken release.

While a release is pending, `install` refuses another update as `state`, so an unconfirmed release never becomes the retained fallback. A manual `rollback` ends the pending state. It keeps the unconfirmed release as `previous`, so a second manual rollback rolls forward to it without a health check.

**Crash safety.** Every transition is one atomic `state.json` commit under the installation lock, using the same `transition` helper as `rollback`. The test kills a child process with `SIGKILL` at each phase (`locked`, `verified`, `committed`) of a counting launch, an exhausted launch and an explicit failure report. The next `launch` then resolves deterministically:

| Killed during    | at `locked` / `verified`                          | at `committed`                                                   |
| ---------------- | ------------------------------------------------- | ---------------------------------------------------------------- |
| counting launch  | attempt not counted; the next launch is attempt 1 | attempt counted; the next launch is attempt 2                    |
| exhausted launch | still pending; the next launch rolls back         | already rolled back; the next launch starts the retained release |
| failure report   | still pending; the next launch counts an attempt  | already rolled back                                              |

`recover` then leaves no staging, temporary files, lock or orphaned release.

## Verified behavior

`bun test tests/tooling/update-keys.test.ts tests/tooling/update-lifecycle.test.ts` (Linux x64, pinned Bun `da867c60`) covers these cases with synthetic payloads:

- keyed install records the signer
- rotation through a trusted signer, persisted and reloaded
- a revoked key rejected despite a valid signature
- unknown, relabeled, legacy-format, malformed, oversized and missing signatures
- tampered manifests and key sets
- manifests below the minimum sequence
- replayed older key sets
- withdrawn revocations and a lowered minimum sequence
- product mismatches
- strict key-set parsing
- conflicting or corrupt stored sets, and a newer bootstrap set
- rollback and launch refusing revoked, unsigned or below-minimum releases
- launcher resolution and refusal for modified, missing or non-executable files and invalid state
- legacy state compatibility
- automatic rollback after the start limit, with data preserved
- confirmation, stale confirmations, explicit failure, manual rollback while pending and refused reinstalls of a failed sequence
- a modified fallback failing closed
- the `SIGKILL` crash matrix above, which is skipped on Windows

`bun test tests/tooling/update-cli.test.ts` drives the same paths through the CLI with a real executable as the application (a copy of the running Bun):

- keygen, key sets and keyed signatures
- a rotation shipped with an update
- a health-limited install and the verified launch, with the environment and exit code checked
- the automatic rollback after an unconfirmed start
- a revocation that refuses the retained release
- confirm and report-unhealthy
- the compiled launcher installed by `integrate`, which starts the release and refuses a modified one

Not verified: real `native build` output, a running GPUI application calling `confirmHealthy`, macOS or Windows, and replacement of running Windows executables.
