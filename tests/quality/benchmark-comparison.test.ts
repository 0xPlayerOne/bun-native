import { expect, test } from 'bun:test'
import {
  assertEquivalentPaint,
  assertEquivalentWorkloads,
  bootstrapMedian,
  bootstrapMedianRatio,
  describe as describeSamples,
  median,
  nearestRank,
  summarize,
  summarizeInputLatency,
  type InputLaunch,
  type Launch,
} from '../../benchmarks/comparison/stats.ts'

const cleanup = {
  windows: 0,
  nodes: 0,
  callbacks: 0,
  queuedTransactions: 0,
  queuedCallbacks: 0,
  activeCallbacks: 0,
  serviceRequests: 0,
}

function report(scale = 1, overrides: Record<string, unknown> = {}) {
  const samples = (count: number) => Array.from({ length: count }, (_, i) => scale * (1 + (i % 7)))
  return {
    status: 'passed',
    workload: { iterations: 10, rotations: 5, mounts: 2, rows: 4, warmup: 20 },
    phases: {
      signals: {
        acknowledgement: { count: 10, samplesMs: samples(10) },
        mutations: { create: 0, set: 10, insert: 0, remove: 0 },
      },
      coalesced: {
        acknowledgement: { count: 1, samplesMs: samples(1) },
        mutations: { create: 0, set: 1, insert: 0, remove: 0 },
      },
      keyedRotations: {
        acknowledgement: { count: 5, samplesMs: samples(5) },
        mutations: { create: 0, set: 0, insert: 5, remove: 0 },
      },
    },
    lifecycles: {
      count: 2,
      samplesMs: samples(2),
      rowsCreated: 8,
      rowsDisposed: 8,
      acknowledgedUpdates: 2,
      retainedWeakRefObjects: 6,
    },
    retentionObservation: { stillReachable: [] },
    cleanup,
    totalWorkloadMs: 100 * scale,
    startup: {
      timeOriginEpochMs: 1_000_010,
      workloadEntryMs: 20 * scale,
      applicationReadyMs: 40 * scale,
      windowOpenedMs: 60 * scale,
      viewMountedMs: 80 * scale,
    },
    ...overrides,
  }
}

function launch(
  adapter: string,
  mode: string,
  trial: number,
  data: Record<string, unknown>,
  status: Launch['status'] = 'passed'
): Launch {
  return {
    name: `${adapter}-${mode}-${trial}`,
    adapter,
    mode,
    trial,
    warmup: trial === 0,
    status,
    report: data,
    process: {
      spawnEpochMs: 1_000_000,
      wallMs: 500,
      exitCode: status === 'passed' ? 0 : 1,
      peakTreeRssBytes: 300,
      peakApplicationRssBytes: 100,
      peakHostRssBytes: 200,
      rssSamples: 10,
    },
  }
}

test('quantiles use nearest rank and the median averages the middle pair', () => {
  expect(nearestRank([1, 2, 3, 4, 5], 0.95)).toBe(5)
  expect(nearestRank([1, 2, 3, 4, 5], 0.5)).toBe(3)
  expect(nearestRank([], 0.5)).toBeNull()
  expect(median([4, 1, 3, 2])).toBe(2.5)
  const described = describeSamples(Array.from({ length: 100 }, (_, i) => i + 1))
  expect(described).toMatchObject({ count: 100, min: 1, max: 100, p95: 95, p99: 99, median: 50.5 })
  expect(() => describeSamples([1, Number.NaN])).toThrow()
})

test('bootstrap intervals are deterministic and bracket the estimate', () => {
  const values = [10, 11, 12, 13, 14, 15, 30]
  const first = bootstrapMedian(values)
  expect(bootstrapMedian(values)).toEqual(first)
  expect(first.estimate).toBe(13)
  expect(first.low!).toBeLessThanOrEqual(13)
  expect(first.high!).toBeGreaterThanOrEqual(13)
  expect(bootstrapMedian([1, 2])).toMatchObject({ low: null, high: null, resamples: 0 })
  const ratio = bootstrapMedianRatio([20, 22, 24, 26], [10, 11, 12, 13])
  expect(ratio.estimate).toBeCloseTo(2, 5)
  expect(ratio.low!).toBeGreaterThan(1)
})

test('equivalent workloads are accepted regardless of timings', () => {
  expect(() =>
    assertEquivalentWorkloads([
      { adapter: 'core', mode: 'aot', name: 'a', report: report(1) },
      { adapter: 'react', mode: 'development', name: 'b', report: report(3) },
    ])
  ).not.toThrow()
})

for (const [label, change] of [
  ['parameters', { workload: { iterations: 20, rotations: 5, mounts: 2, rows: 4, warmup: 20 } }],
  [
    'native mutations',
    {
      phases: {
        ...report().phases,
        coalesced: {
          acknowledgement: { count: 1, samplesMs: [1] },
          mutations: { create: 0, set: 10, insert: 0, remove: 0 },
        },
      },
    },
  ],
  ['lifecycle ownership', { lifecycles: { ...report().lifecycles, rowsDisposed: 7 } }],
  ['retention', { retentionObservation: { stillReachable: [3] } }],
  ['cleanup', { cleanup: { ...cleanup, nodes: 1 } }],
] as const) {
  test(`unequal ${label} are rejected`, () => {
    expect(() =>
      assertEquivalentWorkloads([
        { adapter: 'core', mode: 'aot', name: 'a', report: report() },
        { adapter: 'solid', mode: 'aot', name: 'b', report: report(1, change) },
      ])
    ).toThrow(/Unequal workloads rejected/)
  })
}

test('a report without phase samples cannot define the workload', () => {
  expect(() =>
    assertEquivalentWorkloads([{ adapter: 'core', mode: 'aot', name: 'a', report: {} }])
  ).toThrow(/cannot define/)
})

test('calibrated native trees and renderer identity must match', () => {
  const paint = (text: string, adapter = 'llvmpipe') => ({
    renderer: { type: 'renderer', nonce: crypto.randomUUID(), adapter },
    paint: { nodes: [{ node_id: 1, text }] },
  })
  const same = { initial: paint('a'), final: paint('b') }
  expect(() =>
    assertEquivalentPaint([
      { name: 'x', ...same },
      { name: 'y', initial: paint('a'), final: paint('b') },
    ])
  ).not.toThrow()
  expect(() =>
    assertEquivalentPaint([
      { name: 'x', ...same },
      { name: 'y', initial: paint('a'), final: paint('c') },
    ])
  ).toThrow(/native tree differs/)
  expect(() =>
    assertEquivalentPaint([
      { name: 'x', ...same },
      { name: 'y', initial: paint('a', 'other GPU'), final: paint('b', 'other GPU') },
    ])
  ).toThrow(/renderer differs/)
})

test('summaries keep first launches and failures separate from measured distributions', () => {
  const launches = [
    launch('core', 'aot', 0, report(5)),
    ...[1, 2, 3].map((trial) => launch('core', 'aot', trial, report(1))),
    ...[1, 2, 3].map((trial) => launch('core', 'development', trial, report(2))),
    launch('core', 'development', 4, { status: 'failed' }, 'failed'),
  ]
  const summary = summarize(launches)
  const aot = summary.groups['core/aot'] as Record<string, any>
  expect(aot.measured).toBe(3)
  expect(aot.firstLaunchAfterBuild.spawnToViewMountedMs).toBe(10 + 400)
  expect(aot.perLaunch.spawnToViewMountedMs.median).toBe(10 + 80)
  expect(aot.perLaunch.peakTreeRssBytes.median).toBe(300)
  expect(aot.pooledOperationSamplesMs.signals.count).toBe(30)
  const development = summary.groups['core/development'] as Record<string, any>
  expect(development.failed).toEqual(['core-development-4'])
  expect(development.measured).toBe(3)
  const ratio = summary.comparisons.find(
    (item) => item['candidate'] === 'core/aot' && item['reference'] === 'core/development'
  ) as Record<string, any>
  expect(ratio.medianRatio.totalWorkloadMs.estimate).toBeCloseTo(0.5, 5)
})

test('summaries reject a measured launch that performed different work', () => {
  const launches = [
    ...[1, 2, 3].map((trial) => launch('core', 'aot', trial, report())),
    launch('solid', 'aot', 1, report(1, { lifecycles: { ...report().lifecycles, count: 3 } })),
  ]
  expect(() => summarize(launches)).toThrow(/Unequal workloads rejected/)
})

test('input latency summaries count one sample per passed launch and exclude failures', () => {
  const input = (
    adapter: string,
    mode: string,
    trial: number,
    latency: number | null,
    status: InputLaunch['status'] = 'passed'
  ): InputLaunch => ({
    name: `${adapter}-${mode}-input-${trial}`,
    adapter,
    mode,
    trial,
    status,
    commandStartToPaintObservedMs: latency,
    error: status === 'failed' ? 'driver failed' : null,
  })
  const summary = summarizeInputLatency([
    ...[1, 2, 3].map((trial) => input('core', 'development', trial, 10 * trial)),
    ...[1, 2, 3].map((trial) => input('core', 'aot', trial, 5 * trial)),
    input('core', 'aot', 4, 999, 'failed'),
    ...[1, 2, 3].map((trial) => input('solid', 'aot', trial, 15 * trial)),
  ])
  const aot = summary.groups['core/aot'] as Record<string, any>
  expect(aot.launches).toBe(4)
  expect(aot.passed).toBe(3)
  expect(aot.failed).toEqual(['core-aot-input-4'])
  expect(aot.commandStartToPaintObservedMs).toMatchObject({ count: 3, median: 10, max: 15 })
  expect(aot.commandStartToPaintObservedMs.medianInterval.resamples).toBe(2000)
  const ratio = (candidate: string, reference: string) =>
    (
      summary.comparisons.find(
        (item) => item['candidate'] === candidate && item['reference'] === reference
      ) as Record<string, any>
    ).medianRatio.estimate
  expect(ratio('core/aot', 'core/development')).toBeCloseTo(0.5, 5)
  expect(ratio('solid/aot', 'core/aot')).toBeCloseTo(3, 5)
  expect(summary.comparisons.some((item) => item['candidate'] === 'solid/development')).toBe(false)
})
