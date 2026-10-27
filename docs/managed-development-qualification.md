# Managed development qualification

This executable M6 profile checks the supported persistent development contract
against a real prebuilt CEF desktop. It combines the public
[service reload](service-reload.md), [managed desktop](managed-desktop.md) and
[development host](development-host.md) APIs. Portable tests exercise failure and
authority boundaries separately; they do not substitute for native execution.

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
