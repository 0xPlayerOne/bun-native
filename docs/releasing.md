# Releasing Bun Native desktop applications

**Status:** Distribution is a design target; there are no qualified Bun Native installers or signed production artifacts yet. [BN6 #223](https://github.com/0xPlayerOne/bun-native/issues/223) owns real packaging, signing, updates and rollback. An experimental [verified update and rollback tool](updates.md) exists for build outputs (#249). [OS code signing, notarization and installer images](#os-code-signing-notarization-and-installers) are implemented and run in hosted CI with **throwaway** identities only. No artifact has been signed with a release identity, because the project has no Apple Developer ID and no Windows code-signing certificate; the [owner steps](#configuring-release-identities-owner-steps) list exactly what that needs.

**Note (2026-11-10):** the `Code Foundry Release` workflow ([`release.yml`](../.github/workflows/release.yml)) runs Release Please on `main` only after that exact main commit's own push Validation (which includes the four CodeQL analyses) completes successfully and the commit is still the main head, and sets the workspace version (0.27.2 at the time of writing; the root `package.json` is authoritative). That version release is not an application artifact. It does not qualify native windows, packaging, signing or Bun AOT. `bun scripts/package-native.ts` produces framework package sets for [standalone projects](standalone-projects.md), not signed application installers. [`release-integrity.yml`](../.github/workflows/release-integrity.yml) only checks published immutable releases. It runs on publication only when the `REQUIRE_IMMUTABLE_RELEASES` repository variable is `true` (set once an administrator enables immutable releases), or by manual dispatch for a given tag.

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
- **Prebuilt host artifacts.** CI keeps unsigned `unsigned-native-host.tar.gz` archives with SHA-256 files for 14 days in each run of the [Native Linux](../.github/workflows/native-linux.yml) and [Native Platforms](../.github/workflows/native-platforms.yml) workflows. They are evidence for that run, not published releases: a version release attaches no host, and running an archive on another machine is not exercised by CI. See [supply a native host](getting-started.md#2-supply-a-native-host).
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
- **macOS** runs `codesign --force --options runtime --timestamp` with the given identity (a keychain identity's SHA-1 hash or name). Bun executables (the application, updater and launcher) get [`entitlements.plist`](../scripts/native/entitlements.plist): `com.apple.security.cs.allow-jit` and `com.apple.security.cs.allow-unsigned-executable-memory`, for JavaScriptCore's executable memory. The Rust host gets the hardened runtime and no entitlements. Each file is checked with `codesign --verify --strict`, and `codesign --display` must report the `runtime` flag and, except for ad-hoc signatures, a secure timestamp.
- **Windows** runs the Windows SDK `signtool sign /fd sha256 /tr URL /td sha256` with a certificate thumbprint from `CurrentUser\My` (`--identity`), or with a signing-service library (`--dlib` and `--dlib-metadata`, for example Azure Trusted Signing). The default timestamp server is `http://timestamp.digicert.com`; `--timestamp-url` changes it. Timestamped signing is retried up to three times. Each file is checked with `signtool verify /pa /v`, which must name the chain and the timestamp.
- **`installer`** writes `<bundle>.dmg` (macOS, `hdiutil`, HFS+ and UDZO), `<bundle>.zip` (Windows) or `<bundle>.tar.gz` (Linux or macOS). Each holds the bundle unchanged (update manifest and signature, payload, compiled updater, verifying launcher and key set) plus an install script: `install.sh` (`[INSTALL_DIR] [MENU_DIR]`, defaulting to `~/Library/Application Support/<product>` and `~/Applications` on macOS, and the XDG data directory on Linux) or `install.ps1` (`-Root`, `-Menu`, defaulting to `%LOCALAPPDATA%\Programs\<product>` and the Start menu). The script runs the bundled `install` and `integrate --verified-launcher`, so an installer uses exactly the update manifest and launcher contract in [updates](updates.md). With an identity, the disk image and `install.ps1` are signed too. ZIP and tar.gz bytes are reproducible for equal input (fixed times, sorted members); disk images and signatures are not. A signed manifest needs `keys.json` in the bundle.
- **`notarize IMAGE.dmg`** submits with `xcrun notarytool submit --wait`, fetches the log and fails if the result is not `Accepted`, then runs `xcrun stapler staple` and `stapler validate`, and requires `spctl --assess --type open --context context:primary-signature` to report `source=Notarized Developer ID`. It reads an App Store Connect API key (`APPLE_NOTARY_KEY_ID`, `APPLE_NOTARY_ISSUER_ID`, `APPLE_NOTARY_PRIVATE_KEY`) or an Apple ID (`APPLE_ID`, `APPLE_TEAM_ID`, `APPLE_APP_SPECIFIC_PASSWORD`). With neither it prints `Notarization skipped:` and the reason, and exits 0. Half of either set is an error.
- **`verify PATH ...`** checks every native executable under each path with the same verification and prints the records.
- **Linux** has no OS code signature here. The Ed25519 update manifest is the trust root, and the installer is a tar.gz.

[`scripts/signing/macos-identity.sh`](../scripts/signing/macos-identity.sh) and [`scripts/signing/windows-identity.ps1`](../scripts/signing/windows-identity.ps1) provision the identity. With the release secrets below they import the real certificate. Without them they create a throwaway self-signed code-signing certificate valid for two days: on macOS in a temporary keychain (untrusted, which `codesign` accepts), on Windows in `CurrentUser\My` with that one certificate trusted in the runner's `LocalMachine\Root` and `TrustedPublisher` stores so that `signtool verify /pa` can build its chain. Cleanup deletes the keychain or removes the certificate from every store.

### What CI checks

In the [Native Platforms workflow](../.github/workflows/native-platforms.yml), shard 1 of the `macos-15` and `windows-2022` jobs takes the generated Solid TypeScript template that the CLI template step built with the release host, and runs these steps:

1. **Provision a code-signing identity, throwaway unless release secrets exist.** Pull requests always get the throwaway identity; other events get the release identity when its secrets exist.
2. **Sign, bundle and package the template AOT application.** Signs the build, writes two keyed update manifests (sequences 1 and 2), creates the self-contained bundle, signs its updater and launcher, and creates the `.dmg` or `.zip`.
3. **Notarize and staple the template disk image when Apple credentials exist** (macOS). With the throwaway identity it logs a `Notarization skipped` notice with the reason.
4. **Install the signed template from its installer and confirm its health** ([`signed-installer-smoke.ts`](../scripts/quality/signed-installer-smoke.ts)). Mounts or extracts the image, requires valid signatures on the application, host, updater and launcher (and `install.ps1`), runs the image's install script, checks the installed executables and the `bin/` launcher are still validly signed, installs sequence 2 as a pending update, starts the installed launcher and waits until the application's own `reportHealthy()` is committed, then stops it. On macOS it records the Gatekeeper assessment of the application without requiring it.
5. **Remove the code-signing identity.**

The records are in the job artifact under `signed-template/`. The Linux path of the same installer flow (tar.gz, no OS signature) is covered by [`installer-image.test.ts`](../tests/tooling/installer-image.test.ts), which also runs on macOS and Windows in `bun test tests` (the Windows run executes `install.ps1`). [`signing.test.ts`](../tests/tooling/signing.test.ts) covers command construction, manifest rewriting, refusals, retries, output parsing and notarization with stand-in tools on every OS, and real `codesign` with an ad-hoc identity on macOS.

A passing run with the throwaway identity shows the mechanics: that the hardened runtime and entitlements still let the AOT application render and confirm its health, that Authenticode signatures and timestamps verify, and that installation keeps the signatures. It cannot show Gatekeeper acceptance, notarization or SmartScreen reputation; those need the release identities.

**Results.** On Linux x64 (pinned Bun, 2026-11-11) the unit tests passed and the same packaging sequence ran with the generated Solid template and the release host: tar.gz installer, install script, pending update and a health confirmation through the installed verifying launcher under Xvfb (no OS signature on Linux). The macOS and Windows steps above, the ad-hoc `codesign` test and the Windows `install.ps1` run have **not run yet**; they first run in hosted CI after this change is pushed.

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
- Linux `.deb`, AppImage and package-repository signatures.
- Clean physical machines; the CI evidence is from hosted runners.

Do not deploy or modify Adea production as a side effect of making Bun Native examples.

## Updates and rollback

Update manifests must be authenticated by a configured trust root, not just a checksum downloaded beside the payload. Stage to a private location, verify exact artifact identity and compatibility, replace atomically where supported, recover from interruption and preserve local user data. Native ABI mismatches must fail safely rather than continue with undefined behavior.

The current experimental implementation and its tested cases are documented in [updates](updates.md).

## Release decision

BN7 decides **which feature/platform scope is ready to ship**, not whether Bun Native should replace Bunly. Keep real unmet signing, text/IME, accessibility or security requirements visible in support policy. Quality checks are autonomous technical verification, never an owner go/no-go checkpoint.

Read [toolchain](toolchain.md), [testing](testing.md), [compatibility](compatibility.md) and [engineering-quality](engineering-quality.md).
