import { isDeepStrictEqual } from 'node:util'

/** Deterministic PRNG so a recorded summary can be recomputed bit-for-bit. */
export function mulberry32(seed: number) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296
  }
}

function sorted(samples: readonly number[]) {
  for (const value of samples)
    if (!Number.isFinite(value)) throw new Error('Samples must be finite numbers')
  return [...samples].sort((a, b) => a - b)
}

/** Nearest-rank quantile of an ascending array; never interpolates. */
export function nearestRank(ascending: readonly number[], fraction: number) {
  if (ascending.length === 0) return null
  if (!(fraction > 0 && fraction <= 1)) throw new Error('Quantile fraction must be in (0, 1]')
  return ascending[Math.ceil(ascending.length * fraction) - 1]!
}

/** Median that averages the two middle values for an even count. */
export function median(samples: readonly number[]) {
  const values = sorted(samples)
  if (values.length === 0) return null
  const middle = values.length >> 1
  return values.length % 2 ? values[middle]! : (values[middle - 1]! + values[middle]!) / 2
}

export function describe(samples: readonly number[]) {
  const values = sorted(samples)
  const n = values.length
  const mean = n ? values.reduce((sum, value) => sum + value, 0) / n : null
  const variance =
    n > 1 ? values.reduce((sum, value) => sum + (value - mean!) ** 2, 0) / (n - 1) : null
  return {
    count: n,
    min: values[0] ?? null,
    median: median(values),
    mean,
    sampleStdDev: variance === null ? null : Math.sqrt(variance),
    p95: nearestRank(values, 0.95),
    p99: nearestRank(values, 0.99),
    max: values[n - 1] ?? null,
  }
}

export type Interval = {
  estimate: number | null
  low: number | null
  high: number | null
  confidence: number
  resamples: number
  seed: number
  method: string
}

/**
 * Percentile-bootstrap confidence interval for the median. With fewer than
 * three independent samples no interval is reported rather than a misleading one.
 */
export function bootstrapMedian(
  samples: readonly number[],
  { resamples = 2_000, confidence = 0.95, seed = 244 } = {}
): Interval {
  const values = sorted(samples)
  const method = 'percentile bootstrap of the median over independent samples'
  if (values.length < 3)
    return {
      estimate: median(values),
      low: null,
      high: null,
      confidence,
      resamples: 0,
      seed,
      method,
    }
  const random = mulberry32(seed)
  const medians: number[] = []
  const draw = Array.from<number>({ length: values.length })
  for (let index = 0; index < resamples; index++) {
    for (let item = 0; item < values.length; item++)
      draw[item] = values[Math.floor(random() * values.length)]!
    medians.push(median(draw)!)
  }
  medians.sort((a, b) => a - b)
  const tail = (1 - confidence) / 2
  return {
    estimate: median(values),
    low: medians[Math.floor(tail * (resamples - 1))]!,
    high: medians[Math.ceil((1 - tail) * (resamples - 1))]!,
    confidence,
    resamples,
    seed,
    method,
  }
}

/** Bootstrap interval for median(candidate) / median(reference), resampled independently. */
export function bootstrapMedianRatio(
  candidate: readonly number[],
  reference: readonly number[],
  { resamples = 2_000, confidence = 0.95, seed = 244 } = {}
): Interval {
  const a = sorted(candidate)
  const b = sorted(reference)
  const method = 'percentile bootstrap of median(candidate)/median(reference), independent groups'
  const point = a.length && b.length && median(b)! > 0 ? median(a)! / median(b)! : null
  if (a.length < 3 || b.length < 3 || point === null)
    return { estimate: point, low: null, high: null, confidence, resamples: 0, seed, method }
  const random = mulberry32(seed)
  const ratios: number[] = []
  const drawA = Array.from<number>({ length: a.length })
  const drawB = Array.from<number>({ length: b.length })
  for (let index = 0; index < resamples; index++) {
    for (let item = 0; item < a.length; item++) drawA[item] = a[Math.floor(random() * a.length)]!
    for (let item = 0; item < b.length; item++) drawB[item] = b[Math.floor(random() * b.length)]!
    const denominator = median(drawB)!
    ratios.push(denominator > 0 ? median(drawA)! / denominator : Number.POSITIVE_INFINITY)
  }
  ratios.sort((x, y) => x - y)
  const tail = (1 - confidence) / 2
  return {
    estimate: point,
    low: ratios[Math.floor(tail * (resamples - 1))]!,
    high: ratios[Math.ceil((1 - tail) * (resamples - 1))]!,
    confidence,
    resamples,
    seed,
    method,
  }
}

export const PHASES = ['signals', 'coalesced', 'keyedRotations'] as const

type Report = Record<string, unknown>

function field(value: unknown, path: readonly string[]): unknown {
  let current = value
  for (const key of path) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined
    current = (current as Record<string, unknown>)[key]
  }
  return current
}

/**
 * The work each child actually performed, independent of framework or timings.
 * Two reports are the same workload only when these signatures are identical.
 */
export function workloadSignature(report: Report) {
  return {
    workload: field(report, ['workload']),
    phases: Object.fromEntries(
      PHASES.map((phase) => [
        phase,
        {
          operations: field(report, ['phases', phase, 'acknowledgement', 'count']),
          mutations: field(report, ['phases', phase, 'mutations']),
        },
      ])
    ),
    lifecycles: {
      operations: field(report, ['lifecycles', 'count']),
      rowsCreated: field(report, ['lifecycles', 'rowsCreated']),
      rowsDisposed: field(report, ['lifecycles', 'rowsDisposed']),
      acknowledgedUpdates: field(report, ['lifecycles', 'acknowledgedUpdates']),
    },
    retention: {
      probes: field(report, ['lifecycles', 'retainedWeakRefObjects']),
      stillReachable: (field(report, ['retentionObservation', 'stillReachable']) as unknown[])
        ?.length,
    },
    cleanup: field(report, ['cleanup']),
  }
}

export type Labeled = { adapter: string; mode: string; name: string; report: Report }

/** Throws unless every passed report performed exactly the same native work. */
export function assertEquivalentWorkloads(reports: readonly Labeled[]) {
  if (reports.length === 0) throw new Error('No passed reports to compare')
  const reference = reports[0]!
  const expected = workloadSignature(reference.report)
  for (const phase of PHASES)
    if (typeof expected.phases[phase]?.operations !== 'number')
      throw new Error(`${reference.name} lacks ${phase} samples; it cannot define the workload`)
  const rejected = reports.filter(
    (item) => !isDeepStrictEqual(workloadSignature(item.report), expected)
  )
  if (rejected.length)
    throw new Error(
      `Unequal workloads rejected relative to ${reference.name}: ` +
        rejected
          .map((item) => `${item.name} ${JSON.stringify(workloadSignature(item.report))}`)
          .join('; ')
    )
  return expected
}

/** Native paint trees and renderer identity must match across every calibrated artifact. */
export function assertEquivalentPaint(
  calibrations: readonly { name: string; initial: unknown; final: unknown }[]
) {
  if (calibrations.length === 0) throw new Error('No calibrations to compare')
  const nodes = (paint: unknown) => field(paint, ['paint', 'nodes'])
  const renderer = (paint: unknown) => {
    const value = field(paint, ['renderer'])
    if (!value || typeof value !== 'object') return value
    // The nonce and timestamps differ by construction; the adapter must not.
    const { nonce: _nonce, ...rest } = value as Record<string, unknown>
    for (const key of Object.keys(rest)) if (/time|_ms$|Ms$/.test(key)) delete rest[key]
    return rest
  }
  const [first, ...rest] = calibrations
  for (const item of rest) {
    for (const stage of ['initial', 'final'] as const) {
      if (!isDeepStrictEqual(nodes(item[stage]), nodes(first![stage])))
        throw new Error(`${item.name} ${stage} native tree differs from ${first!.name}`)
      if (!isDeepStrictEqual(renderer(item[stage]), renderer(first![stage])))
        throw new Error(`${item.name} ${stage} renderer differs from ${first!.name}`)
    }
  }
  if (!Array.isArray(nodes(first!.initial)) || !Array.isArray(nodes(first!.final)))
    throw new Error(`${first!.name} lacks a native paint tree`)
}

export type Launch = {
  name: string
  adapter: string
  mode: string
  trial: number
  warmup: boolean
  status: 'passed' | 'failed'
  report?: Report
  process: {
    spawnEpochMs: number
    wallMs: number
    exitCode: number | null
    peakTreeRssBytes: number | null
    peakApplicationRssBytes: number | null
    peakHostRssBytes: number | null
    rssSamples: number
  }
}

function startupMetrics(launch: Launch) {
  const startup = field(launch.report, ['startup']) as Record<string, number> | undefined
  if (!startup) return null
  const origin = startup['timeOriginEpochMs']! - launch.process.spawnEpochMs
  return {
    spawnToRuntimeOriginMs: origin,
    spawnToWorkloadEntryMs: origin + startup['workloadEntryMs']!,
    spawnToApplicationReadyMs: origin + startup['applicationReadyMs']!,
    spawnToWindowOpenedMs: origin + startup['windowOpenedMs']!,
    spawnToViewMountedMs: origin + startup['viewMountedMs']!,
  }
}

function perLaunch(launch: Launch) {
  const report = launch.report!
  const metrics: Record<string, number | null> = {
    ...startupMetrics(launch),
    processWallMs: launch.process.wallMs,
    peakTreeRssBytes: launch.process.peakTreeRssBytes,
    peakApplicationRssBytes: launch.process.peakApplicationRssBytes,
    peakHostRssBytes: launch.process.peakHostRssBytes,
    totalWorkloadMs: field(report, ['totalWorkloadMs']) as number,
    lifecycleMedianMs: median(field(report, ['lifecycles', 'samplesMs']) as number[]),
  }
  for (const phase of PHASES)
    metrics[`${phase}AcknowledgementMedianMs`] = median(
      field(report, ['phases', phase, 'acknowledgement', 'samplesMs']) as number[]
    )
  return metrics
}

function groupKey(item: { adapter: string; mode: string }) {
  return `${item.adapter}/${item.mode}`
}

/**
 * Summarize measured launches. Each launch is the independent unit for intervals;
 * pooled raw operation samples are described but are not treated as independent.
 */
export function summarize(launches: readonly Launch[], { seed = 244 } = {}) {
  const passed = launches.filter((launch) => launch.status === 'passed' && launch.report)
  const signature = assertEquivalentWorkloads(
    passed.map((launch) => ({ ...launch, report: launch.report! }))
  )
  const groups = new Map<string, Launch[]>()
  for (const launch of launches) {
    const key = groupKey(launch)
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(launch)
  }
  const summary: Record<string, unknown> = {}
  const measuredByGroup = new Map<string, Record<string, number[]>>()
  for (const [key, items] of groups) {
    const ok = items.filter((launch) => launch.status === 'passed' && launch.report)
    const measured = ok.filter((launch) => !launch.warmup)
    const firstLaunch = ok.find((launch) => launch.warmup)
    const perMetric: Record<string, number[]> = {}
    for (const launch of measured)
      for (const [name, value] of Object.entries(perLaunch(launch)))
        if (typeof value === 'number') (perMetric[name] ??= []).push(value)
    measuredByGroup.set(key, perMetric)
    const pooled = Object.fromEntries(
      [...PHASES, 'lifecycles'].map((phase) => {
        const path =
          phase === 'lifecycles'
            ? ['lifecycles', 'samplesMs']
            : ['phases', phase, 'acknowledgement', 'samplesMs']
        return [
          phase,
          describe(measured.flatMap((launch) => (field(launch.report, path) as number[]) ?? [])),
        ]
      })
    )
    summary[key] = {
      launches: items.length,
      passed: ok.length,
      failed: items.filter((launch) => launch.status === 'failed').map((launch) => launch.name),
      measured: measured.length,
      firstLaunchAfterBuild: firstLaunch ? perLaunch(firstLaunch) : null,
      perLaunch: Object.fromEntries(
        Object.entries(perMetric).map(([name, values]) => [
          name,
          { ...describe(values), medianInterval: bootstrapMedian(values, { seed }) },
        ])
      ),
      pooledOperationSamplesMs: pooled,
    }
  }
  const comparisons: Record<string, unknown>[] = []
  const keys = [...measuredByGroup.keys()].sort()
  const pairs: [string, string][] = []
  for (const key of keys) {
    const [adapter, mode] = key.split('/') as [string, string]
    if (mode === 'aot' && measuredByGroup.has(`${adapter}/development`))
      pairs.push([key, `${adapter}/development`])
    if (adapter !== 'core' && measuredByGroup.has(`core/${mode}`)) pairs.push([key, `core/${mode}`])
  }
  for (const [candidate, reference] of pairs) {
    const a = measuredByGroup.get(candidate)!
    const b = measuredByGroup.get(reference)!
    comparisons.push({
      candidate,
      reference,
      medianRatio: Object.fromEntries(
        Object.keys(a)
          .filter((name) => b[name])
          .map((name) => [name, bootstrapMedianRatio(a[name]!, b[name]!, { seed })])
      ),
    })
  }
  return { equivalentWorkload: signature, groups: summary, comparisons }
}
