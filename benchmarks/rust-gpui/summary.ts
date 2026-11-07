// Validation and statistics for the direct Rust GPUI baseline (#244). The runner
// (`run.ts`) launches `native/gpui-host/examples/workload-baseline.rs`; this module
// checks each child report and summarizes launches with the same statistics as
// the Bun Native comparison (`benchmarks/comparison/stats.ts`).
import { bootstrapMedian, describe } from '../comparison/stats.ts'

export type Workload = {
  iterations: number
  rotations: number
  mounts: number
  rows: number
  paintSamples: number
}

export type BaselineLaunch = {
  name: string
  first: boolean
  status: 'passed' | 'failed'
  error: string | null
  exitCode: number | null
  spawnEpochMs: number
  wallMs: number
  cpuUserMs: number | null
  cpuSystemMs: number | null
  peakTreeRssBytes: number | null
  rssSamples: number
  report: Record<string, any> | null
}

const PHASES = ['signals', 'coalesced', 'keyedRotations'] as const

/** The mutation counts every passed report must show for this workload. */
export function expectedMutations({ iterations, rotations, mounts, rows, paintSamples }: Workload) {
  return {
    signals: { create: 0, set: iterations, insert: 0, remove: 0 },
    coalesced: { create: 0, set: iterations / 10, insert: 0, remove: 0 },
    keyedRotations: { create: 0, set: 0, insert: rows === 1 ? 0 : rotations, remove: 0 },
    total: {
      create: (rows + 5) * (mounts + 1),
      set: 20 + iterations + iterations / 10 + paintSamples + mounts,
      insert: (rows + 5) * (mounts + 1) + (rows === 1 ? 0 : rotations),
      remove: mounts + 1,
    },
  }
}

/**
 * Returns the reason a child report fails the matched workload, or null. A report
 * passes only when it ran the requested parameters, did exactly the expected
 * mutations and painted the expected final label and row count.
 */
export function reportProblem(report: unknown, workload: Workload): string | null {
  if (typeof report !== 'object' || report === null) return 'no report'
  const value = report as Record<string, any>
  if (value['schemaVersion'] !== 1 || value['baseline'] !== 'rust-gpui')
    return 'not a rust-gpui baseline report'
  if (value['status'] !== 'passed') return `child failed: ${value['error'] ?? 'unknown'}`
  for (const key of ['iterations', 'rotations', 'mounts', 'rows', 'paintSamples'] as const)
    if (value['workload']?.[key] !== workload[key])
      return `workload ${key} ${value['workload']?.[key]} != ${workload[key]}`
  const expected = expectedMutations(workload)
  for (const phase of PHASES) {
    const got = value['phases']?.[phase]?.mutations
    if (JSON.stringify(got) !== JSON.stringify(expected[phase]))
      return `${phase} mutations ${JSON.stringify(got)}`
    const samples = {
      signals: workload.iterations,
      coalesced: workload.iterations / 10,
      keyedRotations: workload.rotations,
    }[phase]
    if (value['phases'][phase].apply?.samplesMs?.length !== samples) return `${phase} sample count`
  }
  if (JSON.stringify(value['mutations']) !== JSON.stringify(expected.total))
    return `total mutations ${JSON.stringify(value['mutations'])}`
  const label = `${workload.iterations / 10 - 1}: Batched 9`
  if (value['finalPaint']?.label !== label || value['finalPaint']?.rows !== workload.rows)
    return 'final paint does not show the expected label and rows'
  if (value['lifecycles']?.samplesMs?.length !== workload.mounts) return 'lifecycle sample count'
  if (value['toPaint']?.samplesMs?.length !== workload.paintSamples) return 'toPaint sample count'
  if (typeof value['startup']?.firstPaintMs !== 'number') return 'no first paint'
  return null
}

function interval(samples: number[]) {
  const ci = bootstrapMedian(samples)
  return { ...describe(samples), medianInterval: { low: ci.low, high: ci.high } }
}

/** Per-launch metrics; startup milestones are relative to the controller's spawn. */
export function launchMetrics(launch: BaselineLaunch): Record<string, number | null> {
  const report = launch.report!
  const origin = report['startup']['timeOriginEpochMs'] - launch.spawnEpochMs
  const cpu =
    launch.cpuUserMs === null || launch.cpuSystemMs === null
      ? null
      : launch.cpuUserMs + launch.cpuSystemMs
  const metrics: Record<string, number | null> = {
    spawnToWindowOpenedMs: origin + report['startup']['windowOpenedMs'],
    spawnToViewMountedMs: origin + report['startup']['viewMountedMs'],
    spawnToFirstPaintMs: origin + report['startup']['firstPaintMs'],
    processWallMs: launch.wallMs,
    cpuTimeMs: cpu,
    cpuUtilization: cpu === null || !(launch.wallMs > 0) ? null : cpu / launch.wallMs,
    peakTreeRssBytes: launch.peakTreeRssBytes,
    totalWorkloadMs: report['totalWorkloadMs'],
    lifecycleMedianMs: report['lifecycles']['p50Ms'],
    toPaintMedianMs: report['toPaint']['p50Ms'],
  }
  for (const phase of PHASES) {
    metrics[`${phase}ApplyMedianMs`] = report['phases'][phase]['apply']['p50Ms']
    metrics[`${phase}TurnMedianMs`] = report['phases'][phase]['turn']['p50Ms']
  }
  return metrics
}

export function summarizeBaseline(launches: readonly BaselineLaunch[]) {
  const measured = launches.filter((launch) => !launch.first && launch.status === 'passed')
  const first = launches.find((launch) => launch.first && launch.status === 'passed')
  const perLaunch: Record<string, ReturnType<typeof interval>> = {}
  const rows = measured.map(launchMetrics)
  for (const key of Object.keys(rows[0] ?? {}))
    perLaunch[key] = interval(
      rows.map((row) => row[key]).filter((value): value is number => typeof value === 'number')
    )
  return {
    measured: measured.length,
    failed: launches.filter((launch) => launch.status === 'failed').map((launch) => launch.name),
    firstLaunchAfterBuild: first ? launchMetrics(first) : null,
    perLaunch,
  }
}
