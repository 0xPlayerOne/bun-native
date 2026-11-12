/**
 * The actual Solid workspace with its real shell, driven through the terminal
 * pane by OS input (see tests/native/workspace-terminal.ts).
 */
import { createApplication } from '@bun-native/core'
import { render, type RenderRoot } from '@bun-native/solid'
import assert from 'node:assert/strict'
import { Workspace } from '../../examples/solid-workspace/app.tsx'
import type { WorkspaceOwnership } from '../../examples/solid-workspace/model.ts'
import { TerminalSession, workspaceShell } from '../../examples/shared/terminal.ts'
import {
  driveTerminal,
  terminalFixtureEnvironment,
  writeTerminalResult,
} from './workspace-terminal.ts'

const environment = terminalFixtureEnvironment()
const TITLE = 'Bun Native Solid Workspace terminal'
const shell = workspaceShell()
const app = await createApplication({
  executable: environment.host,
  permissions: { processes: [{ id: 'shell', executable: shell.executable }] },
})
let root: RenderRoot | undefined
let terminal: TerminalSession | undefined
let ownership: WorkspaceOwnership | undefined
let outcomes: Record<string, unknown> = {}
try {
  const window = await app.openWindow({ title: TITLE, width: 1120, height: 760 })
  const session = new TerminalSession((listener) =>
    window.spawnProcess('shell', { env: shell.env, terminal: { columns: 80, rows: 24 } }, listener)
  )
  terminal = session
  void session.start()
  root = render(
    () => (
      <Workspace
        terminal={session}
        onDispose={(_, released) => {
          ownership = released
        }}
      />
    ),
    window,
    { style: { width: 'fill', height: 'fill' } }
  )
  await root.ready
  outcomes = await driveTerminal({ environment, window, session, title: TITLE })
  await root.dispose()
  await session.release()
  assert.equal(root.diagnostics.nodes, 0)
  assert.equal(root.diagnostics.listeners, 0)
  assert(ownership?.disposed && ownership.pendingTimers === 0 && ownership.activeReplies === 0)
} finally {
  try {
    await root?.dispose()
    await terminal?.release()
  } finally {
    await app.shutdown()
    await app.closed
  }
}
assert(
  Object.values(app.diagnostics).every((count) => count === 0),
  'every owner released'
)
writeTerminalResult(environment, 'solid-workspace-terminal', outcomes, {
  diagnostics: app.diagnostics,
})
