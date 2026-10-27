# Managed development qualification

This executable M6 profile checks the supported persistent development contract
against a real prebuilt CEF desktop. It combines the public
[service reload](service-reload.md), [managed desktop](managed-desktop.md) and
[development host](development-host.md) APIs. Portable tests exercise failure and
authority boundaries separately; they do not substitute for native execution.

The [M6 implementation and local qualification record](m6-completion.md) links the
accepted macOS arm64 run at `96ce3fc2754c4e34e065bb58c9f183ac5abc7462`: 500 actual
backend replacements, 508 renderer receipts and a separately observed controlled
relaunch. It preserves all three earlier failed attempts and reports the measured
scope. Final current-head validation and merge are tracked in
[PR #130](https://github.com/0xPlayerOne/bunly/pull/130); this local run is not a
release or all-platform qualification.

## Run and replay

Use a clean committed checkout, pinned Bun 1.4.3, the contributor Python
environment, and a standard user account. Select an already built native app
whose entire `native/cef-host` source tree matches the current checkout:

```sh
bun run qualify:managed-development /absolute/path/to/prebuilt-app --native-source=COMMIT
```

`COMMIT` is the immutable 40-character native build source declaration. On
Windows and Linux, select the prepared host executable in its complete runtime
directory. On macOS, select its application bundle. The command never downloads
or compiles a missing native host. It assembles a private application fixture,
signs only that fixture ad hoc on macOS, and retains its complete report under
`.bunly/m6/managed-development/run-*/report.json`.

```sh
bun scripts/qualify-managed-development.ts --verify /absolute/path/to/report.json
```

Replay verifies the full historical source inventory, raw workload hashes,
embedded observation hashes, fixed scenario order, artifact inventories and
actual cleanup receipts. It accepts the explicitly marked fixture-nonce export
format. Original private report hashes remain separate from exported hashes.
Missing historical Git objects fail with no implicit fetch or substitution of
current source. Fetch the recorded commits explicitly before replaying them.

Replay the complete retained development/comparison inventory with:

```sh
bun run verify:managed-acceptance
```

The [manifest](../evidence/m6-managed-development/manifest.json) binds all five
archives to source, outcomes, original private report hashes, expanded exported
JSON hashes and gzip archive hashes. Those are distinct identities. Replay checks
the historical failures as failures; later source corrections never relabel them.
It performs no implicit fetch and does not rerun the native workload. See
[the retained attempt table](m6-completion.md#retained-attempts-and-offline-replay)
for each source and disposition.

## Fixed native workload

One launch performs 500 successful Worker replacements through real
`DevelopmentSession` builds of edited files. One stable Bun process owns the
native window, view, ephemeral session, terminal service and non-detaching PTY.
Application generations receive bounded, reauthorized resource bindings.

| Scenario                                   | Required observation                                                                                                                                                |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Each of 500 backend edits                  | The changed imported handler answers from the new generation; the same renderer verifies its unfinished form, session markers, native cookie and terminal progress. |
| Syntax, import and initialization failures | The candidate fails and the previous valid behavior remains usable.                                                                                                 |
| Resource closed during replacement         | Preparation fails without publishing a binding to a closed resource.                                                                                                |
| Runtime handler failure                    | The request settles as an explicit failure; the resource owner remains usable.                                                                                      |
| Accepted request during edit 375           | The old request settles with `RETIRED`; its late continuation cannot mutate retained state.                                                                         |
| Frontend edit after revision 125           | Actual edited CSS is read, sent to the existing document and applied. Browser SHA-256 and computed styles must match.                                               |
| Shared edit at revision 250                | The actual shared dependency changes both backend behavior and the source-derived browser style.                                                                    |
| Configuration edit after revision 500      | The existing development session reports `restart-required` and keeps the last valid generation usable until shutdown.                                              |

The exact plan requires 508 renderer receipts and 501 source-write-to-renderer
timings: 499 backend-only edits, one shared edit, and one frontend-only edit.
Build/replacement timing is recorded separately. The fixture uses real file
writes and explicit `invalidate` with `watch: false`, so these measurements
exclude filesystem watcher notification latency. Watcher coalescing and dependency
classification have their own integration tests.

The frontend adapter is deliberately maintained and small: it reads the fixture's
CSS and shared module, applies a constructed stylesheet and verifies computed
properties in the existing document. This is evidence for that integration
contract, not universal compatibility with external HMR tooling.

## Resource and process accounting

The original terminal runs a numbered Unicode producer throughout replacement.
Each generation also writes an acknowledged marker. The validator independently
checks monotonic output, cumulative byte/checksum agreement, all 501 generation
acknowledgments, and continuing autonomous producer ticks. A newly spawned child
or reconstructed transcript cannot satisfy this fixture's retained identity and
single-launch requirements.

The terminal consumer reads numbered records from xterm's screen after each
parser-completion callback. This admits ConPTY cursor, erase and repaint output
without treating VT control bytes as record text. All original delivered bytes
still contribute to the byte count and checksum; repeated displayed rows must
match the bounded retained history. Sequence gaps, changed repaints, incorrect
acknowledgments, incomplete UTF-8 and missing final output reject qualification.
Portable tests exercise real xterm parsing of control operations and split Unicode;
actual Windows qualification remains a separate native gate.

Generation-owned timers and listeners assert disposal before normal retirement.
Accepted requests must settle, and ownership reservations stay charged until the
underlying work actually settles. Checkpoints every 25 replacements require one
serving generation, no candidate, no queued callers, one retained development
bundle, bounded event handling and zero forced terminations.

The fixed retention sentinels compare early post-warmup and final checkpoint
medians. Main-isolate heap after full GC may grow by at most 32 MiB, and stable
owner-process RSS by at most 256 MiB. These are finite regression sentinels, not
universal leak-freedom claims. Worker heaps are outside the main-isolate heap
counter; owner RSS and sampled process-tree observations provide separate views.
Process, thread and descriptor/handle samples retain missing values and platform
differences. Shared memory can be counted more than once in summed tree RSS.

The final native snapshot is taken **before closing the last window**, with one
window, zero views and zero sessions. Closing that window begins native
finalization. The report then requires zero managed resources, a normally reaped
terminal, fully settled framework requests, backend exit, empty native output,
all ordinary shutdown phases, and positive macOS helper/clone cleanup where
applicable. It never invents a post-exit native query.

Before publishing its result or compact completion marker, each maintained
fixture awaits the backend's private native shutdown receipt. This follows the
complete native `process-stop/start` diagnostic and prevents those two writers
from interleaving that line on shared stderr. Backend disposal is attempted even
when managed cleanup has failed; such an execution still records a failed result.

Fixture results retain at most 32 failure diagnostics, distinguishing dependency
build, native binding preparation, generation reload and outer fixture failure.
Typed stage/code and restart disposition accompany a bounded first-line cause;
local paths, stack frames and credential-like values are omitted with explicit
redaction/truncation flags. Successful stage events are not retained. These fields
explain rejected runs and do not supply native acceptance or change their outcome.
Renderer terminal errors have a separate diagnostic source. Fixture binding
validation identifies the fixed resource name while retaining the original
rejection, and terminal exit/closure receipts are retained even after failed
startup. The earlier hosted Windows `DENIED` report does not contain the original
terminal bytes or renderer error, so a terminal-consumer cancellation remains an
inference until native validation confirms the corrected path.

## Separate controlled relaunch

After the soak has completed and its process observation passes, the qualifier
launches the same verified prepared executable once more. A failed soak does not
admit this phase. The relaunch is a separate report and observation, with its own
15-second fixture and 30-second observer budgets; it does not rerun the 500 edits.
Existing native startup, request, shutdown and helper deadlines are unchanged.

The new Worker imports the actual edited revision 500 and shared revision 1 and
reads the changed JSON configuration from the existing private project. Its hash
must match an independent stable-host read. A fresh renderer verifies the new
behavior and the expected absence of the old unsaved form, session storage and
ephemeral login state. Window, view, session and browser-instance UUIDs must be
new. Native document counter strings may repeat across processes and are not used
alone as proof of freshness. Both renderer requests must settle, followed by the
same ordinary native shutdown gates.

This demonstrates the explicit loss of persistence at the full-restart boundary.
It does not change an engine ABI or claim to migrate persistent credentials.

## Prepared host reuse and provenance

The qualifier retains the input runtime's complete content/link inventory, actual
bundled Bun version, exported CEF identity, and the declaration of the native
source tree. The selected prebuilt lacks embedded source attestation: an explicit
caller declaration plus byte and source-tree checks is recorded as such, not
represented as cryptographic proof of its build provenance.

Preparation assembles the private runtime once. Warm cache reuse must return the
same key and executable without another copy or native compilation. Each native
launch has an empty `PATH`. Complete runtime bytes, link targets, device/inode,
size, modification time, permissions, ownership and final hard-link counts must
remain unchanged across edits and relaunch.

Linux cold assembly includes the empty `extensions` directory that the pinned
Chromium runtime otherwise creates beside its library on first use. It is
validated and included before the complete cache receipt is published; an
unexpected existing file, symlink or extension entry rejects assembly. No path is
excluded from warm verification and no post-launch repair is performed. The
[prepared host contract](development-host.md#prepared-host-cache) links the pinned
upstream path-provider behavior. Portable regression controls reproduce the
original added-directory rejection and verify reuse after complete cold assembly;
the hosted native matrix supplies actual runtime validation.

Cold preparation metrics are retained before launch. If warm verification fails,
the report preserves that failed attempt, its typed integrity diagnostic from the
actual comparison scan, and an explicitly unattempted restart. An incomplete scan
remains incomplete; missing after-data cannot be interpreted as unchanged files.

Chromium on macOS creates a signing clone hard-linked to the host executable.
Its link/unlink lifecycle changes the original file's status-change timestamp.
The only permitted `ctime` difference is for that exact executable, with the
existing observer positively verifying clone ownership and removal for every
launch. All other identity fields must match, including a final link count of
one. Full before/after timestamps and the explicit disposition remain in the
report. An unexplained timestamp or identity change still fails.

## Comparative scope

The [common edit outcome comparison](managed-comparison.md) separately runs the
pinned Electrobun and Mirin adapters with the same browser assets and numbered
xterm workload. It records Bunly's retained desktop separately from reference
rebuild/relaunch and browser-state restoration. Its tiny correlated sample, fixed
framework order, uncontrolled desktop and differing engine/security cohorts
permit descriptive timings, not relative speedup claims.

All development attempts, including startup and harness failures, must remain
retained alongside later accepted evidence. Issue #124's native teardown
investigation and #129's terminal-load failures remain separate reliability work;
successful M6 observations do not resolve those historical failures.
