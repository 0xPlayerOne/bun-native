# Reproducible builds

**Status:** experimental. This records which Bun Native build outputs are byte-for-byte reproducible today, how that is checked, and what is still open. It is part of [BN6 #223](https://github.com/0xPlayerOne/bun-native/issues/223) and [#246](https://github.com/0xPlayerOne/bun-native/issues/246). Nothing here is signed; see [releasing](releasing.md).

"Reproducible" means equal inputs (source tree, `toolchain.json` pins, `Cargo.lock`/`bun.lock`, and the same OS/CPU target) produce identical bytes, regardless of checkout location, output directory, process working directory, build time or file mtimes.

## Summary

| Output                                                                      | Status                                                   | How it is checked                                                                                      |
| --------------------------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `bun-native build`: AOT `application` executable                            | Reproducible (same target)                               | `tests/tooling/build-reproducibility.test.ts` (two clean builds, compared)                             |
| `bun-native build`: `development/application.js` and `.js.map`              | Reproducible (fixed)                                     | Same test; the module previously embedded the caller's working directory                               |
| `bun-native build`: `launcher.ts`, bundled host copy                        | Reproducible                                             | Same test                                                                                              |
| `bun-native build`: `manifest.json`                                         | Reproducible (fixed)                                     | Same test; it previously held absolute paths and wall-clock timing                                     |
| `bun-native build`: `build-metrics.json`, `compile-aot.*.log`               | Not reproducible, by design                              | Declared under `manifest.reproducibility.diagnostics`                                                  |
| `scripts/package-native.ts` source package set (`archives/*.tgz`, manifest) | Reproducible                                             | Two runs into different output directories produced identical archives and manifest (manual, recorded) |
| `scripts/package-native.ts` `logs/`                                         | Not reproducible, by design                              | They record absolute commands and output                                                               |
| CI `unsigned-native-host.tar.gz`                                            | Reproducible (fixed)                                     | `tests/tooling/host-archive.test.ts`, and the Linux native job repacks and `cmp`s                      |
| Release `bun-native-host` (Cargo) on one machine, different dirs and times  | Reproducible (fixed)                                     | Manual two-build comparison                                                                            |
| Release `bun-native-host` across machines with different `CARGO_HOME`       | Fixed in CI with path remapping                          | Linux, macOS and Windows: two independent hosted runners identical (`host-reproducibility.yml`)        |
| Release `bun-native-host` on macOS                                          | Reproducible only for the same absolute target directory | Two clean builds on a Mac; see [macOS qualification](macos-qualification.md)                           |
| Across OS/CPU targets                                                       | Not applicable                                           | Each target has its own binaries; compare only within a target                                         |

## Causes found and fixes

### AOT application package (`bun-native build`)

Two builds of the same generated Solid app, from different project directories, output directories and working directories, were compared file by file. The AOT executable, the copied host and `launcher.ts` already matched. Three files differed:

1. **`development/application.js`.** `Bun.build` names each module in a `// path` comment relative to the **process working directory**, not to its `root` option. The same project built from the checkout root and from another directory produced different bytes, and so did a different source map `debugId`. `bundleProject` now runs the bundler with the working directory set to the project, so the comments are project-relative (for example `// main.tsx`). The production AOT executable was not affected: its minified program has no such comments.
2. **`manifest.json`.** It held the absolute launcher and output paths, the absolute compiler path, and `buildMs`. The compile command now records the compiler as `bun` and other paths relative to the artifact directory. The compiler is identified by `application.compiler` (`revision` and the executable's SHA-256), which is a stronger identity than an install path. Compile time moved to `build-metrics.json`.
3. **Compiler logs.** `compile-aot.stdout.log` contains timings and absolute paths. They remain diagnostics.

The manifest now also records digests for `development/application.js.map` (`sourceMap`) and `launcher.ts` (`launcher`), and lists its file classes under `reproducibility.deterministic` and `reproducibility.diagnostics`. The regression test asserts that the output directory contains exactly those files and that every deterministic file is byte-identical between the two builds. Disabling the working-directory anchor makes it fail on `development/application.js`.

Source map `sources` are relative to the map file. A project with its dependencies inside it (a standalone project) is therefore location-independent. A project inside the checkout records its position relative to the checkout's `packages/`, which is part of its input. Building into an output directory at a different depth relative to the sources changes the map. Use the default `dist` directory, or the same relative output path, when comparing builds.

### Native host archive (CI)

The workflows packed the release host with the platform `tar -czf`. That stores the file's mtime, the runner's uid/gid and user names, and a gzip header that varies by platform, so equal executables produced different archives. `scripts/native/host-archive.ts` writes a minimal USTAR archive instead. Members are sorted with mode `0755`, uid/gid `0` and no user names, and their mtime is taken from `SOURCE_DATE_EPOCH` (the workflows use the commit time). The gzip header has a zero MTIME, no file name and OS byte `255`. The Linux native job packs the host, repacks a copy from another directory with a different mtime, and fails if the bytes differ. A golden-digest unit test catches packer, header or zlib changes.

### Release native host (Cargo)

`[profile.release]` already uses `codegen-units = 1`, thin LTO and `strip = "debuginfo"`, and the build is `--locked`. Workspace sources are compiled with relative paths. A scan of a release `bun-native-host` found no checkout or target-directory paths, but about 900 strings starting with `CARGO_HOME`, such as `/root/.cargo/registry/src/index.crates.io-…/…` and `/root/.cargo/git/checkouts/zed-…/…`. These are panic locations in dependency code, and they change with the build user's home directory: `/home/runner` on Linux runners, `/Users/runner` on macOS and `C:\Users\runneradmin` on Windows.

Cargo's `trim-paths` profile option is still unstable on the pinned toolchain, so the native workflows set `CARGO_ENCODED_RUSTFLAGS=--remap-path-prefix=<CARGO_HOME>=/cargo` before any Cargo build. A probe crate with a registry dependency, built under two different `CARGO_HOME` directories, produced different binaries without the flag and identical binaries with it, with no home path left in either.

**Compile-time randomness (fixed).** Two clean `cargo build --locked --release -p bun-native-host` runs from one commit, using the same `CARGO_HOME` but different source and target directories, produced **different** hosts: `d1b9bf50…` (30,734,080 bytes) and `7cc3551c…` (30,734,096 bytes). The strings diff contained no path. The differences were ThinLTO promoted-symbol suffixes (`….llvm.<module hash>`) on about 32 `gpui_linux` symbols. Disassembling the `gpui_linux` bitcode from both target directories with the toolchain's `llvm-dis` showed exactly one differing definition: a private 64-byte constant. That constant is ahash's fixed hasher seeds. GPUI's XIM client (`zed-xim`) enables ahash `compile-time-rng`, so `const-random` generated new seeds with `getrandom` on every compile. The change in that constant also changed the module hash and therefore every promoted symbol name.

`.cargo/config.toml` sets `CONST_RANDOM_SEED`, which `const-random-macro` reads through `option_env!`. The seed derivation becomes a deterministic hash of that value and the macro call site. Without other randomness, a public seed would make those hasher keys predictable, so `native/gpui-host` also unifies ahash's `runtime-rng` feature (Linux only). `RandomState::new` then mixes per-process `getrandom` keys in at runtime. After the change, two fresh clean builds in the same two layouts produced byte-identical hosts: `99b677e0…`, 30,739,832 bytes each (Linux x64, pinned Rust 1.98.1, 2026-11-05).

To reproduce a CI host locally, use the same remapping:

```sh
CARGO_ENCODED_RUSTFLAGS="--remap-path-prefix=${CARGO_HOME:-$HOME/.cargo}=/cargo" \
  cargo build --locked --release -p bun-native-host
```

## Not yet reproducible or not yet proven

- **Cross-runner host hashes:** [`host-reproducibility.yml`](../.github/workflows/host-reproducibility.yml) builds the release host twice per operating system (Linux, macOS, Windows), each on its own hosted runner from a clean target directory with only downloaded sources cached, and `scripts/quality/host-reproducibility.ts compare` requires the two SHA-256 values (and the two deterministic archives) to match. Linux, macOS and Windows gate that workflow. It runs by manual dispatch and once when its own pull request becomes ready, not on a schedule, because it is six cold Rust builds. Each job's record lists the runner image, `rustc`, linker or Xcode and SDK versions. **First run** ([run 42357401242](https://github.com/0xPlayerOne/bun-native/actions/runs/42357401242), 2026-11-07, source tree of PR #555): Linux x64 `ubuntu-24.04` identical, `51208bf9…` (32,079,600 bytes), which also matches a build of the same tree in an unrelated Linux container (Ubuntu 24.04, Rust 1.98.1, same remapping); macOS arm64 `macos-15` identical, `e405b982…` (9,408,864 bytes); Windows x64 `windows-2022` **different**, `2573377a…` and `73c73097…`, both 11,376,640 bytes. The equal size pointed at embedded build metadata. The compare job now uploads both executables and names the differing bytes by PE region (`scripts/quality/binary-diff.ts`). [Run 42363522092](https://github.com/0xPlayerOne/bun-native/actions/runs/42363522092) found exactly 20 differing bytes on Windows: the COFF `TimeDateStamp`, the three debug directory `TimeDateStamp` fields and the 16-byte CodeView GUID. The PDB path was the same relative `bun_native_host.pdb` in both, and no section differed. MSVC's `link.exe` writes the link time and a fresh PDB GUID unless `/Brepro` is set. `native/gpui-host/build.rs` now passes `/Brepro` for MSVC targets as a link argument, which survives the workflows' `CARGO_ENCODED_RUSTFLAGS`. Adding the build script changes the Linux and macOS host bytes as well (for example, Linux `490a292c…` instead of `51208bf9…` for the same sources), but not their reproducibility. **After the fix** ([run 42364600059](https://github.com/0xPlayerOne/bun-native/actions/runs/42364600059), 2026-11-07, source 1f69f0f): all three identical. Linux `490a292c…` (32,079,600 bytes, also matching a local container build), macOS `61771d6d…` (9,408,896 bytes), Windows `11ed2975…` (11,376,640 bytes). Windows then joined the gate.
- **macOS host:** measured on a physical Mac (2026-11-06, [macOS qualification](macos-qualification.md)). Two clean builds of one commit are byte-identical only when `CARGO_TARGET_DIR` is the same absolute path: the `gpui_apple` build script compiles the Metal shaders from `$OUT_DIR`, and that path (`…/shaders.metal`, `shaders.air`) is embedded in the host, which `--remap-path-prefix` cannot remap. Hosted runners share one workspace path. A local Mac build and a hosted build differ (different Xcode, SDK and path), and no two hosted builds of one commit have been compared.
- **Windows host:** two independent hosted `windows-2022` builds are identical since `/Brepro` (above). A local Windows build with a different Visual Studio or Windows SDK has not been compared.
- **AOT executables:** Linux x64 and, since 2026-11-06, macOS arm64 (`build-reproducibility.test.ts` passes there; the ad-hoc Mach-O signature is deterministic). Windows has not been compared.
- **Diagnostics** (`build-metrics.json`, compiler logs, package-set `logs/`) are never reproducible, and no hash or claim depends on them.
- **Signing** would add non-reproducible signatures. Compare the unsigned payload.

## Checking a build yourself

```sh
bun test tests/tooling/build-reproducibility.test.ts tests/tooling/host-archive.test.ts
```

To compare two package builds, hash every file listed in `manifest.reproducibility.deterministic` in both output directories. Build the same project at the same relative output location and on the same OS/CPU.
