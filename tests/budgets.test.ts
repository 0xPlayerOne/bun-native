import { test, expect } from 'bun:test'
import { validateStageLedger, evaluateBudgets, STAGES } from '../benchmarks/lib/budgets.ts'
import type { BenchmarkRun } from '../benchmarks/lib/results.ts'
const sourceCommit = 'a'.repeat(40)
test('stage ledger preserves unsupported and failed work without invented zeros', () => {
  const entries = STAGES.map((stage) => ({
    stage,
    outcome: 'unsupported' as const,
    reason: 'not implemented',
  }))
  expect(validateStageLedger({ sourceCommit, entries }).entries.length).toBe(STAGES.length)
  expect(() =>
    validateStageLedger({
      sourceCommit,
      entries: [{ stage: 'cold-install', outcome: 'unsupported', reason: 'no', durationMs: 0 }],
    })
  ).toThrow()
  expect(() =>
    validateStageLedger({ sourceCommit, entries: [{ stage: 'cold-install', outcome: 'measured' }] })
  ).toThrow()
  expect(() => validateStageLedger({ sourceCommit, entries: [entries[0]!, entries[0]!] })).toThrow()
})
test('bytes cannot be conflated with time or reported on unsupported stages', () => {
  expect(
    validateStageLedger({
      sourceCommit,
      entries: [
        {
          stage: 'distribution',
          outcome: 'measured',
          durationMs: 0,
          bytes: { installed: 1, compressedInstaller: 2, firstRunDownload: 3, cache: 4, update: 5 },
        },
      ],
    }).entries
  ).toHaveLength(1)
  expect(() =>
    validateStageLedger({
      sourceCommit,
      entries: [
        { stage: 'app-assembly', outcome: 'measured', durationMs: 1, bytes: { installed: 2 } },
      ],
    })
  ).toThrow()
  expect(() =>
    validateStageLedger({
      sourceCommit,
      entries: [
        { stage: 'distribution', outcome: 'measured', durationMs: 1, bytes: { installed: 1.5 } },
      ],
    })
  ).toThrow()
})
function run(): BenchmarkRun {
  return {
    schema: 1,
    createdAt: '2026-10-17T00:00:00Z',
    fixtureSha256: 'a'.repeat(64),
    seed: 7,
    repetitions: 2,
    warmups: 0,
    scenarios: ['terminal'],
    parameters: { count: 10 },
    sourceCommit,
    environment: {
      runClass: 'controlled',
      target: 'linux-x64',
      os: 'linux',
      cpu: 'cpu',
      logicalCpus: 2,
      memoryBytes: 1024,
      gpu: 'gpu',
      display: 'display',
      power: 'ac',
      machineLabel: 'rig',
    },
    variants: [
      {
        id: 'a',
        framework: 'fixture',
        version: '1',
        sourceCommit,
        runtime: 'Bun',
        runtimeVersion: '1.4.4',
        engine: 'cef',
        engineVersion: '100',
        securityProfile: 'sandbox-verified',
        configuration: 'default',
      },
    ],
    trials: [0, 1].map((trial) => ({
      variant: 'a',
      scenario: 'terminal',
      trial,
      warmup: false,
      status: 'passed',
      reason: 'complete',
      correctness: { passed: true, details: 'checksum' },
      metrics: { latency: { value: 10, unit: 'ms' } },
    })),
  }
}
test('regression budgets measure changes only for eligible equivalent runs', () => {
  const a = run()
  const b = structuredClone(a)
  b.trials.forEach((t) => {
    t.metrics.latency!.value = 13
  })
  const goal = [
    { scenario: 'terminal', metric: 'latency', unit: 'ms' as const, maxIncreasePercent: 20 },
  ]
  expect(evaluateBudgets(a, b, 'a', 'a', goal).checks[0]?.passed).toBe(false)
  b.trials.forEach((t) => {
    t.metrics.latency!.value = 9
  })
  expect(evaluateBudgets(a, b, 'a', 'a', goal).checks[0]?.passed).toBe(true)
  b.environment.runClass = 'ci-smoke'
  expect(evaluateBudgets(a, b, 'a', 'a', goal).comparable).toBe(false)
})
test('unknown and duplicate budgets fail closed', () => {
  const a = run()
  const goal = {
    scenario: 'terminal',
    metric: 'latency',
    unit: 'ms' as const,
    maxIncreasePercent: 10,
  }
  expect(() => evaluateBudgets(a, a, 'a', 'a', [])).toThrow()
  expect(() => evaluateBudgets(a, a, 'a', 'a', [goal, goal])).toThrow()
  expect(() => evaluateBudgets(a, a, 'a', 'a', [{ ...goal, metric: 'rss' }])).toThrow()
})
