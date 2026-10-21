import { test, expect } from 'bun:test'
import { compareRuns, reportRun, type BenchmarkRun } from '../benchmarks/lib/results.ts'
function fixture(): BenchmarkRun {
  return {
    schema: 1,
    createdAt: '2026-10-17T00:00:00Z',
    sourceCommit: 'a'.repeat(40),
    fixtureSha256: 'b'.repeat(64),
    seed: 42,
    repetitions: 2,
    warmups: 1,
    scenarios: ['launch'],
    parameters: { workload: 'fixture' },
    variants: [
      {
        id: 'test',
        framework: 'test',
        version: '1',
        sourceCommit: 'c'.repeat(40),
        runtime: 'fixture',
        runtimeVersion: '1',
        engine: 'fixture',
        engineVersion: '1',
        securityProfile: 'isolated',
        configuration: 'default',
      },
    ],
    environment: {
      runClass: 'controlled',
      target: 'fixture',
      os: 'fixture',
      cpu: 'fixture',
      logicalCpus: 2,
      memoryBytes: 1024,
      gpu: 'fixture',
      display: 'fixture',
      power: 'AC',
      machineLabel: 'fixture',
    },
    trials: [
      { trial: 0, warmup: true },
      { trial: 0, warmup: false },
      { trial: 1, warmup: false },
    ].map((item) => ({
      ...item,
      variant: 'test',
      scenario: 'launch',
      status: 'passed',
      reason: 'test',
      correctness: { passed: true, details: 'verified' },
      metrics: { launch: { value: 10, unit: 'ms' } },
    })),
  }
}
test('failed warmups remain visible and prevent false performance eligibility', () => {
  const baseline = fixture()
  const result = fixture()
  result.trials[0]!.status = 'failed'
  result.trials[0]!.correctness.passed = false
  result.trials[0]!.metrics = {}
  const row = reportRun(result)[0]!
  expect(row.passed).toBe(2)
  expect(row.failed).toBe(0)
  expect(row.warmups.failed).toBe(1)
  expect(row.eligibleForPerformanceClaim).toBe(false)
  expect(compareRuns(baseline, result, 'test', 'test').reasons).toContain(
    'Failed or unsupported warmup coverage'
  )
})
test('unsupported warmups cannot be hidden by complete measured repetitions', () => {
  const result = fixture()
  result.trials[0]!.status = 'unsupported'
  result.trials[0]!.metrics = {}
  expect(reportRun(result)[0]!.warmups.unsupported).toBe(1)
  expect(compareRuns(result, result, 'test', 'test').comparable).toBe(false)
})
test('compound unverified security profiles are not accepted as verified', () => {
  const result = fixture()
  result.variants[0]!.securityProfile = 'rpc-disabled+cef-process-sandbox-unverified'
  expect(reportRun(result)[0]!.eligibleForPerformanceClaim).toBe(false)
  expect(compareRuns(result, result, 'test', 'test').comparable).toBe(false)
})
test('missing engine identity and incomplete hardware also block standalone claims', () => {
  const result = fixture()
  result.variants[0]!.engineVersion = null
  expect(reportRun(result)[0]!.eligibleForPerformanceClaim).toBe(false)
  result.variants[0]!.engineVersion = '1'
  result.environment.gpu = 'unknown'
  expect(reportRun(result)[0]!.eligibleForPerformanceClaim).toBe(false)
  result.environment.gpu = 'fixture'
  expect(reportRun(result)[0]!.eligibleForPerformanceClaim).toBe(true)
  expect(compareRuns(result, result, 'test', 'test').comparable).toBe(true)
})
