# Standalone package cohort: cba506b8

The single fixed local Linux/x64 cohort **passed** on the actual published source
[`cba506b844eb6b91dbdd085389d43690539c1186`](https://github.com/0xPlayerOne/bun-native/commit/cba506b844eb6b91dbdd085389d43690539c1186),
tree `afdfcee8bc95042cddc385e55efe454e3d433b57`. It qualified local package creation,
offline consumer installation, relocation, public imports, strict source checking,
inspected AOT compilation and the eight predeclared invalid inputs. **No application
entrypoint, compiled application or native host was executed.**

This is a data-only archive for [#382](https://github.com/0xPlayerOne/bun-native/issues/382)
and feature [#388](https://github.com/0xPlayerOne/bun-native/pull/388). It is based on
accepted main `c4de68deee812cd816316b33f9276786e6eae5c8`, separately from the feature
branch. The equivalent normal-hook implementation checkpoint is
`70b37c5c94bd76f10ba234363d782b9ed8a76c9c`; execution used the public `cba506b8` commit,
not that local alias. The
[committed plan](https://github.com/0xPlayerOne/bun-native/blob/cba506b844eb6b91dbdd085389d43690539c1186/docs/standalone-packages-plan.md)
and exact harness bytes are retained in the archive.

## Completed operations

| Operation                                              | Fixed count | Recorded outcome                                                                    |
| ------------------------------------------------------ | ----------: | ----------------------------------------------------------------------------------- |
| Produce local source package archives                  |           7 | All `bun pm pack --ignore-scripts` children exited 0                                |
| Create Solid/React × TypeScript/JavaScript consumers   |           4 | All exited 0                                                                        |
| Install with an empty offline cache                    |           1 | Expected exit 1, only recognized missing registry cache diagnostics, unchanged lock |
| Install with the copied populated offline cache        |           4 | All exited 0                                                                        |
| Inspect installed complete local/registry lock closure |           4 | All exited 0; exact source tuples and nested locator identities                     |
| Relocate and reinstall offline with a frozen lock      |           4 | All exited 0; all four locks unchanged                                              |
| Check generated TypeScript or checked JavaScript       |           4 | All exited 0                                                                        |
| Inspect all selected public package subpaths           |           4 | All exited 0; resolved files remained inside each consumer                          |
| Build and inspect AOT artifacts                        |           4 | All exited 0; compiled program present and JIT marked unused                        |
| Reject the predeclared invalid inputs                  |           8 | All exited 1 with the expected diagnostic and no build output                       |

There are **38 directly supervised commands**: 29 exited 0 and nine exited 1 as
expected. The producer records its seven pack children separately. All 38 direct
children joined without forced termination, and the outer owner also joined with
exit 0. The original records deliberately retain
`descendant_cleanup_verified: false`; joining a direct command is not a general
process-tree or native teardown proof.

All four consumers were created outside every Git checkout, then moved to new
paths containing spaces before the frozen reinstall, source check, public import
inspection and installed-CLI build. Their original directories were absent after
relocation. The 15 generated files per case, including the complete seed lock and
relative vendor package inputs, were unchanged. All archive identities were
checked; each consumer installed only the selected six-package local closure.
Installed dependencies and links resolved inside the relocated consumer.

The strict source checks cover the generated TS/JS configurations and public type
closure. Public import inspection initializes the declared package modules but
does not invoke an application or window API. Solid's `jsx-runtime` remains a
types-only module with no runtime exports; the existing universal transform is
used for Solid compilation.

## Exact source, tools and cache

| Input or record                        |       Bytes | SHA-256 or identity                                                |
| -------------------------------------- | ----------: | ------------------------------------------------------------------ |
| Raw `result.json`                      |     144,926 | `226f72a4e3cc95fba1dd728fabbb52a33127f33d1112cc9ff574d08f8fdea9c7` |
| Each source snapshot, before and after |      84,803 | `2957bf1feec062983385057d7a20f23c18fcb7148352b1f4ebbfce57fb6545b4` |
| Bun executable                         | 138,468,432 | `fe406996b9915f388e3fad9e6e29ece9c7cb81e06257bbcb4c50f91691b46810` |
| Supplied native host                   |  29,478,384 | `55ad891864636ab1e4c11ad4dd9973552f294ecce2adf7e1e39479f79aaeac9b` |
| Copied-cache inventory                 |     759,557 | `ee743176f9917207afc8acc98b190ff3f569d8e02497ab2bc9b52a256fdcf434` |

The pinned Bun revision is
`da867c60bf0bcbf9d6d36994f8ca0efa42075115`. The measured environment reports
`Linux-6.18.57-x86_64-with-glibc2.39`. All **535 tracked source files**, the clean
source commit/tree, Bun and supplied host identities were unchanged across the
cohort. The package manifest binds that same source inventory. CLI package version
is `0.16.1`; the six libraries retain their declared `0.0.0` versions. No version,
lock or compiler-profile change was made during execution.

The host came from retained GitHub artifact `13359762942`, associated with the
earlier #360 qualification head `241b056cca04a0950a6e114a9133cb8502e93d60`. Its
10,752,717-byte unsigned host archive has SHA-256
`ab6863085c4f51baeab5d4cf85616d16dc9467e21a7d87e7f22df02b14a057ae`.
`inputs/host.json` preserves that prior provenance. The local cohort copied and
inspected the supplied host but did not execute it or acquire a replacement.

The existing source-tool setup was reused without another framework install.
Consumer installs used only their task-owned empty or populated offline caches.
The populated inventory is byte-identical to the earlier `c908` and `7e` cohort
inventories. Cargo, rustc and rustup sentinel records remained unused. There was
no online cache population or registry publication.

The outer owner observed 19.901083273 seconds; the harness recorded
18.419188946 seconds after the cache copy, and the copy itself took
0.806755136 seconds. These are observations from this one fixed cohort with an
existing cache, **not a cold-start benchmark or a timing distribution**.

## Inspected build artifacts

| Consumer         |  AOT bytes | AOT SHA-256                                                        | Mapped source entries |
| ---------------- | ---------: | ------------------------------------------------------------------ | --------------------: |
| Solid TypeScript | 71,384,104 | `397a57b74206bd5951c7d8288f9e1578f3b4b2d2dec3f6fc0f6b4b36e5340fd2` |                    25 |
| Solid JavaScript | 71,384,104 | `655d0d0f398b11c37ae2d99d880bcdbdfca2ce2ffcd4d88a79832b2eefccdacd` |                    25 |
| React TypeScript | 73,071,656 | `56c5bca78f99d1c2bd72d115e80e4c352a90a839a817cb605cedc8932fd0bd5c` |                    34 |
| React JavaScript | 73,071,656 | `c4520b9a71699b77a3baf246e9eaeb02f89221710b97af9f105d373996214a1f` |                    34 |

Every retained build manifest binds the package source, compiler, development
module, compiled artifact and host hashes. The AOT child explicitly used
`--no-install`; the existing compiler inspection reported a compiled program,
JIT `unused`, and 27 removed ranges. Native rendering, OS input and teardown
remain `not-run` in every manifest.

The tooling author rehashed the live artifacts and source-map inputs. The
independent parent reviewer also checked the actual four ELF binaries: machine
62, module-graph offsets and compiled flag, and the `.bun_features` bytes against
the inspection records. These are read-only inspections, not application runs.
The two attributed audit records are retained unchanged.

The actual four development modules, external source maps and compiler explain
outputs are retained. All **118 mapped source entries** were parsed and matched
regular inputs inside the relocated consumers. This establishes the recorded map
inventory and containment; it does not establish original Solid TSX line/column
fidelity, because the existing Solid transform does not emit an intermediate
Babel source map.

## Installer metadata and invalid inputs

All declared local package files remained exact. The four installed closures
contained **310 files**: 286 declared source/package files plus 24 installer-owned
root `.bun-tag` markers. The exact marker bytes are retained separately as data.
The pinned Bun formatter writes a 52-byte SHA-256 tag using unpadded base64 plus
`==`; that differs from the canonical 51-byte SRI used in the lock. The source
correction accepts only this precise regular installer marker alongside the
exact declared inventory. It does not change lock SRI or permit other extra
files, links or archive-owned reserved markers.

| Fixed invalid input              | Expected diagnostic                                      | Exit |
| -------------------------------- | -------------------------------------------------------- | ---: |
| Missing package archive          | `ENOENT`                                                 |    1 |
| Changed package archive          | `archive digest mismatch`                                |    1 |
| Escaping archive path            | `unique contained relative paths`                        |    1 |
| Escaping project entry           | `Project entry must be a source file inside the project` |    1 |
| Changed installed package source | `Installed package digest mismatch`                      |    1 |
| Omitted host                     | `--host must be an absolute path`                        |    1 |
| Recognized foreign OS header     | `Prebuilt host must be a linux/x64 executable`           |    1 |
| Recognized wrong CPU header      | `Prebuilt host must be a linux/x64 executable`           |    1 |

The eight controls used the predeclared Solid TypeScript consumer or package-set
copies. Each failed through the actual CLI before creating a build output. The
two invalid source sentinels were not executed. The two 64-byte host inputs are
inert format guards, not real foreign executables. Their exact bytes, the
modified archive/config/source inputs and every command output are retained.
The absent archive and absent generated outputs are recorded observations; the
archive does not manufacture files to represent their absence.

## Earlier outcomes remain separate

| Source and archive                                                                                         | Preserved outcome                                                                                                                                                                                                             |
| ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `c9080493`, [#394](https://github.com/0xPlayerOne/bun-native/pull/394)                                     | Failed first populated-cache install because the seed omitted local package tuples. Its old empty-cache raw pass label included invalid-lock fallback and remains unqualified as clean cache acceptance.                      |
| Local `c16db305`, public equivalent `95bc5347`, [#397](https://github.com/0xPlayerOne/bun-native/pull/397) | Failed first original-Solid parser control because its controller expected an extra diagnostic that `pm ls` did not print. Exit 1 and the exact 49-byte public diagnostic remain unchanged; no original-Solid retry occurred. |
| Local `39d2b878`, public equivalent `2c6f48f2`, [#397](https://github.com/0xPlayerOne/bun-native/pull/397) | Separate three-call follow-up passed only original React and corrected Solid/React parser inputs. It did not qualify installation or turn the earlier failed control into a four-pass cohort.                                 |
| `7e102937`, [#400](https://github.com/0xPlayerOne/bun-native/pull/400)                                     | Failed pre-import inventory after the strict cache negative and first successful populated install, because the validator did not account for six exact installer markers. Later operations were not run.                     |
| `cba506b8`, this archive                                                                                   | Passed the complete fixed local cohort after the source correction. Native application qualification remains separate.                                                                                                        |

This archive neither replaces those raw outcomes nor contains their feature or
research history in its branch ancestry. The immutable source links and separate
archives preserve each result against the code that produced it.

## Archive contents and omissions

`raw.tar.gz` contains **219 regular members**, totaling **8,429,259 payload bytes**.
Its compressed size is **1,509,880 bytes**, SHA-256
`f19b0c2427163447efdc01c84e58fca5afe03f9f8c45feb4c83d651226070e19`.
The uncompressed 8,601,600-byte TAR has SHA-256
`ee5eff9b05926dceb7ee8490d5bdad0ec86adf83ed0df364ee8177031d97576c`.

The retained groups are:

- Original result, both source snapshots, copied-cache inventory, all 38 command
  stdout/stderr streams and lock snapshots.
- All seven actual source package archives, their canonical package-set manifest,
  seven pack command receipts and pack stdout/stderr.
- Generated consumer files, four build manifests/launchers, four development
  modules/maps and all four compiler explain stdout/stderr streams.
- Exact installer marker bytes and the bounded invalid-input files.
- Original preflight/outer-owner records, owner stdout/stderr, host provenance,
  committed plan/harness/inspector and both attributed read-only audits.

`raw-members.json` records every member name, byte count, SHA-256 and provenance
category. `receipt.json` is a derived readable index of the original outcome,
cases, limits, prior failures and omitted artifact identities. Every raw member
was compared byte-for-byte with its original file; the gzip/TAR metadata is
normalized for portability. No archived code was executed during preservation.
Historical absolute paths remain only where the original records contain them;
portable member paths do not require those original directories to exist.

Large AOT executables, the native host and Bun executable, full cache and installed
dependency trees are omitted. Duplicate vendor package sets and negative-control
project copies are also omitted, while their original hashes, command receipts
and exact changed inputs remain. The full four development modules and source
maps are included; these may embed dependency source text, but they are not a
copy of the installed dependency trees. Omitted executable bytes cannot be
reinspected from this archive, and recorded fingerprints do not replace them.

This evidence does not claim native pixels, OS interaction, application startup,
watch/remount behavior, process-tree teardown, heap collectability, macOS/Windows
consumer support, signing, registry distribution or a completed BN5 milestone.
