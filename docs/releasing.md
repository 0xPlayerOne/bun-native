# Releasing Bun Native desktop applications

**Status:** Distribution is a design target; there are no qualified Bun Native installers or signed production artifacts yet. [BN6 #223](https://github.com/0xPlayerOne/bun-native/issues/223) owns real packaging, signing, updates and rollback.

## Target artifacts

For each supported OS/CPU target (macOS, Windows and Linux), produce a reproducible application package containing:

- Bun-authored TS/JS application logic compiled to machine code by **`bun compile`** for that target host.
- The matching native renderer/host library, OS integration and required runtime assets.
- An exact compatibility manifest: product/package version, Bun compiler build, host ABI, renderer revision, OS/architecture, source SHA, resource inventory and hashes.
- Installer/launcher metadata and diagnostics for clean-machine behavior.

A compiled JIT bundle, build-only probe or WebView app cannot be advertised as a supported Bun Native AOT release. AOT target-host compilation may be necessary; do not assume cross-compilation works.

## Build and acceptance sequence

1. Build on each supported target host and verify real launch/input/teardown (#246).
2. Audit native dependencies, artifact size, startup, idle RSS/CPU/GPU, included assets and whether a browser/JIT payload was inadvertently bundled.
3. Produce installer/package and integrity-checked update channel; define version compatibility, rollback, interrupted install and user-state preservation (#249).
4. Exercise native capability denial, malformed events, crash reports without secrets, signed update trust and clean/offline launch (#247).
5. Publish supported/unsupported matrix and measured evidence; verify accessiblity, text input and platform-specific behavior before a public quality claim (#245).

## Experimental signing policy

The owner permits autonomous experimental development and release preparation. **Unsigned** reproducible test/dev builds are acceptable when platform signing/notarization credentials are not configured. Use already-authorized project signing/publishing workflows where available; never solicit credentials as a routine milestone checkpoint or claim a missing signature passed. Production-quality signing remains explicitly unsupported until genuinely verified.

Do not deploy or modify Adea production as a side effect of making Bun Native examples.

## Updates and rollback

Update manifests must be authenticated by a configured trust root, not just a checksum downloaded beside the payload. Stage to a private location, verify exact artifact identity and compatibility, replace atomically where supported, recover from interruption and preserve local user data. Native ABI mismatches must fail safely rather than continue with undefined behavior.

## Release decision

BN7 decides **which feature/platform scope is ready to ship**, not whether Bun Native should replace Bunly. Keep real unmet signing, text/IME, accessibility or security requirements visible in support policy. Quality checks are autonomous technical verification, never an owner go/no-go checkpoint.

Read [toolchain](toolchain.md), [testing](testing.md), [compatibility](compatibility.md) and [engineering-quality](engineering-quality.md).
