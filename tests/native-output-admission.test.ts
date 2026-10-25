import assert from 'node:assert/strict'
import { test } from 'bun:test'
import { checkOutputAdmission } from '../examples/cef/control-admission.ts'

const bounded = {
  frames: 3,
  ordinaryFrames: 2,
  retainedWireBytes: 600,
  ordinaryWireBytes: 400,
  peakFrames: 8,
  peakWireBytes: 900,
}
test('native output receipts require bounded counters from an exercised queue', () => {
  checkOutputAdmission(bounded)
  checkOutputAdmission({
    frames: 0,
    ordinaryFrames: 0,
    retainedWireBytes: 0,
    ordinaryWireBytes: 0,
    peakFrames: 8,
    peakWireBytes: 900,
  })
  for (const value of [
    undefined,
    null,
    {},
    [],
    { ...bounded, peakFrames: 0 },
    { ...bounded, peakWireBytes: 0 },
    { ...bounded, ordinaryFrames: 4 },
    { ...bounded, ordinaryWireBytes: 601 },
    { ...bounded, peakFrames: 2 },
    { ...bounded, peakWireBytes: 599 },
  ])
    assert.throws(() => checkOutputAdmission(value))
  for (const [field, limit] of [
    ['frames', 256],
    ['ordinaryFrames', 192],
    ['retainedWireBytes', 8 * 1024 * 1024],
    ['ordinaryWireBytes', 7 * 1024 * 1024],
    ['peakFrames', 256],
    ['peakWireBytes', 8 * 1024 * 1024],
  ] as const) {
    for (const invalid of [-1, 0.5, Number.NaN, Infinity, '1', limit + 1, undefined])
      assert.throws(() => checkOutputAdmission({ ...bounded, [field]: invalid }))
  }
})
