# M6 — persistent development sessions

## Implemented and locally qualified scope

M6 implements opt-in replacement of trusted Bun application code while the stable
desktop owner retains windows, browser sessions, terminals and managed processes.
The retained macOS arm64 execution at
[`96ce3fc2754c4e34e065bb58c9f183ac5abc7462`](https://github.com/0xPlayerOne/bunly/commit/96ce3fc2754c4e34e065bb58c9f183ac5abc7462)
passed 500 actual backend replacements, 508 renderer receipts and a separate
controlled relaunch. A separately pinned comparison executed the same selected
edit outcome in Bunly, Electrobun and Mirin, with all 15 rows passing.

This report records the implemented scope and retained local evidence.
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
recorded here. This integrated native run establishes macOS arm64 coverage only.

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
