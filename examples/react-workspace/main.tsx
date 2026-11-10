/** @jsxImportSource @bun-native/react */
import { createApplication, NativeStateError, type ConfirmDialogOptions } from '@bun-native/core'
import { render, type ReactRenderRoot } from '@bun-native/react'
import { resolve } from 'node:path'
import { recordEvidence } from '../native-window/content.ts'
import { TerminalSession, workspaceShell } from '../shared/terminal.ts'
import { Workspace } from './app.tsx'
import type { WorkspaceState } from './model.ts'

const executable = process.env['BUN_NATIVE_HOST']
if (!executable) throw new Error('Set BUN_NATIVE_HOST to an existing prebuilt native host')
// The only executable this app may start. Nothing in the UI can name another.
const shell = workspaceShell()
const application = await createApplication({
  executable: resolve(executable),
  permissions: { processes: [{ id: 'shell', executable: shell.executable }] },
})
let root: ReactRenderRoot | undefined
let terminal: TerminalSession | undefined

function changed(state: WorkspaceState) {
  recordEvidence({ type: 'workspace-state', ...state })
}

try {
  const window = await application.openWindow({
    title: 'Bun Native React Workspace',
    width: 1000,
    height: 760,
  })
  // Closing the window while the question is open rejects it with an
  // invalid-handle error; that is an answer of "no", not a failure.
  async function confirm(options: ConfirmDialogOptions): Promise<boolean> {
    try {
      return await window.showConfirmDialog(options)
    } catch (error) {
      if (error instanceof NativeStateError && error.code === 'invalid_handle') return false
      throw error
    }
  }
  const session = new TerminalSession((listener) =>
    window.spawnProcess('shell', { env: shell.env, terminal: { columns: 80, rows: 24 } }, listener)
  )
  terminal = session
  void session.start()
  root = render(<Workspace onChange={changed} confirm={confirm} terminal={session} />, window, {
    style: { width: 'fill', height: 'fill' },
  })
  await root.ready
  recordEvidence({ type: 'workspace-mounted', diagnostics: root.diagnostics })
  await Promise.race([window.closed, root.closed])
  await root.dispose()
  await session.release()
  if (root.diagnostics.nodes !== 0 || root.diagnostics.listeners !== 0)
    throw new Error('Workspace native nodes or event listeners survived disposal')
  recordEvidence({ type: 'workspace-disposed', diagnostics: root.diagnostics })
  recordEvidence({ type: 'closed' })
} finally {
  try {
    await root?.dispose()
    await terminal?.release()
  } finally {
    await application.shutdown()
    await application.closed
  }
}
