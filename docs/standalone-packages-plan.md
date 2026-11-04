# Standalone local-package qualification plan

Issue [#382](https://github.com/0xPlayerOne/bun-native/issues/382) extends the
accepted checkout-only CLI in [#242](https://github.com/0xPlayerOne/bun-native/issues/242).
It contributes to [#254](https://github.com/0xPlayerOne/bun-native/issues/254);
registry publication, signing and wider platform support remain separate work.

## Source and scope

The implementation starts from accepted commit
`c9ba430d2100841ff7c336bd4cad33a4bc4bcdf4`, tree
`c6db8d921a859cc2d7ccc5a4b6edb989553bb3b1`. Its CLI, six library packages,
dependency lock and toolchain match the accepted CLI foundation in `77c842f`.
Before the first consumer cohort, the branch normally integrates accepted release
commit `27405939ce1007d4142e1bb67e9ecc6ca3ce0411`. That accepted change updates only
the release manifest, changelog and root package version to `0.16.0`; the local
CLI archive consequently uses that current release version. Library exports,
dependency resolutions, compiler and native source are unchanged by the merge.
The initial implementation checkpoint and this release integration are source
preparation, not prior consumer packaging, installation or build experiments.
The eventual experiment must name the clean, published implementation commit,
tree and full tracked-source hashes before its first package/install command.
This plan does not describe an experiment that has already run.

Use the pinned Bun revision
`da867c60bf0bcbf9d6d36994f8ca0efa42075115`. The available Linux x64 executable is
138,468,432 bytes, SHA-256
`fe406996b9915f388e3fad9e6e29ece9c7cb81e06257bbcb4c50f91691b46810`.
Do not change dependency versions, lock resolution, native host, adapters,
runtime, GC policy or existing validation gates for this work.

## One package and compiler path

Produce seven local tarballs: the six existing source-export library packages
and `@bun-native/cli`, containing the existing CLI's TypeScript source closure.
The CLI closure includes the Solid transform, development/watch code, AOT
compiler, executable inspectors and `toolchain.json`. Bun can execute that
source directly; a second compiler implementation or a CLI bundle is unnecessary.
Load compiler/watch modules only for the commands that use them, so the same CLI
can bootstrap `create --packages PATH` without installed Babel dependencies.
An unpacked copy of that exact CLI package in the package set supplies the
bootstrap command. The installed package uses the same source bytes.

Preserve each library's existing version and export map, including Solid's JSX
types and React's production/development JSX entries. Materialize `workspace:*`
edges to the existing exact versions. Preserve `private: true`; these are local
experimental packages, not a registry release. Copy the original MIT license
without editing its notice into every package. Third-party dependencies remain
their original separately installed packages, with their own licenses.

The package-set manifest records source commit/tree and hashes, the exact
toolchain, source-lock identity, package names/versions/manifests, each packaged
file's digest/size, and each tarball's relative path/digest/size. Reject missing,
duplicate, unexpected, escaping or symlink-escaped entries. Checksums establish
consistency with the caller-supplied manifest; they are not a signature or proof
of a trusted publisher. The producer requires a clean source tree and verifies
source/compiler invariance afterward.
The reader inspects raw gzip/USTAR member headers before accepting contents:
only regular files and expected directories are supported, with unique canonical
paths, valid checksums/sizes/padding/end records and bounded decompression tied
to the declared inventory (64 MiB maximum per source archive). Links, PAX/GNU
extension members and unknown formats fail closed. The actual seven planned
`pm pack` outputs must satisfy this format; no fallback parser is used. A retained
inert pinned-reader control demonstrates why a normalized filename Map alone
cannot prove the original tar members were unique.

An external scaffold explicitly selects that manifest. It copies the local
archives and manifest into tracked `vendor/bun-native`, writes its own strict
TypeScript/checked-JavaScript configuration, declares the chosen framework,
library, installed CLI and required Bun/React types, and points scripts at its
own installed CLI. Root-level `file:` tarball overrides keep all internal edges
local. No generated script, config, dependency or source path points back to the
framework checkout. Existing checkout scaffolds retain their current behavior.
Validate all seven archive identities, but require only the selected adapter's
installed closure: that adapter, renderer, core, runtime, protocol and CLI.
Overrides alone do not install an otherwise unused package.

Preserve the committed external dependency graph as the initial lock seed,
including the nested `babel-plugin-jsx-dom-expressions/@babel/helper-module-imports`
resolution. The seed changes project/workspace metadata and removes workspace
package locators; the first normal offline install records the local tarballs.
It is explicitly **not** called a frozen install. Validate the resulting external
package versions, integrity and dependency records against the source lock;
reject unplanned resolution changes. A later frozen install reuses the generated
consumer lock. Do not flatten distinct nested dependency versions with a global
override.
Retain optional-peer declarations unchanged, but do not turn an absent optional
peer into a new installation root. For example, the existing `debug` record
declares `supports-color` optional and the source lock does not install it.

Before application execution/build, validate the project's relative entry,
package manifest/archive identities, exact inspected archive file membership and
digests, and the exact installed local package regular-file inventory/digests.
Resolve installed packages within that consumer's own `node_modules`; reject
checkout/cache escapes through symlinks. Normal internal package-manager links
and the installed bin link are allowed when their real targets stay within the
consumer. Check internal package resolutions against those validated roots.
Compare the actual reachable required registry lock graph, including nested
locator identities and present optional peers, rather than filtering only known
keys. Unexpected nested locators beneath required local packages are rejected;
genuinely unrelated added registry roots can coexist with the pinned graph.
Retain the existing explicit absolute prebuilt-host header/OS/CPU
guard, protocol handshake, AOT inspections and joined development teardown.

## Preparation checkpoint

Publish this fixed plan and a first useful implementation checkpoint before
consumer installation, packaging or build experiments. Static review covers
actual value/type imports, export targets, peer/type requirements, source closure,
relative tarball references, lock preservation, ownership and error paths.
Focused source tests may use inert fixture archives; they do not establish
installability. Run the normal source hooks, type check, boundaries and health.

The implementation worktree may use one separately labelled framework setup:
`bun install --offline --frozen-lockfile --ignore-scripts` with the existing
populated dependency cache. Record its command/status; it is not a fresh consumer
install or evidence of checkout independence. No native build or whole-suite GC
trial is needed to prepare this change.

## Fixed local Linux cohort

Execute only after the published implementation/plan is reviewed. Use one owned
directory outside every Bun Native checkout, a fresh empty cache for the negative
case, and a task-owned copy of the already populated cache for positive cases.
Use a neutral working directory, remove inherited `NODE_PATH`/`BUN_INSTALL`,
disable implicit installation with Bun's `--no-install` for CLI/check/import/build
commands, and install with `--offline --ignore-scripts --linker hoisted
--backend copyfile`. Record whether cache copying preserves any symlink; none may
make installed consumer source resolve outside the consumer.

1. Produce one complete package set with seven `bun pm pack --ignore-scripts`
   calls. Keep their exact commands/stdout/stderr/status and all archives/manifests.
   This source packaging step does not execute application modules or compile Rust.
2. Bootstrap four unchanged generated consumers: Solid TypeScript, Solid
   JavaScript, React TypeScript and React JavaScript. Run the package-set CLI from
   outside its source directory. Retain exact generated bytes and hashes.
3. Attempt one Solid TypeScript install with the empty offline cache. It must
   fail for a missing required registry dependency; retain its actual failure.
   Clear only this owned attempt's install outputs before its planned positive
   install. A different error does not satisfy the negative control.
4. Run one initial populated-cache offline install per consumer. Preserve all
   four outcomes and produced locks, and verify the external resolution graph
   against the source lock. No consumer lock is represented as frozen yet.
5. Move each project, including its archives and lock, into a second unrelated
   directory containing spaces. Remove only that project's owned `node_modules`
   and run one populated-cache **frozen** offline reinstall per consumer.
   This is exactly nine consumer install invocations: one expected failure,
   four first installs and four relocated frozen installs.
6. For each relocated consumer, run one strict check, one public/export-subpath
   import smoke that creates no application/window, and one installed-CLI AOT
   build with the explicitly supplied verified Linux release host. Keep the same
   generated source and current compiler/inspector pipeline. This is exactly four
   AOT application builds; inspect compiled-program and JIT-omission evidence,
   archive/host/module identities, and package source maps. Do not execute these
   applications or claim native rendering from this cohort.
7. Run exactly eight invalid-input controls, using an owned copy of the Solid
   TypeScript consumer/package set: (1) missing core archive; (2) changed core
   archive bytes; (3) manifest archive path `../outside.tgz`; (4) configured entry
   `../outside.ts`; (5) changed installed core source bytes; (6) omitted host;
   (7) a Darwin x64 header; (8) a Linux arm64 header. The first three call create,
   and the remaining five call build on Linux x64. Require failure before
   app/host execution and before any new bundle/output directory. Header
   fixtures are guard inputs, not usable executables. Preserve every outcome.

Put owned `cargo`, `rustc` and `rustup` fail-and-record sentinels first on PATH for
the entire consumer cohort. Hash the supplied host before and after. Require no
sentinel invocation, no checkout-dependent realpath, and no source/compiler
mutation. The native host is an explicit existing artifact; no download,
registry publication, credential use or Cargo compilation is part of this plan.
The shared AOT compiler child also receives an explicit `--no-install`; a parent
CLI flag alone does not propagate into a newly spawned Bun command. Emitted
source maps must be present, parseable and bound to relocated consumer/package
sources. The existing Solid Babel transform has source maps disabled, so this
check does not establish original-TSX line/column fidelity.

Each install/check/import/control command has a 60-second limit; each pack has a
30-second limit; each AOT build retains its existing 120-second compiler limit
under a 150-second owning-process limit. The whole local cohort has a fixed
15-minute budget, excluding initial cache copy. Join owned children before
cleanup, preserve forced termination as failure, and retain exact source, Bun,
host, cache, manifest, archive, lock, command, cwd, exit and raw-log identities.
No retry, extra GC or adaptive extra variant is permitted. Preserve an unexpected
failure and diagnose it before proposing a separately source-bound correction.

### Owning harness and retained inputs

`scripts/quality/standalone-packages.py` implements this single fail-stop cohort.
Run it from the actual published source commit, with a clean tree and the exact
published commit/tree supplied as `--source-commit` and `--source-tree`. An
equivalent unpublished local commit is not substituted: package provenance records
the actual Git HEAD. `--repository`, `--bun`, `--host`, `--cache` and `--output`
select existing source/tools/cache and a new output directory outside every linked
checkout. Existing source-tool dependencies may be reused; preparing the harness
does not add a second framework installation to this plan.

The fixed host is the independently retained Linux x64 release executable from
the accepted CLI qualification: 29,478,384 bytes, SHA-256
`55ad891864636ab1e4c11ad4dd9973552f294ecce2adf7e1e39479f79aaeac9b`.
Its single-member unsigned archive is 10,752,717 bytes, SHA-256
`ab6863085c4f51baeab5d4cf85616d16dc9467e21a7d87e7f22df02b14a057ae`,
retained in GitHub artifact `13359762942` for the source-specific `#360` qualification.
Extraction and hashing do not launch the executable.

The supervisor copies and records the populated cache before starting its whole
cohort timer, dereferencing only contained cache links into its owned copy. It
records four additional lock-only inspections after the first installs; the four
later public-import inspections validate the relocated installed CLI/closure and
every declared public subpath, including Solid's types-only JSX entry. Neither
inspection mode invokes an application/window API. A 240-second producer deadline
contains its seven independently bounded 30-second pack calls. The supervisor
starts a command only when its full timeout remains in the whole-cohort budget;
it never shortens a producer/AOT deadline to spend the last partial budget.
Successful source/compile results retain the product's synchronous child contract,
without an independent descendant-process audit. After interruption or forced
termination, descendant cleanup remains explicitly unqualified. The supervisor
joins each directly spawned command, with a bounded terminate-then-kill cleanup
after interruption or timeout; forced cleanup fails the cohort. It does not adopt
descendants after root exit or claim native process-tree evidence from these
source/compile commands. All output directories and raw records remain available.

An unexpected outcome stops the cohort. Later planned cases remain unrun, rather
than becoming implicit retries or replacement cases. Preserve the first error,
individual exit/status/log records, any subsequent finalization errors, generated
seed/resulting locks, source/compiler/host invariance and unused Cargo/Rust
sentinels. Native rendering, watch behavior and heap collectability remain outside
this harness's scope.

## Native follow-up and limits

A separate reviewed hosted-CI plan will qualify all four installed consumer
templates through the actual `dev` command and inspected AOT application,
requiring real owned OS input, complete counter paints, native close and joined
zero-resource teardown. Reuse the existing native driver/owner contracts and
append the step after earlier baseline/CLI scenarios, so it cannot warm their
first-window observations. Do not infer GUI acceptance from source checks,
imports or compilation. This local cohort does not run the 101-edit watch
experiment, prove a memory plateau, establish physical-GPU behavior, qualify
other OS/CPU combinations, or complete the broader release/support contract.
