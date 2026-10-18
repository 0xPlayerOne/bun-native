# Desktop edit qualification

Real build/relaunch drivers with explicit readiness and cleanup evidence.

**Status:** Implemented drivers; actual desktop execution remains unqualified in the current environment.
**Scope:** M2 #8/#9 and the Electron/Electrobun part of #10. This is not Bunly's managed-reload implementation.

## Workload

The driver generates a private project without editing the repository's example
or the user's application. Both framework entrypoints import the same generated
`revision.ts` and common host helper. Both render the same revision-page HTML and JavaScript, together with the full
shared xterm/browser workbench in a separately originated sandboxed iframe.
Readiness requires the revision acknowledgements AND successful consumption of
the exact numbered terminal workload. The workbench preview remains an iframe,
not an independently controlled native browser view; the older Electron
lifecycle/navigation adapter retains that separate native-window scenario.
The five-step plan is initial build, initial launch, backend source edit,
intentional syntax failure, and source repair. Every planned step is retained;
a prerequisite or correctness failure stops subsequent work instead of assigning
zero timings or retrying until it passes.

This is an **explicit stop-build-relaunch workload**, not a measurement of a
framework's default file watcher. The old application is stopped and its process
observation awaited before the replacement build begins. The failed-edit step
requires a clean positive compiler exit with a diagnostic for the deliberately
invalid imported source. Network/setup failures, a killed compiler, timeout,
overflow, and leaked children cannot satisfy that condition. Repair must execute
the corrected source in a new backend instance and a new document.

A random state token and counter are retained in a fixture-owned JSON file across
launches. They prove disk-state reconnection, not preservation of JavaScript
memory, terminal processes, browser login state, or native window handles.

## Framework paths

- Electron uses the separately installed, exact baseline version **44.8.0**.
  Bun builds the TypeScript main entry as CommonJS; the runtime is external.
  That compilation is not reported as full application assembly or installed
  app size. The app uses a private profile, Node-disabled pages, context isolation,
  and `app.enableSandbox()`. A narrow isolated preload attests `process.sandboxed`
  from the expected main frame during an extra preflight navigation. This extra
  navigation is disclosed instrumentation overhead, not a performance advantage.
- Electrobun uses the exact **2.0.3-beta.26** bootstrap with Bun as main process and
  CEF selected explicitly. The implementation currently supports the previously
  exercised **macOS arm64** bundle layout only. It uses the real prepare/config/build
  commands, reuses the private Hutch dependency cache, resolves the generated app
  entrypoint, and launches that native executable. It does not compile a competing
  framework from source. Electrobun `sandbox: true` disables its page RPC; it is
  not reported as Chromium process-sandbox verification. Exact CEF binary identity
  remains unknown and comparative eligibility remains false.

Use the existing benchmark setup guide to install the pinned contributor-only
runtime and Python dependency. The driver does not install a missing npm package. Electrobun prepare/build may
fetch upstream runtime artifacts on a cache miss; those setup effects are not
reported as eliminated downloads or zero byte costs. No fallback to another
engine or platform is performed.

```sh
bun scripts/qualify-desktop-edits.ts electron --trials=3 --warmups=1
bun scripts/qualify-desktop-edits.ts electrobun --trials=3 --warmups=1
```

The CLI records every planned trial, separate shared-fixture and adapter hashes,
actual driver/runtime metadata, command observations, stage and byte matrices,
setup failures, and retained fixture paths when cleanup could not be established.
Missing runtimes and unsupported platform layouts exit nonzero. Unknown flags or
duplicate count flags fail before any app is started. This command never enables
production debugging endpoints or modifies operating-system browser policies.

## Readiness boundary

An ephemeral `127.0.0.1` completion server has independent host and renderer tokens,
one launch nonce, bounded bodies, strict records, exact Host/Origin checks, no CORS
grants, no-store responses, and a restrictive CSP. Host credentials are not put in
page URLs. A page-only token is supplied in the fragment and removed from the URL
before reporting; command logs redact both per-launch credentials.

The host reports its imported revision, runtime, instance, state, and PID. The
page renders the observed revision/state and acknowledges it after two animation
callbacks. Both acknowledgements must match the expected launch and state. Stale
or duplicate reports and role-token swaps fail. A real process exit before page
readiness also fails, even if the build had succeeded. Known browser error classes
such as `ERR_BLOCKED_BY_ADMINISTRATOR` survive diagnostic sanitization without
including the original URL, credentials, or inherited environment.

This is trusted **benchmark instrumentation**, not Bunly's native authorization
implementation. Page-generated document IDs are not native frame attestation.
Absence of `Bun`, `process`, and `require` is the precise page check, not proof
that every possible native bridge is absent. Two animation callbacks are a render
opportunity, not physical input-to-photon or GPU presentation evidence.

## Process ownership

Commands run through the external process-tree observer. A fresh invocation
nonce binds each consumed report to its command, preventing stale output reuse. Outcomes preserve actual
exit codes, timeouts, cancellation, bounded compiler stdout/stderr, samples,
observed orphan identities, and survivors after attempted cleanup. SIGINT/SIGTERM
ask the observer to terminate/reap its owned commands before it writes a final
report. Cancellation is separate from a successful command and from a timeout.

No new generation starts until the preceding command report has settled. A missing
report or a remaining descendant causes the private project to be retained rather
than removed underneath unconfirmed work. Observed orphans remain failures even
when subsequent cleanup succeeds. Snapshot sampling can miss short-lived or
reparented descendants; it is not a replacement for kernel process containment.
The observer itself and fixture server are outside the app's sampled process tree.
Uninterruptible OS calls remain an environmental limitation.

## Measurements and validation

The raw five-step timing includes orchestration, validation, and observer teardown.
Subtimings distinguish source write, prior app stop, build/reap, and launch-to-page
acknowledgement. They are not pure compiler timings. The standardized stage matrix
maps only actual application-directory assembly (Electrobun) and backend edit-to-
usable operations. Initial fixture launches are not relabeled as warm development
or installed first runs. Signing, downloads, updates, and absent byte observations
remain unavailable. A late cleanup failure invalidates affected successful records.

```sh
bun test tests/desktop-probe.test.ts tests/desktop-edits.test.ts tests/desktop-report.test.ts tests/observed-command.test.ts
bun scripts/qualify-observed-commands.ts
python tests/process_observer_test.py
```

The portable unit suite uses explicitly marked synthetic lifecycle adapters and
actual Bun bundling; it does not execute CEF or Electron. The process qualification
runs real Bun children for stdout/stderr capture, syntax rejection, hangs,
cancellation, orphan detection/cleanup, overflow, and credential redaction. It is
separately classified as process-harness qualification, not desktop performance.

Current limitations remain visible: the actual Electron package is absent in the
local environment; Electrobun's selected layout needs macOS arm64. The previously
encountered managed Chromium URL block is not bypassed or disabled, and this
increment does not claim a successful frontend-HMR run. Mirin/Butter adapters,
full install/release/update measurements, controlled hardware data and actual
cross-platform desktop scenarios remain M2 work. No issue or milestone closes on
unit tests or prerequisite-failure reports alone.

## Shared-workbench integration

`createWorkbenchDesktopProbe` serves the existing `loadWorkbenchAssets()` output.
It does not substitute a second terminal renderer or a reduced workload. A
locally generated exact `frame-src` grant permits the separate fixture origin;
no CORS wildcard or native bridge is enabled. The completion-only token belongs
only to this workload and cannot register a backend or complete its revision
acknowledgement. The parent revision page and workbench must both finish before
launch-to-usable succeeds. Byte and checksum mismatch reject the combined result.

Both local fixture servers live outside the measured application tree, as in
the existing baseline. Their work and the extra embedded frame are disclosed
instrumentation, not evidence of a shell or RPC optimization. All fixtures are
closed together on completion, cancellation or deadline. Real desktop adapters
require all four shared assets, including actual xterm.js; no synthetic renderer
is used when that dependency is absent. HTTP protocol tests use explicitly fake
assets and are not presented as browser execution.

Electron's navigation and redirect hooks receive the separately declared local
workbench origin through trusted fixture configuration. That origin is permitted
only in subframes; it is not a main-frame navigation grant. Other loopback ports,
remote origins, external protocols and credential-bearing URLs remain denied.
The policy is tested by importing the exact generated host template. Those tests
are not a substitute for exercising Electron's actual navigation events.
