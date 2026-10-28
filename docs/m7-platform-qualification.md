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

| Target      | Minimum equipment/configurations to record                                                                                                                                      | Current hardware status                                             |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| macOS ARM64 | Built-in Retina display; second display with a different scale; exact keyboard layout and IME; exact VoiceOver/macOS version.                                                   | Not qualified.                                                      |
| Windows x64 | Two displays at distinct configured scales; exact GPU/driver and Windows build; exact keyboard layout and IME; exact Narrator version and any additional claimed screen reader. | Not qualified.                                                      |
| Linux x64   | Exact distribution, X11 server, window manager, compositor and GPU/driver; display scale/topology; input-method framework and engine; exact Orca/AT-SPI configuration.          | Not qualified. Wayland is not inferred from the current X11 target. |

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

An interactive application is required for the operator cases. The fixed native
acceptance fixtures terminate automatically and are not interactive hardware
test applications. The current mock workbench is also not a native test target.
An operator record without an identified real native interactive target remains
incomplete; adding that maintained interactive target is explicit #38 follow-up.

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
