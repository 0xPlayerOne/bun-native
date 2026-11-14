/** Verify and summarize a completed same-runner paired-host comparison. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import {
  assertEquivalentPaint,
  assertEquivalentWorkloads,
  bootstrapMedian,
  describe,
  type Labeled,
} from './stats.ts'

type Variant = 'baseline' | 'candidate'
type Fingerprint = { sha256: string; bytes: number }
type Entry = {
  name: string
  variant: Variant
  trial: number
  nonce: string
  hostSha256: string
  artifactSha256: string
  status: string
  process: { exitCode: number; wallMs: number; spawnEpochMs: number }
  report: Fingerprint
}
type Run = {
  status: string
  nativeHost: Fingerprint
  pairedHost: Fingerprint
  pairedDiagnostics: Entry[]
  builds: { core: { aot: Fingerprint & { inspection: { hasCompiledProgram: boolean } } } }
  calibrations: Calibration[]
  pairedCalibration: Calibration & { hostSha256: string }
  loadAverageBeforeLaunch?: Record<string, string>
}
type Calibration = {
  name: string
  report: Fingerprint
  nativeEvidence: Fingerprint
  initial: unknown
  final: unknown
}
type Child = Record<string, unknown> & {
  status: string
  adapter: string
  declaredMode: string
  bunRevision: string
  nonce: string
  executable: string
  startup: Record<string, number>
  cleanup: unknown
  phases: Record<string, { acknowledgement: { samplesMs: unknown; count: unknown } }>
}
type LaunchMetrics = {
  wallMs: number
  spawnToReadyMs: number
  spawnToMountedMs: number
  entryToReadyMs: number
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

function verifyCalibration(directory: string, calibration: Calibration) {
  let nonce: string | undefined
  for (const [suffix, fingerprint] of [
    ['json', calibration.report],
    ['jsonl', calibration.nativeEvidence],
  ] as const) {
    const bytes = boundedFile(join(directory, `${calibration.name}.${suffix}`))
    assert.equal(bytes.length, fingerprint?.bytes, 'Calibration size mismatch')
    assert.equal(
      createHash('sha256').update(bytes).digest('hex'),
      fingerprint?.sha256,
      'Calibration hash mismatch'
    )
    if (suffix === 'json') {
      const child = JSON.parse(bytes.toString('utf8'))
      assert.equal(child.status, 'passed', 'Calibration did not pass')
      assert.equal(child.adapter, 'core', 'Wrong calibration adapter')
      assert.equal(child.declaredMode, 'aot', 'Wrong calibration mode')
      assert(typeof child.nonce === 'string' && child.nonce.length > 0, 'Missing calibration nonce')
      nonce = child.nonce
      assert.deepEqual(child.initialNativePaint, calibration.initial, 'Initial calibration changed')
      assert.deepEqual(child.finalNativePaint, calibration.final, 'Final calibration changed')
    } else {
      const rows = bytes.toString('utf8').trimEnd().split('\n')
      assert(
        rows.length > 0 && rows.every((line) => JSON.parse(line).nonce === nonce),
        'Calibration evidence nonce differs'
      )
    }
  }
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
  const app = record.builds?.core?.aot
  assert(app?.inspection?.hasCompiledProgram === true, 'AOT compiled program not verified')
  assert(/^[0-9a-f]{64}$/.test(app.sha256), 'Missing AOT artifact hash')
  const candidateCalibration = record.calibrations?.find(
    (item) => item.name === 'core-aot-calibration'
  )
  const baselineCalibration = record.pairedCalibration
  assert(
    candidateCalibration && baselineCalibration?.name === 'core-aot-paired-baseline-calibration',
    'Missing paired calibrations'
  )
  assert.equal(baselineCalibration.hostSha256, baseline.sha256, 'Wrong baseline calibration host')
  verifyCalibration(directory, candidateCalibration)
  verifyCalibration(directory, baselineCalibration)
  assertEquivalentPaint([candidateCalibration, baselineCalibration])
  const entries = record.pairedDiagnostics
  assert(
    Array.isArray(entries) &&
      entries.length >= 6 &&
      entries.length <= 40 &&
      entries.length % 2 === 0,
    'Incomplete paired launches'
  )
  const pairs: Pair[] = []
  let reference: Labeled | undefined
  let bunRevision: string | undefined
  let executable: string | undefined
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
      assert.equal(
        entry.hostSha256,
        variant === 'baseline' ? baseline.sha256 : candidate.sha256,
        'Wrong host fingerprint'
      )
      assert.equal(entry.artifactSha256, app.sha256, 'AOT artifact changed')
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
      assert(
        typeof report.executable === 'string' && isAbsolute(report.executable),
        'Missing executable'
      )
      if (executable) assert.equal(report.executable, executable, 'Executable changed')
      else executable = report.executable
      assert(typeof entry.nonce === 'string' && entry.nonce.length > 0)
      assert.equal(report.nonce, entry.nonce, 'Child nonce differs')
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
      const labeled: Labeled = { name, adapter: 'core', mode: 'aot', report }
      if (reference) assertEquivalentWorkloads([reference, labeled])
      else reference = labeled
      const phases: Record<string, ReturnType<typeof metrics>> = {}
      for (const phase of ['signals', 'coalesced', 'keyedRotations']) {
        const ack = report.phases?.[phase]?.acknowledgement
        phases[phase] = metrics(ack?.samplesMs, ack?.count)
      }
      const startup = report.startup
      const names = [
        'timeOriginEpochMs',
        'workloadEntryMs',
        'applicationReadyMs',
        'windowOpenedMs',
        'viewMountedMs',
      ]
      assert(
        startup &&
          names.every(
            (name) => typeof startup[name] === 'number' && Number.isFinite(startup[name])
          ),
        'Missing startup milestones'
      )
      const [origin, start, ready, window, mounted] = names.map((name) => startup[name]!)
      assert(
        start! <= ready! && ready! <= window! && window! <= mounted!,
        'Startup milestones are out of order'
      )
      assert(Number.isFinite(entry.process.spawnEpochMs), 'Missing spawn time')
      const spawnToReadyMs = origin! - entry.process.spawnEpochMs + ready!
      const spawnToMountedMs = origin! - entry.process.spawnEpochMs + mounted!
      assert(spawnToReadyMs > 0 && spawnToMountedMs >= spawnToReadyMs, 'Invalid startup interval')
      pair[variant] = {
        wallMs: entry.process.wallMs,
        spawnToReadyMs,
        spawnToMountedMs,
        entryToReadyMs: ready! - start!,
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
      spawnToReadyMs: bootstrapMedian(
        pairs.map((pair) => pair.candidate!.spawnToReadyMs - pair.baseline!.spawnToReadyMs)
      ),
      spawnToMountedMs: bootstrapMedian(
        pairs.map((pair) => pair.candidate!.spawnToMountedMs - pair.baseline!.spawnToMountedMs)
      ),
      entryToReadyMs: bootstrapMedian(
        pairs.map((pair) => pair.candidate!.entryToReadyMs - pair.baseline!.entryToReadyMs)
      ),
    },
    pairedRatio: {
      meaning:
        'Candidate divided by baseline within each pair; bootstrap assumes independent pairs.',
      spawnToReady: bootstrapMedian(
        pairs.map((pair) => pair.candidate!.spawnToReadyMs / pair.baseline!.spawnToReadyMs)
      ),
      spawnToMounted: bootstrapMedian(
        pairs.map((pair) => pair.candidate!.spawnToMountedMs / pair.baseline!.spawnToMountedMs)
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
          spawnToReadyMs: describe(pairs.map((pair) => pair[variant]!.spawnToReadyMs)),
          spawnToMountedMs: describe(pairs.map((pair) => pair[variant]!.spawnToMountedMs)),
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
