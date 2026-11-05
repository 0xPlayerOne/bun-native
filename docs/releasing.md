# Releasing Bun Native desktop applications

**Status:** Distribution is a design target; there are no qualified Bun Native installers or signed production artifacts yet. [BN6 #223](https://github.com/0xPlayerOne/bun-native/issues/223) owns real packaging, signing, updates and rollback.

**Note (2026-11-05):** the `Code Foundry Release` workflow ([`release.yml`](../.github/workflows/release.yml)) runs Release Please on `main` and sets the workspace version (currently `0.19.0`). That version release is not an application artifact. It does not qualify native windows, packaging, signing or Bun AOT. `bun scripts/package-native.ts` produces framework package sets for [standalone projects](standalone-projects.md), not signed application installers. [`release-integrity.yml`](../.github/workflows/release-integrity.yml) only checks published immutable releases, and only once an administrator enables that setting.

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

## Experimental signing policy

The owner permits autonomous experimental development and release preparation. **Unsigned** reproducible test/dev builds are acceptable when platform signing/notarization credentials are not configured. Use already-authorized project signing/publishing workflows where available; never solicit credentials as a routine milestone checkpoint or claim a missing signature passed. Production-quality signing remains explicitly unsupported until genuinely verified.

Do not deploy or modify Adea production as a side effect of making Bun Native examples.

## Updates and rollback

Update manifests must be authenticated by a configured trust root, not just a checksum downloaded beside the payload. Stage to a private location, verify exact artifact identity and compatibility, replace atomically where supported, recover from interruption and preserve local user data. Native ABI mismatches must fail safely rather than continue with undefined behavior.

## Release decision

BN7 decides **which feature/platform scope is ready to ship**, not whether Bun Native should replace Bunly. Keep real unmet signing, text/IME, accessibility or security requirements visible in support policy. Quality checks are autonomous technical verification, never an owner go/no-go checkpoint.

Read [toolchain](toolchain.md), [testing](testing.md), [compatibility](compatibility.md) and [engineering-quality](engineering-quality.md).
