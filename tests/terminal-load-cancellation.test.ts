import assert from 'node:assert/strict'
import { test } from 'bun:test'
import { bounded } from '../examples/cef-terminal-load/probe.ts'
const flush = async () => {
  for (let index = 0; index < 12; index++) await Promise.resolve()
}
test('revoked native connection rejects a pending consumer wait before the workload timer', async () => {
  const controller = new AbortController()
  let release!: () => void
  const source = new Promise<void>((resolve) => {
    release = resolve
  })
  let outcome = 'pending'
  const result = bounded(source, controller.signal).then(
    () => {
      outcome = 'resolved'
    },
    (error: { code?: string }) => {
      outcome = error.code ?? 'unknown'
    }
  )
  controller.abort(new Error('Native stream document revoked'))
  await flush()
  try {
    assert.equal(outcome, 'CONNECTION_REVOKED')
  } finally {
    release()
    await result
  }
})
test('an already revoked connection cannot admit a resolved receipt as success', async () => {
  const controller = new AbortController()
  controller.abort(new Error('Native stream document revoked'))
  await assert.rejects(bounded(Promise.resolve(null), controller.signal), {
    code: 'CONNECTION_REVOKED',
  })
})
