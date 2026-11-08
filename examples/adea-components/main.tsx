import { createApplication } from '@bun-native/core'
import { render, type RenderRoot } from '@bun-native/solid'
import { resolve } from 'node:path'
import { recordEvidence } from '../native-window/content.ts'
import { App, createAppStats } from './app.tsx'

const executable = process.env['BUN_NATIVE_HOST']
if (!executable) throw new Error('Set BUN_NATIVE_HOST to an existing prebuilt native host')
const application = await createApplication({ executable: resolve(executable) })
const stats = createAppStats()
let view: RenderRoot | undefined

try {
  const window = await application.openWindow({ title: 'Adea components', width: 900, height: 620 })
  view = render(() => <App stats={stats} />, window, {
    style: { width: 'fill', height: 'fill' },
  })
  await view.ready
  recordEvidence({ type: 'mounted', diagnostics: view.diagnostics, rows: stats.created })
  await window.closed
  await view.dispose()
  if (
    !stats.ownerDisposed ||
    stats.timers !== 0 ||
    stats.created !== stats.disposed ||
    view.diagnostics.nodes !== 0
  )
    throw new Error('Adea component resources survived window close')
  recordEvidence({ type: 'closed', rows: stats.created })
} finally {
  await view?.dispose()
  await application.shutdown()
  await application.closed
}
