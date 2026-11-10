import { createApplication } from '@bun-native/core'
import { render, type RenderRoot } from '@bun-native/solid'
import { join, resolve } from 'node:path'
import { Workspace } from './app.tsx'
import type { WorkspaceOwnership } from './model.ts'
import { TerminalSession } from './terminal.ts'

const executable = process.env['BUN_NATIVE_HOST']
if (!executable) throw new Error('Set BUN_NATIVE_HOST to an existing prebuilt native host')
const windows = process.platform === 'win32'
const systemRoot = process.env['SystemRoot'] ?? 'C:\\Windows'
// The only executable this app may start. Nothing in the UI can name another.
const shell = windows ? join(systemRoot, 'System32', 'cmd.exe') : '/bin/sh'
const shellEnv: Record<string, string> = windows
  ? { SystemRoot: systemRoot, PATH: process.env['PATH'] ?? '', COMSPEC: shell }
  : {
      PATH: process.env['PATH'] ?? '/usr/bin:/bin',
      HOME: process.env['HOME'] ?? '/',
      TERM: 'dumb',
      PS1: '$ ',
    }
const app = await createApplication({
  executable: resolve(executable),
  permissions: { processes: [{ id: 'shell', executable: shell }] },
})
let root: RenderRoot | undefined
let ownership: WorkspaceOwnership | undefined
let terminal: TerminalSession | undefined
try {
  const window = await app.openWindow({
    title: 'Bun Native Solid Workspace',
    width: 1120,
    height: 760,
  })
  const session = new TerminalSession((listener) =>
    window.spawnProcess('shell', { env: shellEnv, terminal: { columns: 80, rows: 24 } }, listener)
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
    {
      style: { width: 'fill', height: 'fill' },
    }
  )
  await root.ready
  await Promise.race([window.closed, root.closed])
  await root.dispose()
  await session.release()
  if (
    !ownership?.disposed ||
    ownership.pendingTimers !== 0 ||
    ownership.activeReplies !== 0 ||
    root.diagnostics.nodes !== 0 ||
    root.diagnostics.listeners !== 0
  )
    throw new Error('Workspace async work, native nodes or listeners survived disposal')
} finally {
  try {
    await root?.dispose()
    await terminal?.release()
  } finally {
    await app.shutdown()
    await app.closed
  }
}
