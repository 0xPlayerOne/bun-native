import { expect, test } from 'bun:test'
import {
  evaluateBudgets,
  regressionBudget,
  type RegressionBudget,
} from '../benchmarks/lib/regression-budgets.ts'
import { compareRuns, reportRun, type BenchmarkRun } from '../benchmarks/lib/results.ts'
function run(values = [10, 10, 10, 10]): BenchmarkRun {
  return {
    schema: 1,
    createdAt: '2026-10-17T00:00:00Z',
    fixtureSha256: 'a'.repeat(64),
    seed: 1,
    repetitions: values.length,
    warmups: 0,
    scenarios: ['stream'],
    parameters: { bytes: 1024, iterations: 4 },
    sourceCommit: 'b'.repeat(40),
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
    variants: [
      {
        id: 'v',
        framework: 'fixture',
        version: '1',
        sourceCommit: 'c'.repeat(40),
        runtime: 'fixture',
        runtimeVersion: '1',
        engine: 'chromium',
        engineVersion: '1',
        securityProfile: 'fixture',
        configuration: 'default',
      },
    ],
    trials: values.map((value, trial) => ({
      variant: 'v',
      scenario: 'stream',
      trial,
      warmup: false,
      status: 'passed',
      reason: 'Synthetic fixture',
      correctness: { passed: true, details: 'Synthetic checksum' },
      metrics: { latency: { value, unit: 'ms' } },
    })),
  }
}
const budget: RegressionBudget = {
  scenario: 'stream',
  metric: 'latency',
  unit: 'ms',
  statistic: 'mean',
  direction: 'lower',
  maxRegressionPercent: 10,
  minimumSamples: 4,
}
test('configured latency regressions fail instead of producing a passing report', () => {
  expect(evaluateBudgets(run(), run([20, 20, 20, 20]), 'v', 'v', [budget]).status).toBe('failed')
  expect(evaluateBudgets(run(), run([9, 9, 9, 9]), 'v', 'v', [budget]).status).toBe('passed')
})
test('tail budgets catch a spike masked by a mean-only result', () => {
  const before = run([10, 10, 10, 10]),
    after = run([1, 1, 1, 36])
  expect(evaluateBudgets(before, after, 'v', 'v', [budget]).status).toBe('passed')
  expect(evaluateBudgets(before, after, 'v', 'v', [{ ...budget, statistic: 'p99' }]).status).toBe(
    'failed'
  )
})
test('higher-is-better budgets use the correct sign', () => {
  const result = evaluateBudgets(run(), run([5, 5, 5, 5]), 'v', 'v', [
    { ...budget, direction: 'higher' },
  ])
  expect(result.status).toBe('failed')
  expect(result.checks[0]?.regressionPercent).toBe(50)
})
test('zero baselines require explicit absolute budgets', () => {
  const before = run([0, 0, 0, 0])
  expect(evaluateBudgets(before, run(), 'v', 'v', [budget]).status).toBe('ineligible')
  expect(
    evaluateBudgets(before, run(), 'v', 'v', [{ ...budget, maxAbsoluteRegression: 1 }]).status
  ).toBe('failed')
  expect(
    evaluateBudgets(before, before, 'v', 'v', [{ ...budget, maxAbsoluteRegression: 0 }]).status
  ).toBe('passed')
})
test('undersampled and smoke runs remain ineligible', () => {
  expect(evaluateBudgets(run([10]), run([10]), 'v', 'v', [budget]).status).toBe('ineligible')
  const smoke = run()
  smoke.environment.runClass = 'local-smoke'
  expect(evaluateBudgets(smoke, smoke, 'v', 'v', [budget]).status).toBe('ineligible')
})
test('failed warmups cannot be hidden by passing measured trials', () => {
  const value = run()
  value.warmups = 1
  value.trials.push({
    ...value.trials[0]!,
    warmup: true,
    status: 'failed',
    correctness: { passed: false, details: 'Failed fixture' },
    metrics: {},
  })
  expect(evaluateBudgets(value, value, 'v', 'v', [budget]).status).toBe('ineligible')
})
test('object insertion order does not change equivalent workload identity', () => {
  const a = run(),
    b = run()
  b.parameters = { iterations: 4, bytes: 1024 }
  b.environment = Object.fromEntries(
    Object.entries(b.environment).reverse()
  ) as unknown as BenchmarkRun['environment']
  expect(compareRuns(a, b, 'v', 'v').comparable).toBe(true)
})
test('extra or missing metric coverage blocks comparison in both directions', () => {
  const a = run(),
    b = run()
  for (const row of b.trials) row.metrics['memory'] = { value: 100, unit: 'bytes' }
  expect(compareRuns(a, b, 'v', 'v').comparable).toBe(false)
  expect(compareRuns(b, a, 'v', 'v').comparable).toBe(false)
})
test('uncommitted harness source cannot qualify a performance claim', () => {
  const a = run()
  a.sourceCommit = 'local-uncommitted'
  expect(reportRun(a)[0]?.eligibleForPerformanceClaim).toBe(false)
  expect(compareRuns(a, a, 'v', 'v').comparable).toBe(false)
})
test('runtime-only benchmarks require no invented browser version', () => {
  const a = run()
  a.variants[0]!.engine = 'none'
  a.variants[0]!.engineVersion = null
  expect(compareRuns(a, a, 'v', 'v').comparable).toBe(true)
  const b = run()
  expect(compareRuns(a, b, 'v', 'v').comparable).toBe(false)
})
test('unknown selectors and incompatible units cannot silently skip budgets', () => {
  expect(() =>
    evaluateBudgets(run(), run(), 'v', 'v', [{ ...budget, scenario: 'absent' }])
  ).toThrow('scenario')
  expect(() => evaluateBudgets(run(), run(), 'v', 'v', [{ ...budget, unit: 'bytes' }])).toThrow(
    'metric'
  )
})
test('invalid, empty and duplicate budget policies fail validation', () => {
  for (const value of [
    { ...budget, maxRegressionPercent: -1 },
    { ...budget, minimumSamples: 1 },
    { ...budget, unknown: true },
    { ...budget, statistic: 'maximum' },
  ])
    expect(() => regressionBudget(value)).toThrow()
  expect(() => evaluateBudgets(run(), run(), 'v', 'v', [])).toThrow('nonempty')
  expect(() => evaluateBudgets(run(), run(), 'v', 'v', [budget, budget])).toThrow('Duplicate')
})
