# Managed edit outcome comparison

`bun scripts/qualify-managed-comparison.ts PREBUILT_APP --native-source=COMMIT --reference-root=INSTALLED_REPOSITORY --mirin-lock=SHA256`

This macOS arm64 qualification executes a current shared browser workbench in
Bunly, Electrobun 2.0.3-beta.26, and Mirin 0.1.0-alpha.26. It requires the pinned
Bun 1.4.4 driver, the existing pinned reference installations, a cached Hutch
home, and an explicitly selected prebuilt Bunly app with an identical native
source tree. It does not build Bunly native code. Run from a clean committed
checkout as a standard user. The installed reference repository is an input;
its packages and Hutch cache are copied into the private run workspace before
upstream commands execute. Original sources are not edited.

The [retained current comparison](../evidence/m6-managed-development/common-workload-comparison.json.gz)
at `db22f4e3f338b176a2a430f0b486b417232f9fbe` passed all 15 fixed-plan rows.
[The M6 record](m6-completion.md#current-pinned-comparison) publishes the actual
three measured durations per framework, engine/runtime versions and persistence
distinctions. This is local functional evidence with `performanceEligible: false`;
final validation and merge remain tracked in
[PR #130](https://github.com/0xPlayerOne/bunly/pull/130).

The fixed plan has an initial launch, one warmup backend edit, and three measured
backend edits per framework. Every warmup and measured row must pass. A failure
is retained and all remaining rows in that framework are marked unexecuted;
there are no automatic retries or discarded warmups. Source hashes, the full
plan, process observations, actual exported CEF identities, actual backend Bun
versions, immutable renderer asset hashes, and raw per-edit outcomes are retained
under `.bunly/m6/managed-comparison/run-*/`.

Failed-run reports and bounded process observations remain available even when
the disposable app/cache fixture can be removed after confirmed process cleanup.
Cleanup never removes the failed evidence or converts it into a passing trial.

## The common outcome

Each edit changes an imported backend handler. The backend actually executes that
handler and sends its revision through a role-authenticated loopback fixture
channel. The renderer waits for that acknowledgment before accepting the new
revision. The renderer then checks the unfinished form value, consumes the next
32 numbered terminal lines, waits for xterm's write callback, verifies its last
rendered line and the entire cumulative byte count/checksum, and acknowledges
after two animation frame callbacks. All frameworks receive identical HTML,
JavaScript, xterm 5.5.0, CSS, and numbered bytes.

Bunly grants its remote fixture session only the exact generated numeric-loopback
origin. No native bridge is exposed to this page. Its asynchronous controller does
not block browser module evaluation or native load completion.

The initial page seeds the form once. Later reference documents receive no form
seed and must read the previous revision, form value and transcript from their
own same-origin localStorage. They replay that existing transcript into xterm
before appending the next numbered chunk. Missing or stale state fails the run.
This checks reconstruction of actual previous browser state rather than assigning
the expected initial marker after every restart.

| Framework  | Backend edit path                                                                                               | Browser and native identity                                   | Form and transcript                                      |
| ---------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | -------------------------------------------------------- |
| Bunly      | `DevelopmentSession` bundles the changed dependency and `ServiceReloadHost` transactionally replaces its Worker | One backend host, window, view, session, and browser document | Existing DOM form and xterm instance remain alive        |
| Electrobun | Official pinned `build --env=dev`, ordinary stop and relaunch                                                   | New backend instance and browser document                     | Restore browser-owned localStorage under the same origin |
| Mirin      | Official pinned `build`, ordinary stop and relaunch                                                             | New backend instance and browser document                     | Restore browser-owned localStorage under the same origin |

The reference build/relaunch path is an explicit maintained comparison profile;
it does not claim that every upstream development workflow must restart.
Reference native resource identity is not directly inspected. A fresh backend
instance and page UUID establish their observed restart semantics; restoring a
form does not establish native window, document, session, shell, or PTY retention.

The numbered workbench stream is synthetic. This comparison does not substitute
for the separate 500-replacement Bunly native fixture, which exercises a retained
native PTY, real resource adapters, cancellation, failure handling, browser login
state, frontend notification and a full restart request. It also does not claim
automatic compatibility with an arbitrary application or frontend HMR protocol.

## Interpreting timings and retained evidence

Edit time starts immediately before writing the source and ends at the common
renderer acknowledgment. It includes the selected framework's stop/build/relaunch
or bundle/transaction work, polling, browser state handling, xterm consumption,
and two animation callbacks. The initial launch and the warmup edit are excluded
from the three-value timing summary; their correctness is still mandatory.

The three samples are correlated and occur in a fixed framework order on an
uncontrolled desktop. Each framework's actual CEF, Chromium and Bun versions are
recorded separately. This profile does not establish verified matching browser
sandbox cohorts. Reports therefore always set `performanceEligible: false` and
provide descriptive timings with **no speedup ratios**. Equal selected outcomes
do not make unequal native lifecycles or browser engines interchangeable.

Every process is observed until ordinary exit before replacement. The Bunly
observer additionally requires native shutdown receipts and macOS helper/clone
cleanup qualification. Missing process cleanup retains the private fixture and
fails qualification. The selected original Bunly app and prepared stable app
inventories must remain unchanged across edits. Small sample timing and sampled
process observations do not prove absence of arbitrary leaks.

Replay a retained raw report with:

```sh
bun scripts/qualify-managed-comparison.ts --verify PATH_TO_REPORT_JSON
```

Replay recomputes fixed-plan correctness, lifecycle distinctions, timing
summaries, engine identity receipts, process exit gates, equal renderer asset
hashes and historical source fingerprints. A report that merely contains
`passed: true`, a precomputed median, or an old unrelated M2 result is insufficient.
The [retained manifest](../evidence/m6-managed-development/manifest.json) also binds
the accepted Bunly native soak and all three failed development attempts. Replay
that complete inventory with `bun run verify:managed-acceptance`. Original private
report, expanded exported JSON and gzip archive hashes remain distinct; historical
source must already exist locally, with no implicit fetch. Passing this shared
outcome profile does not convert the reference relaunches into native persistence
or resolve the separate #124/#129 reliability investigations.
