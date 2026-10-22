import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { Ledger, FaultChannel } from '../benchmarks/lib/lifecycle.ts'
import { quantile } from '../benchmarks/lib/statistics.ts'
test('rejected overload does not leave an accepted request in the ledger', async () => {
  const ledger = new Ledger(4)
  const channel = new FaultChannel(ledger)
  await assert.rejects(channel.request('too large', 'none'), /QUEUE_LIMIT/)
  ledger.assertClean()
})
test('invalid quantile probabilities cannot produce NaN reports', () => {
  assert.throws(() => quantile([1, 2], NaN))
  assert.throws(() => quantile([1, 2], Infinity))
})
