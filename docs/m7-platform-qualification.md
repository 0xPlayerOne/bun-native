# M7 desktop and hardware qualification matrix

This is the maintained qualification protocol for [issue #38](https://github.com/0xPlayerOne/bunly/issues/38).
It separates finite native execution from the physical input, display, and
assistive-technology observations that still need dedicated equipment and an
operator. It does not close #34–#38 or qualify a production release.

## Evidence already available

| Area                                          | Available evidence                                                                                                                                                                                                                                         | What remains separate                                                                                                                               |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Window state and geometry                     | [PR #132](https://github.com/0xPlayerOne/bunly/pull/132) passed the full native matrix on Linux x64, macOS ARM64, and Windows x64; [retained macOS reports](../evidence/m7-desktop/README.md) replay thirteen ordered states and real renderer visibility. | Physical keyboard/pointer routing, hardware DPI, screen readers, and multiple displays.                                                             |
| Background, hidden, and minimized load        | [M5 completion](m5-completion.md) records native state, page visibility, numbered-output correctness, and finite process observations.                                                                                                                     | Suspend/resume, hardware power behavior, and the independent minimized-terminal failure in [#129](https://github.com/0xPlayerOne/bunly/issues/129). |
| Managed backend replacement                   | [M6 completion](m6-completion.md) records 500 real replacements on all three hosted targets, retained resources, revocation, and ordinary cleanup.                                                                                                         | A physical IME composition or screen-reader focus session spanning a replacement.                                                                   |
| Renderer/GPU fault handling                   | The maintained full native suite includes deliberate fault/recovery cases; [native platform acceptance](m3-native-platform-acceptance.md) defines their scope.                                                                                             | Hardware GPU switching, device loss, driver changes, and accessibility recovery on actual equipment.                                                |
| View composition and further desktop adapters | Their individual PRs and [desktop qualification](desktop-qualification.md) own implementation and exact native receipts.                                                                                                                                   | A compiled adapter or API-driven focus receipt alone does not qualify the hardware cases below.                                                     |

The [text status-item facet](status-items.md) supplies a macOS adapter and an exact
source fixture for four creations, two AppKit action callbacks and zero remaining
native owners. The bounded macOS synthetic-input fixture passed; [PR #142](https://github.com/0xPlayerOne/bunly/pull/142)
records the exact source and native artifact attribution, including earlier failed
attempts. Windows and Linux explicitly report unsupported status items. Physical
input, status-bar appearance and assistive technology remain separate observations.

The [application-link adapter](application-links.md) adds bounded startup inputs on
all three CEF targets, a macOS live URL delegate, and macOS/Windows HTTPS submission
source. Its bounded startup/authority/replay/cleanup fixture passed on macOS;
[PR #145](https://github.com/0xPlayerOne/bunly/pull/145) records the exact source,
native artifact and earlier failed attempts. Live OS URL delivery, successful
browser launch, handler registration, second-instance forwarding and app reopen
remain unqualified; this does not pass the E1 hardware/workbench case.

The historical native teardown watchdog remains tracked by
[#124](https://github.com/0xPlayerOne/bunly/issues/124). A later passing control run
does not erase a failure or establish that either reliability investigation is
resolved.

The documentation candidate also retained a failed macOS minimized terminal-load
trial in [run 40630976372](https://github.com/0xPlayerOne/bunly/actions/runs/40630976372).
Foreground, hidden, and background modes passed; minimized delivery reported
`CONNECTION_REVOKED`. The [results record](../evidence/m7-platform-results.json)
preserves the tested source, outcome, workflow job, and original report checksum.
This is another observation relevant to #129, not a proven cause or a runtime
correction. Full diagnostics remain with the workflow artifacts and local
retention; later successful trials do not replace this result.

## Required target records

Record a separate result for every candidate, OS/architecture, display topology,
input method, and assistive-technology configuration that is claimed supported.
Hosted virtual machines are useful native functional targets; they do not stand
in for these equipment records.

| Target      | Minimum equipment/configurations to record                                                                                                                                      | Current hardware status                                                      |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| macOS ARM64 | Built-in Retina display; second display with a different scale; exact keyboard layout and IME; exact VoiceOver/macOS version.                                                   | Not run; not qualified.                                                      |
| Windows x64 | Two displays at distinct configured scales; exact GPU/driver and Windows build; exact keyboard layout and IME; exact Narrator version and any additional claimed screen reader. | Not run; not qualified.                                                      |
| Linux x64   | Exact distribution, X11 server, window manager, compositor and GPU/driver; display scale/topology; input-method framework and engine; exact Orca/AT-SPI configuration.          | Not run; not qualified. Wayland is not inferred from the current X11 target. |

Each record must include:

- Full source and native-build commit IDs, native source tree, selected profile,
  packaged and developer Bun versions, exported CEF/Chromium identity, and the
  complete installed artifact inventory/hash record.
- OS release/build, architecture, GPU/driver, display connection type, resolution,
  logical scale, relative display placement, primary display, and power state.
- Keyboard layout, input-method framework/engine/version, locale, screen reader
  and version, and any changed accessibility or desktop settings.
- Exact interactive application/fixture source and asset hashes, launch command,
  case IDs, operator observations, failed attempts, and links/digests for retained
  evidence. Use controlled fixture content; do not retain personal clipboard,
  document, credential, or browsing data.

## Maintained interactive target

Use the [native hardware workbench](hardware-workbench.md) at
`examples/hardware-workbench` for the available operator steps. It provides
application controls, two independently owned numeric-loopback preview panes,
and a native application overlay, each with a separate ephemeral session. It
includes editable multilingual text, selection, scrolling, bounded output and
window/input observations, and stays open until explicitly closed. The fixed
native acceptance fixtures terminate automatically; the web-only comparison
workbench uses a different rendering path. Neither substitutes for this target.

Prepare an existing native app from a clean committed checkout. Replace `COMMIT`
with the full 40-character source commit that built the selected native app;
its `native/cef-host` tree must match the current checkout and the object must
already exist locally. macOS takes a `.app` directory; Linux and Windows take
the packaged `bunly_host` or `bunly_host.exe` path. The
[preparation guide](hardware-workbench.md#prepare-an-explicit-prebuilt) describes
the fixed standard profile, inventories, platform requirements and local macOS
ad-hoc signing of the private copy.

```sh
bun run workbench:native prepare /absolute/path/to/prebuilt-app --native-source=COMMIT
bun run workbench:native run /absolute/path/to/preparation.json
```

Both commands finish without a GUI launch. Preparation bundles application
assets only; it never compiles or fetches native code. The second command
verifies the prepared source/artifact identities. Launch requires a separate
explicit command:

```sh
bun run workbench:native run /absolute/path/to/preparation.json --launch
```

Copy the generated `operator-record.template.json` to a new attempt record,
fill the equipment fields above, and follow the
[equipment and evidence flow](hardware-workbench.md#equipment-and-evidence-record-flow).
Retain the preparation record, actual launch command, session records and
independent evidence for each case. Preparation leaves packaged Bun/CEF versions
declared rather than observed; attach actual packaged-runtime observations and
exported identity from the exact native evidence. No preparation, launch,
root-process exit, UI action or protocol test changes a manual case to passed.

### Initial case coverage

The workbench's `hardwareCases` definitions and operator template use the same
twelve case IDs as the protocol below. **All physical hardware and
assistive-technology qualification remains not run.** Unsupported operations
describe this workbench profile, even when another adapter or qualifier supplies
a separate implementation. Available partial steps cannot pass the entire case.

| Case | Initial workbench result | Available steps and remaining limits                                                                                                                                                        |
| ---- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| K1   | Not run                  | Physical traversal and pane eligibility/closure controls are available. API-directed focus does not prove keyboard routing.                                                                 |
| K2   | Not run                  | Pointer/clipping/resize and native overlay controls are available. The overlay is rectangular and nonmodal; transparent composition and click-through are unsupported.                      |
| I1   | Not run                  | Text/composition observations and focus/resize/minimize transitions are available. Actual IME behavior requires equipment; backend replacement is not driven here.                          |
| T1   | Not run                  | Controlled selection is available. Clipboard reads/writes, grants and permission tests are unsupported here; selection alone cannot pass T1.                                                |
| D1   | Not run                  | Move/resize/maximize/fullscreen/restore on actual equipment. Physical scale/topology/reconnect behavior is untested; native popup and macOS open-dialog steps require operator observation. |
| A1   | Not run                  | Labeled controls, previews and a nonmodal overlay are available. Actual screen-reader observations remain untested; native popup and macOS open-dialog steps require operator observation.  |
| L1   | Not run                  | Window/page observations and bounded timer output are available. This is not terminal-load acceptance and does not resolve #129.                                                            |
| L2   | Not run                  | The app stays open for deliberate operator suspend/resume. No automated suspension or recovery result is supplied.                                                                          |
| F1   | Unsupported              | Fault injection belongs to the separate maintained native qualifier. Hardware GPU transitions and input/accessibility recovery still need their own observations.                           |
| E1   | Unsupported              | No deep-link registration, OS dispatch or app-reopen adapter is included in this workbench.                                                                                                 |
| M1   | Not run                  | The native popup and macOS open-file panel are available; shortcuts, status items and backend replacement remain absent. Linux/Windows file dialogs are unsupported.                        |
| C1   | Not run                  | Individual preview disposal/reopen and final-window close are available. Native/process/helper cleanup proof remains separately required; root-process exit cannot pass C1.                 |

## Operator cases and failure criteria

Use independently owned application and preview panes, editable text controls,
an application overlay, and a scrollable preview. Record the initial focus and
display state before each case. Use the same controlled content and action order
for comparisons. An absent adapter is recorded as unsupported, not as a passed
cancel or a no-op.

| ID                           | Actions                                                                                                                                                                                                            | Required observations; failures block the corresponding claim                                                                                                                                                                                                                       |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| K1 — keyboard traversal      | Traverse forward and backward through app controls and preview panes; hide, fully clip, disable focus on, then close the selected pane; restore an eligible pane.                                                  | Focus is visible and reaches the intended document; no hidden/nonfocusable pane receives text; no invisible focus stop traps traversal; closed panes retain no active input owner. API-directed focus alone is insufficient.                                                        |
| K2 — pointer and overlays    | Click each pane, its clipped edge, a covered region and an application overlay; resize rapidly; close the overlay.                                                                                                 | The intended native surface receives input, clipped regions do not, overlay ordering matches observed input, and siblings remain usable after closure. Record native-surface limitations separately from DOM z-index.                                                               |
| I1 — IME                     | Start composition in each pane using a recorded CJK IME; choose candidates, commit and cancel; repeat across focus changes, resizing, minimize/restore and supported backend replacement.                          | Candidate UI stays attached to the intended control; committed/cancelled text is exact; no lost, duplicated or prematurely committed input; no keystrokes reach a retired document. Record dead-key/combining-text cases for the claimed layout too.                                |
| T1 — selection and clipboard | Select controlled multilingual text using keyboard and pointer; use cut/copy/paste and empty-string cases in an isolated test session. Exercise app clipboard grants separately from browser clipboard permission. | Selection remains correct, paste targets the intended document, denied authority stays denied, and empty text differs from absent text. Preserve other native formats by refusing an unknown/nonempty initial fixture clipboard; do not use personal desktop contents as test data. |
| D1 — scaling and displays    | Move and resize the window between recorded display scales and relative positions; maximize/fullscreen/restore; disconnect and reconnect the secondary display.                                                    | Layout and hit testing agree in logical coordinates, text remains usable, menus/IME/overlays remain on an accessible display, focus survives, and no window is stranded outside all displays. A renderer devicePixelRatio value is not this test.                                   |
| A1 — accessibility           | With the recorded screen reader enabled, navigate app controls, previews, overlay and any supported native menu/dialog; inspect roles, names, values, focus announcements and reading order.                       | Every actionable element is reachable and accurately described; hidden/closed surfaces are not exposed as active targets; focus returns to a usable control after dismissing native UI. A DOM or DevTools accessibility snapshot does not replace the screen-reader observation.    |
| L1 — background and restore  | Exercise active, inactive-visible, hidden and minimized states while controlled output continues; restore and refocus through the desktop.                                                                         | Actual window state and page visibility agree, expected throttling stays enabled, output/cancellation remains correct, and input/focus recovers. Retain #129-like failures without relaxing its deadline.                                                                           |
| L2 — suspend/resume          | Suspend and resume the machine with the controlled application active, backgrounded and minimized; record the power/display configuration.                                                                         | The app becomes usable with valid focus, stale operations remain revoked, and no hidden window or lost IME state masquerades as success. Sleep time and recovery latency are recorded separately.                                                                                   |
| F1 — failure recovery        | Use the maintained controlled renderer/GPU fault case, then separately exercise any claimed hardware GPU transition.                                                                                               | A failure is surfaced, owned resources settle, replacement documents receive fresh authority, and input/accessibility recovers. Simulated process loss and hardware device loss remain different results.                                                                           |
| E1 — external activation     | Where implemented, exercise validated deep-link delivery, repeated activation and app reopen, including during shutdown and with an existing window.                                                               | Invalid schemes/arguments are rejected, delivery is bounded and observed once under the declared policy, and focus/window creation follows documented behavior. Unsupported OS integration cannot pass this case.                                                                   |
| M1 — native commands/dialogs | Where implemented, invoke menus/shortcuts, reject duplicate registrations, cancel native dialogs, replace the owning backend generation, and close the owning document during native UI.                           | Exactly the authorized current owner receives callbacks; cancellation is observed, not assumed; stale registrations cannot fire; native UI and listeners actually release.                                                                                                          |
| C1 — close and teardown      | Close previews individually, then the final window; quit while work is pending.                                                                                                                                    | Surviving panes remain usable, retired documents lose authority, native/process/helper cleanup completes under the existing deadlines, and no closed-view GPU/native owner remains reported as live. A successful SDK disposal alone is not process-exit evidence.                  |

For each case use one of **passed**, **failed**, **not run**, or **unsupported**.
Attach a reason to every result other than passed. Keep original failed attempts
and their source identities when a correction is retested. Never substitute a
later successful attempt for the earlier failure record.

Keep partial steps under their original case ID with their own observations and
unsupported reasons. In particular, successful selection cannot replace T1's
clipboard criteria, and the workbench's initial F1/E1 unsupported results
cannot be promoted using a different fixture without identifying its exact
source, capabilities and evidence. A later adapter merge does not silently
expand this workbench profile or qualify a physical test.

## Automated evidence and admission

Run the [full hosted/native contribution workflow](manual-native-qualification.md)
on the exact candidate before associating operator observations with it. Its
source, actual runtime identity, artifact immutability, native shutdown, output
drain and process/helper cleanup checks remain mandatory. Do not extend its
deadlines or disable sandboxing, background throttling, credential-provider
guards, or native authority to make an equipment case appear usable.

An offline report replay verifies retained evidence; it is not a new hardware
execution. A platform API cross-check verifies compilation; it is not native
execution. API-driven focus, synthetic browser input, DOM/AX snapshots and
renderer-reported scale retain their own narrower meaning.

Promote a claim only when its required case records pass on the named equipment
and profile, the relevant current-head native gate passes, and material
limitations are documented. Missing equipment does not block unrelated adapter
work, but its matrix cells remain not qualified. Performance conclusions require
their separately declared workloads and measurement protocol; this matrix
supplies no performance eligibility.
