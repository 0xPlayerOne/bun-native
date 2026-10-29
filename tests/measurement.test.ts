import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { quantile, summarize, schedule } from '../benchmarks/lib/statistics.ts'
import {
  validateRun,
  reportRun,
  compareRuns,
  type BenchmarkRun,
} from '../benchmarks/lib/results.ts'
import { inventory } from '../benchmarks/lib/inventory.ts'
function fixture(): BenchmarkRun {
  return {
    schema: 1,
    createdAt: '2026-10-17T00:00:00Z',
    fixtureSha256: 'a'.repeat(64),
    seed: 42,
    repetitions: 2,
    warmups: 0,
    scenarios: ['stream'],
    parameters: { count: 256 },
    sourceCommit: 'c'.repeat(40),
    environment: {
      runClass: 'controlled',
      target: 'test',
      os: 'test',
      cpu: 'fixture',
      logicalCpus: 2,
      memoryBytes: 1024,
      gpu: 'fixture',
      display: 'fixture',
      power: 'ac',
      machineLabel: 'fixture-machine',
    },
    variants: [
      {
        id: 'a',
        framework: 'fixture',
        version: '1',
        sourceCommit: 'b'.repeat(40),
        runtime: 'fixture',
        runtimeVersion: '1',
        engine: 'fixture',
        engineVersion: '1',
        securityProfile: 'isolated',
        configuration: 'default',
      },
    ],
    trials: [0, 1].map((trial) => ({
      variant: 'a',
      scenario: 'stream',
      trial,
      warmup: false,
      status: 'passed',
      reason: 'fixture',
      correctness: { passed: true, details: 'bytes verified' },
      metrics: { latency: { value: 10 + trial, unit: 'ms' } },
    })),
  }
}
test('quantiles and deterministic confidence summaries', () => {
  assert.equal(quantile([1, 2, 3, 4], 0.5), 2.5)
  assert.deepEqual(summarize([1, 2, 3, 4], 42), summarize([1, 2, 3, 4], 42))
  assert.equal(summarize([7]).meanBootstrap95, null)
  assert.throws(() => summarize([NaN]))
})
test('seeded schedules are repeatable, balanced, and have no missing trials', () => {
  const plan = schedule(['a', 'b', 'c'], 5, 42)
  assert.deepEqual(plan, schedule(['a', 'b', 'c'], 5, 42))
  for (const id of ['a', 'b', 'c']) assert.equal(plan.filter((row) => row.variant === id).length, 5)
  assert.throws(() => schedule(['a', 'a'], 5, 1))
})
test('rejects missing/duplicate trials and false correctness wins', () => {
  const missing = fixture()
  missing.trials.pop()
  assert.throws(() => validateRun(missing), /Incomplete/)
  const duplicate = fixture()
  duplicate.trials[1]!.trial = 0
  assert.throws(() => validateRun(duplicate), /Duplicate/)
  const dropped = fixture()
  dropped.trials[0]!.correctness.passed = false
  assert.throws(() => validateRun(dropped), /incorrect/)
})
test('unsupported scenarios never acquire zero-time performance results', () => {
  const run = fixture()
  const row = run.trials[0]!
  row.status = 'unsupported'
  row.metrics = {}
  row.reason = 'not implemented'
  assert.equal(reportRun(run)[0]!.unsupported, 1)
  row.metrics = { latency: { value: 0, unit: 'ms' } }
  assert.throws(() => validateRun(run), /Unsupported/)
})
test('comparison detects injected latency and memory regressions', () => {
  const a = fixture()
  const b = fixture()
  for (const row of a.trials) row.metrics['memory'] = { value: 1000, unit: 'bytes' }
  for (const row of b.trials) {
    row.metrics['latency']!.value *= 2
    row.metrics['memory'] = { value: 2000, unit: 'bytes' }
  }
  const result = compareRuns(a, b, 'a', 'a')
  assert.equal(result.comparable, true)
  for (const row of result.changes) assert.equal(row.changePercent, 100)
})
test('comparison refuses smoke results, different engines, and missing metadata', () => {
  const a = fixture()
  const b = fixture()
  b.environment.runClass = 'ci-smoke'
  assert.equal(compareRuns(a, b, 'a', 'a').comparable, false)
  b.environment = { ...a.environment }
  b.variants[0]!.engineVersion = null
  assert.equal(compareRuns(a, b, 'a', 'a').comparable, false)
})
test('inventory identifies seeded payload duplication without calling it RAM', async () => {
  const root = await mkdtemp(join(tmpdir(), 'bunly-inventory-'))
  try {
    await mkdir(join(root, 'nested'))
    await writeFile(join(root, 'one'), 'payload')
    await writeFile(join(root, 'nested/two'), 'payload')
    const result = await inventory(root)
    assert.equal(result.bytes, 14)
    assert.equal(result.duplicateContent.length, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Electrobun retains oversized failure evidence while the result remains failed', async () => {
  const { recordElectrobunFailure } = await import('../benchmarks/adapters/electrobun/failure.ts')
  const directory = await mkdtemp(join(tmpdir(), 'bunly-electrobun-failure-'))
  try {
    const details = 'orphan observation ' + 'x'.repeat(10_000)
    const failed = await recordElectrobunFailure(directory, 'stream', 0, false, new Error(details))
    const file = failed.reason.match(/electrobun-failure-[a-f0-9-]+\.json$/)?.[0]
    assert.ok(file)
    const evidence = JSON.parse(await Bun.file(join(directory, file)).text())
    assert.equal(evidence.error, 'Error: ' + details)
    assert.deepEqual([evidence.scenario, evidence.trial, evidence.warmup], ['stream', 0, false])
    const run = fixture()
    failed.variant = 'a'
    run.trials[0] = failed
    assert.equal(validateRun(run).trials[0]!.status, 'failed')
    assert.equal(run.trials[0]!.correctness.passed, false)
    assert.deepEqual(run.trials[0]!.metrics, {})
    assert.equal(reportRun(run)[0]!.failed, 1)
    assert.equal(reportRun(run)[0]!.eligibleForPerformanceClaim, false)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
