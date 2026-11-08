import { expect, test } from 'bun:test'
import {
  assertEquivalentPaint,
  assertEquivalentWorkloads,
  bootstrapMedian,
  bootstrapMedianRatio,
  describe as describeSamples,
  median,
  nearestRank,
  cpuUtilization,
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
      cpuUserMs: 120,
      cpuSystemMs: 30,
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

test('finite large-magnitude samples retain finite mean and standard deviation', () => {
  const constant = describeSamples(Array.from({ length: 12 }, () => 1.5e308))
  expect(constant.mean).toBe(1.5e308)
  expect(constant.sampleStdDev).toBe(0)

  const spread = describeSamples([1e308, 1.5e308])
  expect(spread.mean).toBe(1.25e308)
  expect(spread.sampleStdDev! / 3.535533905932738e307).toBeCloseTo(1, 10)

  // Squaring first also overflows for a finite, representable signed deviation.
  const signed = describeSamples([-1e308, 1e308])
  expect(signed.mean).toBe(0)
  expect(signed.sampleStdDev! / 1.4142135623730951e308).toBeCloseTo(1, 10)
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

test('quantile fractions outside (0, 1] are rejected', () => {
  for (const fraction of [0, -0.5, 1.5, Number.NaN])
    expect(() => nearestRank([1, 2, 3], fraction)).toThrow(/Quantile fraction/)
  expect(nearestRank([1, 2, 3], 1)).toBe(3)
})

test('median ratios report no interval without three samples or a positive reference', () => {
  const unbounded = { low: null, high: null, resamples: 0, seed: 244 }
  expect(bootstrapMedianRatio([2, 4], [1, 2, 3])).toMatchObject({ estimate: 1.5, ...unbounded })
  expect(bootstrapMedianRatio([2, 4, 6], [1, 2])).toMatchObject({ estimate: 4 / 1.5, ...unbounded })
  expect(bootstrapMedianRatio([1, 2, 3], [0, 0, 0])).toMatchObject({
    estimate: null,
    ...unbounded,
  })
  expect(bootstrapMedianRatio([], [1, 2, 3])).toMatchObject({ estimate: null, ...unbounded })
})

test('a resampled zero reference median makes the ratio interval unbounded, not finite', () => {
  const ratio = bootstrapMedianRatio([1, 1, 1, 1], [0, 0, 5, 5])
  expect(ratio.estimate).toBeCloseTo(0.4, 5)
  expect(ratio.resamples).toBe(2000)
  expect(ratio.high).toBe(Number.POSITIVE_INFINITY)
  expect(Number.isFinite(ratio.low!)).toBe(true)
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

test('paint equivalence ignores renderer nonces and timings but needs a native tree', () => {
  const paint = (text: string, startedMs: number) => ({
    renderer: {
      nonce: crypto.randomUUID(),
      adapter: 'llvmpipe',
      startedMs,
      first_frame_ms: 2,
      time: 3,
    },
    paint: { nodes: [{ node_id: 1, text }] },
  })
  expect(() =>
    assertEquivalentPaint([
      { name: 'x', initial: paint('a', 1), final: paint('b', 2) },
      { name: 'y', initial: paint('a', 10), final: paint('b', 20) },
    ])
  ).not.toThrow()
  expect(() => assertEquivalentPaint([])).toThrow(/No calibrations/)
  expect(() =>
    assertEquivalentPaint([{ name: 'x', initial: paint('a', 1), final: { renderer: {} } }])
  ).toThrow(/x lacks a native paint tree/)
  expect(() =>
    assertEquivalentPaint([
      { name: 'x', initial: { paint: { nodes: 'none' } }, final: { paint: { nodes: 'none' } } },
    ])
  ).toThrow(/lacks a native paint tree/)
})

test('renderer runtime identity is not discarded as a timing field', () => {
  const paint = (runtime: string, startedMs: number) => ({
    renderer: {
      nonce: crypto.randomUUID(),
      type: 'renderer',
      runtime,
      startedMs,
      first_frame_ms: startedMs,
      time: startedMs,
    },
    paint: { nodes: [{ node_id: 1, text: 'same' }] },
  })
  const first = { name: 'gpui', initial: paint('GPUI', 1), final: paint('GPUI', 2) }
  const different = {
    name: 'headless',
    initial: paint('HEADLESS', 3),
    final: paint('HEADLESS', 4),
  }
  expect(() => assertEquivalentPaint([first, different])).toThrow(/renderer differs/)
  expect(() =>
    assertEquivalentPaint([
      first,
      { name: 'same', initial: paint('GPUI', 5), final: paint('GPUI', 6) },
    ])
  ).not.toThrow()
})

test('matching absent or volatile-only renderers cannot qualify native paint', () => {
  const paint = (identity: unknown) => ({
    renderer: identity,
    paint: { nodes: [{ node_id: 1, text: 'same' }] },
  })
  const calibrations = (identity: unknown) => [
    { name: 'first', initial: paint(identity), final: paint(identity) },
    { name: 'second', initial: paint(identity), final: paint(identity) },
  ]
  for (const identity of [undefined, {}, { nonce: 'one', time: 1, startedMs: 2 }])
    expect(() => assertEquivalentPaint(calibrations(identity))).toThrow(
      /lacks native renderer identity/
    )
  expect(() =>
    assertEquivalentPaint(calibrations({ type: 'renderer', gpu: { adapter: 'llvmpipe' } }))
  ).not.toThrow()
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
  expect(aot.perLaunch.cpuTimeMs.median).toBe(150)
  expect(aot.perLaunch.cpuSystemMs.median).toBe(30)
  expect(aot.perLaunch.cpuUtilization.median).toBeCloseTo(0.3, 10)
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

test('CPU utilization is CPU seconds per wall second and absent without usage', () => {
  const base = launch('core', 'aot', 1, report(1))
  expect(cpuUtilization(base)).toBeCloseTo(150 / 500, 10)
  expect(cpuUtilization({ ...base, process: { ...base.process, cpuUserMs: null } })).toBeNull()
  expect(cpuUtilization({ ...base, process: { ...base.process, cpuSystemMs: null } })).toBeNull()
  expect(cpuUtilization({ ...base, process: { ...base.process, wallMs: 0 } })).toBeNull()
  const unsupported = launch('core', 'aot', 1, report(1))
  delete unsupported.process.cpuUserMs
  delete unsupported.process.cpuSystemMs
  const summary = summarize([
    unsupported,
    launch('core', 'aot', 2, report(1)),
    launch('core', 'aot', 3, report(1)),
  ])
  const group = summary.groups['core/aot'] as Record<string, any>
  expect(group.perLaunch.cpuTimeMs.count).toBe(2)
})
