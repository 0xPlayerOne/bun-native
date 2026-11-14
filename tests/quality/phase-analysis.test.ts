import { expect, test } from 'bun:test'
import { analyzePhaseTrace } from '../../benchmarks/comparison/phase-analysis.ts'

function fixture() {
  const report = {
    status: 'passed',
    adapter: 'core',
    declaredMode: 'aot',
    workload: { rows: 2, warmup: 20, iterations: 3 },
    phases: {
      signals: {
        acknowledgement: { samplesMs: [0.2, 16.7, 0.4] },
        mutations: { create: 0, set: 3, insert: 0, remove: 0 },
      },
    },
  }
  const trace = {
    schemaVersion: 1,
    batchColumns: [
      'id',
      'windowId',
      'operations',
      'startedNanos',
      'prepareNanos',
      'applyNanos',
      'replyEnqueueNanos',
      'rendersBefore',
    ],
    droppedBatches: 0,
    foregroundColumns: ['id', 'readToForegroundNanos'],
    droppedForeground: 0,
    foreground: Array.from({ length: 24 }, (_, index) => [index + 3, 7000]),
    batches: Array.from({ length: 24 }, (_, index) => [
      index + 3,
      1,
      index === 0 ? 14 : 1,
      index * 100000,
      1000,
      2000,
      3000,
      0,
    ]),
  }
  return { report, trace }
}

test('aligns core signal acknowledgements with ordered native batches', () => {
  const { report, trace } = fixture()
  const result = analyzePhaseTrace(report, trace)
  expect(result.signalSamples).toBe(3)
  expect(result.slowAtLeast10Ms).toBe(1)
  expect(result.samples).toMatchObject([
    {
      index: 0,
      requestId: 24,
      acknowledgementMs: 0.2,
      hostMs: 0.006,
      previousHostGapMs: 0.094,
      rendersSincePrevious: 0,
    },
    {
      index: 1,
      requestId: 25,
      acknowledgementMs: 16.7,
      hostMs: 0.006,
      previousHostGapMs: 0.094,
      rendersSincePrevious: 0,
    },
    {
      index: 2,
      requestId: 26,
      acknowledgementMs: 0.4,
      hostMs: 0.006,
      previousHostGapMs: 0.094,
      rendersSincePrevious: 0,
    },
  ])
  expect(result.samples[1]).toMatchObject({
    readToForegroundMs: 0.007,
    prepareMs: 0.001,
    applyMs: 0.002,
    replyEnqueueMs: 0.003,
  })
})

test('rejects incomplete, reordered or incompatible records rather than misaligning samples', () => {
  for (const change of [
    (f: ReturnType<typeof fixture>) => (f.trace.droppedBatches = 1),
    (f: ReturnType<typeof fixture>) => (f.trace.droppedForeground = 1),
    (f: ReturnType<typeof fixture>) => f.trace.foreground.pop(),
    (f: ReturnType<typeof fixture>) => f.trace.foreground.push([24, 0]),
    (f: ReturnType<typeof fixture>) => f.trace.batches.pop(),
    (f: ReturnType<typeof fixture>) => (f.trace.batches[21]![0] = 999),
    (f: ReturnType<typeof fixture>) => (f.trace.batches[21]![3] = 2_000_001),
    (f: ReturnType<typeof fixture>) => (f.trace.batches[20]![7] = 2),
    (f: ReturnType<typeof fixture>) => (f.trace.batches[0]![2] = 13),
    (f: ReturnType<typeof fixture>) => (f.report.phases.signals.mutations.set = 2),
    (f: ReturnType<typeof fixture>) =>
      (f.report.phases.signals.acknowledgement.samplesMs[0] = Number.NaN),
    (f: ReturnType<typeof fixture>) => (f.report.declaredMode = 'development'),
  ]) {
    const f = fixture()
    change(f)
    expect(() => analyzePhaseTrace(f.report, f.trace)).toThrow()
  }
})
