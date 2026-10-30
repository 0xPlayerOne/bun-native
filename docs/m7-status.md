# M7 implementation and evidence status

This 2026-10-29 record maps M7's bounded desktop/browser implementation to its
retained evidence. It covers the outgoing feature PRs #142, #143 and #145,
diagnostics in #161, hardware-workbench controls in #162, fixture cleanup in
#163 and native console bounds in #165, alongside the earlier desktop APIs.
It also records the merged overlay polling cleanup in #170, composition resource
profile in #172, download completion diagnostics in #173, the Windows
non-file destination correction in #177 and native input-cache retention in #184.
The bounded software criteria for #34 and #37 are complete. M7 remains in
progress: #35 retains physical focus/composition and measurement gaps, and #36
retains the Windows native download-completion gate. The owner closed #38 on
2026-10-28 with its acceptance boxes unchecked; that closure is not hardware
evidence. The issue tracker remains authoritative for closure state.

“Qualified” below means that a retained native fixture ran on that OS for the
named behavior. It does not establish physical input, hardware, every OS
integration path, release packaging or performance. “Implemented / unqualified”
means code or API coverage exists without a matching native run. “Unsupported”
means the adapter rejects the operation or has no implementation. Unsupported
and unrun paths are not passes.

## October 30 continuation: watcher recovery and download phase timing

Release [v0.6.5](https://github.com/0xPlayerOne/bunly/releases/tag/v0.6.5)
includes merged [#201](https://github.com/0xPlayerOne/bunly/pull/201)
and [#202](https://github.com/0xPlayerOne/bunly/pull/202). The latter closes
[#179](https://github.com/0xPlayerOne/bunly/issues/179) for the demonstrated macOS
backend notification-loss recovery path. Its retained failing trace distinguishes
missing notification delivery from a later build/worker failure. The same
real-bundle regression with every filesystem notification withheld fails on the
old implementation at the unchanged fifteen-second deadline and passes on the
bounded correction. Final local validation passed 1,614 Bun tests with three
skips and 310 Python tests; all current-head hosted platform checks passed.
See [the recovery contract](development-host.md#macos-backend-dependency-notification-recovery)
and [source-attributed failure evidence](../evidence/development-watcher/README.md).
This is not a fix for every filesystem notification or arbitrary frontend asset.

The maintained Windows/full [run 41002711192](https://github.com/0xPlayerOne/bunly/actions/runs/41002711192)
on #201's exact source `9bec0651a5ac6b2725095ece77667f0978f97810` still failed its
first six-second download. The [selected phase summary](../evidence/m7-windows-phase-timing-2026-10-30.json)
retains exact source/digests and the following relative native observations:

| Observation                                       | Milliseconds from record creation before StartDownload |
| ------------------------------------------------- | -----------------------------------------------------: |
| Exact resource completion (32,768 bytes, success) |                                                      2 |
| First matched native download callback            |                                                  5,549 |
| Before-download callback                          |                                                  5,551 |
| First positive/full byte count                    |                                                  5,552 |
| Last callback before timeout                      |                                                  5,645 |
| Application-wide file-utility last launch         |                                                  5,647 |
| Timeout receipt                                   |                                                  6,001 |

This localizes substantial pre-callback delay but does not prove its cause. The
last native item remained in progress, not complete. The separate native shutdown
receipt has zero download owners; temporary cleanup and SDK shutdown succeeded,
while overall host `clean` is false. The fixture's nested `downloadShutdown` field
is null and is not substituted for the separate native receipt. Thirteen later
download scenarios were not run. Source-before/after are clean with equal source
hashes, but after-run binary inventories were not reached. No security setting,
payload, completion rule or maintained deadline was relaxed.

**M7 remains open.** #36 still requires a corrected, passing maintained Windows
completion gate, and #35 still requires physical focus/input/IME/accessibility/
display observations and the specified rendering comparison. Historical Mac
composition data and a software watcher fix do not qualify those missing cases.

## Current capability matrix

| Capability                                                                               | macOS ARM64                                                                | Windows x64                                                                                                | Linux x64                                            | Scope and evidence                                                                                                                                                                                                                                                                             |
| ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Window state, geometry and native view composition                                       | Native fixtures; API focus and overlay covered                             | Hosted native suite                                                                                        | Hosted native suite                                  | [#132](https://github.com/0xPlayerOne/bunly/pull/132), [#133](https://github.com/0xPlayerOne/bunly/pull/133). Physical focus, pointer/Tab, IME, accessibility, hardware DPI and multi-monitor behavior remain unqualified.                                                                     |
| Application lifecycle observations and text clipboard                                    | Native fixtures                                                            | Native fixtures                                                                                            | Lifecycle fixture; text clipboard unsupported        | [#134](https://github.com/0xPlayerOne/bunly/pull/134). Clipboard coverage is macOS/Windows text only and does not establish physical clipboard contention.                                                                                                                                     |
| Popup/context menus and window-local shortcuts                                           | Native selection, cancellation and disposal fixture                        | Synthetic-native selection, cancellation and disposal fixture                                              | Native selection/cancellation/disposal fixture       | [#139](https://github.com/0xPlayerOne/bunly/pull/139); [Windows source and replay](#verified-windows-desktop-fixture-reports). Physical keyboard routing and accessibility remain unqualified. Global shortcuts are outside the implemented MVP. PR #162 supplies operator-workbench controls. |
| Native open/save panels                                                                  | Callback/cancel/cleanup fixture; zero files selected                       | Unsupported                                                                                                | Unsupported                                          | [#139](https://github.com/0xPlayerOne/bunly/pull/139); see [dialog limits](file-dialogs.md). This is not general message-dialog or filesystem access.                                                                                                                                          |
| Text status item                                                                         | Native fixture                                                             | Unsupported                                                                                                | Unsupported                                          | [#142](https://github.com/0xPlayerOne/bunly/pull/142). The fixture covers text items and synthetic callbacks, not a tray icon/menu, physical activation, keepalive or release signing.                                                                                                         |
| Application links and outbound HTTPS                                                     | Controlled inbox/read/acknowledgment fixture; live OS delivery unqualified | Startup inbox/read/acknowledgment fixture; outbound HTTPS launch unqualified; inbound OS links unsupported | Outbound submission unsupported                      | [#145](https://github.com/0xPlayerOne/bunly/pull/145); [Windows source and replay](#verified-windows-desktop-fixture-reports). OS registration, live OS delivery and a real external-browser launch remain unqualified. Second-instance forwarding and reopen are not implemented.             |
| Native downloads                                                                         | Fixture evidence on earlier source                                         | Implemented / unqualified; retained completion failure                                                     | Native fixture, source-attributed below              | [#144](https://github.com/0xPlayerOne/bunly/pull/144), incorporating the implementation from superseded [#138](https://github.com/0xPlayerOne/bunly/pull/138). Preserve the Windows failure described below; a fresh passing current-source run is still needed.                               |
| Programmatic file-input upload and synthetic DOM drop                                    | Earlier four-profile fixture on prior source                               | Implemented / unqualified; no native run identified                                                        | Four-profile native fixture, source-attributed below | Merged [#143](https://github.com/0xPlayerOne/bunly/pull/143). This stages application-supplied bytes for approved file inputs and synthetic drops; it grants no arbitrary path reads and does not qualify an OS picker, physical OS-file drop or directory upload.                             |
| Development browser actions                                                              | Four-profile native fixture at recorded source                             | Implemented / unqualified for the native action fixture                                                    | Four-profile native fixture at recorded source       | [#144](https://github.com/0xPlayerOne/bunly/pull/144). Input is synthetic; Windows actions, trusted/physical input and assistive technology remain unqualified.                                                                                                                                |
| Physical keyboard, pointer, IME, accessibility, DPI, display topology and suspend/resume | Not run                                                                    | Not run                                                                                                    | Not run                                              | The maintained [hardware protocol](m7-platform-qualification.md) records operator cases as not run or unsupported. Linux x64/X11 evidence does not imply Wayland support.                                                                                                                      |

The accepted #34 MVP is the capability-reported CEF-first surface: window
state/geometry, lifecycle observations, text clipboard on supported adapters,
application-triggered native popup menus, window-local shortcuts, macOS
open/save panels, a macOS text status item, validated startup/application-link
input and bounded outbound HTTPS submission. Unsupported variants report
capability errors. System menu bars, automatic Chromium context-menu
replacement, full tray icons/menus, general message dialogs, global shortcuts,
OS protocol registration, second-instance forwarding and app reopen remain
outside this implementation. Live OS-link delivery and a real external-browser
launch are unqualified. This bounded acceptance does not assert Electron
compatibility or qualify an untested platform.

The #37 software surface includes capability-gated browser actions, exported
source-map/redaction/bundle helpers, typed per-view renderer console observers
and fixed RPC handler-stage diagnostics. Source-mapped Bun errors cover the
managed reload path and explicitly supplied maps; universal automatic source-map discovery/mapping is not
claimed. Subscriptions and collection are opt-in and best
effort; console forwarding on the existing private native pipe is unchanged.
No public raw CDP or listening debug endpoint exists. Asynchronous observers
and diagnostic queues are bounded, and native console output is limited to
16 in-flight frames and 128 KiB within the ordinary transport budget. Excess
console records are dropped while control capacity and required-event failure
semantics remain intact. No measured performance improvement is inferred from
these bounds.

## Selected native evidence and exact attribution

The [selected M7 native functional summary](../evidence/m7-native-functional-2026-10-29.json)
is a public-safe selection, not a complete independently replayable report. It
contains source/build identities, accepted checks, owner-cleanup counts and raw
report SHA-256 values. It omits raw process arguments, process samples,
machine-local paths, nonces and payloads. Its CEF sandbox identity is explicitly
`unverified`, and it records no embedded native-build attestation. It supports
only the two Linux x64 synthetic-fixture runs below; it does not qualify
hardware, physical input, Windows/macOS, an OS picker, performance or RSS.

The separate [Linux desktop functional summary](../evidence/m7-linux-desktop-functional-2026-10-29.json)
records three more native fixtures associated with PR #165. The parent-close
case used local source `fbdc306` (published equivalent `f83aaa6`); commands and
downloads used local source `ef6c3ca` (published equivalent `823c66d`). The
summary records complete commit/tree identities, native feature profiles,
report and binary hashes, unchanged-input checks, and cleanup outcomes. All
three used native CEF tree `287b418ed4e7dba5df106276baa2f1da3e71c596`.

| Linux fixture             | Recorded result                                                                                                                     | Limits                                                                   |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Parent close              | Four live panes, four view-close callbacks, one window-close callback, surviving control, four released sessions                    | Ordinary packaging profile; no OS-quit, physical-input or hardware claim |
| Menus and local shortcuts | Seven events, three popup openings, two selected commands, one cancelled menu, one disposed open menu, native ownership released    | Contributor `rpc-qualification` profile; synthetic native input          |
| Downloads                 | Fourteen expected outcomes: three completed, seven cancelled and four failed; native ownership released and temporary files cleaned | Contributor profile; Linux result does not resolve Windows completion    |

All three fixtures passed with clean, unchanged source and input/prepared
artifacts, exit 0, no process timeout/cancellation or output overflow, no observed orphans
or cleanup survivors, and cleaned disposable displays. The sandbox identity
remains unverified and embedded build attestations are absent. The summary is
selected evidence, not a complete replay report; earlier setup and unsupported
contributor-probe failures remain failures. No Windows/macOS, physical-input,
assistive-technology, hardware, performance or RSS result is inferred.

| Area                      | Retained attribution and limit                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Window state and geometry | Hosted workflow [40625281036](https://github.com/0xPlayerOne/bunly/actions/runs/40625281036) passed the native suite on Linux x64, macOS ARM64 and Windows x64. The retained macOS fixture source was `e5316ebd48d771ffd490a24b814aabcfd0b80ed2`, native build source `84e8589992e2bf0d701ea45d5b9b4599522cce73`; details are in [m7-desktop evidence](../evidence/m7-desktop/README.md).                                                                                                                                                                                                                                                                                              |
| View composition          | Hosted workflow [40628759325](https://github.com/0xPlayerOne/bunly/actions/runs/40628759325) passed all three targets. The detailed macOS run is attributed to source/native commit `2771bed9af84c956372ca8bbac56711508640ecc`; see [composition evidence](../evidence/m7-view-composition/README.md).                                                                                                                                                                                                                                                                                                                                                                                 |
| Lifecycle and clipboard   | Workflow [40637325605](https://github.com/0xPlayerOne/bunly/actions/runs/40637325605) passed the 14-stage native suite on all three targets at PR head `ef2626b8cd7da8236527947f81965e551e0353af`; see the [public result](../evidence/m7-desktop-services-results.json). Text clipboard ran only on macOS and Windows; Linux was explicitly unsupported.                                                                                                                                                                                                                                                                                                                              |
| Menus and dialogs         | The macOS menu-selection and panel-admission/cancellation/cleanup result is tied to source `efe4db3` in [#139](https://github.com/0xPlayerOne/bunly/pull/139). The panel selected zero files. Neither result is evidence of physical keyboard input or a Windows/Linux native menu run.                                                                                                                                                                                                                                                                                                                                                                                                |
| Windows download          | The maintained [merged-main run 40942788214](https://github.com/0xPlayerOne/bunly/actions/runs/40942788214) retains the six-second completion failure after #177. Earlier failed runs and both excluded timing probes are recorded below with their exact sources and limits.                                                                                                                                                                                                                                                                                                                                                                                                          |
| Status item               | [#142](https://github.com/0xPlayerOne/bunly/pull/142) merged at `2815596`. Its macOS fixture source was `211a09b4f8c53ea005c62024fc9069e73ccedd29`, native build `398f5ac`, report SHA-256 `ab050ec42367161518c02172758d07b40abfc75fcc7320948fe6b8c6b3be72ef`. It has no Windows/Linux adapter.                                                                                                                                                                                                                                                                                                                                                                                        |
| Application links         | [#145](https://github.com/0xPlayerOne/bunly/pull/145) merged at `3fc7ae0`; its macOS fixture source was `3067a218097cd5f18d78673cc2c4b2b510f4a43a`, native build `f984f112ab09b40b64e66090ca21dd2911c7cd84`. Status report SHA-256: `ee3488d6a0877ea78b857c7c603700752b8d46790ce0e045d7e0fc0601bf0168`; links report SHA-256: `05c3ec6d893aa9a6772eea5011f75942552d822bd8a315893c130fd6836e7852`. Neither report proves live OS URL delivery or launch of a real external browser.                                                                                                                                                                                                     |
| Browser actions           | The four-profile macOS pass is tied to fixture `6f7c3ab`, native build `b1dd997`, native tree `4ab9910dd6a24cb90af863763902fc3eb95e4dfb`, as recorded in [#144](https://github.com/0xPlayerOne/bunly/pull/144). The Linux four-profile run used source `718598a55fac90c997cf650879439a79fc46ef31`, source tree `d890d1e028ff1cb0798e8c618c2400f6b60d7ba5`, native CEF tree `faef4e6612afed868de53398333734590e900a7f`, and report SHA-256 `d5b88ac4ce028a3b61cccaeede25c0f9d1e2940aebe801bd51cb2165c8bf50c1`. These are synthetic-input results, not Windows, physical/trusted input or assistive-technology evidence.                                                                 |
| Programmatic files        | The selected Linux report records app/fixture source `fd75339d1c7f4944c14e9db87af309723aab8961`, tree `d820c289edd942c844e473eba7c46d2c31227094`, clean source and unchanged inputs. Its native build declares source `718598a55fac90c997cf650879439a79fc46ef31` and CEF tree `faef4e6612afed868de53398333734590e900a7f`; report SHA-256 is `39bf52879a80287eae278501f081531bc56b0e248459bb1c825f74255b420283`. All four reported profiles produced their expected exits. The integration into #143 adds links/docs changes outside the file qualifier selectors; this is a source-attributed fixture result, not a new run of current `main`. Earlier macOS evidence is prior-source. |

The successful records above do not erase retained failures or extend a result to
an untested operating system or interaction type. No performance gain, process
RSS bound or physical-hardware result is claimed.

### Verified Windows desktop fixture reports

The public reports from [workflow 40909883589](https://github.com/0xPlayerOne/bunly/actions/runs/40909883589)
identify clean, unchanged source `85e18b8257e455fd85733229e6a8704d5642b022`
and native CEF tree `8bbede14123f53c5b36952ee43da4217d5cbb43d`. The workflow
failed its separate file-download stage. These individual reports passed their
own acceptance checks and independent offline replay:

- `window-commands`: seven ordered events, including one shortcut command, one
  menu command, three popup openings, cancellation and disposal of an open menu.
  Command registrations, shortcuts, popups and final SDK owners returned to zero.
  Input was synthetic native input; physical input, hardware DPI, assistive
  technology and performance qualification remain false.
- `application-links`: two accepted startup inputs, one rejected input and two
  acknowledgments, with native ownership released. OS registration, live OS
  delivery, external launch, physical input and performance qualification remain
  false.
- `file-dialogs` and `status-items`: explicitly unsupported, with zero panel
  admissions or status-item creations. These successful unsupported-path checks
  do not qualify the adapters.

Credential qualification was withheld, and the later optional
browser-action/programmatic-file feature gates did not run.

The [public artifact 12915341824](https://github.com/0xPlayerOne/bunly/actions/runs/40909883589/artifacts/12915341824)
ZIP has SHA-256 `e37274feed1135e659efe17677ac49071a15ac63ef5115673e0dbcbd6ff2e727`.

| Report                   | SHA-256                                                            |
| ------------------------ | ------------------------------------------------------------------ |
| `window-commands.json`   | `8c035439e696d5885dc29b69a203ea57dce417f3679075e6ca038956bb965930` |
| `application-links.json` | `b0a653281b6a3a874f918e3604035d120c05283d97ec427750988026d127347d` |
| `file-dialogs.json`      | `d4323def72ef14c804e885ae215a7be94cd56cb6d83048f939df88243917dae6` |
| `status-items.json`      | `cb1492e5f674f4185913f96fd7e044003e9967d63e97bf7d281222520734d60b` |

Each report passed `bun run qualify:desktop --verify REPORT`, including historical
source-inventory and source-blob verification. These were offline replays with no
native launch. The CEF sandbox identity remains unverified and embedded
native-build attestation is absent.

### Historical windowed composition resource baseline

The [retained 2026-10-29 composition cohort](../evidence/m7-composition/README.md)
adds an executed windowed-CEF CPU/RSS baseline: one designated warmup and three
recorded trials all passed at application source
`6349e7527220a44fc75356090210fa9eebd656e9`, declared native build
`9200034a2e7232a3f2f49ea1f61e8b7e8cdb85bf`, and native tree
`287b418ed4e7dba5df106276baa2f1da3e71c596`. Runtime identity was packaged Bun
1.4.4, CEF 156.0.7 and Chromium 156.0.8078.17. The original/export/archive
hashes, sanitized replay reports and separate per-trial summaries are retained.
These observations apply to the named historical source.

A separate partial Metal System Trace retains target-process GPU intervals
and allocated Metal device memory observations. It is excluded from the ordinary
CPU/RSS cohort and does not qualify GPU utilization, resident GPU memory or
full-workload GPU cost.

The equipment was Mac14,5 / Apple M2 Max / 64 GiB / macOS 26.7.1 build 25G241
on AC power, with a Screen Sharing Virtual Display (3840 × 2160 backing
pixels, 1920 × 1080 logical pixels at 60 Hz). No physical panel was observed.
Background machine activity was uncontrolled; no quiet-machine or thermal
gate was established. `performanceEligible` remains false.

Sampled CPU covers only adjacent same-PID-and-creation-time intervals within
each phase; process churn and phase boundaries leave unobserved CPU. Summed
RSS can double-count shared pages and is not GPU memory. API/readback timings
are not paint or physical-input latency. The static pages do not measure a
before/after gain from PR #170's interactive workbench overlay change.
GPU utilization, physical input, IME, assistive technology, hardware DPI and
a matched renderer comparison remain unqualified; #35 remains open.

## Issue acceptance status

| Issue                                                                                           | Software acceptance and remaining qualification                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [#34](https://github.com/0xPlayerOne/bunly/issues/34) — bounded TypeScript desktop API          | The bounded MVP above is implemented with native capability policy, validated arguments/paths and disposable generation-owned callbacks. This matrix records tested, unsupported and implemented-but-unqualified paths. #162 supplies scoped operator-workbench controls. Broader Electron compatibility and untested OS integration are not accepted claims.                                                                                                                                                        |
| [#35](https://github.com/0xPlayerOne/bunly/issues/35) — embedded views and composition          | Attachment, bounds, clipping, visibility, native overlays, reload identity and logical native-owner retirement are implemented and fixture-tested. PR #172 supplies the executable [composition resource profile](composition-measurement.md) and replay validator. Physical focus/pointer/Tab, IME, assistive technology, hardware DPI/multi-monitor behavior, overlay/dialog interaction and measured rendering tradeoffs remain open. Logical owner retirement is not a measurement of GPU memory or process RSS. |
| [#36](https://github.com/0xPlayerOne/bunly/issues/36) — downloads, uploads and file interaction | Bounded downloads and programmatic uploads/synthetic DOM drops are merged, with validated scope and explicit operation cleanup. The issue remains open for a fresh passing Windows native completion run. Application-supplied bytes do not qualify arbitrary path reads, OS-file drop, directory upload or an OS picker.                                                                                                                                                                                            |
| [#37](https://github.com/0xPlayerOne/bunly/issues/37) — browser actions and diagnostics         | #144 implements authorized engine-neutral actions; #161 completes the public diagnostic helpers and bounded renderer/RPC observers; #165 bounds best-effort native console output. No public raw CDP or listening debug endpoint is added. Software acceptance preserves disabled-profile and exact native authority checks; it does not claim Windows native action qualification, physical input, screen-reader behavior or hardware performance.                                                                  |
| [#38](https://github.com/0xPlayerOne/bunly/issues/38) — physical hardware qualification         | Owner-closed 2026-10-28 with acceptance boxes unchecked. The maintained protocol still lists operator cases as not run or unsupported. Workbench controls and preparation are not hardware evidence.                                                                                                                                                                                                                                                                                                                 |

The maintained [hardware workbench guide](hardware-workbench.md) and
[qualification protocol](m7-platform-qualification.md) define equipment,
case IDs and evidence requirements. Every actual operator result must identify
its exact application/native source and packaged Bun/CEF identities, OS and
hardware configuration, case and observations. Workbench preparation or launch
does not mark a case passed.

## Merged implementation and validation

The original outgoing PRs #142 (status items), #143 (programmatic files) and
#145 (application links) are merged. Follow-up PRs #161 (public diagnostics),
#162 (workbench controls), #163 (fixture cleanup) and #165 (native console
bounds) are also merged. [PR #170](https://github.com/0xPlayerOne/bunly/pull/170)
removes unused overlay observation polling; no measured speedup is claimed.
[PR #172](https://github.com/0xPlayerOne/bunly/pull/172) adds the fixed
`composition-profile` workload, CPU/RSS accounting, retained-report validation
and [measurement protocol](composition-measurement.md).
[PR #173](https://github.com/0xPlayerOne/bunly/pull/173) adds bounded exact-request
completion, Safe Browsing preference and utility-launch diagnostics for the
Windows download investigation. [PR #177](https://github.com/0xPlayerOne/bunly/pull/177)
returns the stable non-file replacement error on Windows before a file-only
open, while preserving the remaining handle/reparse/link and authority checks.
Its strengthened regression passed within 254 native library tests on actual
Windows. [PR #184](https://github.com/0xPlayerOne/bunly/pull/184) saves existing
immutable download inputs after successful native build/tests/assembly/preparation,
so a later qualification failure can retain those inputs. It changes no runtime
deadline or acceptance gate, and no elapsed-time saving is claimed.
Further reviewed maintenance is merged in [#180](https://github.com/0xPlayerOne/bunly/pull/180)
(indexed archive-path collision checks), [#181](https://github.com/0xPlayerOne/bunly/pull/181)
(reentrant RPC scheduling and cleanup), [#183](https://github.com/0xPlayerOne/bunly/pull/183)
(prepared-host cleanup error preservation), [#185](https://github.com/0xPlayerOne/bunly/pull/185)
(asynchronous application lifecycle listener failures), [#186](https://github.com/0xPlayerOne/bunly/pull/186) (terminal scheduler failures),
[#188](https://github.com/0xPlayerOne/bunly/pull/188) (application rollback error
preservation), and [#189](https://github.com/0xPlayerOne/bunly/pull/189)
(asynchronous runtime/window listener failures).
The terminal change adds `SCHEDULER_FAILED` to public failure unions and includes
an exhaustive-handler migration example; release 0.6.0 records that breaking
TypeScript change. Each merge followed current-head required checks and review;
no protection or deadline was relaxed. These changes do not establish a native
M7 pass or a measured performance gain. Local watcher failures retained in
[#179](https://github.com/0xPlayerOne/bunly/issues/179) remain source-attributed;
later passing runs are not a demonstrated fix for that issue.

The PR #165 diagnostics integration passed the complete portable gate with
1,490 Bun tests passed and two explicit skips, plus 308 Python tests passed
and one macOS-only skip. Formatting, lint, main/browser types, boundaries,
build and checker qualification passed. PR #165's fresh native checkout passed
260 CEF-host tests, strict packaging Clippy and the native build. Those gates
complement the source-attributed native fixtures above; they do not replace
platform or physical-device qualification.

PR #163 addresses a separate fixture-cleanup problem: bounded retries handle
transient filesystem errors, with six focused cleanup/reset tests passing on
actual Linux, macOS and Windows CI. A prior Windows retry failed during
portable fixture cleanup before native execution. The cleanup fix does not
establish that the retained native download-completion failure is resolved.

### Final released-main verification

[PR #192](https://github.com/0xPlayerOne/bunly/pull/192) merged the existing public
status document without importing the separately held result proposals.
[PR #197](https://github.com/0xPlayerOne/bunly/pull/197) separates the skipped draft
Electrobun check identity from the required ready-event `electrobun` context.
The earlier #196 release had successful actual checks and a newer same-name
skipped check; its historical blocking cause remains unproven. After #197,
[release PR #198](https://github.com/0xPlayerOne/bunly/pull/198) auto-merged and
[v0.6.3](https://github.com/0xPlayerOne/bunly/releases/tag/v0.6.3) published.
Its five protection-required checks and 21 additional reviewed platform contexts
all passed; some additional contexts completed after the automatic merge.
No protection settings or checks were bypassed for #192 or #197.

The final local `bun run check:portable` on clean released source
`21abd9128e60388d431a329073d75d013426778a`, source tree
`20a8a31296328662cc0b7dbc1f12307dd663021f`, recorded **1,602 passed,
three skipped and one failed** across 218 Bun test files. The normal native-metafile
external-dependency watcher case in `tests/dev-host.test.ts` still observed
adapter value 20 instead of 21 after its existing 15-second deadline. The
malformed-cross-drive neighbor passed. No retry was performed and this gate
is not counted as successful.

Formatting, main types, lint and boundaries completed before that failure.
The short-circuited tail was then executed separately: build, browser types,
Python formatting/lint, all 310 Python tests and all 23 compiler-qualification
cases passed. The retained complete-gate log has SHA-256
`78304628d93ff1f70fefdd8063fcd1ad81470bb8c65da28c455c299eb7db53c2`;
the separate tail log has SHA-256
`c8a95bdc20874292b41d738f67278107e34cd4b35bae35d2ca8e234a900e410c`.
Source remained clean. These are portable development checks, not native or
physical qualification.

The retained failure lacks watcher-callback, build/reload-stage and final
session-counter observations. Source review confirms that the external
dependency-directory watcher is created before startup returns, but it does
not establish operating-system watcher readiness or a cause. #179 remains open;
a naturally failing bounded trace of the write, callback, build/reload diagnostics
and final session counters is needed to distinguish a missed event from later
build or replacement failure. The existing deadline remains unchanged.

## Remaining qualification work

### Windows file-workflow completion

The historical standard-user failure at `42675aa` in
[workflow 40764782582](https://github.com/0xPlayerOne/bunly/actions/runs/40764782582)
received 32,768 bytes but missed the unchanged six-second completion deadline.
Later attempts preserve that failure and add the following exact observations:

| Public run                                                                   | Exact source                               | Result and qualification limit                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ---------------------------------------------------------------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [40898407161](https://github.com/0xPlayerOne/bunly/actions/runs/40898407161) | `9200034a2e7232a3f2f49ea1f61e8b7e8cdb85bf` | The first managed download received 32,768 bytes but remained incomplete at the maintained six-second deadline. Failed qualification retained.                                                                                                                                                                                                                                                                                                                                                                               |
| [40909883589](https://github.com/0xPlayerOne/bunly/actions/runs/40909883589) | `85e18b8257e455fd85733229e6a8704d5642b022` | Exact resource completion succeeded with 32,768 encoded bytes. Safe Browsing was enabled at admission; one application-wide FileUtilService launch and no quarantine launch were observed. The owned item remained in progress at six seconds. These observations establish neither completed inspection nor native download completion.                                                                                                                                                                                     |
| [40914760344](https://github.com/0xPlayerOne/bunly/actions/runs/40914760344) | `1b07548d1f6d700b304a3c9ecef087ca76b60b21` | The diagnostic-only first request completed with a temporary twelve-second allowance; the subsequent 4,194,304-byte replacement completed with its unchanged six-second deadline. Both committed the expected bytes and hashes. The fixture then failed its non-file destination rejection assertion. Per-request elapsed time was not recorded. [PR #174](https://github.com/0xPlayerOne/bunly/pull/174) is closed without merge and excluded from M7 acceptance.                                                           |
| [40923447518](https://github.com/0xPlayerOne/bunly/actions/runs/40923447518) | `84ee013a8a524230fcbfaef6c27d735633f8c47b` | After the #177 correction, all 14 raw scenarios passed with clean host/SDK/temporary cleanup. The first request took 7,203.9946 ms with a diagnostic-only twelve-second allowance; the subsequent replacement took 258.9538 ms with six seconds unchanged. The added timing key deliberately failed the exact-key acceptance parser. [PR #178](https://github.com/0xPlayerOne/bunly/pull/178) is closed without merge and excluded from M7 acceptance.                                                                       |
| [40942788214](https://github.com/0xPlayerOne/bunly/actions/runs/40942788214) | `a2f3368e4a52002a7de3d2f564e5a3f771d381e1` | The maintained merged-main run again missed first-download completion at six seconds despite successful exact-resource completion and 32,768 received bytes. Its other 18 native stages and 254 native library tests passed; the remaining 13 download scenarios did not run. Download/SDK/temporary cleanup settled, while overall host clean shutdown was false.                                                                                                                                                           |
| [40951126011](https://github.com/0xPlayerOne/bunly/actions/runs/40951126011) | `085d646e058023c927faa146afefab6af0394942` | All 14 raw scenarios and nine checks passed with the first request taking 6,944.6602 ms under a diagnostic-only twelve-second allowance; the instrumented replacement took 302.4213 ms with its six-second deadline unchanged. Fixed post-completion histograms and background-task markers were recorded. The extra diagnostic keys deliberately failed the unchanged strict acceptance schema. [PR #190](https://github.com/0xPlayerOne/bunly/pull/190) remains an unmerged diagnostic and is excluded from M7 acceptance. |
| [40959005905](https://github.com/0xPlayerOne/bunly/actions/runs/40959005905) | `ae243a352e0e8fa97a1d0013cb5e93013a38eaaf` | The six-counter follow-up again passed all 14 raw scenarios and nine checks. The first request took 6,921.2899 ms under the diagnostic-only twelve-second allowance; the instrumented replacement took 241.8102 ms under six seconds. An application-wide HTTP 400 result and 53 ms loader-duration sample narrow the observed protection path. The unchanged strict schema again excluded the report. #190 is closed without merge.                                                                                         |
| [40970973932](https://github.com/0xPlayerOne/bunly/actions/runs/40970973932) | `21abd9128e60388d431a329073d75d013426778a` | The final maintained v0.6.3 run again failed the first six-second completion gate after receiving 32,768 bytes; the remaining 13 download cases did not run. The other 18 ordinary stages, terminal ownership and all 254 native library tests passed. Native/SDK ownership and temporary cleanup settled, while overall host clean shutdown remained false. Later credentials did not execute and optional view controls were skipped.                                                                                      |

All runs listed in this table remain failed qualifications.
Their retained download receipts and artifact hashes are recorded in
[PR #173](https://github.com/0xPlayerOne/bunly/pull/173),
[PR #174](https://github.com/0xPlayerOne/bunly/pull/174),
[PR #178](https://github.com/0xPlayerOne/bunly/pull/178),
[PR #190](https://github.com/0xPlayerOne/bunly/pull/190) and
[issue #36](https://github.com/0xPlayerOne/bunly/issues/36).
A temporary diagnostic allowance does not change the maintained completion gate.
The #177 corrected native tree is `5bb1444988c7ec2f92d4e4af953a78f94336909b`
in the #178 timing probe and the subsequent maintained run. The timing probe's
measurements include admission invocation through completion/hash/staging
verification; they do not identify the cause of
the first/subsequent difference.

In maintained run 40942788214, the item remained valid and in progress at
100% received bytes, with six callbacks and an owned staging path. The receipt
records Safe Browsing enabled, one application-wide FileUtilService launch and
zero observed quarantine launches. These observations do not establish completed
inspection. Its 6,335.9246 ms fixture workload ended with one terminal callback
for one admission and zero retained download owners. The observer exited one
with no timeout, overflow, observed orphans or cleanup survivors.
Source-before/source-after were clean and unchanged. Prepared/input artifact-after
inventories and metadata-after checks were not reached in this failed report or
the #178 schema-exclusion report; no unchanged-binary-after claim is made for them.
Optional browser-action/programmatic-file checks were skipped, credentials were
withheld, and native embedded build attestation, sandbox and hardware qualification
remain unverified.

The [merged-main artifact 12928403389](https://github.com/0xPlayerOne/bunly/actions/runs/40942788214/artifacts/12928403389)
ZIP has SHA-256 `40a38ffa8341e55c9d2fff8cd685307e6b1685269a1a5cf534eafdded06464ef`;
its exported download report has SHA-256
`42d1f8bf208010e0304c7b2d40179addacf60f3aaf4d8d9a16a20f73ea602111`.
All 68 extracted files, the completed job log and prior failed attempts are retained.

### Bounded analysis diagnostic, excluded from acceptance

The #190 run used clean source `085d646e058023c927faa146afefab6af0394942`,
source tree `4b450fbd1f0acce5ff2194900c63c06a3815ee2c`, and diagnostic native tree
`ce13469e22370fe4f77df922132798c110d82cbe`. The first request was timed from
admission through verified completion, bytes/hash and staging checks. Only after
that measurement did a contributor-only observer request these three fixed,
application-wide histogram snapshots:

| Histogram                                   | Recorded sample                          | Pinned-source meaning and limit                                                                                                                                                                                             |
| ------------------------------------------- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SBClientDownload.CheckDownloadStats`       | One sample, sum 5, bucket `[5, 6)`       | `REASON_SERVER_PING_FAILED`. This reason can result from a missing URL-loader factory or a failed/non-200 protection-service response; it does not establish a particular network error or that a network request occurred. |
| `SBClientDownload.ZipArchiveAnalysisResult` | One sample, sum 0, bucket `[0, 1)`       | `kUnknown`: parsing failed without a more specific reason. This is not a valid-archive or clean-inspection result.                                                                                                          |
| `SBClientDownload.FileAnalysisDuration.Zip` | One sample, sum 480, bucket `[452, 574)` | The recorded ZIP-analysis duration is 480 ms. It is application-wide, not a request-scoped causal trace.                                                                                                                    |

Interpretation uses the pinned Chromium 156.0.8078.17
[download reason enum](https://github.com/chromium/chromium/blob/156.0.8078.17/chrome/browser/safe_browsing/download_protection/download_protection_util.h),
[request completion code](https://github.com/chromium/chromium/blob/156.0.8078.17/chrome/browser/safe_browsing/download_protection/check_client_download_request_base.cc),
and [archive result enum](https://github.com/chromium/chromium/blob/156.0.8078.17/chrome/common/safe_browsing/archive_analyzer_results.h).
A fixed `FILE_BACKGROUND` marker completed 2,998 ms after its admission; the
`FILE_USER_VISIBLE` control completed in 0 ms. Posting marker tasks can perturb
scheduling, and their measurement boundaries differ from the histograms and
first-download timer. These values must not be added or subtracted to invent a
causal timeline. They do not establish a Bunly defect, cache state, network
cause, or performance improvement.

The histogram query completed and its observer registration was released.
The CEF DevTools agent remains attached until controller destruction, so the
subsequent replacement timing is instrumented; the first timing preceded this
attachment. No arbitrary histogram name, CDP command, URL, header, or security
setting was exposed or changed. The maintained six-second acceptance gate and
strict report schema remain unchanged.

The run recorded 14 admissions and terminal outcomes: three completions,
seven cancellations and four expected failures. Native download owners and final
SDK owners returned to zero, temporary cleanup passed, host shutdown was clean,
and the observer exited zero with no timeout, overflow, observed orphan or
cleanup survivor. Windows native library tests passed 254 cases. The complete
workflow still failed because the report contained the deliberately excluded
`diagnosticAnalysis` and `diagnosticTiming` keys. Prepared/input artifact-after
inventories and metadata-after checks were not reached. Source-before and
source-after were clean and unchanged; no unchanged-binary-after claim is made.

The [artifact 12933495750](https://github.com/0xPlayerOne/bunly/actions/runs/40951126011/artifacts/12933495750)
ZIP has SHA-256 `ef785ff2e9a91f62841f839677ad9d66b5b556ac94295e8e5483b9371b58ae91`;
the exported download report has SHA-256
`89915488dacd6f3cbd5f78b2ece800c5e109d43478c9be0d385cc8134ba933d0`.
All 68 artifact files are retained. The initial completed-log download failure
and empty output were preserved separately; the recovered completed log has
SHA-256 `9a15447e4471ead3fa27367b3151c5d8227154fa23cc52b6fa90f411169f92d2`.
The workflow saved only its existing verified immutable build inputs before
qualification, as intended by #184; this is not a measured cache speedup.

### Fixed network-result follow-up, excluded from acceptance

The second #190 run used clean source `ae243a352e0e8fa97a1d0013cb5e93013a38eaaf`,
source tree `56f90f56cfbb08ef13601b3373f3b9ec6351e3bf`, and diagnostic native
subtree `5f77431f93ccb5e42ba84329c55442868681abe3`. It adds exactly three fixed
post-first-completion histogram names to the same bounded query. It changes no
payload, filename, authority, security setting, marker, maintained deadline or
acceptance schema. The signed sparse-result parser is separate from the existing
unsigned parsers and checks bounded counts, samples, ordered unit-width buckets
and exact weighted sums. Its 11 focused native tests, strict feature-enabled
Clippy, main/browser types, boundaries, ten download fixture/parser tests and
signed exporter/exclusion replay passed locally. An initial command selected
zero tests; that log is retained and is not counted as validation.

| Application-wide histogram                        | Count / sum | Recorded bucket |
| ------------------------------------------------- | ----------- | --------------- |
| `SBClientDownload.CheckDownloadStats`             | 1 / 5       | `[5, 6)`        |
| `SBClientDownload.ZipArchiveAnalysisResult`       | 1 / 0       | `[0, 1)`        |
| `SBClientDownload.FileAnalysisDuration.Zip`       | 1 / 395 ms  | `[356, 452)`    |
| `SBClientDownload.DownloadRequestNetworkResult`   | 1 / 400     | `[400, 401)`    |
| `SBClientDownload.DownloadRequestDuration`        | 1 / 449 ms  | `[449, 533)`    |
| `SBClientDownload.DownloadRequestNetworkDuration` | 1 / 53 ms   | `[48, 57)`      |

The pinned [sample writer](https://github.com/chromium/chromium/blob/156.0.8078.17/components/safe_browsing/core/common/utils.cc)
records an HTTP status for a successful loader or `ERR_HTTP_RESPONSE_CODE_FAILURE`,
and otherwise a negative net error. Sample 400 is therefore an HTTP 400 status,
not a negative network error. These counters are emitted by the
[URL-loader completion path](https://github.com/chromium/chromium/blob/156.0.8078.17/chrome/browser/safe_browsing/download_protection/check_client_download_request_base.cc),
not the earlier null-factory return. The snapshot supports reaching that recorded
path; it remains application-wide and does not prove exact-request ownership,
identify the responding endpoint, or establish network egress. The request timer
begins at protection-request object construction, while the network timer begins
immediately after loader submission and includes local processing and callback
scheduling. Neither measures the entire first download or wire time alone.

The background marker completed in 3,008 ms; the user-visible control completed
in 0 ms. The first request took 6,921.2899 ms through completion/hash/staging
verification, before observer attachment. The subsequent replacement took
241.8102 ms after attachment. The same marker and retained-DevTools-client
limitations apply. Differing interval origins and cumulative histogram scope
prevent reconstructing the missing time by subtraction. The observation does
not establish a Bunly ownership, startup or network-policy defect.

All 14 raw cases and nine checks passed; all other 18 qualification stages passed.
There were three completed transfers, seven cancellations and four expected
failures. All download and final SDK owners returned to zero. Temporary cleanup,
SDK shutdown and overall host clean shutdown passed. The observer exited zero
without timeout, cancellation, overflow, observed orphans or cleanup survivors.
Windows native library tests passed 254 cases; portable checks passed 1,489 Bun
tests with 12 skips and 269 Python tests with 41 skips. The workflow still failed
only the unchanged diagnostic-key exclusion. Source-before/source-after and
source hashes matched; prepared/input artifact-after inventories and metadata-after
checks remain unobserved. Native embedded attestation, sandbox and physical
hardware qualification remain unverified.

The [artifact 12936915325](https://github.com/0xPlayerOne/bunly/actions/runs/40959005905/artifacts/12936915325)
ZIP has SHA-256 `aaa8bb688cbf6e4f9d24993dc4bc76a971fd3c42919a465d88e83b096cfb771e`;
the exported download report has SHA-256
`04a165727551fd0cb87c8aebbb9a7d51fa2068eb5d18db71a28efacd0694aeea`;
the completed job log has SHA-256
`e0f7f6946f74e59c583dcabe112bdcd05ba62c4263de7482cad25b675aa95570`.
All 68 artifact files and the completed log are retained, and the prior #190
run's ZIP/report hashes remain unchanged. PR #190 is closed without merge;
both diagnostic sources and their failed acceptance receipts remain retained.

### Final released-main Windows verification

The final maintained [Windows/full run 40970973932](https://github.com/0xPlayerOne/bunly/actions/runs/40970973932)
used clean released source `21abd9128e60388d431a329073d75d013426778a`,
source tree `20a8a31296328662cc0b7dbc1f12307dd663021f`, and native tree
`5bb1444988c7ec2f92d4e4af953a78f94336909b`. This source has the maintained
six-second completion deadline and no #190 probe or diagnostic allowance.
The workflow failed; **18 of the 19 ordinary native stages passed and
`file-downloads` alone failed**. Terminal ownership and all 254 native library
tests passed, including the Windows non-file destination regression. Windows
portable checks passed 1,594 Bun tests with 12 skips, and 269 Python tests with
41 skips.

The first download again timed out at the unchanged six-second deadline.
The exact-resource completion receipt reported success and 32,768 received bytes,
but the native item remained valid, in progress and incomplete at 100%, with an
owned staging path, six callbacks observed, and callback ownership retained
at timeout. Safe Browsing was enabled at admission; one application-wide FileUtilService launch and no quarantine launch
were observed. These observations do not establish completed inspection or
native download completion. The failed outcome reported zero committed
`bytesWritten`; the remaining 13 download scenarios did not execute.

The fixture workload lasted 6,382.4121 ms; this is not a successful-completion
duration. Native shutdown recorded one admission, one failed outcome and one
terminal callback. Owned transfers, callbacks, staging handles and deadline
workers returned to zero. Final SDK windows/views/sessions/listeners and listener
errors were zero, temporary cleanup and SDK shutdown passed, and the observer
exited one with no timeout, cancellation, overflow, observed orphan or cleanup
survivor. Overall host `clean` remained false. Source-before/source-after and
source hashes matched. Download prepared/input artifact-after inventories and
metadata-after checks were absent, so unchanged-binary-after is not claimed for
this failed report.

The subsequent credential test did not execute: its prerequisite requires every
preceding ordinary native stage to pass. The separate optional view-control CI
step was skipped. The observed runtime was Bun 1.4.4, CEF 156.0.7 and Chromium
156.0.8078.17; embedded native-build attestation, sandbox identity and physical
hardware qualification remain unverified.

[Artifact 12940649781](https://github.com/0xPlayerOne/bunly/actions/runs/40970973932/artifacts/12940649781)
contains 68 retained files and has ZIP SHA-256
`02d6c5d63ffed8554f17398c5d25bd9632f0867299aa59879b1b07a1266c2bdf`.
The exported download report has SHA-256
`c55564475d5970d436dba7b7a15ea88f40aee3f382ccfc68f42584abd6a3fd48`;
its two retained copies are identical. The completed job log has SHA-256
`690d43b7dc951700f88b30c21de08a61fd5c937c5f6861225fee931e205e27f3`.
This attempt was not retried. The result preserves the prior failed evidence
and keeps #36 open; no cause or correction for the first-completion delay has
been established.

### Maintained Windows acceptance run

After an evidence-backed correction, rerun the maintained [native CEF workflow](https://github.com/0xPlayerOne/bunly/actions/workflows/cef-runtime.yml)
on the final reviewed `main` revision with `platform=windows` and `suite=full`:

```sh
gh workflow run cef-runtime.yml --ref main -f platform=windows -f suite=full
```

Follow [manual native qualification](manual-native-qualification.md). Retain
the exact source/artifact identities and failed attempts. Require the native
completion callback and the unchanged six-second deadline; arrival of all
32,768 bytes alone does not pass the completion gate. The standard-user native
run, its cleanup, and the optional feature-profile gates must actually execute.
A portable-only pass or a Linux result cannot close this Windows gap.

### Physical focus, input, accessibility and rendering tradeoffs

Use the [hardware workbench](hardware-workbench.md) and
[platform protocol](m7-platform-qualification.md) on the claimed equipment.
Record the exact source/native build, packaged Bun/CEF identity, OS, GPU/driver,
display topology/scales, keyboard layout, IME and assistive technology. Exercise
physical focus and pointer/Tab routing, overlay/menu/dialog interactions,
reload, high-DPI/multi-monitor changes and the applicable lifecycle cases.
Keep unrun and unsupported cases explicit. Measure the GPU/CPU, input, IME
and accessibility tradeoffs required by #35 before accepting its remaining
composition criterion. Use the [composition measurement protocol](composition-measurement.md)
for the fixed windowed workload and retained-report validation, alongside the
physical cases. Current windowed CEF fixtures provide no measured comparison
with off-screen/composited rendering.

Track these remaining gates in #35 and #36. Preserve #38's owner-closed,
unchecked state without converting it into a passed equipment record.
