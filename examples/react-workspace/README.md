# React workspace

A session-local task workspace built with React and Bun Native's public adapter.
It uses the same native window, text, input, button, flex layout, scrolling, and
event pipeline as the Solid adapter. There is no DOM, webview, CSS framework, or
application-specific native widget implementation.

The example supports adding tasks with Enter or a button, completing/reopening
tasks, filtering and searching, selecting and renaming tasks, deleting tasks,
clearing completed tasks after an in-app confirmation, switching light/dark colors, and drafting a local eight-step plan for the
selected task. The plan streams one step every 300 ms, can be stopped, and stops
when the selection changes. Plan text is fixed local data: no model, backend or
network is contacted. The list and detail pane use native vertical
scroll containers. Initial tasks make the list scroll at the default window size.
Closing the window disposes the renderer before shutting down the application.

## Run in development

Use the repository's pinned Bun and an already built host for your platform:

```sh
bun install --frozen-lockfile
export BUN_NATIVE_HOST=/absolute/path/to/bun-native-host
bun examples/react-workspace/main.tsx
```

Ordinary TypeScript or React edits do not rebuild the Rust host. See the
[developer workflow](../../docs/development.md) and the
[engineering standard](../../docs/engineering-quality.md) for host/toolchain gates.

## Build a production AOT executable

The existing AOT helper compiles the same entry, inspects its compiled-program
record and JIT removal, and records source/toolchain/host provenance:

```sh
bun experiments/aot-gpui/build-window.ts \
  --source "$PWD" \
  --host "$BUN_NATIVE_HOST" \
  --host-profile release \
  --entry react-workspace \
  --outdir /absolute/path/to/empty/workspace-package

BUN_NATIVE_HOST="$BUN_NATIVE_HOST" /absolute/path/to/empty/workspace-package/react-workspace
```

Use the `.exe` executable names on Windows. The helper references the supplied
host in place; distribute the matching host with the application and point
`BUN_NATIVE_HOST` at its installed location. Development execution, AOT
compilation, and actual native interaction are separate evidence obligations.

## State and native ownership

`model.ts` owns immutable task updates and a maximum of 200 tasks, with titles
limited to 120 characters. IDs are stable across filtering and completion.
Adding a task reveals and selects it. Deleting the selected task selects the
next adjacent task, or clears selection when the workspace becomes empty.

Clearing completed tasks is a model state too: `clear-request` opens the
in-app confirmation only when something is completed, `clear-dismiss` closes it,
and `clear-confirm` acts only while it is open, so a queued second confirmation
is inert. Clearing keeps surviving IDs, order and selection; if the selected task
was cleared, the first remaining task is selected and a cleared task's plan is
dropped.

`app.tsx` keeps native input observations in React state. Add and Save capture
the input's current revision through the public `inputState` helper before
replacing text. Keyed detail components reset their input ownership when the
selected task changes.

At most one plan exists and at most one plan timer is live. The `Workspace`
effect schedules the next step only while a plan streams; each step, Stop,
selection change, task deletion and unmount runs that effect's cleanup, which
cancels the pending timer. Each step action carries its plan ID, so a callback
that was already queued cannot write into a stopped or newer plan. Stopped plans
keep their partial steps; deleting a task drops its plan. Steps are append-only
keyed rows, so streaming updates preserve native row identity. No timers,
external subscriptions or background jobs outlive the renderer. The optional
state observer and `schedule` prop support evidence recording without replacing
native interaction or the real timer.

The entry passes `{ style: { width: 'fill', height: 'fill' } }` to `render` to
bound the renderer's ownership container to the window. The content row starts
at zero height and grows into the remaining space, allowing its native task
list to scroll instead of expanding beyond the window. The shared mount option
is also available to Solid; existing consumers keep their default intrinsic size.
Flexible columns and clipped task labels keep long titles inside the list. The
example does not yet switch columns at narrow-window breakpoints.

```sh
bun test tests/react/workspace-model.test.ts tests/react/workspace.test.tsx
```

The model tests cover full edit/filter/delete flows, capacity boundaries, plan
ordering, stale or duplicate plan steps and the real 300 ms plan timer and its
cancellation. The adapter tests use real public-core IPC with the existing
headless event peer to exercise native event routing, the delete confirmation (declined, accepted and answered after teardown), input revisions, React
commits, deleting every task through the empty state, plan timer ownership
through stop, selection change and stale delivery, and window-close cleanup.
They do not prove OS rendering, scrolling or focus.

The Native Linux workflow builds the `react-workspace` example and the
`react-workspace-flow` fixture with the same AOT helper. The fixture mounts this
exact `Workspace` component. Its controller uses actual host-reported geometry
to click, type, complete and rename a task, search/filter, scroll, change theme,
resize, delete a task through the modal confirm dialog (Escape keeps it, the
Delete button removes it), stream a complete plan, stop a second plan, switch tasks during
a third, clear two completed tasks through the in-app panel and close the OS window while
a fourth plan still streams. The clear flow is keyboard-checked against the host's
focus record: the panel focuses Keep tasks, Tab moves to the clear button and wraps
back, Escape keeps the tasks and returns focus to the opener, Return on the opener
reopens the panel, Tab and Return confirm, the surviving keyed rows are retained and
focus lands in the composer. Native
paints independently verify the complete task list, ordered plan rows, retained
keyed task and plan rows and the visible plan status; the details pane is
wheel-scrolled until the last plan row is wholly visible. The fixture observes the
component's real timers: after disposal and a further two plan intervals, no
timer is pending or fires, and final ownership must return to zero.
It reuses the existing isolated X11 driver and records screenshots and raw events.

To run that native flow with an already built host and the documented Linux X11
prerequisites:

```sh
xvfb-run --auto-servernum --server-args='-screen 0 1280x800x24 -nolisten tcp' \
  dbus-run-session -- bash scripts/quality/native-linux-session.sh \
  /absolute/path/to/new/workspace-session -- \
  python3 scripts/quality/native-diagnostics-linux.py \
  --scenario react-workspace --mode development --host-profile release \
  --output /absolute/path/to/new/workspace-evidence -- \
  bun tests/native/react-workspace.tsx
```

For AOT, build `--entry react-workspace-flow`, use `--mode aot`, and replace the
final Bun command with the resulting `react-workspace-flow` executable. The
driver's mode label does not itself prove AOT; retain the helper's artifact
inspection and manifest alongside the native results.

The same scenario module runs unchanged on the hosted macOS and Windows runners
of the Native Platforms job, in development and AOT. On macOS,
`scripts/quality/native-workspace-macos.py` maps its X11 words to CoreGraphics
events and Accessibility resize/close. On Windows,
`scripts/quality/native-workspace-windows.py` maps them to `SendInput` pointer,
wheel and key events, `SetWindowPos` resize and the system Close command
(`WM_SYSCOMMAND SC_CLOSE`, what Alt+F4 sends), copies the owned client area from
the composed desktop for the pixel checks, and refuses input unless the owned
window is foreground on the interactive desktop. Both runners temporarily switch
to a larger display mode because the 1000×760 fixture does not fit the hosted
1024×768 displays, and restore it afterwards:

```powershell
python scripts/quality/native-workspace-windows.py --scenario react-workspace `
  --mode development --output C:\absolute\new\evidence -- `
  bun C:\absolute\react-workspace-flow-package\development\application.js
```

## Long-session ownership

`tests/native/react-workspace-soak.tsx` mounts the same `Workspace` with two
qualification-only props: a fixture-owned plan clock (`schedule`) and the
component's own reducer `dispatch` (`onDispatch`). The interactive entry passes
neither and keeps its real 300 ms timer. Each of 60 native rounds adds a task and
drafts eight plans for it: half stream all eight steps, a quarter are stopped
after three steps and then receive their stale callback (which must change no
state and stage no native mutation), and a quarter are cancelled by selecting
another task, which also remounts the keyed details pane. Every plan toggles the
theme. The round then renames, filters and searches, adds and deletes a second
task, and clears its task through the in-app confirmation (dismissed once, then
confirmed, mounting and removing the modal overlay each time). Every action
waits for React's commit and its native acknowledgement.

After every round the state returns to the mounted shape, so React root nodes and
listeners and all public application resources must equal the mounted baseline
exactly, with no plan timer pending. The mounted baseline (round 0) and every
tenth round record a forced-collection `heapStats()` sample, Bun RSS and the owned
host's `VmRSS`; `scripts/quality/native-react-workspace-soak.py` independently
checks the totals, final zero resources and samples. The Native Linux workflow
runs the fixture in development and as an inspected AOT executable. The headless
`tests/react/workspace-soak.test.ts` runs three rounds against the overlay peer.

As for Solid, this is fixture-driven work with native acknowledgements, no OS
input and no paint assertion, and the samples are single-run observations on
Linux Xvfb/llvmpipe, not a leak-freedom, latency or capacity claim. Locally, 60
rounds (480 plans, 5,040 actions) took about 14 s with the release host.

## Dialogs and focus

The example uses both kinds of confirmation the host offers:

- **Delete task** asks through the window's own `showConfirmDialog`, a modal
  question the host draws ([ADR 0014](../../docs/decisions/0014-message-dialogs.md)).
  It focuses the safe "Keep task" choice; Escape keeps the task.
- **Clear completed (N)** opens the app's own confirmation panel, the
  counterpart of the Solid workspace's clear-history panel. It is a modal
  window `overlay` ([native overlays](../../docs/native-overlays.md)), so the
  host provides the focus behavior instead of the app simulating it: the safe
  "Keep tasks" button takes focus when it opens, Tab and Shift-Tab stay inside
  the panel and wrap, Return or Space activates the focused button, and the
  workspace beneath receives no pointer or wheel input. Escape, a press on the
  backdrop and Keep tasks close it, and the host returns focus to the control
  that opened it. Confirming disables that control (nothing is left to clear),
  so the app moves focus to the "Add a task" composer with `focusNode` once the
  panel has left the native tree.

Escape with any modifier is not a dismissal. The panel names itself to
accessibility with `accessibleLabel`; screen-reader qualification remains #241.

## Current scope

This is an incremental reference app for [#238](https://github.com/0xPlayerOne/bun-native/issues/238).
Task changes are intentionally session-local and are not saved to disk.
Deleting a task asks first through the window's own `showConfirmDialog` (a modal
overlay drawn by the host, [ADR 0014](../../docs/decisions/0014-message-dialogs.md)),
so the example simulates no dialog of its own. Menus and OS-native alerts depend on
[#239](https://github.com/0xPlayerOne/bun-native/issues/239). Accessibility qualification tracks
[#241](https://github.com/0xPlayerOne/bun-native/issues/241). Large-history,
virtualization, streaming, adaptive breakpoints, and performance qualification
remain in [#257](https://github.com/0xPlayerOne/bun-native/issues/257).

## Comparison with the Solid workspace

The [Solid conversation workspace](../solid-workspace/README.md) is the Solid
reference for [#248](https://github.com/0xPlayerOne/bun-native/issues/248).
Both apps run on the same core, renderer primitives and GPUI host, and use the
same development/AOT helper, owned X11 driver and native evidence records. They
are different fixtures, so no equal-workload performance comparison is made.

| Behavior                                         | React task workspace                                                                          | Solid conversation workspace                            |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Text entry, native focus, latest input revisions | Native flow (add, rename, search)                                                             | Native flow (per-conversation drafts)                   |
| Keyed list add/edit/delete, filtering            | Native flow                                                                                   | Native flow (history, new/close conversation)           |
| Native scroll, theme, resize                     | Native flow, dark input pixels sampled                                                        | Native flow, dark composer pixels sampled               |
| Bounded local streaming with keyed row retention | Native flow: 8-step plan, effect-owned timer                                                  | Native flow: 8-update reply, model-owned timer          |
| Stop and cancellation on selection change        | Native flow                                                                                   | Native flow                                             |
| OS close with pending work, zero timers after    | Native flow, plus no timer fires after disposal                                               | Native flow                                             |
| Confirmation before a destructive action         | Native flow: modal confirm dialog (Escape keeps the task, Delete removes it)                  | Clear-history confirmation panel (in-app)               |
| In-app confirmation panel                        | Native flow: modal overlay, autofocus, Tab trap, Escape/backdrop keep, focus return           | Native flow: inline panel, confirm/keep                 |
| Keyboard-only dialog flow and programmatic focus | Native flow: Tab/Return/Escape, focus moved to the composer after clearing                    | Not exercised                                           |
| macOS hosted development and AOT                 | Native flow (same scenario)                                                                   | Native flow (same scenario)                             |
| Windows hosted development and AOT               | Native flow (same scenario)                                                                   | Native flow (same scenario)                             |
| Long-session ownership soak (60 rounds, dev+AOT) | Native Linux: plans, stale callbacks, remounts, clear overlay; exact per-round baseline       | Native Linux: replies, stale callbacks, remounts, clear |
| Screenshots                                      | scrolled, dark, resized, edited, filtered, after, plan-streaming, plan-complete, plan-stopped | Per-scenario captures in its native evidence            |

Unsupported or unqualified for both: OS menus and alerts (#239), accessibility
and screen readers, IME (#241), virtualization and long-session memory (#257),
physical input devices and non-hosted display configurations (hosted runners use
injected OS events at scale 1), and matched comparative performance (#244). React-specific limits from the [behavior matrix](../../docs/react-behavior.md)
also apply: suspended/hidden subtrees, hydration, portals and view-transition
animations are outside the adapter contract.

The example does not claim completion of those issues or physical-device
acceptance. Real window/input/scroll/focus/close evidence is required in both
development and AOT modes on each target platform.

```

```
