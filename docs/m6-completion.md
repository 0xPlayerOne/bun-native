# M6 — persistent development sessions

## Implemented scope and retained qualification

M6 implements opt-in replacement of trusted Bun application code while the stable
desktop owner retains windows, browser sessions, terminals and managed processes.
The retained macOS arm64 execution at
[`96ce3fc2754c4e34e065bb58c9f183ac5abc7462`](https://github.com/0xPlayerOne/bunly/commit/96ce3fc2754c4e34e065bb58c9f183ac5abc7462)
passed 500 actual backend replacements, 508 renderer receipts and a separate
controlled relaunch. A separately pinned comparison executed the same selected
edit outcome in Bunly, Electrobun and Mirin, with all 15 rows passing.

This report records the implemented scope and retained local and hosted evidence.
[PR #130](https://github.com/0xPlayerOne/bunly/pull/130) carries the final-head
portable/hosted validation and merge record. Merge requires all applicable checks;
the local observations below do not assert their outcome or additional platform
coverage. The already accepted #28/#29 increments retain their separate records.

This is a functional development profile, not production release qualification,
an untrusted-plugin sandbox, arbitrary application reload, or a demonstrated
performance advantage. [#124](https://github.com/0xPlayerOne/bunly/issues/124) and
[#129](https://github.com/0xPlayerOne/bunly/issues/129) remain open native reliability
work. Successful M6 observations do not erase their retained failures.

| Issue                                                 | Implemented and qualified scope                                                                                                                                                                   | Record                                                                                                                                          |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| [#28](https://github.com/0xPlayerOne/bunly/issues/28) | Stable resource owners, replaceable generations, state/schema compatibility, bounded work, stale callback rejection and dependency-ordered disposal                                               | Closed through [PR #126](https://github.com/0xPlayerOne/bunly/pull/126); [managed generation contract](managed-generations.md)                  |
| [#29](https://github.com/0xPlayerOne/bunly/issues/29) | Pinned Bun experiments select one Worker per application generation and an explicitly preselected application-generation subprocess fallback                                                      | Closed through [PR #127](https://github.com/0xPlayerOne/bunly/pull/127); [mechanism qualification](reload-mechanism-qualification.md)           |
| [#30](https://github.com/0xPlayerOne/bunly/issues/30) | Prepare, validate, quiesce, atomic publication, retirement and explicit failure; bounded communication and request settlement; actual isolate exit; source-mapped diagnostics                     | [Service reload](service-reload.md), Worker/process integration tests and the retained native workload; PR #130                                 |
| [#31](https://github.com/0xPlayerOne/bunly/issues/31) | Reattach exact native resources with current document/policy authority; bounded lifecycle events; stable terminal output and process ownership; reject closed resources and stale generations     | [Managed desktop resources](managed-desktop.md), native protocol/PTY tests and `examples/managed-desktop`; PR #130                              |
| [#32](https://github.com/0xPlayerOne/bunly/issues/32) | Verified prepared-host cache, Bun dependency builds, independent frontend/backend invalidation, shared/generated changes, instance isolation and explicit configuration restart                   | [Development hosts](development-host.md), cache/watcher integration tests and retained runtime inventories; PR #130                             |
| [#33](https://github.com/0xPlayerOne/bunly/issues/33) | 500 actual supported replacements with failure fixtures, retained desktop/PTY identity, resource measurements, frontend/shared edits, controlled relaunch and current pinned reference comparison | [Native qualification](managed-development-qualification.md), [comparison](managed-comparison.md) and the five retained archives below; PR #130 |

The #28 ownership model and #29 mechanism matrix have their own accepted evidence,
including their declared platform execution. Their earlier model transitions and
synthetic owner experiments are separate from the 500 actual desktop replacements
recorded here. The accepted integrated native captures at the historical
checkpoints below establish macOS arm64 coverage; the later hosted run recorded
below also qualifies the complete Linux workload and restart. The final-head
platform gates and merge receipt are maintained in PR #130, separately from those
fixed captures.

## Supported lifecycle

`ServiceReloadHost` prepares one candidate beside the serving application Worker.
The old generation remains available during preparation. After readiness, native
resource validation and quiescence, the host publishes one handler generation and
waits for the old isolate to retire before reporting successful replacement.
Framework calls settle explicitly; a cancelled caller does not release a resource
reservation until the underlying operation actually settles. Failed preparation
keeps the previous generation available. Unconfirmed cleanup requires explicit
recovery and retains the affected ownership and artifacts.

`ManagedDesktopResources` keeps the actual window, view, session, terminal and
supervisor handles in the stable owner. Each replacement receives host-issued
bindings, not authority reconstructed from serialized IDs. Native authorization
is checked again before operations, and publication rejects a locally revoked
policy epoch even before a navigation acknowledgment updates the document state.
Generation listeners and timers retire; the bounded lifecycle journal and original
terminal writer remain with the stable owner.

`DevelopmentSession` uses Bun's resolver and bundler, immutable generation bundles
and source maps. It routes backend edits to replacement and frontend edits to the
configured frontend integration. Shared edits reach both paths. Prepared host
reuse checks actual native/engine/app/configuration identities and complete
artifact inventories. Ordinary warm edits perform no systems compilation or
whole-runtime copy. The native workload runs with an empty `PATH`; the retained
source, cache and artifact records establish the exercised path.

The APIs, capacities, callback contracts and restart conditions are specified in
the linked guides. Ordinary imperative applications remain supported with their
documented full-restart behavior. There is no automatic replay of external side
effects, arbitrary closure migration, native-addon replacement or per-service
Worker/process fan-out. A Worker provides trusted-code lifecycle isolation; it
does not isolate native crashes or grant a security boundary.

## Retained attempts and offline replay

The [manifest](../evidence/m6-managed-development/manifest.json) binds five
compressed archives to exact source commits, original private report identities,
exported JSON identities and original outcomes. Each failed attempt remains a
failure under replay.

| Archive                                                                                             | Source                                     | Retained outcome                                                                                                                                                             |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Startup public-map failure](../evidence/m6-managed-development/startup-public-map-failure.json.gz) | `4b211e762bba2cbca8ca33b4c9f4ae3f08c85012` | Rejected before UI startup: a public renderer source map violated the native public-asset contract; exit 78. No replacement workload is accepted.                            |
| [Clone metadata failure](../evidence/m6-managed-development/clone-metadata-failure.json.gz)         | `a05f0ed4ffb51ce880c9e3545edade6a736b56d1` | The native trial completed 500 replacements and 508 renderer receipts with clean exit, but prepared-host `ctime` equality failed. The overall report remains rejected.       |
| [Last-window quit failure](../evidence/m6-managed-development/last-window-quit-failure.json.gz)     | `bbefea37828fef4746589a4d319d1d09b8ec8a03` | Completed 500 replacements and 508 renderer receipts, but a redundant `quit` raced normal last-window shutdown and the backend exited 1. No controlled relaunch is accepted. |
| [Native managed acceptance](../evidence/m6-managed-development/native-managed-acceptance.json.gz)   | `96ce3fc2754c4e34e065bb58c9f183ac5abc7462` | Passed the complete soak, ordinary native/helper cleanup, artifact checks and distinct controlled relaunch.                                                                  |
| [Common-workload comparison](../evidence/m6-managed-development/common-workload-comparison.json.gz) | `db22f4e3f338b176a2a430f0b486b417232f9fbe` | Passed all 15 initial/warmup/measured rows across the three pinned frameworks; performance eligibility remains false.                                                        |

Reproduce the retained acceptance checks with:

```sh
bun run verify:managed-acceptance
```

This command replays evidence; it does not launch a desktop or fetch source.
The recorded historical Git objects must already be present. Missing source,
modified archives, altered scenario order, incorrect metrics, absent cleanup or a
changed historical failure rejects verification. The manifest keeps three
different identities: the original private report, the expanded sanitized JSON,
and its gzip archive. Their hashes and byte counts are not interchangeable.
Fixture nonces and local-path redactions are declared by the export metadata;
the verifier does not pretend to reconstruct the private original bytes.

The startup fix removed public `.map` assets while retaining backend source maps.
The metadata rule was narrowed to the exact macOS executable whose observed
Chromium signing clone changes `ctime`; all content, link, ownership and other
identity checks still apply, including positive clone removal and final link
count one. The shutdown fix recognizes only the transport's explicit normal
shutdown cancellation of redundant `quit`; native errors, request deadlines and
RPC closure failures still reject. These corrections qualified later executions
without retroactively accepting earlier trials.

### Retained hosted failures

[Native CEF workflow 40584770106](https://github.com/0xPlayerOne/bunly/actions/runs/40584770106)
failed on all three platforms at PR head
`109a895f9f56184215006dcce327c2735d779563`. Its clean test merge was
`1c04bcce73ceb099f11ba9e9c8a8bdb409117ab4`; both revisions had tree
`edb1519ee101989c842120f94a0881491b532338`. These failures remain separate from
the earlier accepted local macOS execution.

The [hosted failure index](../evidence/m6-managed-development/hosted-failures/manifest.json)
records the downloaded artifact IDs and ZIP digests, exact exported report
digests, compressed archive digests, source identities and unchanged failed
outcomes. It retains the following reports:

| Report                      | Observed outcome                                                                                                                                                                                                                                                                                                                             |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Linux managed development   | Completed 500 replacements, 508 renderer checks and all 1,530 accepted requests; exited 0. The completion marker interleaved with a native shutdown-phase line, so ordered shutdown was rejected. Warm preparation also rejected the complete cache inventory. The changed entry was not captured by that revision; no restart was admitted. |
| macOS managed development   | Completed 500 replacements, 508 renderer checks and all 1,530 accepted requests; exited 0. The observer saw a new clone and its removal but did not positively identify a cleanup helper. Cleanup qualification and the metadata exception therefore failed. Warm cache verification passed; no restart was admitted.                        |
| macOS fault matrix          | All six fault scenarios satisfied their individual expected outcomes and ordered shutdown. None collected positive helper evidence, so the aggregate qualification failed.                                                                                                                                                                   |
| Windows managed development | Initial application generation did not become ready. No replacement or renderer check completed. One accepted request settled, the backend exited 1 and owned counters returned to zero. Warm cache and prepared artifact checks passed; no restart was admitted. The generic startup error did not retain the underlying broker failure.    |

These downloaded inputs were already nonce-redacted exports. The artifact did
not contain raw private report hashes, so the index explicitly identifies the
input as an export and does not invent an original-report identity. Windows
workspace paths are additionally redacted, with embedded original hashes left
unchanged. Both Windows export variants are retained: two Unicode inventory
path strings differ because of an encoding discrepancy; their remaining parsed
fields agree. These supplemental archives are indexed separately from the five
historical captures replayed by `verify:managed-acceptance`.

The Linux completion-order regression requires both maintained fixtures to await
the private native shutdown receipt before writing their result or completion
marker. A failed resource-cleanup step still attempts backend disposal and
records a failed result. The cache diagnostic retains the exact expected and
actual inventory comparison, or an explicitly incomplete scan, without relaxing
the cache-integrity rejection. A subsequent native run must establish any
correction; these original failures are not promoted by later changes.

### Follow-up hosted native validation

[Native CEF workflow 40590492356](https://github.com/0xPlayerOne/bunly/actions/runs/40590492356)
ran PR head `d44bd565ecea22c5b27d640d41c54398c02f47e9` as clean test merge
`c47eee9cadbf0c4bc1d06b97f46d98c2eccbffdc`; both have tree
`441f4643767e30bb631837c12e3d4ea790f95148`. macOS passed all eleven native
matrix stages. Linux and Windows remained failed, with their new diagnostics
retained under `followupWorkflows` in the hosted failure index.

| Platform | Observed outcome                                                                                                                                                                                                                                                                                                                                                                                                        |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Linux    | The soak passed 500 replacements, 508 renderer checks, 1,530 settled requests and ordered native shutdown. CEF shutdown took 20 ms and process-stop took 13 ms. Warm cache verification then rejected one added empty directory, `Managed Development/extensions`, with no removed or changed entries. No restart was admitted.                                                                                         |
| Windows  | Generation 1 reached managed-resource validation and was rejected with `INCOMPATIBLE` / `ManagedError: DENIED`; its candidate was retired without publication. No replacement or renderer check completed. The single accepted request settled, the backend exited 1, and the observer reported no timeout, cancellation, overflow, orphan or survivor. Warm cache and artifact checks passed; no restart was admitted. |
| macOS    | The complete soak and distinct controlled restart passed, including positive cleanup-helper identity and exact clone removal for both launches. The six fault scenarios and four terminal-load visibility modes also passed with positive helper and clone evidence.                                                                                                                                                    |

The Linux diagnostic records the expected and actual complete inventories from
the scan that rejected reuse. Chromium 156.0.8078.17's
[external-extension path](https://github.com/chromium/chromium/blob/156.0.8078.17/chrome/common/chrome_paths.cc)
selects and creates `DIR_MODULE/extensions`; its
[external provider](https://github.com/chromium/chromium/blob/156.0.8078.17/chrome/browser/extensions/external_provider_impl.cc)
uses that directory on Linux. The cold managed-fixture assembly now declares and
validates the empty directory before the immutable cache inventory is published.
Warm verification still compares every entry and rejects later additions, file
changes, links or directory removal; it neither repairs nor excludes this path.
The subsequent Linux execution recorded below qualifies this correction.

The Windows fixture also contained a reproduced terminal parser incompatibility:
the old consumer accepted plain records but rejected the same records wrapped in
VT control operations. The corrected consumer reads actual xterm screen state,
with bounded internal writes and parser callbacks before stream credit returns.
Regressions preserve exact byte counts and checksums while rejecting malformed
partial records before scrollback can erase them. Additional diagnostics retain
the failed binding name, renderer error and terminal exit/closure. The hosted
`DENIED` export lacks the original terminal bytes and renderer error, so this
historical causal chain is not reconstructed from the later successful Windows
soak recorded below.

The macOS artifact is `12774692229`, ZIP SHA-256
`2b6fad772038cf64b1214247419a9a6fbd5aa931fe0693a5b75339cbd9030311`
(2,489,135 bytes). Its nonce-redacted `managed-development.json` export is
2,048,705 bytes, SHA-256
`6ea02aabbe3e01c7f03afb9bf35312079aee69794f49686c9143d13d122ae6e1`.
Independent offline validation reapplied the complete managed acceptance rules
and matched all 291 source hashes to the exact test merge. This export identity
does not reconstruct an unavailable private raw report.

That hosted macOS soak completed 500 replacements and 508 renderer receipts,
settled all 1,530 accepted requests and returned owned counters to zero. Its
single PTY supplied 53,766 bytes and 1,651 records, including 1,148 autonomous
records; both cumulative checksum endpoints were `b908e755`. Main-isolate heap
median changed by −312,552 bytes and owner RSS median by +589,824 bytes, within
the unchanged finite sentinels. Soak and restart each observed one verified
cleanup helper and one removed clone, with cleanup durations of 293.598459 ms
and 203.424791 ms. Their CEF shutdown durations were 212 ms and 111 ms;
process-stop durations were 9 ms and 6 ms. Neither launch timed out, overflowed,
was cancelled or left an observed orphan or survivor.

Warm preparation verified the unchanged 427,981,134-byte runtime in
1851.967833 ms, with one total assembly and zero warm native copies or
compilations. The restart admitted backend revision 500, shared revision 1 and
the edited configuration, settled both requests and used fresh native and
renderer identities. Unsaved form, ephemeral session and login state were
absent as required by the full-restart boundary. These finite macOS passes do
not resolve the earlier failures or establish release or comparative performance
qualification.

### Hosted validation after cache and terminal corrections

[Native CEF workflow 40604917371](https://github.com/0xPlayerOne/bunly/actions/runs/40604917371)
ran PR head `7b3ab866a53ed2458a6c4a0bfbe3fde2a146ddc2` as clean test merge
`1d2b890411b835c7ab438011ce37f103564b0548`; both have tree
`4025f6f0c65d9067078daa14a69c49ad9bf3eddc`. Linux and macOS passed all eleven
native matrix stages. Windows passed the fixed soak and warm cache verification,
then failed its distinct controlled restart. The Windows job also exposed a
separate diagnostic-collection encoding error. The overall workflow remains
failed; none of its failed observations is promoted by the successful stages.

All three platform soaks completed 500 replacements, 508 renderer receipts and
1,530 accepted and settled requests, with one retained native PTY and zero
pending requests at shutdown. Independent acceptance replay matched all 292
source fingerprints to the exact test merge. Linux and macOS also passed their
separate restart acceptance; the retained Windows export continues to report
`passed: false`.

| Platform | Verified outcome                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Linux    | The empty `extensions` directory was present before publication of the cache inventory. Warm verification and the distinct restart passed. The PTY delivered 45,054 bytes in 1,387 records, including 884 autonomous records; both cumulative hashes were `0dccecc7`. Soak/restart process-stop took 11/6 ms and CEF shutdown took 21/26 ms.                                                                                                                           |
| macOS    | The soak and distinct restart passed with one positively verified cleanup helper and one removed clone per launch. All six fault trials and all four terminal-load modes also retained positive helper and clone evidence. The PTY delivered 38,454 bytes in 1,187 records, including 684 autonomous records; both cumulative hashes were `6ea5ed4f`. Soak/restart cleanup took 181.637750/174.440042 ms, process-stop took 3/1 ms and CEF shutdown took 131/83 ms.    |
| Windows  | The soak passed with 48,021 PTY bytes, 1,517 records, 501 acknowledgments and matching `ff3aabde` hashes; ordinary exit was 0. Warm cache verification passed. The restart rejected `view has no ready native document authority` before producing backend, renderer or identity receipts; its one accepted request settled and the backend exited 1. No observer timeout, cancellation, output overflow, orphan or survivor was recorded. Credentials remained gated. |

Linux warm verification reused 1,691,918,428 bytes in 2950.247493 ms; macOS
reused 427,981,134 bytes in 878.571333 ms; Windows reused 537,249,277 bytes in
1578.490500 ms. Each recorded one total assembly, zero warm native copies and
zero warm native compilations. Both accepted restarts applied revision 500,
shared revision 1 and the edited configuration, settled two requests, obtained
fresh native and renderer identities, and lacked the old unsaved form, ephemeral
session and login state. These timings remain descriptive, with performance
eligibility false.

Artifact and exported-report identities:

- Linux artifact `12780234276`: ZIP 3,609,751 bytes, SHA-256
  `02ff79b1a5d0ba00842c5b680844ab1b4a8c3f2087619f1441b9838bdf8277d5`.
  The canonical and run-specific managed exports are byte-identical: 5,919,528
  bytes, SHA-256 `8e618bcadb790a01fc5f0c11b84955ab733235126fae4657fa476681b9bd822c`.
- macOS artifact `12780544337`: ZIP 2,292,920 bytes, SHA-256
  `b20d20fc563bc2e6c2064ed85a043eabd2f84e89513d6abdb90508fd9a6fd534`.
  The managed export is 1,677,769 bytes, SHA-256
  `a79df460b3aecb00915bf3e4d3a0bef7f6a08de364f14dc212aa37a5ff79dfe5`.
- Windows artifact `12781211009`: ZIP 3,095,716 bytes, SHA-256
  `26df0026b66153c06ba6209aaff67c17770c5e7affd3b84d191be0dab85edbda`.
  Its canonical managed report copy is 4,991,237 bytes, SHA-256
  `dab5bc9ff55e4e638e841ecdb2cbe5366c70fb20110392eff28d4a2f44554428`.

The Windows collector failed at `scripts/hosted_cef.py:417` because a default
CP1252 read rejected byte `0x90` at position 3,851,785 of a UTF-8 report. This
happened before creating the run-specific alias and before the evidence-directory
nonce-sanitization pass. The surviving canonical input is therefore an
**unsanitized hosted JSON copy**, unlike the earlier already-sanitized inputs.
The [retained Windows archive](../evidence/m6-managed-development/hosted-failures/run-40604917371-windows-managed-development.json.gz)
applies the repository's nonce sanitizer and workspace-path redaction to that
exact input. The index records the separate input, expanded and compressed
identities and the missing alias. Embedded original observation/result hashes
remain unchanged; unavailable private original serialization is not reconstructed.

The restart correction separates the renderer RPC handshake from native document
readiness. Native RPC grants can arrive before `OnLoadEnd`, while `policy.scope`
correctly rejects a view whose navigation is still in progress. Both maintained
fixtures now wait for their renderer handshake and an exact URL/document-matched
`view.loaded` receipt before capturing authority. The observer is installed before
view creation and retains at most four early receipts, covering completion before
the create call returns. It shares the existing fixture deadline and removes its
listeners on completion or cancellation. The subsequent native policy call still
grants or rejects authority; the event itself grants none. Real native-transport
and RPC regressions reproduce the premature capture before the fix, then verify
renderer-first ordering, a load receipt coalesced with creation, and the unchanged
restart deadline. These ordering tests are not a substitute for native CEF
qualification of the corrected restart.

The collector correction explicitly reads all persisted UTF-8 JSON, log and
summary inputs as UTF-8. Invalid bytes fail without a lossy replacement rewrite.
Real-filesystem regressions reproduce both the earlier Unicode mojibake and this
CP1252 failure under a simulated locale default; malformed UTF-8 reports and
exports remain rejected and unchanged. The focused collector suite passed 20
tests and 19 subtests. A later Windows native run must still qualify the restart
correction and complete the gated stages.

## Native workload results

The accepted archive records Bun 1.4.3 with CEF 156.0.7 / Chromium 156.0.8078.17
on macOS arm64. The selected prebuilt's declared native source is
`de8cfc995de828e3b636fe77edbf79d113172cb5`, with matching current native source
tree and actual artifact inventories. The declaration is not embedded build
attestation. Source and artifact checks retain that limitation explicitly.

All 500 replacements use real edited dependency files and a fresh application
Worker. Syntax/import/initialization failures, a closed resource, a failing runtime
handler and an accepted old-generation request are exercised separately. The
renderer retains its unfinished form, session markers and native login cookie
across supported replacements. The original PTY launches once and continues
autonomous output while generations change.

| Observation                                              | Accepted result                                        |
| -------------------------------------------------------- | ------------------------------------------------------ |
| Successful backend replacements / renderer receipts      | 500 / 508                                              |
| Framework requests accepted / settled / pending          | 1,530 / 1,530 / 0                                      |
| PTY launches                                             | 1                                                      |
| Terminal bytes / parsed records                          | 39,411 / 1,216                                         |
| Autonomous producer records / generation acknowledgments | 713 / 501                                              |
| Cumulative terminal FNV checksum                         | `1f6978cd`                                             |
| Main-isolate post-GC heap, early / final median          | 7,013,939 / 7,683,172 bytes; change +669,233 bytes     |
| Stable-owner RSS, early / final median                   | 41,141,016 / 37,585,688 bytes; change −3,555,328 bytes |
| CEF shutdown / process-stop phase                        | 83 / 5 ms                                              |

The report retains checkpoint queue/resource counts and sampled process-tree,
thread and descriptor observations. Across 356 process-tree samples, the observed
peaks were 943,030,272 bytes of summed RSS, 10 processes, 180 threads and 249
descriptors. These independent peaks need not occur in the same sample. Brief
processes can be missed, and unavailable descriptor observations remain null.
The sentinels permit at most 32 MiB of
main-isolate heap growth and 256 MiB of stable-owner RSS growth between the fixed
early/final checkpoint medians. This finite pass does not prove universal leak
freedom. Worker heaps are outside the main-isolate heap counter, and summed
process-tree RSS may count shared pages more than once.

The prepared cache assembled the runtime once and verified 426,014,772 bytes on
both its cold and warm calls. Those calls took 3494.648666 ms and 763.851875 ms
respectively; they measure preparation/inventory verification, not each edit.
The warm path recorded zero native copies and zero native compilations, with
unchanged complete runtime contents and the narrowly qualified macOS clone
metadata disposition described above.

### Descriptive edit timings

The fixture writes real source files and explicitly calls `invalidate` with
`watch: false`. These measurements exclude filesystem watcher notification latency.
Build/reload duration and source-write-to-renderer acknowledgment are separate
quantities. The frontend adapter applies actual edited CSS and checks its browser
hash and computed styles; the shared edit updates both backend and frontend.

| Measurement                                          | Samples | Median, ms | p95, ms   | Maximum, ms |
| ---------------------------------------------------- | ------- | ---------- | --------- | ----------- |
| Backend build and replacement                        | 500     | 16.700917  | 58.348486 | 151.611958  |
| Backend-only source write to renderer acknowledgment | 499     | 20.122708  | 74.660046 | 185.430958  |
| Shared source edit to renderer acknowledgment        | 1       | 21.234250  | —         | 21.234250   |
| Frontend-only edit to renderer acknowledgment        | 1       | 2.372291   | —         | 2.372291    |

These are correlated sequential samples from one desktop execution, not
independent launches or confidence intervals. Their sample counts and distinct
endpoints are retained; no comparative performance conclusion follows.

### Controlled relaunch

The configuration change after revision 500 first returns `restart-required`
while the old valid generation remains usable. Only after successful soak
shutdown does the qualifier launch a fresh process from the verified prepared
runtime. Two requests settle, both ordinary cleanup gates pass, and CEF shutdown
and process-stop phases take 75 ms and 2 ms respectively.

The new window, view, session and renderer have fresh UUIDs. The edited backend
revision 500, shared revision 1 and changed configuration are applied; its
independently checked SHA-256 is
`3d68391bc95f36cf33c2aefed7bc35b8b1f27760f096457f0a675637d508d5dd`.
The old unfinished form, session storage and ephemeral login state are absent.
This is the documented loss of in-memory persistence at a full restart, not
seamless resource retention or credential migration. Native counters that can
repeat across processes are not used alone as proof of freshness.

## Current pinned comparison

The [comparison archive](../evidence/m6-managed-development/common-workload-comparison.json.gz)
executes an initial launch, one excluded warmup edit and three measured edits for
each framework. All 15 correctness rows passed. Each measured outcome includes
the changed backend response, the form and cumulative transcript check, xterm's
write callback and two animation frames. All frameworks serve identical browser
assets and numbered bytes.

| Framework                | Observed edit lifecycle                                              | Three measured edit durations, ms     | Actual Bun / CEF / Chromium       |
| ------------------------ | -------------------------------------------------------------------- | ------------------------------------- | --------------------------------- |
| Bunly                    | Retained native desktop and renderer; Worker replacement             | 86.376333, 49.902333, 81.642667       | 1.4.3 / 156.0.7 / 156.0.8078.17   |
| Electrobun 2.0.3-beta.26 | Official build, process relaunch and browser-owned state restoration | 8116.537541, 6832.988125, 2300.215125 | 1.4.0 / 147.0.10 / 147.0.7727.118 |
| Mirin 0.1.0-alpha.26     | Official build, process relaunch and browser-owned state restoration | 2216.705916, 2202.000583, 2281.571291 | 1.4.3 / 148.0.10 / 148.0.7778.218 |

The reference pages receive a form seed only on the initial launch. Subsequent
documents restore the actual preceding form, revision and transcript from their
same-origin browser storage. A fresh backend and page identity demonstrate
relaunch; restored state does not demonstrate native window/session retention.
The synthetic numbered stream is not the native PTY used by the separate soak.

Execution used a fixed framework order on an uncontrolled Apple M2 Max desktop
(Darwin 25.6.0, arm64).
There are only three correlated measured edits per framework, the engines and
backend runtimes differ, and all three process-sandbox cohorts remain unverified.
The report therefore keeps `performanceEligible: false`: no ratios, causal speed
claim, matched-security assertion or release claim is admitted. The full
[comparison guide](managed-comparison.md) defines the selected upstream workflows,
recorded environment and replay contract.

## Remaining qualification boundaries

- Final full portable validation, current-head hosted checks, review and merge are
  tracked on PR #130; this checkpoint does not substitute local native receipts
  for those gates.
- The integrated native persistence/relaunch workload and comparison were run on
  macOS arm64. Previous cross-platform mechanism or runtime acceptance does not
  establish this workload's Linux/Windows coverage.
- The frontend integration is the maintained fixture adapter, not proof of every
  frontend framework's HMR behavior. Browser source maps remain outside the native
  public-asset contract.
- Full restart, incompatible schemas/configuration/native identity, arbitrary
  unmanaged effects and native-addon replacement retain their explicit limits.
  The process fallback is selected before execution and never automatically
  replays uncertain mutations or turns failed cleanup into a seamless swap.
- Native teardown watchdog resolution (#124), reduced-visibility terminal-load
  failures (#129), production signing/security review and quiet matched-engine
  performance qualification remain separate work. No native deadline, sandbox,
  certificate policy, provider guard or final-zero assertion was relaxed to pass
  this profile.
