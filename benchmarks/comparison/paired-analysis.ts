/** Verify and summarize a completed same-runner paired-host comparison. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { assertEquivalentWorkloads, bootstrapMedian, describe, type Labeled } from './stats.ts'

type Variant = 'baseline' | 'candidate'
type Fingerprint = { sha256: string; bytes: number }
type Entry = {
  name: string
  variant: Variant
  trial: number
  status: string
  process: { exitCode: number; wallMs: number }
  report: Fingerprint
}
type Run = {
  status: string
  nativeHost: Fingerprint
  pairedHost: Fingerprint
  pairedDiagnostics: Entry[]
  loadAverageBeforeLaunch?: Record<string, string>
}
type Child = Record<string, unknown> & {
  status: string
  adapter: string
  declaredMode: string
  bunRevision: string
  cleanup: unknown
  workload: { iterations: number; rotations: number; mounts: number }
  lifecycles: { count: number }
  retentionObservation: { stillReachable: unknown[] }
  phases: Record<string, { acknowledgement: { samplesMs: unknown; count: unknown } }>
}
type LaunchMetrics = {
  wallMs: number
  phases: Record<string, ReturnType<typeof metrics>>
  load: string | null
}
type Pair = { trial: number; order: Variant[] } & Partial<Record<Variant, LaunchMetrics>>

function metrics(samples: unknown, count: unknown) {
  assert(
    Array.isArray(samples) && samples.length > 0 && samples.length === count,
    'Incomplete samples'
  )
  assert(
    samples.every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0),
    'Invalid samples'
  )
  const sorted = [...samples].sort((a: number, b: number) => a - b) as number[]
  return {
    count: sorted.length,
    medianMs: describe(sorted)!.median!,
    p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1]!,
    slowAtLeast10Ms: sorted.filter((n) => n >= 10).length,
  }
}

function boundedFile(path: string): Buffer {
  const stat = statSync(path)
  assert(stat.isFile() && stat.size <= 4_194_304, 'Report exceeds size limit')
  const bytes = readFileSync(path)
  assert.equal(bytes.length, stat.size, 'Report changed while reading')
  return bytes
}

/** Fail closed on missing, altered, reordered, incomplete or unequal launches. */
export function analyzePairedRun(directory: string) {
  assert(isAbsolute(directory), 'Run directory must be absolute')
  const record = JSON.parse(boundedFile(join(directory, 'comparison.json')).toString('utf8')) as Run
  assert.equal(record.status, 'passed', 'Comparison did not pass')
  const candidate = record.nativeHost
  const baseline = record.pairedHost
  assert(/^[0-9a-f]{64}$/.test(candidate?.sha256 ?? ''), 'Missing candidate host hash')
  assert(/^[0-9a-f]{64}$/.test(baseline?.sha256 ?? ''), 'Missing baseline host hash')
  assert.notEqual(candidate.sha256, baseline.sha256, 'Host binaries are identical')
  const entries = record.pairedDiagnostics
  assert(
    Array.isArray(entries) &&
      entries.length >= 6 &&
      entries.length <= 20 &&
      entries.length % 2 === 0,
    'Incomplete paired launches'
  )
  const pairs: Pair[] = []
  let reference: Labeled | undefined
  let bunRevision: string | undefined
  for (let trial = 1; trial <= entries.length / 2; trial++) {
    const expected: Variant[] = trial % 2 ? ['baseline', 'candidate'] : ['candidate', 'baseline']
    const pair: Pair = { trial, order: expected }
    for (let index = 0; index < 2; index++) {
      const entry = entries[(trial - 1) * 2 + index]!
      const variant = expected[index]!
      const name = `core-aot-paired-${variant}-${trial}`
      assert.equal(entry.name, name, 'Unexpected paired launch order')
      assert.equal(entry.variant, variant)
      assert.equal(entry.trial, trial)
      assert.equal(entry.status, 'passed')
      assert.equal(entry.process?.exitCode, 0)
      assert(
        typeof entry.process?.wallMs === 'number' &&
          Number.isFinite(entry.process.wallMs) &&
          entry.process.wallMs > 0
      )
      const bytes = boundedFile(join(directory, 'launches', `${name}.json`))
      assert(
        bytes.length <= 4_194_304 && bytes.length === entry.report?.bytes,
        'Child report size mismatch'
      )
      assert.equal(
        createHash('sha256').update(bytes).digest('hex'),
        entry.report?.sha256,
        'Child report hash mismatch'
      )
      const report = JSON.parse(bytes.toString('utf8')) as Child
      assert.equal(report.status, 'passed')
      assert.equal(report.adapter, 'core')
      assert.equal(report.declaredMode, 'aot')
      assert(typeof report.bunRevision === 'string' && report.bunRevision.length > 0)
      if (bunRevision) assert.equal(report.bunRevision, bunRevision, 'Bun revision changed')
      else bunRevision = report.bunRevision
      assert.deepEqual(report.cleanup, {
        windows: 0,
        nodes: 0,
        callbacks: 0,
        queuedTransactions: 0,
        queuedCallbacks: 0,
        activeCallbacks: 0,
        serviceRequests: 0,
      })
      const { iterations, rotations, mounts } = report.workload ?? {}
      assert(
        Number.isSafeInteger(iterations) && iterations > 0 && iterations % 10 === 0,
        'Invalid workload iterations'
      )
      assert(Number.isSafeInteger(rotations) && rotations > 0, 'Invalid workload rotations')
      assert(
        Number.isSafeInteger(mounts) && mounts > 0 && report.lifecycles?.count === mounts,
        'Invalid lifecycle count'
      )
      assert(
        Array.isArray(report.retentionObservation?.stillReachable) &&
          report.retentionObservation.stillReachable.length === 0,
        'Retained lifecycle probes'
      )
      const labeled: Labeled = { name, adapter: 'core', mode: 'aot', report }
      if (reference) assertEquivalentWorkloads([reference, labeled])
      else reference = labeled
      const phases: Record<string, ReturnType<typeof metrics>> = {}
      for (const phase of ['signals', 'coalesced', 'keyedRotations']) {
        const ack = report.phases?.[phase]?.acknowledgement
        phases[phase] = metrics(ack?.samplesMs, ack?.count)
      }
      assert.equal(phases.signals!.count, iterations, 'Signal count differs from workload')
      assert.equal(
        phases.coalesced!.count,
        iterations / 10,
        'Coalesced count differs from workload'
      )
      assert.equal(phases.keyedRotations!.count, rotations, 'Rotation count differs from workload')
      pair[variant] = {
        wallMs: entry.process.wallMs,
        phases,
        load: record.loadAverageBeforeLaunch?.[name] ?? null,
      }
    }
    pairs.push(pair)
  }
  return {
    candidateHost: candidate.sha256,
    baselineHost: baseline.sha256,
    trials: pairs.length,
    note: 'Each pair is one fresh process per host; acknowledgement is not input or display presentation.',
    pairs,
    pairedDelta: {
      meaning:
        'Candidate minus baseline per pair; bootstrap assumes independent pairs and does not remove temporal or runner bias.',
      signalMedianMs: bootstrapMedian(
        pairs.map(
          (pair) =>
            pair.candidate!.phases.signals!.medianMs - pair.baseline!.phases.signals!.medianMs
        )
      ),
      signalP95Ms: bootstrapMedian(
        pairs.map(
          (pair) => pair.candidate!.phases.signals!.p95Ms - pair.baseline!.phases.signals!.p95Ms
        )
      ),
      signalSlowCount: bootstrapMedian(
        pairs.map(
          (pair) =>
            pair.candidate!.phases.signals!.slowAtLeast10Ms -
            pair.baseline!.phases.signals!.slowAtLeast10Ms
        )
      ),
      processWallMs: bootstrapMedian(
        pairs.map((pair) => pair.candidate!.wallMs - pair.baseline!.wallMs)
      ),
    },
    summary: Object.fromEntries(
      (['baseline', 'candidate'] as const).map((variant) => [
        variant,
        {
          signalMedianMs: describe(pairs.map((pair) => pair[variant]!.phases.signals!.medianMs)),
          signalP95Ms: describe(pairs.map((pair) => pair[variant]!.phases.signals!.p95Ms)),
          signalSlowCount: describe(
            pairs.map((pair) => pair[variant]!.phases.signals!.slowAtLeast10Ms)
          ),
          processWallMs: describe(pairs.map((pair) => pair[variant]!.wallMs)),
        },
      ])
    ),
  }
}

if (import.meta.main) {
  const directory = process.argv[2]
  if (!directory) throw new Error('Usage: bun paired-analysis.ts ABSOLUTE_RUN_DIRECTORY')
  console.log(JSON.stringify(analyzePairedRun(directory), null, 2))
}
