# Interactive native hardware workbench

`examples/hardware-workbench` is the maintained interactive target for
[issue #38](https://github.com/0xPlayerOne/bunly/issues/38). It uses the merged
[window controls](desktop-window-api.md) and [view composition](view-composition.md)
APIs. It stays open until the operator closes its final window or explicitly
quits. The application has no timed completion, automatic case acceptance, or
hardware qualification claim.

The [twelve-case hardware protocol](m7-platform-qualification.md)
defines the required equipment and failure criteria. This workbench supplies an
interactive target for its supported steps. The fixed native acceptance fixtures
and the web-only comparison workbench keep their existing purposes.

## Prepare an explicit prebuilt

Use Bun **1.4.4**, a clean committed checkout, and a native app already built for
the same `native/cef-host` source tree. `COMMIT` must be the full 40-character
commit used to build the selected native app. The object must already exist in
the local Git database. Preparation never fetches source, acquires a native
runtime, or invokes Cargo, Rust, Clang or a native bundler.

```sh
bun install --frozen-lockfile
bun run workbench:native prepare /absolute/path/to/Bunly.app --native-source=COMMIT
```

On Linux, select `/absolute/path/to/package/bunly_host`. On Windows, select the
absolute path to `bunly_host.exe` in its prepared package. The supported target
identities are `darwin-arm64`, `linux-x64`, and `win32-x64`. Launch as a standard
desktop user, with the normal sandbox and background throttling enabled. Linux
uses the existing X11/Xwayland target; this does not qualify native Wayland.

Preparation verifies the local native source tree, inventories the supplied app,
and copies it into a unique private directory under
`.bunly/m7/hardware-workbench`. It bundles only the Bun application and browser
assets, adds their asset manifest, and checks that the original app and source
remain unchanged. It rejects escaping links, aliases under mutable application
resources, development origins, credential-provider configuration, and widened
native deadline profiles. Runtime acquisition and native compilation have no
fallback path.

On macOS, preparation applies and verifies local ad-hoc signatures on the copy
with the repository's existing inside-out signing policy. It uses no identity,
timestamp service, trust-store change or production signing. This changes the
copy's signature bytes, which are included in its prepared inventory. It does
not execute the packaged Bun, native host or CEF library and does not open a GUI.

The command prints the absolute path to `preparation.json`. That record contains
the application source commit and hashes, declared native build commit and source
tree, original and prepared inventories, prepared file metadata, selected
profile, and developer Bun version. Packaged Bun and CEF versions are explicitly
**declared, not observed** at this stage. Native source matching is based on the
operator's supplied commit; it is not embedded binary build attestation.

## Verify, then deliberately launch

Verification does not launch anything:

```sh
bun run workbench:native run /absolute/path/to/prepared-directory/preparation.json
```

Add the separate explicit launch flag to open the native application:

```sh
bun run workbench:native run /absolute/path/to/prepared-directory/preparation.json --launch
```

Run uses the same unchanged source checkout and rechecks native source, prepared
bytes, links and file metadata before execution. It passes no arbitrary native
arguments, clears inherited `BUNLY_*` contributor controls, and assigns a fresh
private cache. It does not disable sandboxing, alter native owners or extend
startup, request, shutdown or backend-exit deadlines.

The session has no outer workload timeout. Close the window through the desktop
or use **Close the final window… → Close workbench**. An explicit terminal
interrupt terminates the selected process and records an interrupted attempt;
it does not count as ordinary cleanup. A separate `session-*` directory records
launch and root-process exit. Native diagnostics remain on the launch terminal.
The records never claim helper cleanup, successful native acceptance, performance
eligibility, or a passed operator case from an exit code.

Prepare a fresh copy for a later session if artifact identity or metadata changed.
In particular, macOS code-signing clone activity can change host metadata even
when the final executable bytes are unchanged. This tool refuses to infer the
clone-removal proof provided by the separate finite native observer. Keep the
earlier attempt and its records when preparing another copy.

### Fresh-run shutdown diagnostics

For an explicitly authorized finite process-observer probe, the contributor helper
`summarizeNativeHostFailures` in `benchmarks/lib/native-failure-codes.ts` can print
bounded failure codes from that probe's newly captured `nativeEvents(observation)`.
It maps exact fixed native source messages to fixed labels, preserves repeated
failures, and records the last observed shutdown phase start. An absent phase is
`no-phase-start-observed`, which does not prove that shutdown has not started.
Unknown messages
and phase names become `unclassified` and `unclassified-phase`; no raw message,
path, application payload or arbitrary input property is returned. The helper has
no file, process or network access and is not a retained-report reader.

For example, the next fresh probe can print its diagnostic summary immediately
after awaiting its observed command, before applying the existing acceptance
checks:

```ts
console.log(JSON.stringify({
  event: 'bunly.workbench.failure-codes',
  failures: summarizeNativeHostFailures(nativeEvents(observation)),
}))
```

This is diagnostic output, not an acceptance result. A missing failure record or
an `unclassified` code cannot establish clean shutdown. Keep root exit, native
shutdown, backend exit, all existing deadlines and process/helper cleanup gates.
An OS-quit probe must continue to use the actual OS quit action; a successful SDK
quit cannot substitute for that path. This helper does not change native bytes,
enable a diagnostic build feature, launch an app, or authorize reading a retained
private report.

The native shutdown-acknowledgment deadline also attaches fixed `pending` owner
counts and lifetime callback counts to its existing failure receipt. These count
registry records and retained Bunly wrappers, not CEF internal reference counts.
The snapshot distinguishes pending window/view owners, session initialization
or disposal, and executed finalization/IO/UI fence callbacks. It reads registry
state without invoking CEF, releasing owners, or changing the failure path. Counts
saturate at 65,535 with an explicit flag. The fresh-run classifier projects only
those fixed numeric/boolean fields; malformed snapshots become `unclassified`.
An already borrowed registry reports `state-unavailable` without panicking or
inventing zero owners.
Zero counts alone cannot prove native cleanup or satisfy an acceptance gate.

The finite `qualify:desktop --case=parent-close` regression separately closes a
parent with four live manual panes, requires every actual native browser close
callback before disposing sessions, and verifies a surviving control window.
See [the parent-close qualification contract](desktop-qualification.md#live-pane-parent-close).
Its API close receipt does not qualify the workbench's OS-quit path. After a
native ownership change, the workbench still needs a fresh ordinary OS quit
against the matching rebuilt host, with native shutdown and process/helper
cleanup observed under the existing deadlines.

## Application surfaces and controls

The window owns four independent native browser views. Each has a separate
ephemeral session:

| Surface              | Content and authority                                                                                                  |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Application controls | Packaged `app://ui/index.html`; native-authenticated RPC can operate the specific retained workbench window and panes. |
| Left preview         | Fixed content from the app's numeric-loopback server; remote trust, no application RPC or native capability grant.     |
| Right preview        | A second independently owned remote preview and session at the same exact fixture origin.                              |
| Application overlay  | Packaged `app://ui/overlay.html`; a real native overlay view. Its RPC can read observations and dismiss itself.        |

The server binds `127.0.0.1` on an ephemeral port and serves only three fixed
assets at four fixed paths. It checks the exact origin and Host header, accepts
GET/HEAD only, and exposes no generic filesystem, commands, redirects or network
proxy. The preview sessions allow only that exact numeric-loopback origin.
There are no third-party URLs in the workload. This is the existing session
policy, not a claim of an OS-level network firewall.

All application RPC payloads use a strict command union. Unknown commands,
additional fields, supplied view IDs, URLs, paths, arbitrary native operation
names, fractional geometry and oversized dimensions fail before dispatch.
Application routing checks the actual opaque view, current document, exact
origin/URL, authenticated frame/generation and cancellation signal. It rechecks
authority after asynchronous work and before subsequent actions. The overlay
cannot invoke the controls' commands. At most one workbench mutation or readback
is admitted at a time; input bursts are bounded rather than accumulated in an
unlimited command queue.

Every surface has a labeled editable multilingual field, reset and select
controls, a local action, visible focus styling, and local input/composition
observations. Preview pages also provide scrollable controlled text and bounded
numbered output. Text stays in the document; it is not sent to the backend or
written into records. Composition events report type and data length, not input
contents. Enter controlled test text only.

The pane controls expose focus, visibility, focus eligibility, partial/full
clipping, width/height sliders, native forward/reverse traversal, individual
close and reopen. Clipping **changes the page viewport and reflows its content**;
it does not retain a larger page behind a crop. Reopening creates a new preview
and session. Because content views must precede native overlays, reopening also
disposes and recreates the overlay hidden, discarding its previous text/state.
Reapply presentation controls deliberately after reopening.

The native overlay can be shown, hidden, dismissed to application controls, or
disposed. It is a rectangular nonmodal application surface. It has no modal
accessibility claim, click-through guarantee, OS dialog semantics or transparent
compositing claim. CSS z-index cannot order it relative to sibling native views.

Window controls expose activation, minimize/maximize/restore, fullscreen,
three sizes, and an explicitly timed five-second hide. The timed show is a
recovery mechanism requested by the operator, not a test deadline. Restore a
minimized window through the desktop. Use the desktop to make the application
inactive, move it across displays, resize it continuously, or suspend/resume the
machine. None of those physical actions is simulated by preparation or tests.

The observations section separates requested presentation from native readback.
Each page shows its own focus, visibility, viewport, scale, selection length and
IME event state. A backend heartbeat and the latest 48 window/application
observations remain bounded; older events are counted as discarded. Each preview
retains at most 40 numbered output rows and each local input log at most 12
events. Pause periodic native observations while reading with assistive
technology; an explicit refresh remains available. These are live aids to
observation, not exhaustive retained evidence,
performance measurements or proof of released GPU resources. Normal renderer
background throttling remains enabled.

## Operator case coverage

No physical execution is recorded by adding or preparing this workbench. Every
available case starts **not run**. Unsupported cases remain **unsupported**,
with a reason. Partial steps cannot pass a complete matrix case.

| Case | Available workbench steps                                                                                                         | Separate or unsupported steps                                                                                                      |
| ---- | --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| K1   | Physical forward/reverse traversal, focus indication, hidden/clipped/nonfocusable/closed panes, restoration.                      | API focus receipts alone cannot pass keyboard traversal.                                                                           |
| K2   | Pointer routing, clipped edges, native overlay ordering, pane/window resizing, overlay closure.                                   | Transparent composition and click-through regions are unsupported.                                                                 |
| I1   | Multilingual fields and local composition observations in controls, both previews and overlay; focus/resize/minimize transitions. | Record the actual IME/layout and candidate UI. Backend replacement is not driven by this workbench.                                |
| T1   | Controlled text selection by keyboard/pointer; visible selection length.                                                          | Clipboard reads, writes, grants and permission tests are unsupported here. Selection alone cannot pass T1.                         |
| D1   | Native window movement, resizing, maximize/fullscreen/restore on operator-supplied displays.                                      | Physical display topology, scaling changes and reconnect behavior require equipment. Renderer scale alone is insufficient.         |
| A1   | Native HTML controls, labels, focus styling, remote previews and nonmodal overlay.                                                | Actual VoiceOver/Narrator/Orca observations remain not run. Native popup and macOS open-dialog steps require operator observation. |
| L1   | Native state/events, renderer visibility, local numbered output and backend heartbeat while changing desktop state.               | This does not replace terminal-load acceptance or resolve #129.                                                                    |
| L2   | Long-lived application permits deliberate machine suspend/resume.                                                                 | No automated suspension. Record power state, sleep duration and recovery independently.                                            |
| F1   | Unsupported in this workbench.                                                                                                    | Use the maintained renderer/GPU fault qualifier; hardware GPU transitions remain a distinct manual result.                         |
| E1   | Unsupported in this workbench.                                                                                                    | No deep-link registration, OS dispatch or app-reopen adapter is included.                                                          |
| M1   | Native popup menu and macOS open-file panel can be exercised explicitly.                                                          | Shortcuts, status items, backend replacement and Linux/Windows file dialogs are unsupported here.                                  |
| C1   | Individual preview disposal/reopen, surviving sibling use, final-window close and explicit quit.                                  | Exact-head native shutdown and process/helper cleanup evidence still come from the full finite native suite.                       |

The controls view can open a fixed native popup and, on supported macOS hosts,
a native open-file panel. Both use a freshly captured document scope and exact
native grant; the popup registration is disposed after native closure or failure.
The dialog starts in the temporary directory and records only whether it was
selected or cancelled, never the path. Selection grants no file access. The RPC
request expires after 60 seconds and cancellation requests native cleanup.
Clipboard operations are omitted because ordinary hosts lack a safe preflight
for preserving unknown clipboard formats. No manual result is inferred from an
operation receipt.

## Equipment and evidence record flow

1. Read the [protocol's failure criteria](m7-platform-qualification.md#operator-cases-and-failure-criteria)
   for the same twelve case IDs used by the UI and operator template. Run the
   [full hosted/native qualification](manual-native-qualification.md) on
   the exact candidate using the normal profile and existing deadlines. Preserve
   runtime identity, artifact inventory, native shutdown, output drain and
   process/helper cleanup evidence, including failures. A passing workbench
   preparation or root-process exit does not replace that gate.
2. Prepare this workbench and retain its `preparation.json`, exact launch command
   and session records. Copy `operator-record.template.json` to a new attempt
   record before editing it. Its preparation section identifies source, native
   build/tree, target, profile and preparation-record SHA-256.
3. Fill the equipment fields: OS release/build and architecture; GPU/driver;
   every display's connection, resolution, logical scale and relative placement;
   primary display and power state; keyboard layout/locale; IME framework, engine
   and version; screen-reader version and altered accessibility settings. Attach
   the actual packaged Bun observation and exported CEF/Chromium identity from
   the exact native evidence. A virtual hosted target does not supply a physical
   equipment record.
4. Record initial focus/display state, precise action order, observed behavior,
   timestamps and evidence digests for each attempted case. Allowed results are
   **passed**, **failed**, **not run**, and **unsupported**. Every result other
   than passed needs a reason. Record unsupported portions of partially available
   cases explicitly; do not promote the entire case based on a smaller step.
5. Preserve each failed attempt with its original source/equipment identity and
   evidence. Append a later attempt when retesting a correction. Keep recordings
   and logs limited to controlled fixture content and inspect them before
   sharing. Do not use personal clipboard, browsing, document or credential data.

Hardware high-DPI/multi-display, assistive-technology, IME and suspend/resume
testing remain **not run** until actual operator records exist. This workbench
does not close #38, #34 or #35 and supplies no production-release or performance
qualification.

## Portable validation

```sh
bun test tests/hardware-workbench.test.ts tests/hardware-workbench-preparation.test.ts
bun run typecheck
bun run typecheck:browser
bun run boundaries
bun run check:portable
```

Portable tests exercise strict command validation, current native RPC authority,
overlay restrictions, remote-session rejection, revocation during pending work,
fixed loopback routes, prebuilt/source/metadata boundaries, and the separate
launch opt-in. A preparation test uses deliberately inert host, Bun and CEF files
to prove that bundling and verification do not execute them. It builds the actual
Bun and browser assets. The inert-binary preparation test is inapplicable to
macOS ad-hoc signing; real native Mac preparation/launch must be observed there.
No portable test launches a GUI or claims physical input, accessibility or
hardware qualification. Runtime shutdown deadlines remain unchanged.
