import assert from 'node:assert/strict'
import { test } from 'bun:test'
import {
  LatestDiagnostic,
  type ConsumerDiagnostic,
} from '../examples/cef-terminal-load/diagnostics.ts'
import { diagnostic } from '../examples/cef-terminal-load/contract.ts'
const value: ConsumerDiagnostic = {
  terminal: 0,
  batch: 0,
  stage: 'xterm-write',
  control: 'pending',
  bytes: 0,
  callbacks: 0,
  records: 0,
  visibility: 'hidden',
  error: null,
}
const flush = async () => {
  for (let index = 0; index < 10; index++) await Promise.resolve()
}
test('diagnostics retain latest stage under blocked delivery without blocking or queue growth', async () => {
  const sent: ConsumerDiagnostic[] = []
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const reporter = new LatestDiagnostic(async (snapshot) => {
    sent.push(snapshot)
    await gate
  })
  reporter.update(value)
  for (let batch = 1; batch <= 700; batch++) reporter.update({ ...value, batch, stage: 'digest' })
  assert.equal(sent.length, 1)
  release()
  await flush()
  assert.equal(sent.length, 2)
  assert.equal(sent[1]!.batch, 700)
  assert.equal(sent[1]!.stage, 'digest')
})
test('diagnostic failure is bounded and cannot convert workload failure into success', async () => {
  let sends = 0
  const reporter = new LatestDiagnostic(async () => {
    sends++
    throw new Error('disconnected')
  })
  reporter.update(value)
  await flush()
  for (let index = 0; index < 100; index++) reporter.update(value)
  await flush()
  assert.equal(sends, 1)
})
test('consumer snapshots reject extra authority, unbounded values and unknown phases', () => {
  assert.deepEqual(diagnostic(value), value)
  for (const change of [
    { pid: 123 },
    { stage: 'unknown' },
    { batch: 701 },
    { records: 23102 },
    { bytes: 32769 },
    { callbacks: 257 },
    { control: 'unknown' },
    { error: 'x'.repeat(241) },
  ])
    assert.throws(() => diagnostic({ ...value, ...change }))
})
