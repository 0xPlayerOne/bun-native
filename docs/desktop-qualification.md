# Native desktop qualification

M7 desktop API increments use an explicit native workload against a prepared host
built from matching source. Ordinary example consumers do not compile Rust or C++.
Native support is recorded only after execution on the named platform; a portable
contract or a fake transport test does not establish OS behavior.

## Window controls

With pinned Bun 1.4.4, a clean checkout and an already prepared CEF 156.0.7 host:

```sh
bun run qualify:desktop /absolute/path/to/prepared-app --native-source=COMMIT
```

`COMMIT` is the full immutable build-source commit. The runner requires the same
`native/cef-host` tree as the current checkout, inventories the selected binary
and runtime, and records the declared-source limitation: it does not invent an
embedded build attestation. It creates its own private fixture and leaves the
input application unchanged.

The maintained `examples/desktop-controls` application performs thirteen fixed
observations: initial state, geometry, resize, hide, show, minimize, restore,
maximize, unmaximize, fullscreen, windowed restoration, activation request and
geometry after unsubscribing. It uses native notifications to wake bounded
readback rather than polling. Fullscreen entry and exit require their actual
completed native transition callbacks. Activation records the real result;
operating-system focus policy can refuse a request.
Both state-change and bounds-change notifications must be delivered; successful
readback alone cannot satisfy that callback contract.
The hide/show/minimize/restore sequence also waits for five ordered, authenticated
renderer visibility receipts. Native minimize readback is not a completion callback:
page visibility supplies an independent transition observation and wake-up signal.

An authenticated renderer receipt establishes an actual browser document and
records its viewport and device-pixel ratio. That observation is not physical
keyboard/IME, screen-reader, GPU, high-DPI monitor or multi-monitor qualification.
The fixture separately checks invalid geometry, forged/stale handles, one close
event, zero deliveries after abort, released view/session resources and ordinary
native teardown. An anchor window remains until final shutdown; the pre-quit
resource snapshot therefore correctly contains one window, not an invented
post-exit all-zero native snapshot.

The fixture has a fixed 25-second deadline and a 45-second process-tree observer
budget. Existing native shutdown phases and helper-cleanup deadlines are
unchanged. macOS still requires positive helper ownership and exact signing-clone
cleanup. Linux executes under its own disposable Xvfb/Openbox instance, without
changing a contributor's desktop. Windows runs as a standard user with the
existing sandbox bootstrap.

## Hosted gate and replay

The full hosted native matrix includes `desktop`, `view-composition`, `composition-interactions`,
`desktop-services`, `file-downloads`, `window-commands`, `file-dialogs`,
`status-items`, `view-parent-close` and `application-links` stages before the existing
window-mode, terminal, managed-reload and credential stages. Every earlier stage
must pass before credential/provider qualification can proceed. The existing
M4-only suite remains unchanged.

Reports live under `.bunly/m7/desktop/run-*/report.json`. They retain exact source
fingerprints, exported CEF/Chromium identity and an actual bundled Bun version
probe, input and prepared artifact inventories, complete file identity/metadata,
native receipts and process-tree cleanup. Binary hashes bind both probes to the
prepared files, and observer OS/architecture must match the reported target.
The fixed observer budget is retained; replay also enforces the observer's existing
15-second outer cleanup guard without extending its launch or native deadlines. Failed runs
remain failed. Replay a downloaded or retained report with historical Git objects
already available:

```sh
bun run qualify:desktop --verify /absolute/path/to/report.json
```

Replay performs no native execution or implicit fetch. It rejects missing source,
changed fingerprints, incomplete transitions, stale geometry, callback/resource
leaks, altered artifacts and failed cleanup. Current native CI outcomes belong in
the relevant PR's acceptance record; these finite functional results confer no
performance or production-release eligibility.

The [retained window observations](../evidence/m7-desktop/README.md) preserve the
two initial macOS fixture failures and the subsequent accepted run, with separate
original/export/archive digests and an offline replay command. Their fixed source
commits remain distinct from the current-head three-platform merge gates.

## View composition

The same runner selects the fixed three-pane composition workload explicitly:

```sh
bun run qualify:desktop /absolute/path/to/prepared-app --native-source=COMMIT --case=composition
```

Its report family is `.bunly/m7/view-composition/run-*/report.json`, with profile
`native-view-composition-v1`. Offline `--verify` selects the matching acceptance
rules from the report; unknown profiles are rejected. Window-v1 retains its
original source selectors so historical window evidence remains replayable.
Composition adds the entire fixture and its shared document-readiness helper to
the source inventory. Both profiles enforce the same artifact, identity, process,
shutdown and metadata requirements and the unchanged 45-second observer budget.

Twenty-eight ordered observations cover two independently controlled content
panes and an application-owned native overlay. Acceptance requires native and
renderer viewport agreement, partial/full clipping, hide/show, forward/reverse
view focus traversal, 16 resize transitions, two managed-generation reattachments,
retained document/form/session identity, stale-generation rejection, sibling
survival after overlay closure, and no remaining owned views or sessions.
API-directed focus and observed device-pixel ratios do not establish physical
keyboard, pointer, IME, assistive-technology or hardware display behavior.
See [the composition contract and limitations](view-composition.md).

On Linux the existing disposable display wrapper accepts
`--desktop --desktop-case=composition --native-source=COMMIT`; it creates and
cleans its own Xvfb/Openbox processes. The full hosted suite requires the native
desktop stages on every platform before later credential/provider work. Neither
profile changes the existing M4-only suite.

## Composition interactions

The separate interaction case keeps the original composition workload and its
retained report semantics unchanged:

```sh
bun run qualify:desktop /absolute/path/to/prepared-app --native-source=COMMIT --case=composition-interactions
```

Its profile is `native-composition-interactions-v1`, and reports live under
`.bunly/m7/composition-interactions/run-*/report.json`. It reuses the authenticated
composition renderer with a separate application entry. The full hosted suite
runs it immediately after `view-composition`; Linux uses its owned disposable
Xvfb/Openbox session. The fixture has a 30-second overall limit inside the same
45-second process observer and existing native shutdown deadlines.

Three independent documents and sessions occupy two manual content panes and a
trusted overlay. Each opens and cancels its own native popup. Acceptance requires
the actual `menu-shown`/`menu-closed` pair for each registration and agreement
between native focus readback and authenticated renderer focus/blur observations
for every pane after explicit restoration. The workload also records focus before
opening each menu. Unsupported or failed menu display is a failure.

On macOS the overlay's document opens a native file panel in a new empty temporary
directory. The qualifier observes the panel as visible, requires a competing
popup to fail with `RESOURCE_IN_USE`, cancels the panel, observes its callback and
native removal, then explicitly restores overlay focus. No file is selected or
created. Windows/Linux require an explicit unsupported dialog rejection with zero
native admissions; that outcome does not count as a dialog pass. There are ten
ordered focus observations with the panel case and nine when dialogs are
unsupported. Hiding the overlay must remove both native and renderer focus and
reject another focus request. Reopening it must preserve the same document and
session.

Before teardown, an authenticated resize acknowledgement stops each renderer
producer and the fixture drains its admitted RPC replies. The receipt requires
zero command registrations/popups, views, sessions and queued deliveries, plus
successful native shutdown and zero SDK resources. Replay rejects missing,
reordered or contradictory observations, changed identities, leaked ownership,
an unobserved dialog dismissal and a receipt emitted before shutdown. Source and
artifact identity checks remain the shared desktop checks.

This is SDK-driven native integration, not physical input. It injects no keyboard
or pointer event, and it cannot qualify an IME, screen reader or physical display.
`physicalInputQualified`, `imeQualified`, `hardwareDpiQualified`,
`assistiveTechnologyQualified` and `performanceEligible` are always `false`.
The [operator protocol](m7-platform-qualification.md) remains the acceptance path
for those observations.

## Live-pane parent close

Close a parent while all four independently loaded manual panes remain live:

```sh
bun run qualify:desktop /absolute/path/to/prepared-app --native-source=COMMIT --case=parent-close
```

Reports use `.bunly/m7/view-parent-close/run-*/report.json` and profile
`native-view-parent-close-v1`. The static-page fixture uses four separate
ephemeral sessions. It records the exact native document/view identities before
closing the parent, then requires four matching actual native `view.closed`
callbacks and the parent's `window.closed` callback. SDK child-handle disposal
after the parent reply cannot substitute for these browser callbacks. Sessions
are disposed only after those receipts, and a native `windowState` request
through the retained control handle must succeed. Final native diagnostics
require that single surviving window with zero views, sessions and delivery
buffers; ordinary shutdown then closes the control and must satisfy the shared
native cleanup contract.

This profile adds its own fixture, receipt binding, lifetime and document
readiness helpers to the source inventory while leaving the historical
composition profile unchanged. The same source/artifact/metadata checks,
25-second fixture deadline and 45-second process observer apply. Offline
`--verify` rejects incomplete identities, missing callbacks, an unproven control
survivor, leaked owners or failed process cleanup. Linux uses the disposable
display wrapper's `--desktop --desktop-case=parent-close` arguments. The full
hosted suite requires this case on all three targets; the M4-only suite remains
unchanged.

The receipt explicitly leaves OS quit, physical input, hardware display,
assistive technology and performance qualification false. The workbench's
ordinary OS-quit action requires a separate fresh native observation against the
matching host source.

## Clipboard and application lifecycle

The `services` case uses a static local page and native document readiness. It
does not add a renderer RPC endpoint. On disposable GitHub-hosted macOS ARM64 and
Windows x64 runners, launch it with explicit clipboard opt-in:

```sh
bun run qualify:desktop /absolute/path/to/prepared-app --native-source=COMMIT --case=services --disposable-clipboard
```

The qualifier rejects local/connected desktops, self-hosted runners, missing
opt-in, and mismatched runner identities **before native launch or artifact
preparation**. The receipt records this contributor launch condition separately
from the runtime's exact document authority. The fixture refuses every nonempty
or uncertain initial clipboard, compares only its own bounded text in memory,
and restores the initial emptiness after success or failure. It does not retain
clipboard payloads. This requires an isolated runner with no competing clipboard
producer; the empty preflight is not an atomic reservation.

Linux uses `--case=services` without the clipboard opt-in, or the disposable
display wrapper's `--desktop --desktop-case=services --native-source=COMMIT`.
It verifies explicit unsupported clipboard errors and real application lifecycle
without accessing an OS clipboard. This outcome cannot satisfy a macOS/Windows
clipboard support claim.

Reports use `.bunly/m7/desktop-services/run-*/report.json` and profile
`native-desktop-services-v1`. The same offline `--verify` command checks the
complete source, runtime, artifact, metadata, ordinary teardown, output drain and
process cleanup contract. Service acceptance additionally requires the ordered
quit-requested/quitting/closed observations, stale document rejection, zero
remaining native resource owners and, where executed, all clipboard
denial/Unicode/byte-boundary/clear/restoration checks. No hardware, assistive
technology or performance eligibility is inferred from these operations.

The full hosted suite requires this case on all three targets. See
[desktop services](desktop-services.md) for the public API and adapter limits.

## File downloads

The download case exercises the real CEF download pipeline using only its own
numeric-loopback HTTP fixtures and a private temporary destination root:

```sh
bun run qualify:desktop /absolute/path/to/prepared-app --native-source=COMMIT --case=downloads
```

On Linux use the disposable display wrapper with
`--desktop --desktop-case=downloads --native-source=COMMIT`. The ordinary native
host implements this adapter; the qualifier needs no browser inspection flag,
renderer RPC authority, clipboard permission or separate transfer implementation.

Fourteen ordered transfers cover three successful files, seven cancellations
and four failures. Acceptance checks actual successful byte counts and fixed
SHA-256 digests, explicit replacement and duplicate preservation, denied grants
and traversal, allowed/denied redirects, unknown-size limits, timeout, interrupted
responses, AbortSignal, navigation/reload, view/window closure, and cancellation
during application quit. An unrelated sentinel must survive owned staging cleanup.
The native download settlement receipt reports exactly matching admissions,
terminal callbacks and outcomes, with zero owned transfer/callback/staging/timer
resources before ordinary shutdown. Missing callbacks fail the existing deadlines.

The settled native baseline retains one anchor window. `nativeBeforeQuit`
deliberately retains one view, one session, one window and the final transfer.
The final SDK snapshot is all zero after `backend.dispose()` has received the
native shutdown response. These are separate observations; the live snapshot is
never represented as post-shutdown evidence.

Reports use `.bunly/m7/file-downloads/run-*/report.json` and profile
`native-file-downloads-v1`. The shared `--verify` command checks their exact
source inventory and the same prepared-artifact, runtime identity, metadata,
native shutdown, output drain and process-cleanup gates. Native and application
receipts contain bounded counters, opaque document identities and content digests,
without destination paths, source URLs or file payloads. The workload and observer
retain their fixed 25-second and 45-second limits. Uploads, native file-input
selection and OS file drops remain unavailable; this case does not qualify their
behavior or claim physical input, hardware displays, assistive technology,
antivirus or performance support. See [scoped native downloads](downloads.md).

## Descriptive composition resources

The explicit `--case=composition-profile` case uses the same prebuilt/source,
runtime-identity, immutable-artifact, shutdown and cleanup gates. It records
fixed windowed-CEF idle, pane resize, overlay and close/reopen phases with sampled
CPU/RSS and native API/readback durations. It is separate from the functional
`composition` case and is not added to the full hosted functional suite.
See [the measurement protocol](composition-measurement.md) for the exact workload,
independent trial procedure, clock/counter limits, GPU-trace requirements and
physical qualification boundaries. `performanceEligible` remains false.

## Text status items

The `status` case covers the bounded macOS text status-item adapter:

```sh
bun run qualify:desktop /absolute/path/to/prepared-app --native-source=COMMIT --case=status
```

The contributor host includes `rpc-qualification`. Its fixture requires four
actual creations, two AppKit `performClick` action callbacks, an exact document
grant, a text update, managed-generation journal replay, and native removal after
explicit disposal, view closure and quit. Every native item, target delegate and
weak callback owner must be released before process-stop begins. The SDK must
also report zero items and listeners after native shutdown. No action event or
native removal receipt is supplied by a simulated backend.

Windows and Linux run explicit unsupported-capability checks. Linux uses the
disposable display wrapper's `--desktop --desktop-case=status` option. Reports
use `.bunly/m7/status-items/run-*/report.json` with profile
`native-status-items-v1`; offline verification applies the existing exact-source,
artifact, output-drain, process-cleanup and shutdown gates. The full hosted suite
requires this case before credential/provider work without changing the M4-only
suite or its deadlines. Physical status-bar input, appearance, icons, menus,
application keepalive, assistive technology and performance remain unqualified.
See [text status items](status-items.md) for the public API and ownership limits.
