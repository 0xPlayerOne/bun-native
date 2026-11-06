# React workspace

A session-local task workspace built with React and Bun Native's public adapter.
It uses the same native window, text, input, button, flex layout, scrolling, and
event pipeline as the Solid adapter. There is no DOM, webview, CSS framework, or
application-specific native widget implementation.

The example supports adding tasks with Enter or a button, completing/reopening
tasks, filtering and searching, selecting and renaming tasks, deleting tasks,
switching light/dark colors, and drafting a local eight-step plan for the
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
ordering and stale or duplicate plan steps. The adapter tests use real
public-core IPC with the existing headless event peer to exercise native event
routing, input revisions, React commits, plan timer ownership through stop,
selection, stale delivery and window close, and window-close cleanup. They do
not prove OS rendering, scrolling or focus.

The Native Linux workflow builds the `react-workspace` example and the
`react-workspace-flow` fixture with the same AOT helper. The fixture mounts this
exact `Workspace` component. Its controller uses actual host-reported geometry
to click, type, complete and rename a task, search/filter, scroll, change theme,
resize, delete, stream a complete plan, stop a second plan, switch tasks during
a third, and close the OS window while a fourth plan still streams. Native
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

## Current scope

This is an incremental reference app for [#238](https://github.com/0xPlayerOne/bun-native/issues/238).
Task changes are intentionally session-local and are not saved to disk.
Menus and dialogs depend on [#239](https://github.com/0xPlayerOne/bun-native/issues/239);
the example has no simulated menu or dialog. Accessibility qualification tracks
[#241](https://github.com/0xPlayerOne/bun-native/issues/241). Large-history,
virtualization, streaming, adaptive breakpoints, and performance qualification
remain in [#257](https://github.com/0xPlayerOne/bun-native/issues/257).

## Comparison with the Solid workspace

The [Solid conversation workspace](../solid-workspace/README.md) is the Solid
reference for [#248](https://github.com/0xPlayerOne/bun-native/issues/248).
Both apps run on the same core, renderer primitives and GPUI host, and use the
same development/AOT helper, owned X11 driver and native evidence records. They
are different fixtures, so no equal-workload performance comparison is made.

| Behavior                                         | React task workspace                                   | Solid conversation workspace                   |
| ------------------------------------------------ | ------------------------------------------------------ | ---------------------------------------------- |
| Text entry, native focus, latest input revisions | Native flow (add, rename, search)                      | Native flow (per-conversation drafts)          |
| Keyed list add/edit/delete, filtering            | Native flow                                            | Native flow (history, new/close conversation)  |
| Native scroll, theme, resize                     | Native flow, dark input pixels sampled                 | Native flow, dark composer pixels sampled      |
| Bounded local streaming with keyed row retention | Native flow: 8-step plan, effect-owned timer           | Native flow: 8-update reply, model-owned timer |
| Stop and cancellation on selection change        | Native flow                                            | Native flow                                    |
| OS close with pending work, zero timers after    | Native flow, plus no timer fires after disposal        | Native flow                                    |
| In-app confirmation panel                        | None                                                   | Clear-history confirmation                     |
| Screenshots                                      | scrolled, dark, resized, edited, filtered, after, plan | Per-scenario captures in its native evidence   |

Unsupported or unqualified for both: OS menus and dialogs (#239), accessibility
and screen readers, IME (#241), virtualization and long-session memory (#257),
macOS and Windows workspace interaction, and matched comparative performance
(#244). React-specific limits from the [behavior matrix](../../docs/react-behavior.md)
also apply: suspended/hidden subtrees, hydration, portals and view-transition
animations are outside the adapter contract.

The example does not claim completion of those issues or cross-platform native
acceptance. Real window/input/scroll/focus/close evidence is required in both
development and AOT modes on each target platform.
