# Shared example code

Code that more than one example uses, kept framework-neutral so the Solid and
React examples run the same logic.

- `terminal.ts`: `TerminalSession`, one owned shell on a pseudo-terminal shown
  as plain text, and `workspaceShell()`, the single shell (`/bin/sh`, or
  `cmd.exe` on Windows) and explicit environment that the workspace examples may
  start through the [process service](../../docs/native-services.md). The
  [Solid workspace](../solid-workspace/README.md) and the
  [React workspace](../react-workspace/README.md) render it in their details
  panes.

`tests/examples/shared-terminal.test.ts` covers the session with a fake owned
process: line splitting, escape removal, carriage returns, UTF-8 splits, bounds,
exits, restarts and release. `tests/native/processes.ts` drives it against a
real interactive shell in development and AOT on Linux, macOS and Windows.
