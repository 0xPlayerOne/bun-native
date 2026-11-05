# Reproducible builds

**Status:** experimental. This records which Bun Native build outputs are byte-for-byte reproducible today, how that is checked, and what is still open. It is part of [BN6 #223](https://github.com/0xPlayerOne/bun-native/issues/223) and [#246](https://github.com/0xPlayerOne/bun-native/issues/246). Nothing here is signed; see [releasing](releasing.md).

"Reproducible" means equal inputs (source tree, `toolchain.json` pins, `Cargo.lock`/`bun.lock`, and the same OS/CPU target) produce identical bytes, regardless of checkout location, output directory, process working directory, build time or file mtimes.

## Summary

| Output                                                                      | Status                          | How it is checked                                                                                      |
| --------------------------------------------------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `bun-native build`: AOT `application` executable                            | Reproducible (same target)      | `tests/tooling/build-reproducibility.test.ts` (two clean builds, compared)                             |
| `bun-native build`: `development/application.js` and `.js.map`              | Reproducible after this change  | Same test; the module previously embedded the caller's working directory                               |
| `bun-native build`: `launcher.ts`, bundled host copy                        | Reproducible                    | Same test                                                                                              |
| `bun-native build`: `manifest.json`                                         | Reproducible after this change  | Same test; it previously held absolute paths and wall-clock timing                                     |
| `bun-native build`: `build-metrics.json`, `compile-aot.*.log`               | Not reproducible, by design     | Declared under `manifest.reproducibility.diagnostics`                                                  |
| `scripts/package-native.ts` source package set (`archives/*.tgz`, manifest) | Reproducible                    | Two runs into different output directories produced identical archives and manifest (manual, recorded) |
| `scripts/package-native.ts` `logs/`                                         | Not reproducible, by design     | They record absolute commands and output                                                               |
| CI `unsigned-native-host.tar.gz`                                            | Reproducible after this change  | `tests/tooling/host-archive.test.ts`, and the Linux native job repacks and `cmp`s                      |
| Release `bun-native-host` (Cargo) on one machine, different dirs and times  | See measurement below           | Manual two-build comparison                                                                            |
| Release `bun-native-host` across machines with different `CARGO_HOME`       | Fixed in CI with path remapping | Mechanism demonstrated; cross-runner hash comparison not yet recorded                                  |
| Across OS/CPU targets                                                       | Not applicable                  | Each target has its own binaries; compare only within a target                                         |

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

To reproduce a CI host locally, use the same remapping:

```sh
CARGO_ENCODED_RUSTFLAGS="--remap-path-prefix=${CARGO_HOME:-$HOME/.cargo}=/cargo" \
  cargo build --locked --release -p bun-native-host
```

## Not yet reproducible or not yet proven

- **Cross-runner host hashes:** CI does not yet build the host twice on independent runners and compare them. The remapping removes the known home-path cause. Linker or system-library version differences between runner images may still change bytes; the toolchain record in each job's evidence identifies the image.
- **macOS and Windows hosts:** these were not measured locally. macOS adds `LC_UUID`, and Windows PE files contain a link timestamp and PDB GUID. Rust's MSVC linker defaults (`/Brepro` is not set) may make the Windows host vary between builds.
- **AOT executables on macOS/Windows:** only Linux x64 was compared. Unsigned Mach-O executables carry an ad-hoc signature over their contents. That is deterministic if the contents are, but this has not been checked.
- **Diagnostics** (`build-metrics.json`, compiler logs, package-set `logs/`) are never reproducible, and no hash or claim depends on them.
- **Signing** would add non-reproducible signatures. Compare the unsigned payload.

## Checking a build yourself

```sh
bun test tests/tooling/build-reproducibility.test.ts tests/tooling/host-archive.test.ts
```

To compare two package builds, hash every file listed in `manifest.reproducibility.deterministic` in both output directories. Build the same project at the same relative output location and on the same OS/CPU.
