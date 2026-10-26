import assert from 'node:assert/strict'
import { test } from 'bun:test'
import { terminalLoadBaselines } from '../benchmarks/lib/terminal-load-baselines.ts'
test('pinned adapters refuse unsupported PTY load without synthetic timing or security equivalence', async () => {
  const report = await terminalLoadBaselines()
  assert.equal(report.variants.length, 2)
  assert.equal(report.variants[0]!.identity.version, '44.9.3')
  assert.equal(report.variants[1]!.identity.version, '2.0.3-beta.26')
  assert.equal(
    report.variants[1]!.identity.securityProfile,
    'rpc-disabled+cef-process-sandbox-unverified'
  )
  assert.equal(report.ratios, null)
  for (const variant of report.variants) {
    assert.equal(variant.result.status, 'unsupported')
    assert.equal(variant.result.correctness.passed, false)
    assert.deepEqual(variant.result.metrics, {})
  }
})
