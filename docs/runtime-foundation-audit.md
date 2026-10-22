# Runtime foundation audit

Ownership correctness and bounded hot-path optimization after the tooling closeout.

**Scope:** Post-M3 runtime, native protocol, and authenticated cache; no M4 acceptance claim.
**Baseline:** Merged PR #85, recorded by full commit and source hashes in the measurement evidence.
**Evidence:** `evidence/runtime-foundation-local.json`; local measurements, not controlled product benchmarks.

## Correctness fixes

Creation snapshots the submitted session partition and view owners before awaiting
native completion. Caller mutation can no longer leak the original partition
reservation or attach a native view to a different local parent. Native creation
responses establish their ownership before a coalesced following lifecycle event
is consumed: initial navigation and immediate close events are no longer lost.
The transport returns its actual pending promise and drains response continuations
between frames; it does not introduce an unbounded event replay buffer.

Cancellation keeps the original native acknowledgement deadline. Cancelled and
pending calls share one 128-request budget; a late reply clears the retained timer,
and an absent reply retires the connection. Argument serialization happens before
allocating request identities, followed by a cancellation/closure/capacity recheck.
A reentrant `toJSON` cannot overwrite a pending ID or enqueue into a closed transport.
Frame byte limits are checked before allocating the outgoing buffer.

Duplicate live native IDs, malformed creation IDs, and invalid or missing native
navigation metadata fail closed rather than leaving unowned resources or stale
application trust. Runtime event snapshots are immutable, and listener delivery
uses stable snapshots that honor unsubscription. Mock close cascades tolerate a
listener disposing a sibling before the parent finishes walking its snapshot.

These are trusted backend/protocol boundaries, not the future renderer authority
bridge. Public operations still require genuine opaque registry handles. Native
IDs remain private lookup keys and never become capabilities.

## Lower-allocation dispatch and cleanup

The registry maintains per-kind live sets and constant-time counts. CEF dispatch
uses an O(1) native-ID index instead of copying and scanning all windows and views
for every event. Window and session ownership indexes allow scoped cleanup and
reference checks without scanning unrelated views. Entries are removed before
callbacks; backend closure clears all live indexes. Disposed public handles retain
only the existing weak identity tombstones.

## Shared cache use

Warm `withCefRuntime` calls take a shared kernel lease directly. Previously they
first acquired the exclusive installation lock, so one running application's lease
could block a second consumer until timeout. Warm use also performed two full
hash passes. It now verifies every signed member once while holding its shared
lease, and reuses one 64 KiB buffer across sequential file verification.

Cold installation remains exclusive, and validation across the cold-install/lease
handoff remains deliberate. A single outer deadline spans acquisition and lease
validation. Metadata alone never substitutes for cryptographic verification.
Cleanup still requires an exclusive lock, callback failure releases the lease,
and corruption or an entry disappearing before lease acquisition fails explicitly.
This is not a guarantee of lock fairness or automatic retry under concurrent deletion.

Download cleanup now owns the response reader before attempting an exclusive file
open; an open failure cancels and unlocks the response body. No trust root, archive
limit, browser sandbox, native deadline, or signature requirement was relaxed.

## Paired local measurements

One warmup and eight measured repetitions alternated old/new order on the same
Mac with Bun 1.4.3. The protocol fixture used 32 windows and 128 views, matching the
native host's declared caps. These use protocol peers, not CEF rendering. Cache
measurements use a synthetic authenticated offline cache with one 64 MiB file;
they exclude installation and network transfer. No quiet-machine or thermal gate
was imposed. Raw samples and exact code hashes are retained.

| Workload                                    | Baseline median | Updated median |
| ------------------------------------------- | --------------: | -------------: |
| Dispatch 8,192 native title events          |       25.929 ms |       3.123 ms |
| Read resource diagnostics 50,000 times      |      119.368 ms |       1.074 ms |
| Verify and lease the warm synthetic cache   |       90.704 ms |      47.207 ms |
| 512 sequential protocol request/reply pairs |        1.362 ms |       1.409 ms |

Request round trips did not improve in this sample; the additional ordering and
reentrancy guarantees take priority over that small difference. These figures do
not establish faster desktop startup, lower total RAM, smaller shipped bundles,
competitor superiority, or M9 performance acceptance.

The JSON evidence archives the exact one-off measurement harness as text rather
than installing another maintainer CLI. To repeat the experiment, reconstruct its
`archivedHarness.path`, retain the baseline package files and native peer fixture
under `.bunly/runtime-audit/before/` from the recorded Git commit, and place that
commit in `.bunly/runtime-audit/base.txt`. Run the harness with the pinned Bun from
this checkout. Its scratch files and protocol peers are cleaned on completion.
Only compare against the recorded updated source hashes, or explicitly label a
later checkout as a different experiment. No historical outcome is rewritten.

## Validation and boundaries

The full portable suite passes 521 Bun tests and 145 Python tests. The added 21
regressions cover ownership snapshots, coalesced frames, cancellation bounds,
reentrant serialization, lifecycle cleanup, shared leases and download cleanup.
Six focused regressions were first executed against the merged baseline and
failed before the corresponding fixes. The native/reference checker qualification
also passes all 23 cases. Both native workspaces pass their existing pinned
format/lint/build checks and tests (3 probe tests; 43 CEF tests on macOS).

Run `bun run check:portable`, `bun run check:ci`, and `bun run check:ci:native` with
the documented contributor environment. Fresh packaged macOS and complete-runtime
acquisition results are recorded in the pull request at their actual execution
commit; a unit test is not a browser qualification result. Windows/Linux execution
requires a later authorized hosted run. CI billing remains paused.

This audit fixes demonstrated defects and removes measured hot-path waste. It
is not a proof that the complete codebase has no remaining bugs. M4 renderer
identity, permissions and session acceptance, production signing, and later
platform/performance qualification keep their existing milestone owners.

## Executed native closeout

Clean code commit `7c076457330d1b09c58c5b806cb2d7c8f759376d` passed fresh local
macOS arm64 qualification using a newly assembled, explicitly ad-hoc-signed app.
All 11 prebuilt installation/startup/rejection/restoration cases passed. The five
positive runs completed 100 lifecycle cycles; development-origin isolation saw
zero forbidden requests, and all four actual backend/backend-tree/renderer/GPU
fault cases passed with standard deadlines.

Complete-size acquisition also passed: one trusted-local HTTPS download of
183,769,830 archive bytes, 421,677,568 expanded tar bytes and 531 declared members.
The acquired runtime launched offline with an empty compiler PATH for 20 further
lifecycle cycles. Cache inode reuse, active-lease cleanup refusal, tamper rejection
and explicit removal all passed. The measured synthetic cache workload above is
separate from this actual complete-CEF functional test.

The code checkout remained clean throughout these runs. No timeout or observed
orphan counted as success. Audit-owned duplicate app copies, profiles, temporary
archive and ephemeral TLS key/certificate were removed after process inspection;
raw reports remain under `.bunly/runtime-audit/` and the original per-run locations.
One fresh reusable bundle is retained. No other app, container, or Docker resource
was touched. No native Windows/Linux or hosted Actions rerun is claimed.

Final local Foundry audit, both native workspaces, formatting, workflow syntax,
root/benchmark Bun audits, both Cargo audits and the Python requirements audit
passed. Two real syncs were unchanged across 479 files, and the 86 pre-existing
evidence/lock files remained byte-identical. The Git secret scan used the existing
exact historical digest exclusions and found no new matches. The known Foundry
release-SHA-versus-tag warning remains informational and visible.
