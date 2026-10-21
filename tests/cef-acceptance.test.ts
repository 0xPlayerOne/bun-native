import { expect, test } from 'bun:test'
import { acceptNativeSmoke, acceptNativeRejection } from '../benchmarks/lib/cef-acceptance.ts'
import type { CommandObservation } from '../benchmarks/lib/observed-command.ts'
const clean = (): CommandObservation => ({
  exitCode: 0,
  timedOut: false,
  cancelled: false,
  cleanupSurvivors: [],
  outputOverflow: false,
  observedOrphans: [],
  elapsedMs: 1,
  peakTreeRssBytes: 1,
  peakTreeThreads: 1,
  stdoutTail: [],
  samples: [],
  environment: { classification: 'synthetic-unit-input-not-native-evidence' },
  stderr: [
    JSON.stringify({
      event: 'bunly.native.smoke',
      passed: true,
      cycles: 20,
      timers: 2,
      diagnostics: { windows: 1, views: 1, sessions: 1 },
    }),
    JSON.stringify({ event: 'bunly.backend.exit', code: 0, forced: false }),
    JSON.stringify({ event: 'bunly.host.shutdown', clean: true }),
  ],
})
test('native smoke needs workload, converged ownership and acknowledged clean shutdown', () => {
  expect(() => acceptNativeSmoke(clean())).not.toThrow()
  for (let index = 0; index < 3; index++) {
    const report = clean()
    expect(() =>
      acceptNativeSmoke({ ...report, stderr: report.stderr.filter((_, i) => i !== index) })
    ).toThrow()
  }
  expect(() =>
    acceptNativeSmoke({
      ...clean(),
      stderr: [...clean().stderr, JSON.stringify({ event: 'bunly.host.failure' })],
    })
  ).toThrow()
})
test('native workload cannot hide observer failure, a forced backend or wrong cycle count', () => {
  for (const change of [
    { timedOut: true },
    { cancelled: true },
    { cleanupSurvivors: [1] },
    { observedOrphans: [1] },
    { outputOverflow: true },
    { exitCode: 1 },
  ])
    expect(() => acceptNativeSmoke({ ...clean(), ...change })).toThrow()
  for (const [from, to] of [
    ['"cycles":20', '"cycles":0'],
    ['"forced":false', '"forced":true'],
    ['"windows":1', '"windows":2'],
  ]) {
    expect(() =>
      acceptNativeSmoke({
        ...clean(),
        stderr: clean().stderr.map((line) => line.replace(from!, to!)),
      })
    ).toThrow()
  }
})
test('startup rejection must be the intended native error, not any crash', () => {
  const report = {
    ...clean(),
    exitCode: 78,
    stderr: [
      JSON.stringify({ event: 'bunly.host.error', error: 'Unsafe command-line override denied' }),
    ],
  }
  expect(() => acceptNativeRejection(report, 'Unsafe command-line')).not.toThrow()
  expect(() => acceptNativeRejection(report, 'Missing helper')).toThrow()
  expect(() => acceptNativeRejection({ ...report, exitCode: -9 }, 'Unsafe command-line')).toThrow()
})

test('native qualification cannot relabel a standard or unreported deadline profile', () => {
  expect(() => acceptNativeSmoke(clean(), 'emulated-functional')).toThrow('deadline profile')
  const report = clean()
  const smoke = JSON.parse(report.stderr[0]!)
  smoke.diagnostics.deadlineProfile = 'standard'
  const standard = { ...report, stderr: [JSON.stringify(smoke), ...report.stderr.slice(1)] }
  expect(() => acceptNativeSmoke(standard, 'standard')).not.toThrow()
  expect(() => acceptNativeSmoke(standard, 'emulated-functional')).toThrow('deadline profile')
  smoke.diagnostics.deadlineProfile = 'emulated-functional'
  expect(() =>
    acceptNativeSmoke(
      { ...report, stderr: [JSON.stringify(smoke), ...report.stderr.slice(1)] },
      'emulated-functional'
    )
  ).not.toThrow()
})
