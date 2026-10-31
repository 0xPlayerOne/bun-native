# Initial composition observations: stock v2 runtimes

This directory retains one actual Linux failure and one actual Mac pass of
`native-composition-interactions-v2`. The stronger fixture observes the existing
initial-hidden Linux CEF defect from the application's first script. The Mac
execution satisfies the complete v2 interaction contract on its recorded virtual
display. Neither result supplies a runtime fix or completed Linux interaction
qualification. Issue #35 and M7 remain open.

| Attempt | Application source | Declared native build source | Result |
| --- | --- | --- | --- |
| Stock Linux | `af32858a0edcfbeed74c4e7f73e21a2f8cce745d` | `af32858a0edcfbeed74c4e7f73e21a2f8cce745d` | Initial document-visibility mismatch |
| Stock Mac | `af32858a0edcfbeed74c4e7f73e21a2f8cce745d` | `be22c89a1c680c3262316e516f22a4816cbf4e9c` | Complete interaction acceptance |

Both native declarations resolve to tree
`9ed1b04c6d65b5351c064c4b3ea03ae0e7d4cc88`. The Linux record occupies the
manifest's original fields; `additionalRuns` links the accepted Mac archive and
its exact transferred metadata.

## Linux source and runtime

Application and declared native build source are
[`af32858a0edcfbeed74c4e7f73e21a2f8cce745d`](https://github.com/0xPlayerOne/bunly/commit/af32858a0edcfbeed74c4e7f73e21a2f8cce745d),
tree `5a3263cbc36748d7566727f7f21a909b1e3ad56f`, with unchanged
`native/cef-host` tree `9ed1b04c6d65b5351c064c4b3ea03ae0e7d4cc88`.
All 367 selected source files match that commit, before and after execution.
The exact commit was published after the local run; the report's original source
identities were preserved. This baseline qualifies no later integrated native
tree or release.

The earlier stock bundle had been deleted during disk cleanup. The remaining
withdrawn candidate was left intact. A fresh stock host was built with the
normal locked Cargo command, Rust 1.91.0, the default sandbox feature, and
`packaging,rpc-qualification`. The manifest records the command and build source.
An application-resource inventory check stopped before native launch because
the fresh assembler output lacked `resources/bun`. Copying the exact generated
application resources, as the maintained hosted preparation does, completed
assembly. There was exactly one native execution and no retry to obtain a pass.

The executed runtime reports Bun 1.4.4, CEF 156.0.7 and Chromium 156.0.8078.17.
Input and prepared host SHA-256 both equal
`60a2995de98afc61520954bf64593713819e12f79b0f07cf6ee5aa2d52d5898a`.
The CEF library SHA-256 is
`d6ae34b71b65685b9fc84f24b53214cdb71a17ceecca0034c3a95a9d4358d86f`.
The complete inventories remain in the report. Source attribution is a local
build record and checked declaration; the executable has no embedded build
attestation.

## Actual Linux failure

The schema-2 application receipt failed at `initial-observation-after-create`:

| Observation | Retained result |
| --- | --- |
| Native overlay | Hidden, undrawn, nonfocusable and unfocused |
| Overlay first-script sample | `visibility: visible`, `focused: false` |
| Overlay after-create sample | `visibility: visible`, `focused: false` |
| Overlay history overflow | `false` |
| Right pane through creation | Focused at both checkpoints, with no intervening blur recorded |
| First explicit overlay show | Not reached |
| Native menu and dialog cases | Not reached |

All three partial histories, native view/document IDs, page instances, original
application receipt, and failure text remain unchanged in the export. The
overlay's native widget was hidden; the failure is the document visibility
state observed by its actual application script. No renderer state was
injected and no hidden-content show/hide preparation was performed.

The application workload lasted 212.873322 ms, the native process observation
677.429884 ms, and the enclosing qualifier 11.218901 seconds. These are retained
execution durations, not performance or input-latency measurements. The existing
30-second workload and 45-second observer limits were unchanged.

V2 histories retain at most 32 records per pane and reject overflow. The complete
serialized receipt must also fit the shared 16 KiB diagnostic-line budget; all
maximum-length histories are not guaranteed to fit. The recorded `af32858`
source initially asserted 32 KiB locally, which exceeded that unchanged
transport limit. The current producer and parser both enforce 16 KiB. This
actual diagnostic was 4,397 UTF-8 bytes and its retained bytes are unchanged.
A successful history would end at each authenticated `before-show` snapshot;
it does not observe the later IPC interval before the native show call. This
attempt stopped earlier, at `after-create`.
The six historical v1 reports and their 16 KiB receipt contract remain in
[`m7-composition-interactions`](../m7-composition-interactions/README.md) with
their original outcomes.

## Linux environment and cleanup

The actual host ran as the existing standard account `nobody`, UID/GID 65534,
inside a Linux x86_64 container using an owned D-Bus session, Xvfb and Openbox.
The user/PID/network namespace preflight succeeded. The native build retained
the default sandbox feature and `no_sandbox: 0`; no sandbox-disabling flags or
GitHub-runner environment claims were used. The exported CEF identity probe
still labels sandbox status `unverified`: its version probe is not a separate
kernel-sandbox attestation.

SDK window/view/session/listener/error counts reached zero and the application
shutdown request fulfilled. The native process exited with code 1 and the host
reported `clean: false`. No observer timeout, output overflow, orphan or surviving
process was recorded. The complete positive `nativeFinal` receipt was not
reached and remains null. These cleanup facts preserve the failed outcome.

The unchanged display runner reports `cleanup: true`; its recorded Xvfb/Openbox
PIDs were independently confirmed absent afterward. The qualifier stopped at
the failed acceptance check, so its post-run artifact checks remain absent.
A separate read-only review verified all 258 input entries, all 248 prepared
entries, and prepared metadata against the recorded pre-run values. That review
is recorded separately in the manifest and does not backfill the failed report.

## Accepted Mac execution

The Mac's unchanged stock native tree ran the same exact `af32858` application
source. Its earliest overlay sample, `after-create`, and `before-show` sample
all report hidden and unfocused, with no intervening focus/blur event. The left,
right and overlay histories contain 7, 8 and 3 records respectively; no history
overflowed. The right pane preserved focus during hidden-overlay creation.

The complete sequence then passed ten focus observations, three native menu
opening/cancellation pairs, a visible file panel and completed cancellation,
rejection of a competing popup, later overlay show/hide, and preserved
view/document/session identities. Its original acceptance object retains
`initialVisibilityObserved: true` and `creationFocusPreserved: true` alongside
all five hardware/performance flags set to false.

Native view/session/delivery and SDK counters reached zero, the application
shutdown request fulfilled, and the host reported `clean: true`. No timeout,
output overflow, orphan or surviving process was recorded. The maintained
macOS clone-lifecycle observation verified the one new code-signing helper and
exact clone removal. The complete artifact inventories and metadata checks
passed. The input/prepared host hashes differ because the qualifier re-signs
the prepared Mac app; both original hashes and the verified metadata exception
remain in the report and [transfer metadata](macos-stock-passed.metadata.json).

The schema-2 diagnostic is 10,433 UTF-8 bytes, within the unchanged 16 KiB
transport budget and the corrected producer/parser limit. The archived report
is byte-identical to the supplied sanitized export. It passed maintained replay
with the corrected parser, including all 367 historical source hashes and its
declared native tree. The recorded source still has its original 32 KiB local
assertion; no source identity or receipt was rewritten to claim it executed
the later correction.

Application duration was 2,570.732875 ms; native observer duration was
3,426.204917 ms. The equipment record identifies an Apple M2 Max and a Screen
Sharing Virtual Display at 1920 × 1080, 60 Hz, with accessibility trust false.
These facts establish no physical keyboard/pointer, IME, screen-reader, hardware
DPI/display-topology or performance acceptance. This Mac pass does not resolve
the retained Linux failure.

## Retention and replay

The [manifest](manifest.json) records original, compressed and expanded report
hashes; the exact source/runtime bindings; the preserved partial histories;
limits; and cleanup. The [display-runner receipt](linux-display-runner.json)
retains its original failed outcome and successful cleanup.

Both reports use the maintained `scripts/export_native_evidence.py` and preserve
its nonce/correlation export schema. The Linux export additionally replaces
local checkout, fixture and workspace path prefixes. Its complete schema-2
receipt and outcome/source/runtime/cleanup fields were compared with the raw
input. The Mac's raw-to-export checks occurred on the source Mac; its metadata
records the original digest and zero occurrences for the listed private-prefix
replacements. The exact transferred gzip/expanded bytes were verified locally.
No raw private report, runtime binary or profile is committed. Both gzip archives
use a zero timestamp.

Verify compressed and expanded bytes against the manifest, expand the selected
archive to a temporary JSON file, and run:

```sh
bun run qualify:desktop --verify /absolute/path/to/expanded-report.json
```

The Mac archive must exit zero and return its original acceptance object.
**The Linux archive must exit nonzero:** it records `passed: false`. Linux failure
rejection occurs before positive acceptance/source replay gates; the separate
source review checked all 367 recorded blobs and the native tree. Replay performs
no native execution and does not fetch missing Git objects.

Physical keyboard/pointer input, IME, assistive technology, hardware display/DPI
behavior, and performance remain unqualified. This cohort records the Linux
defect and the stronger observation path on both platforms; it does not complete
the milestone.
