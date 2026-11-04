import { createApplication } from '@bun-native/core'
import { render, type RenderRoot } from '@bun-native/solid'
import { resolve } from 'node:path'
import { Workspace } from './app.tsx'
import type { WorkspaceOwnership } from './model.ts'

const executable = process.env['BUN_NATIVE_HOST']
if (!executable) throw new Error('Set BUN_NATIVE_HOST to an existing prebuilt native host')
const app = await createApplication({ executable: resolve(executable) })
let root: RenderRoot | undefined
let ownership: WorkspaceOwnership | undefined
try {
  const window = await app.openWindow({
    title: 'Bun Native Solid Workspace',
    width: 1120,
    height: 760,
  })
  root = render(
    () => (
      <Workspace
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
  } finally {
    await app.shutdown()
    await app.closed
  }
}
