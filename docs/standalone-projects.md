# Standalone projects from local package sets

The `create --packages` mode uses local archives of the existing Bun Native CLI and libraries
for a project outside the framework checkout. It is the implementation lane for
[#382](https://github.com/0xPlayerOne/bun-native/issues/382). Its initial source
controls use inert package fixtures; the [fixed qualification plan](standalone-packages-plan.md)
separately specifies real package production, offline installation, relocation,
AOT builds and later native GUI cases. Until those records are present, these
commands describe the intended experimental contract, not a completed installation
or native acceptance claim. The already qualified [checkout workflow](getting-started.md)
remains available.

## Produce the local package set

From a clean, committed Bun Native checkout with its pinned dependencies installed:

```sh
bun --no-install scripts/package-native.ts --outdir /absolute/new/package-set
```

The output directory must not already exist and must be outside the checkout.
The producer retains the original MIT license and creates seven private local
tarballs: the six existing library packages and `@bun-native/cli`. Libraries
retain their original TypeScript source exports and versions. The CLI contains
the same source implementation, compiler, executable inspectors and toolchain
pin as the checkout. No native source is compiled, and no package is published.

`manifest.json` binds the Git source/tree, tracked-file digests, exact compiler,
toolchain, package manifests, file inventories and tarball hashes. It also retains
the relevant external dependency-lock records, including distinct nested
versions and optional-peer declarations. `logs` preserves each pack command and
its output/status. The producer checks source/compiler invariance and exact
archive file contents before writing the success manifest. A failed production
keeps its partial output and failure record; it cannot be mistaken for a completed
package set.
Source archives use the checked gzip/USTAR format: regular files, optional
expected directory entries, unique canonical names and valid header/end records.
Links and extended/unknown member formats are rejected. Decompression is bounded
by the declared inventory and a 64 MiB source-archive maximum; native host binaries
are supplied separately and are not stored in these packages.

## Create and install

Use the unpacked copy of the same CLI as the bootstrap. It can create the project
without loading Babel or requiring a framework checkout:

```sh
bun --no-install /absolute/package-set/cli/src/scripts/native.ts \
  create /absolute/new/my-app \
  --packages /absolute/package-set/manifest.json \
  --framework solid --language typescript
```

Choose `--framework react` for React, and `--language javascript` for checked JSX
instead of TSX. Each destination must be new. The generated `vendor/bun-native`
directory is part of the project: commit it with the generated source/configuration
and the resulting lockfile. Scripts and archive references are project-relative.
The project does not extend a checkout configuration or import workspace paths.

The initial lock seeds the original external dependency graph, but it has not
yet recorded the new local tarballs. With an already populated cache:

```sh
cd /absolute/new/my-app
bun install --offline --ignore-scripts --linker hoisted --backend copyfile
```

This first install is not described as frozen. Keep its resulting `bun.lock`.
Subsequent installs, including after moving the complete project, use:

```sh
bun install --offline --frozen-lockfile --ignore-scripts \
  --linker hoisted --backend copyfile
```

An empty offline cache cannot supply required third-party packages. Local Bun
Native tarballs do not embed Babel, Solid, React or their dependency/type packages.
Supply a cache containing the pinned records for the intended platform; the CLI
does not populate one or silently retry online. Cache population and broader
distribution remain separate operations. The local package set itself contains
portable source and no prebuilt host or compiler executable.

## Check, develop and build

The installed CLI uses the existing generated template, bundler, AOT compiler
and teardown path:

```sh
bun run check
bun run dev --host /absolute/path/to/bun-native-host
bun run build --host /absolute/path/to/bun-native-host --host-profile release
```

Supply the exact pinned Bun revision and a separately acquired, compatible native
host. Ordinary source edits and AOT builds do not invoke Cargo. The compiler child
also receives `--no-install`, so an absent import cannot silently trigger package
acquisition during compilation. `--watch` uses the existing remount contract and
resets state; see the [CLI lifecycle reference](developer-tooling.md).

The CLI validates the selected installed package closure before loading compiler
modules or creating an application bundle. It requires contained archive paths,
matching archive/file digests, an exact regular-file inventory in each required
local package, contained package roots and consistent internal dependency
resolution. It compares the actually reachable pinned lock records, including
nested locators and present optional peers. Unrelated added registry roots may
coexist; a new nested locator under a required local package is rejected. Hashes
establish consistency with the supplied manifest, not a trusted-publisher signature.
Verify the manifest and native-host artifact's origin separately.

Solid retains `jsx: preserve` and the official universal transform. Its
`jsx-runtime` export supplies types and does not implement React's automatic JSX
functions. React retains its two native JSX runtime exports and pinned React/
reconciler types. Both consumer languages use the strict Bun-aware checker.
DOM/WebView component libraries remain unsupported.

The resulting AOT directory keeps the existing compiled-program/JIT-omission
inspections and caller-supplied host digest, plus the package-set source identity.
It is unsigned. Its manifest continues to mark GUI/input/teardown as `not-run`:
package creation and compilation are not native window qualification. The
separate hosted plan must exercise the actual installed `dev` command and AOT
application with owned OS input, complete paint and joined cleanup before those
claims are made.
