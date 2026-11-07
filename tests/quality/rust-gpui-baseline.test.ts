import { expect, test } from 'bun:test'
import {
  expectedMutations,
  launchMetrics,
  reportProblem,
  summarizeBaseline,
  type BaselineLaunch,
  type Workload,
} from '../../benchmarks/rust-gpui/summary.ts'

const workload: Workload = { iterations: 20, rotations: 5, mounts: 3, rows: 4, paintSamples: 2 }

function phase(samples: number, mutations: object) {
  return {
    apply: { p50Ms: 0.001, samplesMs: Array(samples).fill(0.001) },
    turn: { p50Ms: 0.003, samplesMs: Array(samples).fill(0.003) },
    mutations,
  }
}

function report(overrides: Record<string, unknown> = {}) {
  const expected = expectedMutations(workload)
  return {
    schemaVersion: 1,
    baseline: 'rust-gpui',
    status: 'passed',
    workload: { ...workload, warmup: 20 },
    startup: {
      timeOriginEpochMs: 1_000_010,
      windowOpenedMs: 90,
      viewMountedMs: 91,
      firstPaintMs: 120,
    },
    phases: {
      signals: phase(20, expected.signals),
      coalesced: phase(2, expected.coalesced),
      keyedRotations: phase(5, expected.keyedRotations),
    },
    mutations: expected.total,
    finalPaint: { label: '1: Batched 9', rows: 4 },
    lifecycles: { p50Ms: 0.01, samplesMs: [0.01, 0.01, 0.01] },
    toPaint: { p50Ms: 16, samplesMs: [16, 16] },
    totalWorkloadMs: 150,
    ...overrides,
  }
}

function launch(name: string, first = false, extra: Partial<BaselineLaunch> = {}): BaselineLaunch {
  return {
    name,
    first,
    status: 'passed',
    error: null,
    exitCode: 0,
    spawnEpochMs: 1_000_000,
    wallMs: 200,
    cpuUserMs: 150,
    cpuSystemMs: 50,
    peakTreeRssBytes: 120e6,
    rssSamples: 9,
    report: report(),
    ...extra,
  }
}

test('expected mutations follow the shared workload counts', () => {
  expect(expectedMutations(workload).total).toEqual({
    create: 9 * 4,
    set: 20 + 20 + 2 + 2 + 3,
    insert: 9 * 4 + 5,
    remove: 4,
  })
  expect(expectedMutations({ ...workload, rows: 1 }).keyedRotations.insert).toBe(0)
})

test('a complete matched report passes', () => {
  expect(reportProblem(report(), workload)).toBeNull()
})

test('reports that did different work or did not paint are rejected', () => {
  expect(reportProblem(null, workload)).toBe('no report')
  expect(reportProblem(report({ baseline: 'other' }), workload)).toContain('not a rust-gpui')
  expect(reportProblem(report({ status: 'failed', error: 'boom' }), workload)).toContain('boom')
  expect(reportProblem(report({ workload: { ...workload, rows: 5 } }), workload)).toContain('rows')
  const bad = report()
  bad.phases.signals.mutations = { create: 0, set: 19, insert: 0, remove: 0 }
  expect(reportProblem(bad, workload)).toContain('signals mutations')
  const short = report()
  short.phases.coalesced.apply.samplesMs = [1]
  expect(reportProblem(short, workload)).toContain('coalesced sample count')
  expect(
    reportProblem(report({ mutations: { create: 0, set: 0, insert: 0, remove: 0 } }), workload)
  ).toContain('total')
  expect(reportProblem(report({ finalPaint: { label: 'Initial', rows: 4 } }), workload)).toContain(
    'final paint'
  )
  expect(reportProblem(report({ lifecycles: { p50Ms: 0, samplesMs: [] } }), workload)).toContain(
    'lifecycle'
  )
  expect(reportProblem(report({ toPaint: { p50Ms: null, samplesMs: [] } }), workload)).toContain(
    'toPaint'
  )
  const unpainted = report()
  unpainted.startup = { ...unpainted.startup, firstPaintMs: null as unknown as number }
  expect(reportProblem(unpainted, workload)).toBe('no first paint')
})

test('launch metrics are relative to the controller spawn and include CPU', () => {
  const metrics = launchMetrics(launch('trial-1'))
  expect(metrics['spawnToWindowOpenedMs']).toBe(100)
  expect(metrics['spawnToFirstPaintMs']).toBe(130)
  expect(metrics['cpuTimeMs']).toBe(200)
  expect(metrics['cpuUtilization']).toBe(1)
  expect(metrics['signalsApplyMedianMs']).toBe(0.001)
  expect(metrics['toPaintMedianMs']).toBe(16)
  expect(launchMetrics(launch('x', false, { cpuUserMs: null }))['cpuUtilization']).toBeNull()
})

test('the summary excludes the first launch and failed launches', () => {
  const summary = summarizeBaseline([
    launch('first', true),
    launch('trial-1'),
    launch('trial-2', false, { wallMs: 400 }),
    launch('trial-3'),
    launch('trial-4', false, { status: 'failed', error: 'exit 1', report: null }),
  ])
  expect(summary.measured).toBe(3)
  expect(summary.failed).toEqual(['trial-4'])
  expect(summary.firstLaunchAfterBuild?.['processWallMs']).toBe(200)
  expect(summary.perLaunch['processWallMs']?.median).toBe(200)
  expect(summary.perLaunch['processWallMs']?.medianInterval.low).not.toBeNull()
  expect(summarizeBaseline([]).firstLaunchAfterBuild).toBeNull()
})
