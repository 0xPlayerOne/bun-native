# Solid conversation workspace

This Adea-inspired native reference app advances [#250](https://github.com/0xPlayerOne/bun-native/issues/250). It is a separate example in Bun Native, with local demo data and deterministic replies. It neither ports nor changes Adea production code.

The app uses the public Solid adapter and shared GPUI `box`, `text`, `button` and `input` primitives. It provides conversation history, per-conversation drafts, a local eight-update reply stream, cancellation, new/close actions, a clear-history confirmation panel, theme switching and a collapsible details pane. History and navigation use real native scroll containers. The flexible conversation pane grows with the window; hide the details pane for more room on small windows. No automatic breakpoint or minimum-window-size API is claimed.

The interactive example also runs a real shell in the details pane: `/bin/sh` on macOS and Linux, `cmd.exe` on Windows, started through the owned [process service](../../docs/native-services.md) on an 80×24 pseudo-terminal. It is the only executable in the app's launch policy, it receives an explicit environment and nothing in the UI can name another program. `examples/shared/terminal.ts`, which the React workspace also uses, shows output as plain text (escape sequences removed, carriage returns applied, 200 lines of scrollback), sends one command per Enter, types Ctrl-C for **Interrupt** so the terminal stops the foreground job, and can restart the shell. Closing the window stops the shell's process group. The native qualification fixtures mount the same `Workspace` without a terminal, so their panes still say no shell runs. `tests/native/processes.ts` drives `TerminalSession` against a real interactive shell in development and AOT on Linux, macOS and Windows. There is no model backend, network connection, filesystem browser, persistent history or OS dialog. The confirmation panel is part of the application UI. Native service/dialog work remains tracked separately in [#239](https://github.com/0xPlayerOne/bun-native/issues/239); broader adaptive layouts, streaming and themes remain [#257](https://github.com/0xPlayerOne/bun-native/issues/257).

## Run with an existing host

From the repository root, with the pinned Bun and dependencies installed:

```sh
bun scripts/solid-build.ts examples/solid-workspace/main.tsx "$PWD/.bun-native/solid-workspace"
BUN_NATIVE_HOST=/absolute/path/to/bun-native-host bun .bun-native/solid-workspace/application.js
```

Build a production AOT executable with the same transformed source:

```sh
bun experiments/aot-gpui/build-window.ts \
  --entry solid-workspace \
  --host /absolute/path/to/bun-native-host \
  --host-profile release \
  --outdir "$PWD/.bun-native/solid-workspace-aot"
BUN_NATIVE_HOST=/absolute/path/to/bun-native-host .bun-native/solid-workspace-aot/solid-workspace
```

Output directories must be empty for the AOT helper. Ordinary source edits use the prebuilt host; neither command invokes Cargo. A successful build establishes compilation and binary inspection, not native interaction or release readiness.

## Ownership and bounds

At most one reply and one timer are live. Each callback carries reply and timer identity. Cancelling, switching, creating, closing or clearing a conversation invalidates that identity before publishing new state; disposal cancels without writing into a disposed Solid owner. A queued stale callback cannot consume a newer timer or modify another conversation. Partial replies retain a `Cancelled` label.

The example limits a workspace to 12 conversations, a conversation to 32 messages and a submitted prompt to 240 characters. These keep this small reference workload bounded; they are not a virtualization claim. Switching back to a full conversation remounts its keyed pane in one Solid commit of more than the protocol's 256 operations per native batch (a message row is its box and three text nodes, created and inserted). The core commits such a transaction by building the new nodes in invisible staging batches and then applying every change to committed nodes in one native batch ([`commit-plan.ts`](../../packages/core/src/commit-plan.ts)), so the remount still paints once and fails or succeeds as a whole. A keyed conversation pane creates a fresh versioned input owner on selection changes, while drafts remain in the model. The composer reads the latest native input revision before submission and replacement.

## Port inventory

| Source                                                                        | Treatment                                                  | Purpose                                                                                                                               |
| ----------------------------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/core`, `packages/renderer`                                          | Reused unchanged                                           | Shared native window, layout, text, input, events and ownership.                                                                      |
| `packages/solid/src/renderer.ts`, `tests/solid/renderer.test.ts`              | Narrow adapter correction and regression                   | Accept the official universal compiler's null insertion marker for adjacent dynamic regions; retain non-null anchor ownership checks. |
| `scripts/solid-build.ts`, `experiments/aot-gpui/build-window.ts`              | Existing compiler path; new entry and source hashes        | Official Solid universal transform, Bun AOT and executable inspection.                                                                |
| `examples/react-workspace/app.tsx`, `main.tsx`                                | Layout/input/lifetime patterns adapted                     | Root fill sizing, bounded flexible scroll panes, latest native input intents and joined shutdown.                                     |
| `examples/solid-workspace/model.ts`                                           | New                                                        | Conversation policy and owned local streaming simulation.                                                                             |
| `examples/shared/terminal.ts`, `tests/examples/shared-terminal.test.ts`       | New                                                        | Owned shell session over the process service: bounded plain-text scrollback, commands, Ctrl-C, restart and stale-output rejection.    |
| `examples/solid-workspace/app.tsx`, `main.tsx`                                | New                                                        | Solid native composition and standalone example lifetime.                                                                             |
| `tests/solid/workspace-model.test.ts`                                         | New                                                        | Completion/cancellation, stale delivery, reentrancy, limits and disposal controls.                                                    |
| `tests/solid/workspace-contract.tsx`, `workspace.test.ts`                     | New, reuse existing headless IPC peer                      | Actual compiled component, versioned drafts, actions and zero-resource teardown.                                                      |
| `tests/native/solid-workspace-soak.tsx`, `tests/solid/workspace-soak.test.ts` | New long-session fixture; headless run reuses the IPC peer | Many rounds of the same component's actions with exact per-round ownership restoration; see below.                                    |

No Adea production source files were copied. No new native widget, framework dependency or runtime bridge was introduced. The interactive example requests one existing capability, the `processes` launch permission for its shell.

## Validation scope

Model tests deliberately drive stale callbacks. The component contract builds the actual example and runs the public Solid/core adapters against the existing headless subprocess peer. It exercises synthetic peer events and real owned timers; it cannot qualify GPUI pixels, native scrolling, focus, OS input or OS window close.

The Linux native workflow appends a separate development/AOT workspace scenario **after the existing native scenarios and measured baseline**. It compiles both the ordinary example and `tests/native/solid-workspace.tsx`; the latter mounts this same component with observation callbacks only. The controller uses the existing owned X11/XTest driver, 30-second overall diagnostic bound, five-second exit wait, nonce checks, bounded logs and joined process cleanup. It does not change the earlier first-launch order or existing gates.

The workspace step runs only when the native build succeeded and the run has not been canceled. It can collect its own evidence after an earlier scenario fails; that earlier failure still fails the job. Each build and native result remains bound to its recorded source revision.

The native scenario requires complete expected paint trees, actual scroll endpoints, preserved row identity across streaming/theme changes, native focus and input, a resized flexible pane, visible partial/complete replies, cancellation on switch, and in-app clear/keep actions. It captures screenshots and samples the dark composer's actual background and readable foreground pixels. OS close occurs with a reply still pending; the app must report disposed local work with zero timers/replies, revoked native listeners, zero application resources and a successful joined exit. Geometry is usable only for the same live node IDs at a revision no newer than the paint.

The shared native evidence producer publishes changed geometry before the corresponding paint record. This prevents a new theme paint from temporarily certifying the previous scroll position. Identical geometry remains deduplicated, and scroll/focus-only frames still publish their geometry; a failed geometry write withholds the new paint record. Deterministic writer and log-prefix controls cover this ordering without changing native rendering, scheduling or deadlines.

| Native qualification source                                                         | Treatment                                                 | Purpose                                                                                                                     |
| ----------------------------------------------------------------------------------- | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `tests/native/solid-workspace.tsx`                                                  | New observer of the unchanged component                   | Real event order, independently expected final state and async/native teardown.                                             |
| `scripts/quality/native-solid-workspace-scenario.py`                                | New scenario using existing owned driver/geometry helpers | Actual OS actions, screenshots, streaming/scroll/resize/focus and close.                                                    |
| `scripts/quality/native-solid-workspace-paint.py`                                   | New independent full-tree expectation                     | Every native element, style, child, label and input value; rejects omitted, foreign or incomplete evidence.                 |
| `tests/quality/test_solid_workspace_paint.py`                                       | New negative controls                                     | Wrong values/styles, missing/extra/cyclic nodes, stale/future geometry and foreign windows fail.                            |
| `native/gpui-host/src/evidence.rs`, `evidence/layout*`, `view.rs`                   | Narrow shared evidence ordering correction                | Publish changed geometry before correlated paint; retain deduplication and reject stale certification after a failed write. |
| `scripts/quality/native-diagnostics-linux.py`, `.github/workflows/native-linux.yml` | Narrow registration and source inventory                  | Reuse existing ownership, renderer checks, log bounds and cleanup.                                                          |

## Long-session ownership

`tests/native/solid-workspace-soak.tsx` mounts the same `Workspace` with two qualification-only props: a fixture-owned reply clock (`schedule`) and access to the component's controller (`onController`). The interactive entry passes neither and keeps real 250 ms timers. Each of 60 native rounds creates a conversation and sends 16 prompts that fill it to the 32-message limit: half stream all eight updates, a quarter are cancelled after three updates and then receive their stale callback (which must change nothing and commit nothing), and a quarter are cancelled by switching away, which also remounts the keyed pane, including at the full limit. Every prompt toggles the theme. The round then checks the limit rejection, dismisses and confirms the in-app clear, toggles details twice and closes the conversation. Every action waits for the native acknowledgement of its Solid commit.

After every round the state returns to the mounted shape, so Solid root nodes and listeners, all public application resources and the controller's timer/reply counts must equal the mounted baseline exactly. The mounted baseline (round 0) and every tenth round record a forced-collection `heapStats()` sample, Bun RSS and the owned host's `VmRSS`; `scripts/quality/native-solid-workspace-soak.py` independently checks the report's counts, final zero resources and samples. The window closes through the public API, then disposal, shutdown and host exit must leave zero resources. The Native Linux workflow runs the fixture in development and as an inspected AOT executable. The headless bun test (`tests/solid/workspace-soak.test.ts`) builds the same fixture and runs three rounds against the existing headless events peer, with one sample per round and no host RSS.

This is fixture-driven work through the component's own actions with native acknowledgements. It has no OS input and no paint assertion; the separate `solid-workspace` scenario covers real X11 input, paint and OS close. Memory samples are single-run observations on Linux Xvfb/llvmpipe, not a leak-freedom, latency or capacity claim.

### Wall-clock long sessions

With `BUN_NATIVE_SOAK_SECONDS` the same fixture repeats the same round until that wall time passes ([`workspace-session.ts`](../../tests/native/workspace-session.ts)). With `BUN_NATIVE_SOAK_OS_INPUT=1` each round's first prompt is typed into the focused composer through the OS ([`workspace-os-input.ts`](../../tests/native/workspace-os-input.ts): XTest through `xdotool` on Linux, the bounded CoreGraphics helper on macOS) and sent with Return through the app's own key handler, and 24 wheel notches go to the history's scroll viewport; the wheel's effect is not asserted. The fixture's single-timer, stale-callback, exact per-round ownership and final zero-resource assertions all still apply. A sample every `BUN_NATIVE_SOAK_SAMPLE_SECONDS` (default 30) records app and host RSS, threads, open files and CPU time, the forced-collection heap, per-interval acknowledgement and input-to-state latency and the load average, appended to `samples.jsonl` as it is taken. `BUN_NATIVE_SOAK_PACE_MS` waits before each streamed update, so a session can follow the real 250 ms reply interval. [`native-workspace-long-session.sh`](../../scripts/quality/native-workspace-long-session.sh) runs one session in a private Xvfb/DBus/openbox session with the host phase trace and a whole-machine load trace, then checks it with `native-solid-workspace-soak.py --long-session`.

The Native Linux workflow runs 120 s per mode after the fixed soak, and the hosted `macos-15` workspace step runs 120 s per mode. One local 30-minute session in development and one as the inspected AOT executable, unpaced, on Linux Xvfb/lavapipe in a shared 4-vCPU container, are recorded in [the long-session evidence](../../benchmarks/results/workspace-long-session-2026-11-11/README.md). No session paced at the real reply interval has been recorded, and these are software-rendered VM sessions, not a physical machine.

Real native development/AOT interaction results remain a separate required scope; a passing source or oracle control does not establish them. Physical-device accessibility, screen-reader behavior, IME, workspace interaction on a physical Mac or Windows PC, memory beyond the recorded sessions, OS input typed into the PTY panel, backend integration and full Adea parity remain unqualified. Keep #250 open until its broader acceptance is demonstrated.
