import { expect, test } from 'bun:test'
import { referenceTrialComplete } from '../benchmarks/lib/reference-completion.ts'
const trial = () => ({
  result: { passed: true },
  idle: {
    observed: true,
    kernel: { status: 'observed' },
    sampleCount: 120,
    sampledDurationMs: 4950,
  },
})
test('successful app and measured idle interval qualify the collector', () => {
  expect(referenceTrialComplete(trial())).toBe(true)
})
test('collector failure cannot inherit a successful app result', () => {
  expect(referenceTrialComplete({ ...trial(), failed: 'idle reduction failed' })).toBe(false)
})
test('missing or incomplete idle evidence is not a successful trial', () => {
  expect(referenceTrialComplete({ result: { passed: true } })).toBe(false)
  for (const change of [
    { observed: false },
    { sampleCount: 0 },
    { sampledDurationMs: 100 },
    { sampledDurationMs: NaN },
    { kernel: { status: 'unavailable' } },
  ])
    expect(referenceTrialComplete({ ...trial(), idle: { ...trial().idle, ...change } })).toBe(false)
})
test('malformed records and application failure remain failures', () => {
  for (const value of [null, 0, [], {}, { idle: trial().idle, result: { passed: false } }])
    expect(referenceTrialComplete(value)).toBe(false)
})
