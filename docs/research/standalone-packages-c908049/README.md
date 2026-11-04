# First standalone-package cohort: rejected consumer lock seed

**Outcome: failed, with no retry.** The first populated-cache consumer install
rejected the generated lockfile. Package production and four template creations
had completed; relocation, strict checks, public imports, AOT builds and the eight
invalid-input cases did not run. This record does not qualify standalone
installation or application execution.

The single run used the actual published source commit
[`c90804933034ccc942467de8eb47379d8ee47e71`](https://github.com/0xPlayerOne/bun-native/commit/c90804933034ccc942467de8eb47379d8ee47e71),
tree `4e944901d40ee3761d163cfc157e75d8f786469b`, under the plan and harness committed
there before execution. The execution checkout was clean and remained unchanged.
The retained before/after records bind all 528 tracked source files. The source
includes the accepted 0.16.0 release metadata and the original standalone package
implementation; no dependency version, runtime, native host or GC policy changed
during this run.

## What ran

| Operation                                 | Planned | Attempted | Observed result                                                 |
| ----------------------------------------- | ------: | --------: | --------------------------------------------------------------- |
| `bun pm pack` inside the package producer |       7 |         7 | All seven exited 0; exact raw USTAR membership/digests accepted |
| Bootstrap `create --packages`             |       4 |         4 | Solid/React × TypeScript/JavaScript exited 0                    |
| Empty-cache offline install               |       1 |         1 | Exit 1, with both invalid-lock and missing-cache diagnostics    |
| Initial populated-cache offline installs  |       4 |         1 | Solid TypeScript exited 1; cohort stopped                       |
| Relocated frozen offline reinstalls       |       4 |         0 | Not run                                                         |
| Initial lock-only inspections             |       4 |         0 | Not run                                                         |
| Strict consumer checks                    |       4 |         0 | Not run                                                         |
| Public-export import inspections          |       4 |         0 | Not run                                                         |
| AOT application builds                    |       4 |         0 | Not run                                                         |
| Invalid-input cases                       |       8 |         0 | Not run                                                         |

The two installation commands used the generated Solid TypeScript project and:

```text
bun install --offline --ignore-scripts --linker hoisted --backend copyfile
```

The first attempt selected a new empty cache. Before the planned positive attempt,
the owner retained that attempt's lock bytes, removed only its owned installation
outputs and restored the unchanged generated seed. The second selected the owned
copy of the existing populated cache. The copied cache's full file/digest inventory
is retained; contained source-cache links were dereferenced into the copy. There
was no online dependency acquisition, additional framework setup, alternate
dependency version or adaptive installation variant.

## Exact failure and interpretation

Both install stderr files are **869 bytes** and have the same SHA-256:
`9b727e957052e18873e6514fd93e6a958337b53eb2f062213e0b3e39a56b8c61`.
They begin:

```text
5 |     "": {
            ^
error: Failed to resolve root dev dependency '@bun-native/cli'
    at bun.lock:5:9
InvalidLockfile: failed to parse lockfile: 'bun.lock'

warn: Ignoring lockfile
Resolving dependencies
Resolved, downloaded and extracted [6]
error: --offline: no cached manifest for "@types/bun" (run once online, or use --prefer-offline)
```

The remaining stderr reports missing cached manifests for `solid-js`, `@babel/core`
and `babel-preset-solid`, followed by their exact-version resolution failures. The
progress line is preserved verbatim; it is not evidence of a network download in
this offline invocation.

The generated root manifest declares local tarball dependencies, including the
CLI, while its lock seed contains only the retained registry tuples. The observed
parser rejects that incomplete local-root lock and ignores it before attempting
registry-manifest resolution. This disproves the initial assumption that Bun would
retain the source's registry lock graph while filling missing local archive tuples
on the first non-frozen install. It does **not** establish whether a complete,
correctly represented local-archive lock would install from this cache.

The original harness classified the empty-cache attempt as `passed` because it saw
missing-registry-cache diagnostics. Its raw result is retained unchanged. The
audited interpretation is narrower: **not qualified as a clean empty-cache control**,
because the preceding invalid-lock rejection also occurred. The first populated
install failed with that same mixed diagnostic. A subsequent correction must fix
the seed contract and must reject invalid-lock fallback when assessing the cache
negative; this record makes no claim about an unexecuted corrected source.

## Tools, ownership and limits

The pinned Bun was revision `da867c60bf0bcbf9d6d36994f8ca0efa42075115`, 138,468,432
bytes, SHA-256 `fe406996b9915f388e3fad9e6e29ece9c7cb81e06257bbcb4c50f91691b46810`.
The supplied, independently retained release host was 29,478,384 bytes, SHA-256
`55ad891864636ab1e4c11ad4dd9973552f294ecce2adf7e1e39479f79aaeac9b`. The host was
hashed but never launched or copied into an application build in this cohort.

The outer supervisor exited 1 without forced termination. Every directly spawned
command was joined. Source, Bun and host identities remained invariant, and the
owned Cargo/Rust sentinels were unused. No independent descendant-process audit,
native window/input/teardown, watch cycle, AOT application, or GC workload is
claimed. Recorded durations describe this one run; they are not a controlled cold
installation or performance benchmark.

## Portable raw evidence

- [receipt.json](receipt.json) keeps exact identities, commands, observed counts,
  original versus audited cache status, the full raw install error and limits.
- [raw.tar.gz](raw.tar.gz) retains 86 original regular-file byte streams: source
  snapshots, cache inventory, package manifest and seven source tarballs, pack and
  command logs, all four generated top-level scaffolds/locks, owner receipts and
  host-input provenance. No archived program needs to be executed to audit it.
- [raw-members.json](raw-members.json) records each member's size and SHA-256.

The archive is 421,845 bytes, SHA-256
`fc1d46e58756532017fe67c7accc1eb846b1c96325f7b335668303b8a6a96117`; its original
member bytes total 1,377,680. Copied cache payloads, duplicate consumer vendor
copies, the duplicate unpacked bootstrap CLI, the native executable and the full
source checkout are omitted. Their relevant inventories, original package
archives, public source identity and executable digests remain available in the
retained records. The original experiment directories and raw statuses were not
edited while preparing this archive.
