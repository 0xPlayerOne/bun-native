# First hosted standalone-consumer qualification: original failed run

This research archive preserves the first hosted installed-consumer execution
for [PR #388](https://github.com/0xPlayerOne/bun-native/pull/388). The original
Validation run **failed**. All four preparation cases completed, six native cases
passed, React JavaScript development failed the existing OS-close requirement,
and React JavaScript AOT was not run. The earlier source-quality and portable
Protocol failures remain separate failures. No workload was retried to prepare
this archive, and no cause or production fix for the close failure is established.

This is a data-only preservation branch intended for a **closed, unmerged research
PR**. It changes no production source, workflow, deadline, assertion or toolchain.

## Exact original source and execution

| Identity             | Original value                                                                                                                                          |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Published PR head    | `d09ed9068b472337337e07accbf0e465f2e8c1d1`                                                                                                              |
| Actual tested merge  | `d04361e69fb2b71b51a995287ac5d328f0812633`                                                                                                              |
| Tested tree          | `a906a768ceec7efaf5f47ff9ae41c8fe05876aa4`                                                                                                              |
| Tested merge parents | `c4de68deee812cd816316b33f9276786e6eae5c8`, then the published head                                                                                     |
| Validation           | [41929577560](https://github.com/0xPlayerOne/bun-native/actions/runs/41929577560), attempt 1, failure                                                   |
| Native Linux job     | [126922751144](https://github.com/0xPlayerOne/bun-native/actions/runs/41929577560/job/126922751144), failure                                            |
| Final Gate           | `126931918606`, failure                                                                                                                                 |
| CodeQL               | [41929578336](https://github.com/0xPlayerOne/bun-native/actions/runs/41929578336), attempt 1; Detect, all four actual analyses and the aggregate passed |
| Bun revision         | `da867c60bf0bcbf9d6d36994f8ca0efa42075115`                                                                                                              |
| Built release host   | 29,478,432 bytes; SHA-256 `81f06bcc2025fb5c6e2b674106c2d1441b5063c6a4613dd78580fb1c631bad4a`                                                            |

All 544 recorded source files match the tested Git tree. The independent package
audit also checked all 53 package source payloads, including the 20-file original
CLI closure. The host identity above was checked against the actual original
unsigned-host archive payload, without executing it during review.

The complete twelve-job Validation result is **seven successes and five
failures**, including the aggregate Gate:

| Job                               | ID             | Conclusion |
| --------------------------------- | -------------- | ---------- |
| Source quality                    | `126922750409` | failure    |
| Protocol (macos-15)               | `126922750741` | failure    |
| Protocol (windows-2022)           | `126922750937` | failure    |
| Protocol (ubuntu-24.04)           | `126922750982` | success    |
| AOT native interop (windows-2022) | `126922750838` | success    |
| AOT native interop (ubuntu-24.04) | `126922750872` | success    |
| AOT native interop (macos-15)     | `126922750926` | success    |
| Security / Dependency audit       | `126922751092` | success    |
| Native Linux                      | `126922751144` | failure    |
| Native Windows                    | `126922751298` | success    |
| Native macOS                      | `126922752002` | success    |
| Validation / Gate                 | `126931918606` | failure    |

## Installed-consumer results

The fixed preparation completed seven package operations, four project creates,
four offline installs from the populated pinned cache, four strict checks, four
public-import inspections and four AOT builds. These were 21 outer preparation
commands, all with exit zero and joined, unforced cleanup. Installed inventories,
contained links and exact pinned integrity markers are original controller
observations; the removed dependency trees cannot be reinspected from this
archive. The consumer Cargo/Rust sentinels recorded no invocation; the native host
was built separately by the framework job.

The eight planned native cases retain their original order and classifications:

| External consumer | Preparation | Development native     | AOT native  |
| ----------------- | ----------- | ---------------------- | ----------- |
| Solid TypeScript  | passed      | passed                 | passed      |
| Solid JavaScript  | passed      | passed                 | passed      |
| React TypeScript  | passed      | passed                 | passed      |
| React JavaScript  | passed      | **failed at OS close** | **not run** |

The independent native audit verified the complete counter-zero and counter-one
trees and a fresh, ordered native pointer pair for all seven executed cases. The
six successful cases additionally have normal OS close, one zero-resource stopped
acknowledgement, IPC disconnect, joined exit zero and no forced termination. This
is hosted Linux X11 evidence with the recorded llvmpipe software renderer, not
physical GPU, display-presentation timing, accessibility or IME qualification.

React JavaScript development reached the same complete counter paint and pointer
checks, then exceeded the unchanged five-second OS-close wait. The subsequent
read-only probe still found X window `4194305` owned by host PID `38422`, start
ticks `157518`. Its native log ends after the counter-one paint and has no
`native_window_closed` marker. The IPC owner recorded no stopped acknowledgement
or final-resource counters. Its `zero_resources: false` therefore means an absent
successful acknowledgement; it is **not** a measured retained-root or nonzero
counter result.

The failed native driver and IPC owner required forced cleanup. Their outer
wrapper joined and exited 1 without being forced; all 28 outer commands joined,
with 27 exit-zero results and this one exit-one result. No observed or unreaped
process remained, and the aggregate owned directory was subsequently removed.
Later cleanup does not make the failed native case pass. The failed command also
preceded its post-case consumer-input recheck; no such recheck is inferred.

The retained records do not establish delivery of `WM_DELETE_WINDOW`, GPUI's entry
into its close handler, or the cause of the missing removal. The untimed stderr
message `Native output closed before shutdown` cannot distinguish an initiating
failure from later forced cleanup. The empty optional phase list does not mean
seven instrumented close phases failed: those phase sites belong to a different
fixture and are absent from the unchanged CLI templates. The fixed sequence
stopped before React JavaScript AOT; there is no eighth native case directory.

## Retained bytes and independent audits

`original-evidence.tar.gz` is **3,356,041 bytes**, SHA-256
`75166f5d52368c07d4b2ab513992b4ffa7c6f781d38fbcfcca9085e876ad0172`.
It contains **284 unique regular members**, with 14,499,045 uncompressed payload
bytes. Its exact membership and byte round trip were checked by the collector;
an independent root audit compared every member against original ZIP, log, API,
Git or collector-plan bytes.

The full original native artifact was `13372920151`, `native-linux-X64`,
32,007,383 bytes, SHA-256
`5d5db7e9fbeb84393b8fba1996925f4313ef8d77a457f5385400518aff4c1cd6`.
All **2,085** original regular files are hashed in
`full-zip-inventory.json.raw`: **235 retained, 1,850 omitted**. The full original
ZIP is not embedded. The remaining retained members comprise seven original API
records, five complete job logs, 27 exact source snapshots, the collector and its
predeclared plan, and both original protocol ZIPs plus their six unchanged member
files.

The archive retains all seven package archives, generated source/configuration
and locks, available preparation receipts and command logs, four actual AOT
development modules/maps, and all seven executed native cases' raw
paint/input/process/IPC records, screenshots and logs. The two complete protocol
environment artifacts are preserved separately:

| Artifact                              | Bytes | SHA-256                                                            |
| ------------------------------------- | ----- | ------------------------------------------------------------------ |
| `13370124944`, `protocol-macOS-ARM64` | 1,188 | `12fe66199118d3f8284f4809cd47855f46ab7dd0df271a02f43f22527115660e` |
| `13370468930`, `protocol-Windows-X64` | 1,195 | `181c6f9c6d1ff1920760d95e0671c3d76334ab5cc00aff729d1c678618298a51` |

Each protocol ZIP retains its exact `bootstrap.txt`, `bun-bootstrap.log` and
`toolchain.txt` bytes. The original Windows job log also retains its 1,372 CRLF
sequences. No original record was reformatted. The `.json.raw` suffix protects
byte-exact JSON from normal source-formatting hooks.

Outside the unchanged TAR:

- `collection-receipt.json.raw` records the collector's original source and
  artifact bindings. Its collection-time **independent audit pending** field
  remains unchanged; the subsequent audits below supplement it.
- `retained-members.json.raw` and `full-zip-inventory.json.raw` provide exact
  retained membership and complete original inclusion/omission inventories.
- `audits/tooling-preparation.json.raw` independently checks package source,
  generated consumers, locks, preparation commands, source maps and build
  receipts, with their limits.
- `audits/native-cases.json.raw` independently checks the seven executed native
  cases and the immutable close-path source, without causal attribution.
- `audits/root-bytes.json.raw` independently checks all retained bytes, original
  member hashes, source identities, complete jobs and outer-command cleanup.
- `archive-receipt.json` binds these unchanged files and the archive source base.

The audit records preserve their own corrected data-review assumptions: a
per-package source-projection contract, legitimate unchanged-geometry reuse, and
the additional CodeQL Detect job. These were audit-preparation corrections, not
new product executions or changes to the original observations.

## Explicit omissions and remaining limits

The four AOT executable payloads, their `launcher.ts` files and inner
`compile-aot.stdout.log` / `compile-aot.stderr.log` files were **not retained by the
original d09 controller and are unrecoverable from this artifact**. Source-bound
build, inspection and fingerprint receipts remain; this archive does not promote
them to a new inspection of missing binary sections. A later retention correction
cannot replace those original missing bytes.

Caches, installed `node_modules`, Bun/host/large application executables, duplicate
staging trees and unrelated native scenarios' raw payloads are omitted. Existing
hashes and full inventories identify the omitted data; complete native-job logs
and metadata preserve other steps' outcomes without implying their individual
predicates were re-audited here.

The four retained module maps bind 118 mapped inputs. The two Solid entry sources
have the existing universal transform, so original TSX/JSX line-and-column
fidelity is not claimed. Per-case wrapper records that report unavailable source
or host-path fields remain unchanged; the outer verified inventory, explicit
expected-host paths, lifecycle fingerprints and PID/start-ticks observations
provide the documented binding.

The prior local consumer result is separately preserved in
[closed research PR #403](https://github.com/0xPlayerOne/bun-native/pull/403);
earlier [#394](https://github.com/0xPlayerOne/bun-native/pull/394),
[#397](https://github.com/0xPlayerOne/bun-native/pull/397) and
[#400](https://github.com/0xPlayerOne/bun-native/pull/400) failures remain distinct.
The later prepared correction tree `b8c5a7e16dac5a6160b876da4f11a0017abfda10`
(prepared PR head `f8bfb869b45df7140537d50fa348efd40c2cea83`, local ordinary merge
`2a199413aaf307a6ed4851a0c2b79fcd059a78a9`) is not qualified by this d09 evidence.
PR #388 remains draft. Full installed-consumer native acceptance, a causal close
fix, physical hardware, additional platforms, watch, long soak, heap/retention,
signing and performance claims remain outside this archive.
