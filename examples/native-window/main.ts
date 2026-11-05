import { createApplication } from '@bun-native/core'
import { resolve } from 'node:path'
import { mountCounter, recordEvidence } from './content.ts'

const executable = process.env['BUN_NATIVE_HOST']
if (!executable) throw new Error('Set BUN_NATIVE_HOST to the prebuilt native host executable')
const app = await createApplication({ executable: resolve(executable) })
try {
  const window = await app.openWindow({ title: 'Bun Native BN1', width: 560, height: 380 })
  await mountCounter(window)
  await window.closed
  recordEvidence({ type: 'closed' })
} finally {
  await app.shutdown()
  await app.closed
}
