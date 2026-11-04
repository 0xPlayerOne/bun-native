# React workspace

A session-local task workspace built with React and Bun Native's public adapter.
It uses the same native window, text, input, button, flex layout, scrolling, and
event pipeline as the Solid adapter. There is no DOM, webview, CSS framework, or
application-specific native widget implementation.

The example supports adding tasks with Enter or a button, completing/reopening
tasks, filtering and searching, selecting and renaming tasks, deleting tasks,
and switching light/dark colors. The list and detail pane use native vertical
scroll containers. Initial tasks make the list scroll at the default window size.
Closing the window disposes the renderer before shutting down the application.

## Run in development

Use the repository's pinned Bun and an already built host for your platform:

```sh
bun install --frozen-lockfile
export BUN_NATIVE_HOST=/absolute/path/to/bun-native-host
bun examples/react-workspace/main.tsx
```

Ordinary TypeScript or React edits do not rebuild the Rust host. See the root
[development guide](../../docs/engineering-quality.md) for host/toolchain gates.

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
selected task changes. No timers, external subscriptions, or background jobs
outlive the renderer. The optional state observer supports evidence recording
without replacing native interaction.

```sh
bun test tests/react/workspace-model.test.ts tests/react/workspace.test.tsx
```

The model tests cover full edit/filter/delete flows and capacity boundaries.
The adapter test uses real public-core IPC with the existing headless event
peer to exercise native event routing, input revisions, React commits, and
window-close cleanup. It does not prove OS rendering, scrolling, or focus.

## Current scope

This is an incremental reference app for [#238](https://github.com/0xPlayerOne/bun-native/issues/238).
Task changes are intentionally session-local and are not saved to disk.
Menus and dialogs depend on [#239](https://github.com/0xPlayerOne/bun-native/issues/239);
the example has no simulated menu or dialog. Accessibility qualification tracks
[#241](https://github.com/0xPlayerOne/bun-native/issues/241). Large-history,
virtualization, streaming, adaptive breakpoints, and performance qualification
remain in [#257](https://github.com/0xPlayerOne/bun-native/issues/257).

The example does not claim completion of those issues or cross-platform native
acceptance. Real window/input/scroll/focus/close evidence is required in both
development and AOT modes on each target platform.
