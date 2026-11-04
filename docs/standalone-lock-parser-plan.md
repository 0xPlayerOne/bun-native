# Standalone lock correction: four parser-only controls

This bounded source check follows the failed `c908049` consumer cohort retained in
[#394](https://github.com/0xPlayerOne/bun-native/pull/394). That cohort remains failed.
No installation, archive extraction, public import, compilation or application
acceptance is inferred from the controls below. They do not repeat or replace the
consumer cohort.

## Pinned contract and correction

The source is Bun revision `da867c60bf0bcbf9d6d36994f8ca0efa42075115`; execution uses
the same Linux x64 compiler bytes as the first cohort, SHA-256
`fe406996b9915f388e3fad9e6e29ece9c7cb81e06257bbcb4c50f91691b46810`.

- The pinned [text-lock printer/parser](https://github.com/oven-sh/bun/blob/da867c60bf0bcbf9d6d36994f8ca0efa42075115/src/install/lockfile/bun.lock.rs)
  emits a local tarball's raw relative path at lines 799–818. Its INFO object is
  mandatory, can be empty, and retains dependencies/bin; it does not add a package
  version field. Required roots must resolve to a package row.
- [Resolution parsing](https://github.com/oven-sh/bun/blob/da867c60bf0bcbf9d6d36994f8ca0efa42075115/src/install/resolution.rs)
  interprets `file:` as a folder in the text-lock resolution field. The raw `.tgz`
  path is classified as a tarball by the pinned
  [dependency parser](https://github.com/oven-sh/bun/blob/da867c60bf0bcbf9d6d36994f8ca0efa42075115/src/install/dependency.rs).
  Package manifest dependencies/overrides still use `file:`.
- The [integrity parser](https://github.com/oven-sh/bun/blob/da867c60bf0bcbf9d6d36994f8ca0efa42075115/src/install/integrity.rs)
  accepts SHA-256 SRI. Each local tuple can bind the already recorded archive
  digest, without changing the archive, dependency version or compiler.
- The text-lock top-level overrides must match the consumer manifest. An omitted
  override is a changed package according to the pinned
  [package diff](https://github.com/oven-sh/bun/blob/da867c60bf0bcbf9d6d36994f8ca0efa42075115/src/install/lockfile/Package.rs).

The corrected seed includes exactly the selected six local rows (CLI, core,
protocol, runtime, renderer and adapter), with unchanged manifest dependencies and
the CLI bin. A row is `[name@relative.tgz, INFO, sha256-SRI]`; the six identical
`file:relative.tgz` overrides appear in both the manifest and the lock. Every
registry tuple, including the nested helper-module-imports 7.18.6 record and
optional-peer declarations, remains equal to the retained source data. Runtime
validation compares all expected local rows and the complete override map, rather
than ignoring an arbitrary local resolution.

## Read-only command boundary

The pinned [`pm ls` implementation](https://github.com/oven-sh/bun/blob/da867c60bf0bcbf9d6d36994f8ca0efa42075115/src/runtime/cli/package_manager_command.rs)
loads the lock and lists its in-memory dependency tree. Its `Pm` initialization
sets `writes_package_json=false`; existing package/lock files are opened read-only.
This path does not install, save a lock, run scripts or invoke archive extraction.
It initializes shared configuration/HTTP infrastructure, so each command receives
an explicit minimal environment and owned cache. The before/after inventory must
remain unchanged. No node_modules or extra lock/config file is supplied.

`scripts/quality/standalone-lock-control.ts` will use the existing retained
`c908049` package-set manifest, original generated Solid/React TypeScript manifests
and original seed bytes. It computes corrected seeds through the actual corrected
product functions, preserving those input identities. It stages fresh owned data
directories outside the source checkout and original experiment directory. It
requires a clean, normally committed source tree and records that source, the
compiler, all input/staged file digests and raw command outcomes.

Execute exactly these four `bun pm ls --all` calls, once and in this order:

| Control              | Input                                                  | Expected result                                                                                           |
| -------------------- | ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| Original Solid seed  | Original retained manifest/lock bytes                  | Exit 1, missing root dev dependency `@bun-native/cli` and public `InvalidLockfile`; no installer fallback |
| Original React seed  | Original retained manifest/lock bytes                  | The same defined lock-parse failure                                                                       |
| Corrected Solid seed | Original manifest plus complete product-generated lock | Exit 0, listing all selected local packages and the preserved nested helper version                       |
| Corrected React seed | Original manifest plus complete product-generated lock | The same successful parser/listing contract for React                                                     |

Each call has a 10-second limit with explicit `SIGKILL` on timeout; the controller
records and rejects Bun's `exitedDueToTimeout` flag as well as any signal. Its
bounded Git reads use the same timeout/kill policy. The overall parser-call window
is 45 seconds; a call starts only if its full 10-second allowance remains. A forced
outcome cannot pass. Stop at the first unexpected result, retain every output/status and
mark later controls unrun. No retry, additional variant, package/install/create/
build command, lifecycle script, native executable or GC workload is allowed.

The corresponding inert metadata tests and cache-error predicate tests run
separately as source checks. The latter retain the original 869-byte mixed error
and require exact exit 1, known external-package cache errors, and no invalid-lock
fallback or unrelated errors. The pinned cache code emits either a missing
registry-manifest diagnostic or `--offline: "package" is not in the cache`; accepting
both source-backed forms does not turn the original mixed observation into a pass.

Any later full consumer cohort requires its own exact published correction and
reviewed plan. This parser result alone cannot authorize a claim of installability,
offline-cache sufficiency, relocation, AOT compilation or native behavior.
