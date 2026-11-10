# Releasing Bun Native desktop applications

**Status:** Distribution is a design target; there are no qualified Bun Native installers or signed production artifacts yet. [BN6 #223](https://github.com/0xPlayerOne/bun-native/issues/223) owns real packaging, signing, updates and rollback. An experimental [verified update and rollback tool](updates.md) exists for build outputs (#249); platform installers, OS code signing and notarization remain unimplemented.

**Note (2026-11-10):** the `Code Foundry Release` workflow ([`release.yml`](../.github/workflows/release.yml)) runs Release Please on `main` only after that exact main commit's own push Validation (which includes the four CodeQL analyses) completes successfully and the commit is still the main head, and advances the preview workspace version recorded in the root [`package.json`](../package.json) and [Release Please manifest](../.release-please-manifest.json). That version release is not an application artifact. It does not qualify native windows, packaging, signing or Bun AOT. `bun scripts/package-native.ts` produces framework package sets for [standalone projects](standalone-projects.md), not signed application installers. [`release-integrity.yml`](../.github/workflows/release-integrity.yml) only checks published immutable releases. It runs on publication only when the `REQUIRE_IMMUTABLE_RELEASES` repository variable is `true` (set once an administrator enables immutable releases), or by manual dispatch for a given tag.

## Target artifacts

For each supported OS/CPU target (macOS, Windows and Linux), produce a reproducible application package containing:

- Bun-authored TS/JS application logic compiled to machine code by **`bun compile`** for that target host.
- The matching native renderer/host library, OS integration and required runtime assets.
- An exact compatibility manifest: product/package version, Bun compiler build, host ABI, renderer revision, OS/architecture, source SHA, resource inventory and hashes.
- Installer/launcher metadata and diagnostics for clean-machine behavior.

A compiled JIT bundle, build-only probe or WebView app cannot be advertised as a supported Bun Native AOT release. AOT target-host compilation may be necessary; do not assume cross-compilation works.

## Build and acceptance sequence

1. Build on each supported target host and verify real launch/input/teardown (#246). _2026-11-05: #246 is closed. [`native-platforms.yml`](../.github/workflows/native-platforms.yml) runs hosted macOS and Windows release builds with development/AOT paint, input and lifecycle checks, and the native Linux lane covers Linux. [Native platforms](native-platforms.md) gives the scope and limits. Signing and installers remain under #249._
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

Do not deploy or modify Adea production as a side effect of making Bun Native examples.

## Updates and rollback

Update manifests must be authenticated by a configured trust root, not just a checksum downloaded beside the payload. Stage to a private location, verify exact artifact identity and compatibility, replace atomically where supported, recover from interruption and preserve local user data. Native ABI mismatches must fail safely rather than continue with undefined behavior.

The current experimental implementation and its tested cases are documented in [updates](updates.md).

## Release decision

BN7 decides **which feature/platform scope is ready to ship**, not whether Bun Native should replace Bunly. Keep real unmet signing, text/IME, accessibility or security requirements visible in support policy. Quality checks are autonomous technical verification, never an owner go/no-go checkpoint.

Read [toolchain](toolchain.md), [testing](testing.md), [compatibility](compatibility.md) and [engineering-quality](engineering-quality.md).
