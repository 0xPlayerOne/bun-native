# M7 implementation and evidence status

This page's original platform matrix is a historical snapshot of `main` at
`59dc4c8` (2026-10-29); the current queue status is updated separately below.
It is a status map, not a milestone closeout. The issue tracker remains
authoritative for acceptance state: #34–#37 are open; #38 was closed by its
owner on 2026-10-28 with its acceptance boxes unchecked. That closure is
preserved as recorded and is not treated as hardware acceptance.

The labels below describe evidence scope, not product-release status:

- **Qualified (native fixture)** means the linked record documents an actual
  native execution on that OS for the named fixture. It does not qualify
  physical input, every OS integration path, hardware, release packaging or
  performance.
- **Implemented / unqualified** means code or an API/compile check exists, but
  this page found no qualifying native execution for that platform and behavior.
- **Unsupported** means the adapter explicitly rejects the operation or no
  implementation is provided.
- **Pending PR** means the change is not part of the `main` snapshot above.
- **Not run** is reserved for physical hardware or operator cases without a
  retained execution record.

## Platform capability matrix

| Capability                                                                            | macOS ARM64                                                              | Windows x64                                                          | Linux x64                                              | Scope and evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------- | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Window state and geometry                                                             | Qualified (native fixture)                                               | Qualified (hosted native suite)                                      | Qualified (hosted native suite)                        | [#132](https://github.com/0xPlayerOne/bunly/pull/132), [retained window reports](../evidence/m7-desktop/README.md), and [qualification protocol](desktop-qualification.md#window-controls). Hardware DPI, multi-monitor behavior, physical focus and accessibility are separate.                                                                                                                                                                                                                                                 |
| Native view composition, clipping, API focus and overlay                              | Qualified (native fixture)                                               | Qualified (hosted native suite)                                      | Qualified (hosted native suite)                        | [#133](https://github.com/0xPlayerOne/bunly/pull/133) and [composition evidence](../evidence/m7-view-composition/README.md). The hosted suite covered the fixed API fixture across all three targets; the retained detailed native observations are macOS. Physical pointer/Tab, IME, assistive technology, hardware displays and measured GPU/CPU comparison remain unqualified.                                                                                                                                                |
| Application lifecycle observations                                                    | Qualified (native fixture)                                               | Qualified (hosted native suite)                                      | Qualified (hosted native suite)                        | [#134](https://github.com/0xPlayerOne/bunly/pull/134) and [public result record](../evidence/m7-desktop-services-results.json). These callbacks do not by themselves prove process/helper cleanup or suspend/resume behavior.                                                                                                                                                                                                                                                                                                    |
| Text clipboard                                                                        | Qualified (native fixture)                                               | Qualified (native fixture)                                           | Unsupported                                            | macOS AppKit and Windows Win32 paths are in [#134](https://github.com/0xPlayerOne/bunly/pull/134). Linux explicitly reports unsupported. This is text clipboard behavior on the disposable qualification runners, not arbitrary formats or physical clipboard contention.                                                                                                                                                                                                                                                        |
| Popup/context menus and window-local shortcuts                                        | Qualified (macOS fixture)                                                | Implemented / unqualified                                            | Implemented / unqualified                              | [#139](https://github.com/0xPlayerOne/bunly/pull/139) records real macOS menu selection, local shortcut, cancellation and disposal callbacks. Windows/Linux evidence is API/compile coverage, not native menu execution. Physical keyboard routing, accessibility and global shortcuts are not covered.                                                                                                                                                                                                                          |
| Native open/save file dialogs                                                         | Qualified for callback, cancel and cleanup fixture                       | Unsupported                                                          | Unsupported                                            | [#139](https://github.com/0xPlayerOne/bunly/pull/139) records six macOS panel admissions/callbacks, cancellation and revocation; it selected zero files. Windows/Linux explicitly report unsupported. See [dialog contract and limits](file-dialogs.md).                                                                                                                                                                                                                                                                         |
| Text status item                                                                      | Merged on main; earlier macOS native fixture pass                        | Unsupported                                                          | Unsupported                                            | [#142](https://github.com/0xPlayerOne/bunly/pull/142) merged at `2815596` after this matrix snapshot. Its macOS fixture exercised text items and synthetic callbacks. Windows/Linux return unsupported. Appearance, physical activation, tray menus, global shortcuts, application keepalive and release signing are outside that fixture.                                                                                                                                                                                       |
| Application links and outbound HTTPS                                                  | Pending PR; earlier macOS fixture pass, live OS delivery unqualified     | Pending PR; outbound HTTPS implemented, OS-link handling unsupported | Pending PR; unsupported                                | [#145](https://github.com/0xPlayerOne/bunly/pull/145) is a draft and is absent from this `main` snapshot. Its earlier macOS fixture covered controlled startup inputs, inbox/read/acknowledgment and cleanup; it does not register an OS protocol handler or open a real external browser. Windows outbound HTTPS uses the fixed ShellExecute verb, but live inbound OS links are unsupported. Linux reports outbound submission unsupported. Second-instance forwarding and reopen are not implemented.                         |
| Native downloads                                                                      | Qualified fixture evidence on an earlier source                          | Implemented / unqualified; retained completion failure               | Qualified fixture evidence on an earlier source        | Download code is in `main` through [#144](https://github.com/0xPlayerOne/bunly/pull/144), which incorporated the implementation from superseded [#138](https://github.com/0xPlayerOne/bunly/pull/138). The Windows standard-user run received all 32 KiB but did not complete before the unchanged six-second deadline; cancellation and cleanup settled. Preserve that failure. Do not advertise Windows completion as qualified without a fresh passing current-source run. See [download qualification limits](downloads.md). |
| Programmatic file-input upload and synthetic DOM drop                                 | Pending PR; earlier macOS four-profile pass on a prior integrated source | Pending PR; no current native qualification identified               | Pending PR; no current native qualification identified | [#143](https://github.com/0xPlayerOne/bunly/pull/143) is a draft and absent from this `main` snapshot. The earlier macOS pass is explicitly not attributed to its current integrated head; a fresh integrated run is required. The scope supplies application-approved bytes to an exact main-document input/drop target. It does not implement OS file picking, arbitrary path reads, directory upload or physical drag.                                                                                                        |
| Development browser actions                                                           | Qualified on macOS at the recorded fixture/build source                  | Implemented / unqualified for native action fixture                  | Implemented / unqualified for native action fixture    | [#144](https://github.com/0xPlayerOne/bunly/pull/144) is merged. Its four-profile macOS pass is tied to the recorded fixture and native build in the PR, not to physical or trusted input. The feature is gated, non-default and development-only; it does not expose a public CDP listener. The current evidence map does not identify an equivalent Windows/Linux native browser-action execution.                                                                                                                             |
| Physical keyboard, pointer, IME, accessibility, DPI, display topology, suspend/resume | Not run                                                                  | Not run                                                              | Not run                                                | [#38](https://github.com/0xPlayerOne/bunly/issues/38) remains unqualified; the maintained [hardware protocol](m7-platform-qualification.md) records all operator cases as not run or unsupported. Wayland is not inferred from the Linux X11 target.                                                                                                                                                                                                                                                                             |

“Qualified” above is deliberately narrow. It does not combine a macOS run with a Windows/Linux claim, and an unsupported cell is not a pass. Where a fixture was run against an earlier source or native build, its PR is the source of that attribution; it is not a fresh run of the current `main` snapshot.

## Evidence provenance and exact attributions

The merged feature PRs contain their full review, validation and retained-run
records. These exact identities make clear which observations support the
matrix and where an older fixture result must not be mistaken for a current
source run:

| Area                         | Exact evidence attribution                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Window state and geometry    | [Hosted workflow 40625281036](https://github.com/0xPlayerOne/bunly/actions/runs/40625281036) passed the native suite on Linux x64, macOS ARM64 and Windows x64. The accepted macOS fixture source was `e5316ebd48d771ffd490a24b814aabcfd0b80ed2`, with native build source `84e8589992e2bf0d701ea45d5b9b4599522cce73`; retained report/replay details are in [evidence/m7-desktop](../evidence/m7-desktop/README.md) and [#132](https://github.com/0xPlayerOne/bunly/pull/132).                                            |
| View composition             | [Hosted workflow 40628759325](https://github.com/0xPlayerOne/bunly/actions/runs/40628759325) passed the native suite on all three targets. The detailed macOS run is attributed to source/native commit `2771bed9af84c956372ca8bbac56711508640ecc`; the accepted report and replay instructions are in [evidence/m7-view-composition](../evidence/m7-view-composition/README.md) and [#133](https://github.com/0xPlayerOne/bunly/pull/133).                                                                                |
| Lifecycle and clipboard      | [Workflow 40637325605](https://github.com/0xPlayerOne/bunly/actions/runs/40637325605) passed the full 14-stage native suite on all three targets at PR head `ef2626b8cd7da8236527947f81965e551e0353af`; the minimal public record is [m7-desktop-services-results.json](../evidence/m7-desktop-services-results.json). Clipboard is exercised only on macOS and Windows; Linux is an explicit unsupported result. See [#134](https://github.com/0xPlayerOne/bunly/pull/134).                                               |
| Menus, shortcuts and dialogs | The actual macOS selection/cancellation/cleanup pass is tied to source `efe4db3` in [#139](https://github.com/0xPlayerOne/bunly/pull/139). It is not evidence of physical input or a Windows/Linux native menu execution. The dialog run selected zero files, so this qualifies callback/cancel/cleanup behavior only.                                                                                                                                                                                                     |
| Downloads                    | The retained Windows standard-user completion failure occurred at checkpoint `42675aa` in [workflow 40764782582](https://github.com/0xPlayerOne/bunly/actions/runs/40764782582): 32,768 bytes arrived, but completion missed the unchanged six-second request deadline. Later diagnostic/filename fixes do not convert that attempt into a pass. [#138](https://github.com/0xPlayerOne/bunly/pull/138) was superseded after its implementation entered main through [#144](https://github.com/0xPlayerOne/bunly/pull/144). |
| Browser actions              | The actual four-profile macOS pass is tied to fixture `6f7c3ab`, native build `b1dd997`, native tree `4ab9910dd6a24cb90af863763902fc3eb95e4dfb`, as recorded in [#144](https://github.com/0xPlayerOne/bunly/pull/144). It is earlier-source evidence; it does not qualify Windows/Linux native actions, physical input or trusted input.                                                                                                                                                                                   |
| Status item                  | [#142](https://github.com/0xPlayerOne/bunly/pull/142) merged at `2815596`. Its macOS fixture pass is attributed to source `211a09b4f8c53ea005c62024fc9069e73ccedd29`, using native build `398f5ac`; report SHA-256 `ab050ec42367161518c02172758d07b40abfc75fcc7320948fe6b8c6b3be72ef`. It has no Windows/Linux adapter. The generated 0.2.0 release candidate is [#160](https://github.com/0xPlayerOne/bunly/pull/160).                                                                                                    |
| Application links            | The pending [#145](https://github.com/0xPlayerOne/bunly/pull/145) records a macOS pass at source `3067a218097cd5f18d78673cc2c4b2b510f4a43a`, native build `f984f112ab09b40b64e66090ca21dd2911c7cd84`. Status report SHA-256: `ee3488d6a0877ea78b857c7c603700752b8d46790ce0e045d7e0fc0601bf0168`; links report SHA-256: `05c3ec6d893aa9a6772eea5011f75942552d822bd8a315893c130fd6836e7852`. Neither report establishes live OS URL delivery or opening a real external browser.                                             |
| Programmatic files           | The pending [#143](https://github.com/0xPlayerOne/bunly/pull/143) explicitly attributes its earlier four-profile macOS pass to source `d2b8c05` and says it is not evidence for the current integrated head `77c1101da8a89c80137b1270dc33ebed9bddfbbd`. A fresh current-head native run is pending.                                                                                                                                                                                                                        |

The PRs also preserve failed attempts. A later successful run only replaces a
failure when its exact source and outcome are recorded; it never erases the
earlier result or makes an unrelated target qualified.

## Acceptance coverage by issue

### #34 — bounded TypeScript desktop API and platform matrix

The repository has implemented and fixture-tested the bounded core: window
state/geometry ([#132](https://github.com/0xPlayerOne/bunly/pull/132)), lifecycle
and text clipboard ([#134](https://github.com/0xPlayerOne/bunly/pull/134)),
macOS popup menus, local shortcuts and file-panel cancellation/cleanup
([#139](https://github.com/0xPlayerOne/bunly/pull/139)), and the text status item
([#142](https://github.com/0xPlayerOne/bunly/pull/142), merged at `2815596`). The
application-link increment [#145](https://github.com/0xPlayerOne/bunly/pull/145)
remains pending. The matrix above makes
the platform boundary and recorded evidence explicit; implementation and
qualification still differ by feature and target.

| #34 acceptance area                                                                                     | Current coverage                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Bounded APIs for window state/geometry, lifecycle, menus, tray, dialogs, clipboard, shortcuts and links | Window/lifecycle/clipboard plus local popup menus, shortcuts and macOS file panels are implemented in #132/#134/#139; the text status item merged in #142. Application links remain pending in #145. Tray icons/menus, general message dialogs, global shortcuts, protocol registration, second-instance forwarding and reopen are outside the documented bounded MVP. |
| Apply #21 capability policy and safe argument/path validation                                           | Merged native operations use scoped capability/policy checks and bounded inputs; downloads retain path/redirect/session checks. Pending link and file branches add their own bounded validation and need final integrated gates. The status-item implementation merged in #142.                                                                                        |
| Generation-aware disposable callbacks and #28 resource ownership                                        | Merged and pending feature PRs include retirement/disposal tests and native cleanup receipts. Reconfirm the complete integrated current-head native gate after dependent merges.                                                                                                                                                                                       |
| Publish tested/unsupported platform matrix and fallback errors                                          | This page consolidates feature status and links to source evidence. Many cells remain unqualified or unsupported; publication does not itself qualify them. The physical matrix in #38 remains unrun.                                                                                                                                                                  |
| Preserve useful Electron concepts without claiming full compatibility                                   | The repository documents a bounded CEF-first scope and does not claim Electron parity.                                                                                                                                                                                                                                                                                 |

The M7 scope is a bounded CEF-first MVP, not full Electron compatibility. The
repository and PR descriptions leave global shortcuts, tray icons/menus, general
message dialogs, OS protocol registration, second-instance forwarding and app
reopen as separate work or explicit exclusions. The merged text-only status
item, window-local shortcuts and open/save file panels do not imply those larger
surfaces. This map records the implemented bounded scope; it does not close #34
or decide that unsupported variants satisfy its remaining acceptance criteria.
Existing broad wording in the issue about “tray,” “dialogs,” and “external
URL/deep-link handling” is only partially satisfied by these narrower surfaces:
the application-link PR remains pending, file panels do not provide general
message dialogs, and live OS link delivery/external browser submission remains
unqualified.

Generation-aware ownership and disposal are implemented for the merged native
facets, including the status item, and in the pending application-link change;
see their exact lifecycle tests and reports in the linked PRs. PR results are
not a substitute for confirming the final integrated current-head gates after
each dependency merge.

### #35 — embedded views, layout and focus composition

The merged API supplies multi-view bounds, clipping, visibility, API focus
traversal, native overlay behavior, managed-generation reattachment and close
cleanup. [#133](https://github.com/0xPlayerOne/bunly/pull/133) records a macOS
native fixture and the three-target hosted suite. The retained limitations in
[view-composition.md](view-composition.md) and the PR are substantive: physical
keyboard/pointer behavior, IME, assistive technology, hardware DPI/multiple
displays, and context-menu/dialog focus are not established by API-directed
fixtures.

| #35 acceptance area                                                                                                   | Current coverage                                                                                                                                                                                                             |
| --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Multi-view attach, bounds, clipping, visibility, resize and lifecycle                                                 | Implemented and exercised by the fixed composition fixture; the hosted native suite ran on Linux, macOS and Windows, with detailed retained macOS observations in #133. Physical high-DPI/display behavior remains separate. |
| Keyboard/pointer focus transfer, tab order, context menus and host overlay/dialog interaction                         | API focus order, focus eligibility and overlay interaction are implemented. Physical keyboard/Tab/pointer routing and context-menu/dialog focus are unqualified.                                                             |
| Document native-surface versus DOM stacking limits and prototype a supported overlay                                  | Documented in [view-composition.md](view-composition.md); the CEF Views overlay path is implemented and exercised.                                                                                                           |
| Evaluate windowed versus off-screen rendering where needed, including GPU/CPU, accessibility, IME and input tradeoffs | Windowed CEF Views are the implemented choice, with qualitative tradeoffs documented. No GPU/CPU comparison or performance eligibility exists; whether the MVP requires a measured OSR comparison is unresolved.             |
| Preserve view/session identity through reload and release resources on close                                          | Managed reattachment and ordinary native owner cleanup are covered by #133 fixtures. These receipts do not measure physical GPU-memory reclamation.                                                                          |

The current rendering decision uses windowed CEF Views with a supported native
overlay. The documentation describes the reason and tradeoffs, but explicitly
says resize throughput was not benchmarked and the fixture is ineligible for
performance comparison. Therefore no GPU/CPU improvement, memory advantage or
OSR-versus-windowed measurement is claimed. The #35 criterion asks for an
evaluation “only where needed”; the defensible closeout is to record whether a
measured OSR comparison is needed for the declared MVP, and to retain the
unmeasured status if it is not. If the criterion is read as requiring measured
GPU/CPU tradeoffs, that work remains a true open gate. No performance result is
inferred here.

### #36 — downloads, uploads and file interaction

Native downloads include bounded start/progress/cancel/complete/failure handling,
path validation, overwrite behavior, redirect/session checks and cleanup in
[#144](https://github.com/0xPlayerOne/bunly/pull/144); the earlier standalone
download PR [#138](https://github.com/0xPlayerOne/bunly/pull/138) was superseded
after its implementation landed through #144. The retained Windows completion
failure is still a qualification gap. The download docs also state that
application uploads/file input and OS-file drag/drop require distinct scoped
designs.

| #36 acceptance area                                                           | Current coverage                                                                                                                                                                                                               |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Download lifecycle and safe destination/overwrite policy                      | Implemented with a 14-transfer native fixture and destination/overwrite checks. macOS/Linux fixture evidence exists; preserve the Windows completion failure until a fresh passing current-source run.                         |
| File-input upload and declared drop through approved file access              | Programmatic application-supplied bytes are proposed in draft #143. OS picker-to-read, arbitrary path access, directory upload and physical OS-file drag/drop remain unsupported or unqualified.                               |
| Names, paths, redirects, ownership/permissions and platform security metadata | Download implementation validates these boundaries; the retained Windows run includes a completion failure despite earlier security-stream checks. Full current-source Windows qualification remains outstanding.              |
| Close/navigation/reload lifetime and cleanup                                  | Download fixtures cover cancellation and cleanup across navigation, reload, view/window closure and quit. #143 adds corresponding programmatic-input ownership tests but is still pending current-source native qualification. |
| Portable contracts and explicit unsupported errors                            | Portable contracts and capability/error behavior are implemented for the merged download path; the pending file-input path still needs its final integrated evidence.                                                          |

[#143](https://github.com/0xPlayerOne/bunly/pull/143) adds the narrower
programmatic byte-input path. It does not grant remote content arbitrary file
reads and does not satisfy OS-picker selection or physical file drop. It remains
draft, and the PR says the earlier macOS four-profile run is not attributed to
the current integrated source. Fresh current-source evidence is required before
those paths can be called qualified.

### #37 — engine-neutral browser actions and secure diagnostics

[#144](https://github.com/0xPlayerOne/bunly/pull/144) merges capability-gated
navigation, screenshot capture, approved evaluation, bounded DOM/accessibility
observation and synthetic DOM text/pointer input, with per-view/session/document
authority checks. Its macOS four-profile fixture does not establish physical or
trusted input, and the PR describes the feature as non-default development
functionality.

| #37 acceptance area                                                                              | Current coverage                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Engine-neutral navigation, screenshots, approved evaluation, DOM/AX observation and input        | Implemented in #144 with bounded outputs and a macOS four-profile native fixture. Physical/trusted input and Windows/Linux native action execution remain unqualified.                                                                           |
| Bind actions to authorized view/session and revalidate targets; keep remote content unprivileged | Implemented with exact view/session/document/frame/context checks, stale-target/navigation tests and remote-trust preservation in #144.                                                                                                          |
| Keep raw CDP engine-specific instead of the only public control API                              | Met by the engine-neutral action surface; no public raw CDP listener/API is exposed by #144.                                                                                                                                                     |
| Source-mapped errors, renderer/RPC/reload diagnostics and bounded/redacted bundle                | The bounded collector is implemented in `diagnostics.ts`; its public re-export is pending. Confirm the exact public API and documentation after the separate diagnostics change lands.                                                           |
| Local/authenticated/opt-in debug surfaces disabled in production                                 | The collector opens no endpoint. #144 gates its development feature behind an exact loopback origin and installed-manifest opt-in, with rejection before browser startup when missing. Preserve that default-off boundary in any follow-on work. |

The bounded/redacted diagnostic collector exists in
`packages/runtime/src/diagnostics.ts` and opens no debug endpoint. It is not
currently re-exported from `packages/runtime/src/index.ts`. Public export/API
and the corresponding documentation are being handled separately; this page
does not claim that work merged or that the full #37 diagnostic criterion is
closed. The current scope also requires continued verification that any debug
endpoint stays local, authenticated, opt-in and disabled in packaged production
builds. The #37 closeout should also name the public diagnostics API and its
exact supported surfaces; the collector's presence alone does not satisfy the
entire criterion.

### #38 — hardware, accessibility and lifecycle qualification

The owner closed [#38](https://github.com/0xPlayerOne/bunly/issues/38) on
2026-10-28, but its acceptance boxes are unchecked, and the maintained
[qualification protocol](m7-platform-qualification.md) says the operator cases
remain not run or unsupported. The closure is left unchanged here and is not
represented as evidence of completion. The merged API fixtures do not replace
physical keyboard/pointer, IME, clipboard, accessibility, high-DPI/multi-monitor,
suspend/resume, GPU-context recovery, deep-link or reopen observations.

Required configuration and record fields are maintained in the protocol. The
current equipment needs are:

- macOS ARM64: Retina built-in display plus a second display at another scale,
  a recorded keyboard layout/IME and VoiceOver.
- Windows x64: two displays with different configured scales, recorded GPU,
  driver and Windows build, a keyboard layout/IME and Narrator.
- Linux x64: a recorded distribution, X11/window manager/compositor/GPU,
  display topology/scale, input-method framework and Orca/AT-SPI. This does not
  infer Wayland support.

Each physical result must identify its exact source/native build and packaged
Bun/CEF identities, hardware/OS/input/accessibility settings, fixture and case
IDs, observations, failures and retained evidence. The workbench's preparation
or launch alone does not mark a case passed. See
[hardware-workbench.md](hardware-workbench.md) and
[m7-platform-qualification.md](m7-platform-qualification.md).

## Current merge and qualification boundary

At this snapshot, [#142](https://github.com/0xPlayerOne/bunly/pull/142),
[#145](https://github.com/0xPlayerOne/bunly/pull/145) and
[#143](https://github.com/0xPlayerOne/bunly/pull/143) are draft PRs and are not
included in the original `59dc4c8` matrix snapshot. At the current queue head,
[#142](https://github.com/0xPlayerOne/bunly/pull/142) is merged as commit
`2815596`; [#145](https://github.com/0xPlayerOne/bunly/pull/145) and
[#143](https://github.com/0xPlayerOne/bunly/pull/143) remain draft PRs. The
generated [0.2.0 release PR #160](https://github.com/0xPlayerOne/bunly/pull/160)
is open at head `503d0e9b865c1b927e5d3dc6ebce1c311d9dfe74`; it contains release
metadata/version changes for #142, not additional desktop capability work.
Refresh remaining #34–#37 coverage against the integrated main after #145/#143
and their current-head gates; this document does not close or mutate issues.
M7 should not be described as complete while those items, the Windows download
failure and unresolved #34–#37 acceptance details remain. Separately, the #38
owner-closed state does not change that its physical qualification evidence is
unrun; preserve that limitation in any milestone or support claim without
changing the issue state.

No measured performance advantage or speedup is claimed by this status map.
