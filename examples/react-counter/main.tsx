/** @jsxImportSource @bun-native/react */
import { createApplication } from '@bun-native/core'
import { render, type ReactRenderRoot } from '@bun-native/react'
import { resolve } from 'node:path'
import { recordEvidence } from '../native-window/content.ts'
import { App, createCounterStats } from './app.tsx'

const executable = process.env['BUN_NATIVE_HOST']
if (!executable) throw new Error('Set BUN_NATIVE_HOST to an existing prebuilt native host')
const application = await createApplication({ executable: resolve(executable) })
const stats = createCounterStats()
let view: ReactRenderRoot | undefined

try {
  const window = await application.openWindow({
    title: 'Bun Native React',
    width: 640,
    height: 520,
  })
  view = render(<App stats={stats} view={() => view!} />, window)
  await view.ready
  recordEvidence({
    type: 'react-mounted',
    diagnostics: view.diagnostics,
    rowsCreated: stats.rowsCreated,
    effects: stats.effects,
  })
  await window.closed
  await view.dispose()
  recordEvidence({
    type: 'react-disposed',
    diagnostics: view.diagnostics,
    rowsCreated: stats.rowsCreated,
    rowsDisposed: stats.rowsDisposed,
    ownerDisposed: stats.ownerDisposed,
  })
  if (
    !stats.ownerDisposed ||
    stats.rowsCreated !== stats.rowsDisposed ||
    view.diagnostics.nodes !== 0
  )
    throw new Error('React owner or keyed rows survived window close')
  recordEvidence({ type: 'closed' })
} finally {
  await view?.dispose()
  await application.shutdown()
  await application.closed
}
