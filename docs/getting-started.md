# Getting started with Bun Native

**Bun Native is not installable as a working desktop framework yet.** This guide is for contributors and coding agents implementing the direct rewrite. It must not pretend the old Bunly 0.6.9 CEF scripts create a Bun Native app.

## Start with the current implementation task

1. Read the [vision](bun-native-vision.md), [architecture](architecture.md), [engineering-quality policy](engineering-quality.md) and [roadmap](https://github.com/0xPlayerOne/bun-native/issues/1).
2. Start [BN0 #217](https://github.com/0xPlayerOne/bun-native/issues/217). [#251](https://github.com/0xPlayerOne/bun-native/issues/251) replaces legacy source, scripts and CI; [#225](https://github.com/0xPlayerOne/bun-native/issues/225) pins the _actual_ Bun AOT, GPUI and Rust toolchains. They can proceed in parallel.
3. Inspect the current checkout/branch and any existing PRs. Do not assume obsolete Bun 1.4.4 versions, M1 tests or CEF run commands apply to the new framework.
4. Open a draft PR with the first useful change, push continuously, run focused tests and enable auto-merge when repository checks permit. No routine human design checkpoint is required.

## Toolchains

You need Bun, a matching target OS/architecture, Rust toolchain/native renderer build prerequisites for **framework contributors**, and GitHub-hosted CI or a supported native desktop for verification. Pin exact versions in #225 rather than copying version numbers from legacy Bunly documents.

The **new** developer command contract (create/dev/build/test/doctor) is designed in [BN5 #242](https://github.com/0xPlayerOne/bun-native/issues/242) and **does not exist yet**. Avoid showing fictional install commands or framework imports as runnable examples.

To learn the compiler interface, see the official [Bun compiler documentation](https://bun.com/docs/compiler) and [AOT compatibility](https://bun.com/docs/compiler/compatibility). `bun compile` differs from `bun build --compile`: the latter is an ordinary bundled JIT executable and is not accepted as a Bun Native production AOT proof.

## First actual app acceptance

The first example, owned by #230 and #227, must:

- Launch a **real native GPU/OS window**, with text, a button and editable input, controlled by Bun-authored TypeScript.
- Send click/keyboard/focus events through the native bridge, update visible UI, close cleanly and repeat without leaked callbacks.
- Run under normal Bun development mode and a separately verified machine-code AOT executable built from the same source.
- Record OS/CPU/GPU, Bun and native renderer revisions, source commit, exact command, artifact bytes, memory/startup measurements and failures.
- Contain no Chromium, CEF or system WebView UI fallback.

Do not wait for a human feasibility vote if interop fails. Reproduce, fix or take another genuinely native implementation route and keep building.

## Test locations

Use GitHub Actions Linux/Windows/macOS runners first. For actual macOS GUI, keyboard, text/IME or accessibility testing that hosted runners cannot prove, discover the owner's connected Mac through Remote Desktop Commander. Keep temporary work bounded and avoid persistent Docker/VM disks on the Mac. Label unavailable physical tests **unsupported**, never passed.

## After BN0

- [BN1](https://github.com/0xPlayerOne/bun-native/issues/219): typed native bridge and public API.
- [BN2](https://github.com/0xPlayerOne/bun-native/issues/218): SolidJS renderer.
- [BN3](https://github.com/0xPlayerOne/bun-native/issues/221): React renderer.
- [BN4](https://github.com/0xPlayerOne/bun-native/issues/222): shared native primitives, OS capabilities and accessibility.
- [BN5](https://github.com/0xPlayerOne/bun-native/issues/220): supported app authoring CLI, fast reload, CI.
- [BN6](https://github.com/0xPlayerOne/bun-native/issues/223): native packages, updates, rollback.
- [BN7](https://github.com/0xPlayerOne/bun-native/issues/224): real app compatibility, performance and public documentation.

An agent assigned any later milestone should verify prerequisites and implement missing dependencies itself rather than ask the owner for a checkpoint.
