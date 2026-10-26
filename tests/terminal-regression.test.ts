import { test, expect } from 'bun:test'
import {
  compareTerminalCaptures,
  terminalReviewEnvelope,
  validateTerminalCapture,
} from '../benchmarks/lib/terminal-regression.ts'
import { capture } from './fixtures/terminal-review-capture.ts'
test('measured review envelopes use independent launches and retain descriptive uncertainty', () => {
  const data = capture(),
    envelope = terminalReviewEnvelope(data)
  expect(envelope.launchesPerMode).toBe(5)
  expect(envelope.modes).toHaveLength(4)
  expect(envelope.modes[0]!.metrics.controlP95Ms!.count).toBe(5)
  expect(envelope.modes[0]!.metrics.controlP95Ms!.mean).toBe(12)
  expect(envelope.classification).toContain('not-a-release-threshold')
  expect(envelope.limits.join(' ')).toContain('not a memory-plateau')
  const same = compareTerminalCaptures(data, data)
  expect(same.reviewRequired).toBe(false)
  expect(same.releaseApproved).toBe(false)
  expect(same.comparisons.every((row) => row.assessment === 'overlapping-uncertainty')).toBe(true)
})
test('adverse non-overlapping shifts trigger review, not an invented fixed millisecond threshold', () => {
  const result = compareTerminalCaptures(capture(), capture(30))
  expect(result.reviewRequired).toBe(true)
  expect(
    result.comparisons
      .filter((row) => row.metric === 'controlP95Ms')
      .every((row) => row.assessment === 'review-adverse-shift')
  ).toBe(true)
  expect(
    result.comparisons
      .filter((row) => row.metric === 'throughputBytesPerSecond')
      .every((row) => row.assessment === 'overlapping-uncertainty')
  ).toBe(true)
  const faster = structuredClone(capture())
  for (const row of faster.samples)
    (row.metrics as Record<string, number>).throughputBytesPerSecond =
      row.metrics.throughputBytesPerSecond + 1000
  expect(
    compareTerminalCaptures(capture(), faster)
      .comparisons.filter((row) => row.metric === 'throughputBytesPerSecond')
      .every((row) => row.assessment === 'observed-favorable-shift')
  ).toBe(true)
  const slower = structuredClone(capture())
  for (const row of slower.samples)
    (row.metrics as Record<string, number>).throughputBytesPerSecond =
      row.metrics.throughputBytesPerSecond / 2
  expect(compareTerminalCaptures(capture(), slower).reviewRequired).toBe(true)
})
test('functional-only or incomplete sample matrices cannot establish a measured envelope', () => {
  const original = capture()
  const one = { ...original, samples: original.samples.filter((row) => row.index === 0) }
  validateTerminalCapture(one)
  expect(() => terminalReviewEnvelope(one)).toThrow('five independent')
  for (const samples of [
    original.samples.slice(1),
    [...original.samples.slice(0, -1), original.samples[0]!],
    original.samples.map((row, i) => (i === 0 ? { ...row, index: 99 } : row)),
    original.samples.map((row, i) =>
      i === 0 ? { ...row, observationSha256: original.samples[1]!.observationSha256 } : row
    ),
  ])
    expect(() => validateTerminalCapture({ ...original, samples })).toThrow()
})
test('invalid metric availability and malformed profile identities fail closed', () => {
  for (const invalid of [null, undefined, NaN, Infinity, -1, false, '0']) {
    const value = structuredClone(capture())
    ;(value.samples[0]!.metrics as unknown as Record<string, unknown>).treeCpuPercentOfOneCore =
      invalid
    expect(() => validateTerminalCapture(value)).toThrow()
  }
  for (const mutation of [
    (value: Record<string, unknown>) => {
      value.adapter = 'electron'
    },
    (value: Record<string, unknown>) => {
      value.reportSha256 = 'claimed'
    },
    (value: Record<string, unknown>) => {
      value.source = 'main'
    },
    (value: Record<string, unknown>) => {
      value.samples = []
    },
  ]) {
    const value = structuredClone(capture()) as unknown as Record<string, unknown>
    mutation(value)
    expect(() => validateTerminalCapture(value)).toThrow()
  }
})
test('engine, environment and workload-source changes require deliberate requalification', () => {
  for (const field of ['workload', 'runtime', 'environment', 'workloadSources'] as const) {
    const changed = structuredClone(capture())
    ;(changed.context as unknown as Record<string, unknown>)[field] = {
      ...(changed.context[field] as Record<string, unknown>),
      newField: 'changed',
    }
    expect(() => compareTerminalCaptures(capture(), changed)).toThrow()
  }
  const shortened = structuredClone(capture())
  ;(shortened.context.workload as { phases: { batches: number }[] }).phases[2]!.batches = 1
  expect(() => validateTerminalCapture(shortened)).toThrow()
})
