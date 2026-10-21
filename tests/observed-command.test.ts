import { expect, test } from 'bun:test'
import {
  validateCommandObservation,
  assertCleanCommand,
  observationsPermitFixtureRemoval,
  observedCommand,
} from '../benchmarks/lib/observed-command.ts'
const input = () => ({
  schema: 1,
  exitCode: 0,
  timedOut: false,
  cancelled: false,
  outputOverflow: false,
  cleanupSurvivors: [],
  observedOrphans: [],
  elapsedMs: 1,
  peakTreeRssBytes: 1,
  peakTreeThreads: 1,
  stdoutTail: [],
  stderr: [],
  samples: [],
  environment: { fixture: true },
})
test('process observations reject unknown or incomplete outcome data', () => {
  expect(() => validateCommandObservation(input())).not.toThrow()
  for (const extra of [
    { exitCode: null },
    { timedOut: undefined },
    { cancelled: 'no' },
    { elapsedMs: NaN },
    { cleanupSurvivors: null },
    { observedOrphans: [-1] },
  ]) {
    expect(() => validateCommandObservation({ ...input(), ...extra })).toThrow()
  }
})
test('timed-out, cancelled, orphaning and overflowing commands never validate clean', () => {
  for (const extra of [
    { timedOut: true },
    { cancelled: true },
    { outputOverflow: true },
    { observedOrphans: [1] },
    { cleanupSurvivors: [1] },
    { exitCode: 1 },
  ]) {
    expect(() => assertCleanCommand(validateCommandObservation({ ...input(), ...extra }))).toThrow()
  }
})
test('process identity and diagnostic shapes are bounded', () => {
  for (const extra of [
    { samples: [{ processes: [{ pid: 0 }] }] },
    { stdoutTail: [null] },
    { stderr: Array.from({ length: 41 }, () => 'x') },
    { environment: [] },
  ]) {
    expect(() => validateCommandObservation({ ...input(), ...extra })).toThrow()
  }
})

test('fixture deletion requires positive child cleanup evidence', () => {
  const clean = validateCommandObservation(input())
  expect(observationsPermitFixtureRemoval([])).toBe(true)
  expect(observationsPermitFixtureRemoval([clean])).toBe(true)
  expect(observationsPermitFixtureRemoval([clean, null])).toBe(false)
  expect(observationsPermitFixtureRemoval([{ ...clean, cleanupSurvivors: [123] }])).toBe(false)
  // An orphan remains a trial failure even if it has since been reaped.
  expect(observationsPermitFixtureRemoval([{ ...clean, observedOrphans: [123] }])).toBe(true)
})
test('invalid redaction configuration is rejected before process execution', () => {
  expect(() =>
    observedCommand([process.execPath, '-e', 'throw 1'], {
      cwd: import.meta.dir,
      output: 'never-written.json',
      redact: ['invalid-token'],
    })
  ).toThrow('Invalid redaction credential')
})

test('observation nonce is a bounded identity rather than arbitrary report text', () => {
  expect(() =>
    validateCommandObservation({ ...input(), observationId: 'a'.repeat(48) })
  ).not.toThrow()
  for (const observationId of [1, null, '', 'bad', 'a'.repeat(49)]) {
    expect(() => validateCommandObservation({ ...input(), observationId })).toThrow()
  }
})
