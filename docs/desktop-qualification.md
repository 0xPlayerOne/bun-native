# Native desktop qualification

M7 desktop API increments use an explicit native workload against a prepared host
built from matching source. Ordinary example consumers do not compile Rust or C++.
Native support is recorded only after execution on the named platform; a portable
contract or a fake transport test does not establish OS behavior.

## Window controls

With pinned Bun 1.4.3, a clean checkout and an already prepared CEF 156.0.7 host:

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

The full hosted native matrix includes `desktop` and `view-composition` stages before the existing
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
cleans its own Xvfb/Openbox processes. The full hosted suite requires both native
desktop stages on every platform before later credential/provider work. Neither
profile changes the existing M4-only suite.
