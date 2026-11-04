# Standalone consumer cohort: preserved failure at 7e102937

The one declared consumer cohort at published source
[`7e102937bb7af362db59bddd1ab92b664386cd52`](https://github.com/0xPlayerOne/bun-native/commit/7e102937bb7af362db59bddd1ab92b664386cd52),
tree `1dea214842f25d93c8c03c61a7fce66ad7d540d5`, failed after its first
populated-cache installation. The installer exited 0, but the immediate
package-inventory check rejected an installer-created `.bun-tag` file. The
original failure and all unattempted stages remain unchanged.

This record is separate from the first consumer failure in
[#394](https://github.com/0xPlayerOne/bun-native/pull/394) and the parser failure
with its separately planned three-call follow-up in
[#397](https://github.com/0xPlayerOne/bun-native/pull/397). No command was repeated
to create this archive. It is a data-only research branch for draft review and
closure without merging.

## Executed scope

The source-bound harness ran on `Linux-6.18.57-x86_64-with-glibc2.39`, with Bun
revision `da867c60bf0bcbf9d6d36994f8ca0efa42075115`. Its executable is
138,468,432 bytes, SHA-256
`fe406996b9915f388e3fad9e6e29ece9c7cb81e06257bbcb4c50f91691b46810`.
The supplied native host was fingerprinted but never executed; its fingerprint
is retained in the raw result and compact receipt.

| Stage                                                   | Observed outcome                                                                                                             |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Package preparation                                     | One packaging command completed seven internal `bun pm pack --ignore-scripts` calls, all exit 0                              |
| CLI project creation                                    | Solid and React, TypeScript and JavaScript: four projects created, all exit 0                                                |
| Solid TypeScript, empty cache                           | Installer exit 1 with the declared offline cache-miss diagnostics; negative control recorded passed and lock bytes unchanged |
| Solid TypeScript, copied populated cache                | Installer exit 0; exact package-inventory check then failed                                                                  |
| Remaining installs and relocations                      | Not attempted                                                                                                                |
| Installed project checks, public imports and AOT builds | Not attempted                                                                                                                |
| Eight declared invalid-input cases                      | All remain `not-run`                                                                                                         |
| Application/native execution, watch and GC workloads    | None                                                                                                                         |

The original result error is:

```text
RuntimeError: Installed package inventory differs: @bun-native/cli
```

The [measured inventory check](https://github.com/0xPlayerOne/bun-native/blob/7e102937bb7af362db59bddd1ab92b664386cd52/scripts/quality/standalone-packages.py#L145-L159)
compares every observed installed file against the package-set declaration
before executing an installed CLI module. It stops at the first mismatch. The
four case statuses remain `created`; an installer exit 0 is not a completed
consumer acceptance result.

All seven directly supervised commands exited and were joined without forced
termination. The outer owner exited 1, joined its direct child and was not forced.
No post-exit descendant discovery or complete process-tree claim is made. The
record retains the original command limits, owner limits, source/compiler/host
invariance and unused native-tool sentinel records.

## Exact observed inventory difference

Independent read-only audits checked the six installed local packages. All 70
declared files are present and byte-identical to their package-set declarations.
Each package has exactly one additional regular root file named `.bun-tag`, with
52 bytes and no newline. The React adapter was not installed by this Solid
consumer. No other extra, missing or changed local-package file was found.

| Package                | Declared files | Observed files | Extra      |
| ---------------------- | -------------: | -------------: | ---------- |
| `@bun-native/cli`      |             24 |             25 | `.bun-tag` |
| `@bun-native/core`     |             10 |             11 | `.bun-tag` |
| `@bun-native/protocol` |             10 |             11 | `.bun-tag` |
| `@bun-native/renderer` |             12 |             13 | `.bun-tag` |
| `@bun-native/runtime`  |              6 |              7 | `.bun-tag` |
| `@bun-native/solid`    |              8 |              9 | `.bun-tag` |

The archive preserves all 76 observed installed files, including the six original
markers, so this difference can be checked without executing any package. It
also preserves the seven original package archives and their complete declared
file inventories.

## Pinned installer metadata contract

A source-only trace explains the extra file:

- [`extract_tarball.rs`](https://github.com/oven-sh/bun/blob/da867c60bf0bcbf9d6d36994f8ca0efa42075115/src/install/extract_tarball.rs#L51-L86)
  verifies a supported supplied integrity and retains it for local/remote
  tarballs. Its [cache publication path](https://github.com/oven-sh/bun/blob/da867c60bf0bcbf9d6d36994f8ca0efa42075115/src/install/extract_tarball.rs#L531-L559)
  writes that integrity's `sri` output into `.bun-tag`, with no newline.
- [`PackageInstall.rs`](https://github.com/oven-sh/bun/blob/da867c60bf0bcbf9d6d36994f8ca0efa42075115/src/install/PackageInstall.rs#L1168-L1176)
  compares a tarball's installed marker with the same formatter. Its empty-tag
  alternative applies only when integrity verification is explicitly skipped.
- The pinned [`Integrity` formatter](https://github.com/oven-sh/bun/blob/da867c60bf0bcbf9d6d36994f8ca0efa42075115/src/install/integrity.rs#L235-L255)
  appends `==` after unpadded base64 for every non-SHA1 algorithm. For SHA-256,
  this produces **52 bytes**: `sha256-` plus 43 base64 characters plus `==`.
  Canonical SHA-256 SRI has one padding `=` and 51 bytes.

All six observed markers match that exact pinned 52-byte formatting of their
own recorded archive digest. Each differs from canonical SRI by one trailing
`=`. The receipt retains every original marker's bytes, hex, digest and source
references. This observation supports a narrow installed-metadata correction;
it does not justify ignoring arbitrary files or substituting the marker for
exact archive/source hashes. No proposed correction is executed or qualified
by this failed cohort.

## Preserved bytes

`standalone-packages-7e102937-raw.tar.gz` contains 170 unique regular members,
1,721,825 uncompressed member bytes. Its compressed size is 520,469 bytes and
its SHA-256 is:

```text
6d38ce49fa651fa41af27b51cac6b5147c65d2e3281aabc9fbbd40eaa41b6c5c
```

The original 26,981-byte result has SHA-256
`d4028101f6c922dd46be58a49b9fba4abca6f949408eaf6a2918c4496f63ad7c`.
Both 84,479-byte source inventories are byte-identical, SHA-256
`fe75571450934758db16ea236a132916feff2aa275cf3278fc2705b2bd92fc9b`.
All 533 tracked-file digests were independently compared with the actual
published Git source.

The capture includes the raw result, source/cache inventories, command and pack
logs, generated consumer files, one original package set, the six installed
local-package contents, native-tool sentinels, owner/preflight records and exact
measured harness/inspector/plan. The `analysis/` members are explicitly separate
post-failure data audits by the tooling and root agents; their authors are listed
in `receipt.json`. Original temporary paths remain verbatim in raw records.

The Bun/native binaries, dependency-cache payloads and external registry
`node_modules` are omitted. Identical vendor copies of the package archives and
manifest are omitted after their original generated-copy hashes were checked;
one original set remains. Complete source and cache inventories retain their
identities. No original data is rewritten to remove the unexpected metadata.

`raw-members.json` lists every original member's size and SHA-256.
`receipt.json` provides portable source, outcome, metadata-contract, omission and
scope information. The tar/gzip container uses deterministic metadata. Checking
the index requires only reading/decompressing data; archived Python/TypeScript
or package payloads must not be executed to verify it.

This record preserves a failed qualification. It establishes no relocation,
installed import/type, AOT or native acceptance, and makes no GC, heap-root or
runtime-causality claim. The earlier failures in #394 and #397 remain distinct.
