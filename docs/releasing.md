# Releasing Bun Native desktop applications

**Status (November 12, 2026):** Linux x64 X11 has a hosted-qualified `tar.gz`/`install.sh` installer with verified keyless provenance, but no production identity-signed artifacts exist. macOS 15 ARM64 is a supported preview without Developer ID notarization; Windows is deferred ([accepted platform scope](decisions/0021-platform-release-readiness.md)). [BN6 #223](https://github.com/0xPlayerOne/bun-native/issues/223) tracks remaining packaging, signing, updates and rollback. An experimental [verified update and rollback tool](updates.md) exists for build outputs (#249). [OS code signing, notarization and installer images](#os-code-signing-notarization-and-installers) are implemented and run in hosted CI with **throwaway** identities only. No artifact has been signed with a release identity, because the project has no Apple Developer ID and no Windows code-signing certificate; the [owner steps](#configuring-release-identities-owner-steps) list exactly what that needs.

**Note (2026-11-10):** the `Code Foundry Release` workflow ([`release.yml`](../.github/workflows/release.yml)) runs Release Please on `main` only after that exact main commit's own push Validation (which includes the four CodeQL analyses) completes successfully and the commit is still the main head, and advances the preview workspace version recorded in the root [`package.json`](../package.json) and [Release Please manifest](../.release-please-manifest.json). That version release is not an application artifact. It does not qualify native windows, packaging, signing or Bun AOT. `bun scripts/package-native.ts` produces framework package sets for [standalone projects](standalone-projects.md), not signed application installers. [`release-integrity.yml`](../.github/workflows/release-integrity.yml) only checks published immutable releases. It runs on publication only when the `REQUIRE_IMMUTABLE_RELEASES` repository variable is `true` (set once an administrator enables immutable releases), or by manual dispatch for a given tag.

## Target artifacts

For each supported OS/CPU target (macOS, Windows and Linux), produce a reproducible application package containing:

- Bun-authored TS/JS application logic compiled to machine code by **`bun compile`** for that target host.
- The matching native renderer/host library, OS integration and required runtime assets.
- An exact compatibility manifest: product/package version, Bun compiler build, host ABI, renderer revision, OS/architecture, source SHA, resource inventory and hashes.
- Installer/launcher metadata and diagnostics for clean-machine behavior.

A compiled JIT bundle, build-only probe or WebView app cannot be advertised as a supported Bun Native AOT release. AOT target-host compilation may be necessary; do not assume cross-compilation works.

## Build and acceptance sequence

1. Build on each supported target host and verify real launch/input/teardown (#246). _2026-11-05: #246 is closed. [`native-platforms.yml`](../.github/workflows/native-platforms.yml) runs hosted macOS and Windows release builds with development/AOT paint, input and lifecycle checks, and the native Linux lane covers Linux. [Native platforms](native-platforms.md) gives the scope and limits. Signing and installers are [below](#os-code-signing-notarization-and-installers) (#249)._
2. Audit native dependencies, artifact size, startup, idle RSS/CPU/GPU, included assets and whether a browser/JIT payload was inadvertently bundled.
3. Produce installer/package and integrity-checked update channel; define version compatibility, rollback, interrupted install and user-state preservation (#249).
4. Exercise native capability denial, malformed events, crash reports without secrets, signed update trust and clean/offline launch (#247).
5. Publish supported/unsupported matrix and measured evidence; verify accessibility, text input and platform-specific behavior before a public quality claim (#245).

## Version and support policy

This policy applies to the experimental developer preview described in [ADR 0013](decisions/0013-release-readiness.md).

- **Versions.** The workspace version follows Release Please on `main` with [`release-please-config.json`](../release-please-config.json). Before 1.0, `bump-minor-pre-major` is set, so a breaking change raises the minor version. The [changelog](../CHANGELOG.md) lists each release's changes.
- **No API stability before 1.0.** Any release may change the public API in [`api-reference.md`](api-reference.md), the native protocol or the CLI. Release Please lists commits marked as breaking (`feat!:` or a `BREAKING CHANGE` footer) in the changelog.
- **One supported line.** Only the latest release on `main` is maintained; fixes land forward, not on earlier versions. The [compatibility matrix](compatibility.md) states which release its rows describe.
- **Exact pins.** Each release pins one Bun revision, one GPUI revision, Solid, React and one native protocol version; they are exact selections, not ranges ([exact pins](compatibility.md#exact-pins)).
- **Host and packages move together.** A prebuilt host must come from the same source as the packages that launch it. A different protocol version fails at launch with a protocol error; see [upgrade an app](getting-started.md#upgrade-an-app).
- **Prebuilt host artifacts.** CI keeps unsigned `unsigned-native-host.tar.gz` archives with SHA-256 files for 14 days in each run of the [Native Linux](../.github/workflows/native-linux.yml) and [Native Platforms](../.github/workflows/native-platforms.yml) workflows. They are evidence for that run, not published releases: a version release attaches no host, and running an archive on another machine is not exercised by CI. The Linux archive from a `main` push also carries [keyless build provenance](#linux-keyless-build-provenance). See [supply a native host](getting-started.md#2-supply-a-native-host).
- **Support claims need evidence.** A platform, service or framework capability is supported only when the compatibility matrix links native evidence for it; compile success alone is not support.

## Experimental signing policy

The owner permits autonomous experimental development and release preparation. **Unsigned** reproducible test/dev builds are acceptable when platform signing/notarization credentials are not configured. Use already-authorized project signing/publishing workflows where available; never solicit credentials as a routine milestone checkpoint or claim a missing signature passed. Production-quality signing remains explicitly unsupported until genuinely verified.

## OS code signing, notarization and installers

[`scripts/release-package.ts`](../scripts/release-package.ts) signs, verifies, packages and notarizes. The implementation is in [`scripts/native/signing.ts`](../scripts/native/signing.ts), [`scripts/native/installer-image.ts`](../scripts/native/installer-image.ts) and [`scripts/native/notarize.ts`](../scripts/native/notarize.ts). `native build` itself stays unsigned; signing is a separate release step on the target OS, because `codesign` and `signtool` exist only there.

The order matters, because every later step hashes what the earlier one produced:

```sh
bun run native build apps/my-app --host /absolute/bun-native-host --host-profile release --outdir dist
bun scripts/release-package.ts sign dist --identity IDENTITY [--keychain signing.keychain-db]
bun scripts/release-update.ts manifest dist --product dev.example.app --version 1.2.0 --sequence 12 --signed --out update.json
bun scripts/release-update.ts sign update.json --private-key /absolute/release.pem --keyed
bun scripts/release-update.ts bundle update.json --payload dist --out bundles --self-contained --key-set keys.json
bun scripts/release-package.ts sign bundles/dev.example.app-1.2.0-darwin-arm64 --identity IDENTITY
bun scripts/release-package.ts installer bundles/dev.example.app-1.2.0-darwin-arm64 --format dmg --name "Example App" --out installers --identity IDENTITY
bun scripts/release-package.ts notarize installers/dev.example.app-1.2.0-darwin-arm64.dmg
```

- **`sign DIR`** on a build output signs every native executable in it: the AOT `application` and `bun-native-host`. It refuses a build whose files no longer match `manifest.json`, an already signed build, a native executable for another OS and a symbolic link. It then rewrites `manifest.json` with the signed sizes and SHA-256 values, so the update manifest, `verifyBuildManifest` and the verifying launcher agree with the signed files. `verification.signing` records the certificate chain, team, timestamp and, for each file, its unsigned and signed digests. Signed files move from `reproducibility.deterministic` to `reproducibility.signed`; compare the recorded unsigned digests for reproducibility. On a self-contained bundle (a directory with `update.json`) it signs the compiled `bun-native-update` and `launcher`, checks that the payload still matches `update.json` before and after, writes `signing.json` and appends a line to `README.txt`.
- **macOS** runs `codesign --force --options runtime --timestamp` with the given identity (a keychain identity's SHA-1 hash or name). Bun executables (the application, updater and launcher) get [`entitlements.plist`](../scripts/native/entitlements.plist): `com.apple.security.cs.allow-jit` and `com.apple.security.cs.allow-unsigned-executable-memory`, for JavaScriptCore's executable memory. The Rust host gets the hardened runtime and no entitlements; it is the main executable of `BunNativeHost.app` in a macOS build, so it is signed and verified as that bundle, which seals the bundle's `Info.plist` and identifier (macOS serves user notifications only to a bundled process). Each file is checked with `codesign --verify --strict`, and `codesign --display` must report the `runtime` flag and, except for ad-hoc signatures, a secure timestamp.
- **Windows** runs the Windows SDK `signtool sign /fd sha256 /tr URL /td sha256` with a certificate thumbprint from `CurrentUser\My` (`--identity`), or with a signing-service library (`--dlib` and `--dlib-metadata`, for example Azure Trusted Signing). The default timestamp server is `http://timestamp.digicert.com`; `--timestamp-url` changes it. Timestamped signing is retried up to three times. Each file is checked with `signtool verify /pa /v`, which must name the chain and the timestamp.
- **`installer`** writes `<bundle>.dmg` (macOS, `hdiutil`, HFS+ and UDZO), `<bundle>.zip` (Windows) or `<bundle>.tar.gz` (Linux or macOS). Each holds the bundle unchanged (update manifest and signature, payload, compiled updater, verifying launcher and key set) plus an install script: `install.sh` (`[INSTALL_DIR] [MENU_DIR]`, defaulting to `~/Library/Application Support/<product>` and `~/Applications` on macOS, and the XDG data directory on Linux) or `install.ps1` (`-Root`, `-Menu`, defaulting to `%LOCALAPPDATA%\Programs\<product>` and the Start menu). The script runs the bundled `install` and `integrate --verified-launcher`, so an installer uses exactly the update manifest and launcher contract in [updates](updates.md). With an identity, the disk image and `install.ps1` are signed too. ZIP and tar.gz bytes are reproducible for equal input (fixed times, sorted members); disk images and signatures are not. A signed manifest needs `keys.json` in the bundle.
- **`notarize IMAGE.dmg`** submits with `xcrun notarytool submit --wait`, fetches the log and fails if the result is not `Accepted`, then runs `xcrun stapler staple` and `stapler validate`, and requires `spctl --assess --type open --context context:primary-signature` to report `source=Notarized Developer ID`. It reads an App Store Connect API key (`APPLE_NOTARY_KEY_ID`, `APPLE_NOTARY_ISSUER_ID`, `APPLE_NOTARY_PRIVATE_KEY`) or an Apple ID (`APPLE_ID`, `APPLE_TEAM_ID`, `APPLE_APP_SPECIFIC_PASSWORD`). With neither it prints `Notarization skipped:` and the reason, and exits 0. Half of either set is an error.
- **`verify PATH ...`** checks every native executable under each path with the same verification and prints the records.
- **Linux** has no OS code signature here. The Ed25519 update manifest is the trust root, and the installer is a tar.gz. The Linux host archive that CI builds on `main` carries a keyless [Sigstore build provenance attestation](#linux-keyless-build-provenance) instead; it needs no paid certificate or stored key.

[`scripts/signing/macos-identity.sh`](../scripts/signing/macos-identity.sh) and [`scripts/signing/windows-identity.ps1`](../scripts/signing/windows-identity.ps1) provision the identity. With the release secrets below they import the real certificate. Without them they create a throwaway self-signed code-signing certificate valid for two days: on macOS in a temporary keychain (untrusted, which `codesign` accepts), on Windows in `CurrentUser\My` with that one certificate trusted in the runner's `LocalMachine\Root` and `TrustedPublisher` stores so that `signtool verify /pa` can build its chain. Cleanup deletes the keychain or removes the certificate from every store.

### What CI checks

In the [Native Platforms workflow](../.github/workflows/native-platforms.yml), shard 1 of the `macos-15` and `windows-2022` jobs takes the generated Solid TypeScript template that the CLI template step built with the release host, and runs these steps:

1. **Provision a code-signing identity, throwaway unless release secrets exist.** Pull requests always get the throwaway identity; other events get the release identity when its secrets exist.
2. **Sign, bundle and package the template AOT application.** Signs the build, writes two keyed update manifests (sequences 1 and 2), creates the self-contained bundle, signs its updater and launcher, and creates the `.dmg` or `.zip`.
3. **Notarize and staple the template disk image when Apple credentials exist** (macOS). With the throwaway identity it logs a `Notarization skipped` notice with the reason.
4. **Install the signed template from its installer and confirm its health** ([`signed-installer-smoke.ts`](../scripts/quality/signed-installer-smoke.ts)). Mounts or extracts the image, requires valid signatures on the application, host, updater and launcher (and `install.ps1`), runs the image's install script, checks the installed executables and the `bin/` launcher are still validly signed, installs sequence 2 as a pending update, starts the installed launcher and waits until the application's own `reportHealthy()` is committed, then stops it. On macOS it records the Gatekeeper assessment of the application without requiring it.
5. **Remove the code-signing identity.**

The records are in the job artifact under `signed-template/`.

On Linux, shard 3 of [Native Linux](../.github/workflows/native-linux.yml) takes the same generated Solid TypeScript template, built there by the `Generated Solid and React templates in development and inspected AOT` step with the release host, and runs two gating steps. Linux has no OS code signature, so the Ed25519 update manifest and its key set are the trust root:

1. **Bundle the generated Solid template with keyed update manifests into a Linux tar.gz installer.** Creates a throwaway Ed25519 key and key set, writes and signs two keyed update manifests (sequences 1 and 2), creates the self-contained bundle and runs `release-package.ts installer --format tar.gz`.
2. **Install the Linux template from its tar.gz installer, confirm its health under Xvfb and remove it** ([`signed-installer-smoke.ts`](../scripts/quality/signed-installer-smoke.ts) with `--verify-installation --window-title 'Bun Native Solid' --uninstall`). Extracts the archive and runs its `install.sh`. The installed release must hold exactly the update manifest's files with the bundle's bytes, `bin/` must hold the bundle's verifying launcher, and the release must be trusted through the bundle's key set. The bundled updater must refuse a copy of the sequence 2 manifest altered after signing, and the installed launcher must refuse to start after one byte of the installed application changed (the byte is then restored). Sequence 2 is installed as a pending update and the installed launcher is started under Xvfb. The application's own `reportHealthy()` must be committed, the running processes must be the installed release's AOT application and host, and the window must paint, as captured from the X server. The application is then stopped, both processes must exit, and `uninstall --purge-data` must leave no installation root and no menu entry.

These records, logs and the window capture are in the `native-linux-X64-shard-3` artifact under `linux-template-installer/`. Linux `.deb` and AppImage packages are not built or covered, because the tar.gz with `install.sh` is the supported Linux platform installer. [`installer-image.test.ts`](../tests/tooling/installer-image.test.ts) covers the same installer flow with a synthetic payload on Linux, macOS and Windows in `bun test tests` (the Windows run executes `install.ps1`). [`signing.test.ts`](../tests/tooling/signing.test.ts) covers command construction, manifest rewriting, refusals, retries, output parsing and notarization with stand-in tools on every OS, and real `codesign` with an ad-hoc identity on macOS.

A passing run with the throwaway identity shows the mechanics: that the hardened runtime and entitlements still let the AOT application render and confirm its health, that Authenticode signatures and timestamps verify, and that installation keeps the signatures. It cannot show Gatekeeper acceptance, notarization or SmartScreen reputation; those need the release identities.

**Results.** On Linux x64 (pinned Bun, 2026-11-12) the two Linux steps above ran locally with their workflow commands unchanged, under Xvfb with Mesa software rendering and the release host. Packaging took 22 s. The install, update, launch, paint, health and removal check took 6 s and passed every check; the window capture had 1,275 colors. The first hosted run of these steps is the first Native Linux run that includes them. On hosted CI the macOS and Windows steps above passed with the throwaway identity in Validation runs 43087027363 (#632) and 43093920340 (main, `5642e0b`): provisioning, signing and packaging, installing the signed template and confirming its health, and removing the identity. Notarization was skipped there, as designed, because no Apple credentials exist. The ad-hoc `codesign` test and the Windows `install.ps1` run are part of `bun test tests`, which passed in the same runs' macOS and Windows Protocol and AOT jobs.

## Linux keyless build provenance

Linux has no OS code-signing authority, so the Linux artifact is signed with [Sigstore](https://www.sigstore.dev/) keyless signing through GitHub's OIDC token (#249, #223). No private key, certificate or repository secret exists, so nothing here is owner-only.

**What is signed.** On every push to `main`, shard 1 of [Native Linux](../.github/workflows/native-linux.yml) builds the release `bun-native-host`, packs the byte-stable `unsigned-native-host.tar.gz` ([reproducible builds](reproducible-builds.md)) and runs [`actions/attest-build-provenance`](https://github.com/actions/attest-build-provenance) (v4.2.2, pinned by commit) on that archive. The job's OIDC token obtains a short-lived Fulcio certificate that names the signing workflow (`.github/workflows/native-linux.yml@refs/heads/main`), the repository, the commit and the hosted runner. The SLSA v1 provenance statement over the archive's SHA-256 is signed with it, logged in the public Rekor transparency log and stored in the repository's attestations. Pull-request and scheduled builds are not attested. The archive name keeps `unsigned`: it holds no OS code signature, and the attestation travels beside it, not inside it.

**What is verified.** The same job then runs [`scripts/quality/linux-provenance.ts`](../scripts/quality/linux-provenance.ts), which calls `gh attestation verify` with the signer workflow, `--source-ref`, `--source-digest`, `--predicate-type https://slsa.dev/provenance/v1` and `--deny-self-hosted-runners`, and then rechecks the verified statement itself: a subject with the archive's SHA-256, the SLSA v1 predicate, the `native-linux.yml` signer, the repository, `refs/heads/main`, the exact commit and `github-hosted`. It uploads the archive, its `.sha256`, the Sigstore bundle (`unsigned-native-host.sigstore.json`) and the verification record as the `linux-host-provenance-X64` artifact (30 days). The [release workflow](../.github/workflows/release.yml) has a `Verify Linux host provenance` job that downloads that artifact from the exact Validation run it releases from, checks the digest and repeats the verification; **Release Please does not run unless it passes**. [`linux-provenance.test.ts`](../tests/quality/linux-provenance.test.ts) covers the command and every refusal (other bytes, signer, repository, ref, commit, runner and predicate) with a stand-in `gh`; [`release-gating.test.ts`](../tests/quality/release-gating.test.ts) pins the workflow wiring and that every caller of Native Linux grants `id-token: write` and `attestations: write`.

**Verify a downloaded archive yourself** (GitHub CLI 2.49 or later, signed in; the attestation is looked up by the archive's SHA-256):

```sh
gh attestation verify unsigned-native-host.tar.gz --repo 0xPlayerOne/bun-native \
  --signer-workflow 0xPlayerOne/bun-native/.github/workflows/native-linux.yml \
  --source-ref refs/heads/main --deny-self-hosted-runners
# or check the bundle from the artifact instead of the attestations API:
gh attestation verify unsigned-native-host.tar.gz --repo 0xPlayerOne/bun-native \
  --bundle unsigned-native-host.sigstore.json
```

Or, with the repository checked out, `bun scripts/quality/linux-provenance.ts verify /absolute/unsigned-native-host.tar.gz --repo 0xPlayerOne/bun-native --signer-workflow .github/workflows/native-linux.yml --source-ref refs/heads/main --source-digest COMMIT`.

**What it proves and what it does not.** A passing verification shows that these exact archive bytes were produced by `native-linux.yml` on a GitHub-hosted runner from the named `main` commit of this repository. It does not show that the host is free of defects, it is not an OS code signature (no Linux desktop checks one), and it does not cover the application's AOT executable or a `.tar.gz` installer from `release-package.ts installer`; those are built by the application's own release, which can attest them the same way. A version release still attaches no host (see [Version and support policy](#version-and-support-policy)).

**Results.** The unit and workflow-wiring tests pass on Linux x64 with pinned Bun (2026-11-11). On `main` at `e1b6c60`, Native Linux in Validation [43142396083](https://github.com/0xPlayerOne/bun-native/actions/runs/43142396083) attested `unsigned-native-host.tar.gz` (sha256 `eb8930dc37a6209b5338f2bd3834c82d8acf4d4f0e5579e11792b48d36bab426`, Rekor log index 3822959972) and verified it in the job against the `native-linux.yml` signer, `refs/heads/main` and that commit; the release workflow run [43145047946](https://github.com/0xPlayerOne/bun-native/actions/runs/43145047946) verified the checksum and provenance again before Release Please.

### What remains owner-only

These need credentials that only the repository owner can obtain; the repository already consumes them when present ([owner steps](#configuring-release-identities-owner-steps)):

- **macOS Developer ID signing and notarization**: an Apple Developer Program membership, a Developer ID Application certificate and App Store Connect (or Apple ID) notarization credentials. Until they exist, CI signs with a throwaway identity and macOS builds are ad-hoc or throwaway signed; Gatekeeper and notarization are unverified.
- **Windows Authenticode**: an OV/EV certificate, Azure Trusted Signing account or hardware token. Windows release readiness also waits on [#629](https://github.com/0xPlayerOne/bun-native/issues/629).
- **The Ed25519 update-manifest release key** for a real application channel: a key the application owner generates and keeps; the repository has no release signing key and no CI secret for one.

Linux provenance needs none of these.

## Release host archives

Every version release carries the unsigned release host for each released
platform, so an application can run against a host that matches its packages
without building one. The [release workflow](../.github/workflows/release.yml)'s
`Attach release host archives` job runs after Release Please creates a release.
It downloads the four `native-host-<OS>-<arch>` artifacts from the exact
Validation run it releases from: Linux x64 from [Native Linux](../.github/workflows/native-linux.yml),
macOS ARM64 from [Native macOS and Windows](../.github/workflows/native-platforms.yml),
and Linux ARM64 and macOS x64 from [Native Linux ARM64 and macOS x64](../.github/workflows/native-architectures.yml).
It checks each archive against the digest its build job recorded and attaches it
as `bun-native-host-<platform>-<arch>.tar.gz` (`linux-x64`, `linux-arm64`,
`darwin-arm64`, `darwin-x64`), with a `SHA256SUMS` file. A missing archive or a
digest mismatch fails the job. Windows is deferred ([ADR 0021](decisions/0021-platform-release-readiness.md)).

The Linux x64 archive is the one whose keyless provenance the release workflow
verified ([above](#linux-keyless-build-provenance)), so `gh attestation verify`
works on the downloaded asset. The other three carry no attestation yet, and no
archive carries an OS code signature: macOS hosts are unsigned until a Developer
ID exists. `bun run native host install` and `--host auto`
([developer tooling](developer-tooling.md#released-hosts)) download these assets.

## npm packages

The same release publishes the seven `@bun-native` packages (`cli`, `core`,
`protocol`, `react`, `renderer`, `runtime`, `solid`) to npm, all at the
workspace version. The `Publish @bun-native packages to npm` job checks out the
release tag, produces the verified [local package set](standalone-projects.md)
with [`scripts/package-native.ts`](../scripts/package-native.ts), and turns it into
public packages with [`scripts/registry-packages.ts`](../scripts/registry-packages.ts).
That script changes only `package.json` (no `private`, the release version, the
same version for every `@bun-native` dependency, repository metadata and
`publishConfig`) and the README. It then publishes dependencies before
dependents and skips any version already on npm, so a re-run after a partial
publish completes the set.

Publishing uses npm **trusted publishing**: npm exchanges the job's GitHub OIDC
token for a short-lived credential, and every package gets npm provenance. No npm
token is stored anywhere. Each package needs a trusted publisher on npmjs.com
with organization or user `0xPlayerOne`, repository `bun-native`, workflow
filename `release.yml`, no environment, and direct `npm publish` allowed. npm
requires a package to exist before a trusted publisher can be added, so each
name was first published once by the owner as a `0.0.0-bootstrap.0` placeholder.

## Configuring release identities (owner steps)

Nothing in the repository changes when these are added. Store each value as a repository secret (**Settings → Secrets and variables → Actions → New repository secret**, or `gh secret set NAME --repo 0xPlayerOne/bun-native`). [`bun-native.yml`](../.github/workflows/bun-native.yml) passes them to Native Platforms, which uses them for pushes and manual runs, never for pull requests.

### macOS: Developer ID Application certificate and notarization

1. Enroll in the [Apple Developer Program](https://developer.apple.com/programs/) (individual or organization). Only the team's Account Holder can create Developer ID certificates.
2. On a Mac, create the certificate: Xcode → Settings → Accounts → select the team → Manage Certificates → **+** → **Developer ID Application**. (Alternatively create a certificate signing request in Keychain Access and upload it under developer.apple.com → Certificates → **+** → Developer ID Application.)
3. In Keychain Access → login → My Certificates, select **Developer ID Application: NAME (TEAMID)** with its private key, choose File → Export Items, save it as `developer-id.p12` and set a strong export password.
4. Create the two signing secrets:
   - `APPLE_DEVELOPER_ID_P12_BASE64`: the output of `base64 -i developer-id.p12`
   - `APPLE_DEVELOPER_ID_P12_PASSWORD`: the export password
5. Create notarization credentials. Preferred, an App Store Connect API key: App Store Connect → Users and Access → Integrations → App Store Connect API → Team Keys → **+**, role **Developer**. Download `AuthKey_KEYID.p8` (it can be downloaded only once) and create:
   - `APPLE_NOTARY_KEY_ID`: the key ID
   - `APPLE_NOTARY_ISSUER_ID`: the issuer ID shown above the key list
   - `APPLE_NOTARY_PRIVATE_KEY`: the full text of the `.p8` file, including the `BEGIN` and `END` lines

   Or, instead, an Apple ID: create an app-specific password at account.apple.com → Sign-In and Security → App-Specific Passwords, and create `APPLE_ID` (the Apple ID email), `APPLE_TEAM_ID` (the 10-character team ID) and `APPLE_APP_SPECIFIC_PASSWORD`. Set one complete set, never half of one.

6. Delete the local `developer-id.p12` and `.p8` copies, or keep them in a password manager.
7. Run the workflow on `main`: `gh workflow run native-platforms.yml --repo 0xPlayerOne/bun-native --ref main`. In the macOS shard 1 job, step 1 must print `Provisioned release identity 'Developer ID Application: …'`, step 3 must end with `"status": "accepted"` and `source=Notarized Developer ID`, and step 4 must pass. `signed-template/install-smoke.json` then records the Developer ID chain.

### Windows: Authenticode

Since June 2023 the CA/Browser Forum requires the private key of a publicly trusted OV or EV code-signing certificate to stay in a hardware token or HSM, so a newly bought certificate usually cannot be exported as a `.pfx`. Choose one route:

1. **A certificate with an exportable key** (for example one issued before that rule, or one a provider delivers as a `.pfx`): create
   - `WINDOWS_CODESIGN_PFX_BASE64`: the output of `[Convert]::ToBase64String([IO.File]::ReadAllBytes('codesign.pfx'))` in PowerShell
   - `WINDOWS_CODESIGN_PFX_PASSWORD`: the `.pfx` password

   Then run the workflow as in macOS step 7. In the Windows shard 1 job, step 1 must print `Provisioned release certificate CN=…` with the publisher's name, and step 4 must pass.

2. **Azure Trusted Signing** (Microsoft's managed service; the key never leaves Azure): create a Trusted Signing account and a Public Trust certificate profile, complete identity validation, and give an Entra ID app registration the _Trusted Signing Certificate Profile Signer_ role on the profile. Signing then runs `bun scripts/release-package.ts sign DIR --dlib PATH\Azure.CodeSigning.Dlib.dll --dlib-metadata metadata.json --timestamp-url http://timestamp.acs.microsoft.com` with `AZURE_TENANT_ID`, `AZURE_CLIENT_ID` and `AZURE_CLIENT_SECRET` in the environment. The `--dlib` path is unit-tested for its `signtool` arguments only. The workflow does not install the Trusted Signing client yet, so this route needs one more workflow step and has not run.
3. **A hardware token (OV or EV)**: sign on a Windows machine with the token attached, using `--identity` with the certificate's thumbprint. Hosted CI cannot use a token.

An EV certificate or Trusted Signing gives immediate SmartScreen reputation; an OV certificate builds reputation with downloads. Neither has been tested here.

### Still not covered by any identity

- A macOS `.app` bundle that holds the release itself, `.pkg` installers, Finder drag-and-drop installation and a Gatekeeper run on a downloaded (quarantined) image. The disk image holds the bundle and `install.sh`, and `integrate` creates an unsigned script wrapper `.app` locally.
- MSI or MSIX packages, `.lnk` shortcuts and replacing a running Windows executable.
- Linux `.deb`, AppImage and package-repository signatures; the tar.gz with `install.sh` is the supported Linux platform installer.
- Clean physical machines; the CI evidence is from hosted runners.

Do not deploy or modify Adea production as a side effect of making Bun Native examples.

## Updates and rollback

Update manifests must be authenticated by a configured trust root, not just a checksum downloaded beside the payload. Stage to a private location, verify exact artifact identity and compatibility, replace atomically where supported, recover from interruption and preserve local user data. Native ABI mismatches must fail safely rather than continue with undefined behavior.

The current experimental implementation and its tested cases are documented in [updates](updates.md).

## Release decision

BN7 decides **which feature/platform scope is ready to ship**, not whether Bun Native should replace Bunly. Keep real unmet signing, text/IME, accessibility or security requirements visible in support policy. Quality checks are autonomous technical verification, never an owner go/no-go checkpoint.

Read [toolchain](toolchain.md), [testing](testing.md), [compatibility](compatibility.md) and [engineering-quality](engineering-quality.md).
