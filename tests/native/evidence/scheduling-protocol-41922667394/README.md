# First scheduling qualification: preserved protocol retention failure

The first exact-head qualification of [PR #396](https://github.com/0xPlayerOne/bun-native/pull/396)
failed in [Validation 41922667394](https://github.com/0xPlayerOne/bun-native/actions/runs/41922667394),
attempt 1. Ubuntu's existing `retained window unsubscribe handles release their
callbacks immediately` test observed one live WeakRef where the unchanged
assertion required zero. The full suite reported **704 pass, 1 fail, 5,479
assertions, 705 tests across 55 files**, in 35.86 seconds.

All ten other implementation jobs passed. The actual final aggregate received
`protocol: failure`, with its other five dependency families successful, and
exited 1. The Validation run remains **failed**, and scheduling's merge acceptance
remains blocked. This archive is intended for a draft research PR closed unmerged;
it changes no production code, workflow, assertion, timing or toolchain.

## Exact source and environment

| Identity                              | Value                                                              |
| ------------------------------------- | ------------------------------------------------------------------ |
| Published scheduling head             | `b813d1bb7c33567c17bbd3ce0d0036db562b6769`                         |
| Actual tested merge                   | `85a927ce871a4b51cff59a8f9637e12e8031653e`                         |
| Tested tree                           | `8a1cf2ae8a037946b3ef83ce81de4a960f22df01`                         |
| Equivalent local source               | `01d8e07c7a4f236f42d58b93c58026dfcd452075`                         |
| Accepted base and this archive's base | `c4de68deee812cd816316b33f9276786e6eae5c8`                         |
| Failed Ubuntu job                     | `126898883953`, step 9, `bun test tests`                           |
| Actual failed aggregate job           | `126908908862`                                                     |
| Bun revision                          | `1.4.4-canary.1+da867c60b`                                         |
| Bun executable SHA-256                | `fe406996b9915f388e3fad9e6e29ece9c7cb81e06257bbcb4c50f91691b46810` |
| Runner                                | Ubuntu 24.04, Linux x64, kernel `7.0.0-1014-aws`                   |
| Rust / Cargo                          | Rust 1.98.1 (`48a229cea`), Cargo 1.98.1 (`797e8a9bc`)              |

The assertion is at `tests/renderers/revoker-ownership.test.ts:22:84`. It creates
ten callback/revocation observations, releases every handle, and performs the
existing two zero-delay turns and two `Bun.gc(true)` calls before checking the
WeakRefs. It uses real public-core IPC with the headless protocol peer. The
original observation does not identify the surviving callback's index or explain
its retaining owner. It provides no native GUI or heap-graph diagnosis. The Rust
protocol step following the failed TypeScript step was skipped.

Compared with accepted main, the tested source changes only
`.github/workflows/bun-native.yml`, the new `.github/workflows/native-audit.yml`
and `docs/native-platforms.md`. Fourteen recorded Git objects establish exact
parity for the complete packages, tests, scripts, native, examples and benchmarks
trees and relevant dependency/configuration/toolchain files. The copied failing
test, renderer lifetime source and test support are byte-exact. This parity does
not establish the retention cause or justify changing the collection oracle.

## Final original job outcomes

| Job                               |           ID | Conclusion  |
| --------------------------------- | -----------: | ----------- |
| Source quality                    | 126898883511 | success     |
| Protocol (ubuntu-24.04)           | 126898883953 | **failure** |
| Protocol (macos-15)               | 126898884389 | success     |
| Protocol (windows-2022)           | 126898884204 | success     |
| AOT native interop (ubuntu-24.04) | 126898884318 | success     |
| AOT native interop (macos-15)     | 126898884120 | success     |
| AOT native interop (windows-2022) | 126898884131 | success     |
| Native Linux                      | 126898884528 | success     |
| Native macOS                      | 126898884646 | success     |
| Native Windows                    | 126898884683 | success     |
| Dependency audit                  | 126898884763 | success     |
| Validation / Gate                 | 126908908862 | **failure** |

CodeQL run `41922668175`, attempt 1, completed successfully, including all four
actual language analyses and aggregate check `126899334388`. The optional
OpenCode Security Detect and Scan checks were skipped. These are retained status
observations; this archive does not repeat any analysis or inspect individual
successful native predicates.

## Explicit workflow byte boundaries

The complete Validation jobs suffix is identical in the accepted base and tested
tree. Two previously reported digests use different, now explicit boundaries:

| Slice                                                                                    |  Bytes | SHA-256                                                            |
| ---------------------------------------------------------------------------------------- | -----: | ------------------------------------------------------------------ |
| From the LF before `jobs:` through EOF, including the full seven-byte `\njobs:\n` marker | 11,054 | `ab6ee52ad7ca4f991f98b484dc3673bf563a510212c4165c3dfa67949a0da404` |
| After the entire `\njobs:\n` marker through EOF                                          | 11,047 | `026939a58e1e8bcefd80b4dce5d340e3187c1977954963153692ececda83de2a` |

The marker starts at byte 572 in accepted main and byte 568 in the tested file;
the latter is four bytes shorter because `workflow_dispatch` became
`workflow_call`. An interim message incorrectly attributed the second digest to
removing only one leading LF. Direct byte computation corrected that explanation.
Removing only the LF gives a separate 11,053-byte slice with digest
`1f656fae50a88dcc3c377199a876fdf75b4cacd9cc8ec36019de94a82622da38`.

## Retained bytes and omissions

`original-evidence.tar.gz` contains 20 regular relative members, 334,329
uncompressed file bytes. Every member was round-trip checked against its original
input; the full per-file inventory is in `audit-receipt.json.raw`.

| Original or archive                           |   Bytes | SHA-256                                                            |
| --------------------------------------------- | ------: | ------------------------------------------------------------------ |
| This exact evidence archive                   |  52,903 | `2a81a8aa1e67d0f253cb4047c869fee2ff7ba65db3621ed648676871f51e70d8` |
| Original protocol ZIP, artifact `13367647897` |   1,197 | `032e8475cdd066664f6ad6526a7220400da897d3932e117bcdeb2ca79a33cbca` |
| Complete decoded Ubuntu job log               | 132,606 | `f19f35c6d788562038f6fc63e2ada3034083c11a27e7289a3f3b91f8b46c1d00` |
| Complete decoded aggregate job log            |   2,567 | `625de92c1ca69206bf051e0d15ff4f049582aab7f8e556c1ebcb552d88c2e2f3` |

The archive includes the unchanged original ZIP and all three decoded environment
members, both complete decoded job logs, the exact aggregate `RESULTS` JSON slice,
all twelve full attempt-1 job records, final run/check/CodeQL/artifact metadata,
the tested merge object, and six exact source files. The decoded logs preserve
their leading UTF-8 BOMs. Raw source records retain their original failures.

Passing native/AOT/protocol ZIPs, binaries, screenshots, individual case records
and their job logs are deliberately omitted. Their artifact IDs, sizes and
API-declared digests are listed, with byte download and predicate audit explicitly
marked false. A successful job status is not presented as a new independent audit
of every native assertion.

No runtime, native, GC, test, CI or installer workload was invoked to prepare this
archive. Existing dependency links support its ordinary documentation hook.
No head mutation or retry replaced the failed run. The scheduled/manual
protected-main caller has not executed, so caller execution remains a separate
pending acceptance item for [#256](https://github.com/0xPlayerOne/bun-native/issues/256).
The callback-retention observation belongs with [#287](https://github.com/0xPlayerOne/bun-native/issues/287);
its cause remains unestablished.
