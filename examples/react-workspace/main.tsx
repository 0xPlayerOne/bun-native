/** @jsxImportSource @bun-native/react */
import { createApplication } from '@bun-native/core'
import { render, type ReactRenderRoot } from '@bun-native/react'
import { resolve } from 'node:path'
import { recordEvidence } from '../native-window/content.ts'
import { Workspace } from './app.tsx'
import type { WorkspaceState } from './model.ts'

const executable = process.env['BUN_NATIVE_HOST']
if (!executable) throw new Error('Set BUN_NATIVE_HOST to an existing prebuilt native host')
const application = await createApplication({ executable: resolve(executable) })
let root: ReactRenderRoot | undefined

function changed(state: WorkspaceState) {
  recordEvidence({ type: 'workspace-state', ...state })
}

try {
  const window = await application.openWindow({
    title: 'Bun Native React Workspace',
    width: 1000,
    height: 760,
  })
  root = render(<Workspace onChange={changed} />, window)
  await root.ready
  recordEvidence({ type: 'workspace-mounted', diagnostics: root.diagnostics })
  await Promise.race([window.closed, root.closed])
  await root.dispose()
  if (root.diagnostics.nodes !== 0 || root.diagnostics.listeners !== 0)
    throw new Error('Workspace native nodes or event listeners survived disposal')
  recordEvidence({ type: 'workspace-disposed', diagnostics: root.diagnostics })
  recordEvidence({ type: 'closed' })
} finally {
  try {
    await root?.dispose()
  } finally {
    await application.shutdown()
    await application.closed
  }
}
