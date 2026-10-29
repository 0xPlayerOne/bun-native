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
Each merge used the normal squash path after current-head required checks
passed; no protection or deadline was relaxed.

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

## Remaining qualification work

### Windows file-workflow completion

The historical standard-user failure at `42675aa` in
[workflow 40764782582](https://github.com/0xPlayerOne/bunly/actions/runs/40764782582)
received 32,768 bytes but missed the unchanged six-second completion deadline.
Later attempts preserve that failure and add the following exact observations:

| Public run                                                                   | Exact source                               | Result and qualification limit                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ---------------------------------------------------------------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [40898407161](https://github.com/0xPlayerOne/bunly/actions/runs/40898407161) | `9200034a2e7232a3f2f49ea1f61e8b7e8cdb85bf` | The first managed download received 32,768 bytes but remained incomplete at the maintained six-second deadline. Failed qualification retained.                                                                                                                                                                                                                                                                                                                     |
| [40909883589](https://github.com/0xPlayerOne/bunly/actions/runs/40909883589) | `85e18b8257e455fd85733229e6a8704d5642b022` | Exact resource completion succeeded with 32,768 encoded bytes. Safe Browsing was enabled at admission; one application-wide FileUtilService launch and no quarantine launch were observed. The owned item remained in progress at six seconds. These observations establish neither completed inspection nor native download completion.                                                                                                                           |
| [40914760344](https://github.com/0xPlayerOne/bunly/actions/runs/40914760344) | `1b07548d1f6d700b304a3c9ecef087ca76b60b21` | The diagnostic-only first request completed with a temporary twelve-second allowance; the subsequent 4,194,304-byte replacement completed with its unchanged six-second deadline. Both committed the expected bytes and hashes. The fixture then failed its non-file destination rejection assertion. Per-request elapsed time was not recorded. [PR #174](https://github.com/0xPlayerOne/bunly/pull/174) is closed without merge and excluded from M7 acceptance. |
| [40923447518](https://github.com/0xPlayerOne/bunly/actions/runs/40923447518) | `84ee013a8a524230fcbfaef6c27d735633f8c47b` | After the #177 correction, all 14 raw scenarios passed with clean host/SDK/temporary cleanup. The first request took 7,203.9946 ms with a diagnostic-only twelve-second allowance; the subsequent replacement took 258.9538 ms with six seconds unchanged. The added timing key deliberately failed the exact-key acceptance parser. [PR #178](https://github.com/0xPlayerOne/bunly/pull/178) is closed without merge and excluded from M7 acceptance.             |
| [40942788214](https://github.com/0xPlayerOne/bunly/actions/runs/40942788214) | `a2f3368e4a52002a7de3d2f564e5a3f771d381e1` | The maintained merged-main run again missed first-download completion at six seconds despite successful exact-resource completion and 32,768 received bytes. Its other 18 native stages and 254 native library tests passed; the remaining 13 download scenarios did not run. Download/SDK/temporary cleanup settled, while overall host clean shutdown was false.                                                                                                 |

The three maintained runs and both diagnostic probes remain failed qualifications.
Their retained download receipts and artifact hashes are recorded in
[PR #173](https://github.com/0xPlayerOne/bunly/pull/173),
[PR #174](https://github.com/0xPlayerOne/bunly/pull/174),
[PR #178](https://github.com/0xPlayerOne/bunly/pull/178) and
[issue #36](https://github.com/0xPlayerOne/bunly/issues/36).
A temporary diagnostic allowance does not change the maintained completion gate.
The #177 corrected native tree is `5bb1444988c7ec2f92d4e4af953a78f94336909b`
in both newer runs. The timing probe's measurements include admission invocation
through completion/hash/staging verification; they do not identify the cause of
the first/subsequent difference.

In the maintained merged-main run, the item remained valid and in progress at
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

Run the maintained [native CEF workflow](https://github.com/0xPlayerOne/bunly/actions/workflows/cef-runtime.yml)
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
