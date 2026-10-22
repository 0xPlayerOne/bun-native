import { expect, test } from 'bun:test'
import { validateStageLedger, type StageLedger } from '../benchmarks/lib/budgets.ts'
const sourceCommit = 'a'.repeat(40)
const validate = (value: unknown) => validateStageLedger(value as StageLedger)
test('legacy stage ledger rejects forged outcomes instead of accepting them as unsupported', () => {
  for (const outcome of ['skipped', 'pending', '', null, false, 1]) {
    expect(() =>
      validate({ sourceCommit, entries: [{ stage: 'cold-install', outcome, reason: 'reason' }] })
    ).toThrow()
  }
})
test('legacy stage ledger validates runtime shapes before using typed fields', () => {
  for (const value of [
    null,
    [],
    {},
    { sourceCommit, entries: {} },
    { sourceCommit, entries: [], fakePass: true },
    { sourceCommit: 12, entries: [] },
    { sourceCommit, entries: [null] },
  ]) {
    expect(() => validate(value)).toThrow()
  }
})
test('arrays and primitives cannot be used to bypass byte-accounting validation', () => {
  for (const bytes of [[], null, '', 0, true])
    expect(() =>
      validate({
        sourceCommit,
        entries: [{ stage: 'distribution', outcome: 'measured', durationMs: 1, bytes }],
      })
    ).toThrow()
})
test('unknown stage fields and non-string reasons fail rather than influence evidence', () => {
  expect(() =>
    validate({
      sourceCommit,
      entries: [{ stage: 'cold-install', outcome: 'failed', reason: {}, pass: true }],
    })
  ).toThrow()
  expect(() =>
    validate({ sourceCommit, entries: [{ stage: 'cold-install', outcome: 'failed', reason: 2 }] })
  ).toThrow()
  expect(() =>
    validate({
      sourceCommit,
      entries: [{ stage: 'cold-install', outcome: 'unsupported', reason: '   ' }],
    })
  ).toThrow()
})
