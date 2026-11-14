import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { analyzePairedRun } from '../../benchmarks/comparison/paired-analysis.ts'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'paired-analysis-'))
  mkdirSync(join(root, 'launches'))
  const paint = { renderer: { gpu: { name: 'test' } }, paint: { nodes: [{ id: 1 }] } }
  const calibration = (name: string) => {
    const report = JSON.stringify({
      status: 'passed',
      adapter: 'core',
      declaredMode: 'aot',
      nonce: 'calibration-nonce',
      initialNativePaint: paint,
      finalNativePaint: paint,
    })
    const evidence = '{"nonce":"calibration-nonce"}\n'
    writeFileSync(join(root, `${name}.json`), report)
    writeFileSync(join(root, `${name}.jsonl`), evidence)
    const hash = (value: string) => ({
      bytes: Buffer.byteLength(value),
      sha256: createHash('sha256').update(value).digest('hex'),
    })
    return {
      name,
      report: hash(report),
      nativeEvidence: hash(evidence),
      initial: paint,
      final: paint,
    }
  }
  const pairedDiagnostics = []
  for (let trial = 1; trial <= 3; trial++) {
    const order = trial % 2 ? ['baseline', 'candidate'] : ['candidate', 'baseline']
    for (const variant of order) {
      const name = `core-aot-paired-${variant}-${trial}`
      const ack = { count: 2, samplesMs: variant === 'baseline' ? [1, 20] : [1, 2] }
      const phase = { acknowledgement: ack, mutations: { set: 2 } }
      const report = {
        status: 'passed',
        adapter: 'core',
        declaredMode: 'aot',
        bunRevision: 'test-revision',
        executable: '/tmp/pinned-application',
        nonce: `${name}-nonce`,
        startup: {
          timeOriginEpochMs: 1000,
          workloadEntryMs: 1,
          applicationReadyMs: variant === 'baseline' ? 8 : 5,
          windowOpenedMs: 10,
          viewMountedMs: 12,
        },
        workload: { iterations: 2 },
        phases: { signals: phase, coalesced: phase, keyedRotations: phase },
        lifecycles: {
          count: 1,
          rowsCreated: 1,
          rowsDisposed: 1,
          acknowledgedUpdates: 1,
          retainedWeakRefObjects: 1,
        },
        retentionObservation: { stillReachable: [] },
        cleanup: {
          windows: 0,
          nodes: 0,
          callbacks: 0,
          queuedTransactions: 0,
          queuedCallbacks: 0,
          activeCallbacks: 0,
          serviceRequests: 0,
        },
      }
      const raw = JSON.stringify(report)
      writeFileSync(join(root, 'launches', `${name}.json`), raw)
      pairedDiagnostics.push({
        name,
        trial,
        variant,
        nonce: `${name}-nonce`,
        hostSha256: (variant === 'baseline' ? 'b' : 'a').repeat(64),
        artifactSha256: 'c'.repeat(64),
        status: 'passed',
        process: { exitCode: 0, wallMs: 10, spawnEpochMs: 999 },
        report: {
          bytes: Buffer.byteLength(raw),
          sha256: createHash('sha256').update(raw).digest('hex'),
        },
      })
    }
  }
  const record = {
    status: 'passed',
    nativeHost: { sha256: 'a'.repeat(64) },
    pairedHost: { sha256: 'b'.repeat(64) },
    builds: {
      core: { aot: { sha256: 'c'.repeat(64), bytes: 1, inspection: { hasCompiledProgram: true } } },
    },
    calibrations: [calibration('core-aot-calibration')],
    pairedCalibration: {
      ...calibration('core-aot-paired-baseline-calibration'),
      hostSha256: 'b'.repeat(64),
    },
    pairedDiagnostics,
  }
  writeFileSync(join(root, 'comparison.json'), JSON.stringify(record))
  return { root, record }
}

test('summarizes every pair and retains tail samples', () => {
  const { root } = fixture()
  try {
    const result = analyzePairedRun(root)
    expect(result.trials).toBe(3)
    expect(result.pairedDelta.signalMedianMs.estimate).toBe(-9)
    expect(result.pairedDelta.spawnToReadyMs.estimate).toBe(-3)
    expect(result.pairedDelta.spawnToMountedMs.estimate).toBe(0)
    expect(result.pairedRatio.spawnToReady.estimate).toBeCloseTo(2 / 3)
    expect(result.pairs[0]!.baseline!.phases.signals).toMatchObject({
      medianMs: 10.5,
      p95Ms: 20,
      slowAtLeast10Ms: 1,
    })
    expect(result.pairs[0]!.candidate!.phases.signals).toMatchObject({
      medianMs: 1.5,
      p95Ms: 2,
      slowAtLeast10Ms: 0,
    })
    expect(result.pairs[1]!.order).toEqual(['candidate', 'baseline'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('rejects changed reports, missing pairs and wrong ordering', () => {
  const { root, record } = fixture()
  try {
    const child = join(root, 'launches', 'core-aot-paired-baseline-1.json')
    const original = readFileSync(child, 'utf8')
    writeFileSync(child, `${original} `)
    expect(() => analyzePairedRun(root)).toThrow(/size mismatch/)
    writeFileSync(child, original)
    record.pairedDiagnostics.pop()
    writeFileSync(join(root, 'comparison.json'), JSON.stringify(record))
    expect(() => analyzePairedRun(root)).toThrow(/Incomplete paired/)
    record.pairedDiagnostics.push(record.pairedDiagnostics[0]!)
    ;[record.pairedDiagnostics[0], record.pairedDiagnostics[1]] = [
      record.pairedDiagnostics[1]!,
      record.pairedDiagnostics[0]!,
    ]
    writeFileSync(join(root, 'comparison.json'), JSON.stringify(record))
    expect(() => analyzePairedRun(root)).toThrow(/order/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('rejects unequal workloads even when the changed child hash is updated', () => {
  const { root, record } = fixture()
  try {
    const entry = record.pairedDiagnostics[1]!
    const child = join(root, 'launches', `${entry.name}.json`)
    const report = JSON.parse(readFileSync(child, 'utf8'))
    report.phases.signals.mutations.set = 99
    const raw = JSON.stringify(report)
    writeFileSync(child, raw)
    entry.report = {
      bytes: Buffer.byteLength(raw),
      sha256: createHash('sha256').update(raw).digest('hex'),
    }
    writeFileSync(join(root, 'comparison.json'), JSON.stringify(record))
    expect(() => analyzePairedRun(root)).toThrow(/Unequal workloads/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('rejects oversized reports before parsing them', () => {
  const { root } = fixture()
  try {
    writeFileSync(join(root, 'comparison.json'), Buffer.alloc(4_194_305))
    expect(() => analyzePairedRun(root)).toThrow(/size limit/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('rejects mismatched nonce and non-monotonic startup milestones', () => {
  const { root, record } = fixture()
  try {
    const entry = record.pairedDiagnostics[0]!
    const child = join(root, 'launches', `${entry.name}.json`)
    const report = JSON.parse(readFileSync(child, 'utf8'))
    report.nonce = 'wrong'
    let raw = JSON.stringify(report)
    writeFileSync(child, raw)
    entry.report = {
      bytes: Buffer.byteLength(raw),
      sha256: createHash('sha256').update(raw).digest('hex'),
    }
    writeFileSync(join(root, 'comparison.json'), JSON.stringify(record))
    expect(() => analyzePairedRun(root)).toThrow('Child nonce differs')
    report.nonce = entry.nonce
    report.startup.windowOpenedMs = 2
    raw = JSON.stringify(report)
    writeFileSync(child, raw)
    entry.report = {
      bytes: Buffer.byteLength(raw),
      sha256: createHash('sha256').update(raw).digest('hex'),
    }
    writeFileSync(join(root, 'comparison.json'), JSON.stringify(record))
    expect(() => analyzePairedRun(root)).toThrow('Startup milestones are out of order')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('rejects altered calibration evidence and wrong host attribution', () => {
  const { root, record } = fixture()
  try {
    const evidence = join(root, 'core-aot-paired-baseline-calibration.jsonl')
    writeFileSync(evidence, '{"nonce":"calibration-wrong"}\n')
    expect(() => analyzePairedRun(root)).toThrow('Calibration hash mismatch')
    const altered = readFileSync(evidence)
    record.pairedCalibration.nativeEvidence = {
      bytes: altered.length,
      sha256: createHash('sha256').update(altered).digest('hex'),
    }
    writeFileSync(join(root, 'comparison.json'), JSON.stringify(record))
    expect(() => analyzePairedRun(root)).toThrow('Calibration evidence nonce differs')
    writeFileSync(evidence, '{"nonce":"calibration-nonce"}\n')
    const original = readFileSync(evidence)
    record.pairedCalibration.nativeEvidence = {
      bytes: original.length,
      sha256: createHash('sha256').update(original).digest('hex'),
    }
    record.pairedDiagnostics[0]!.hostSha256 = 'a'.repeat(64)
    writeFileSync(join(root, 'comparison.json'), JSON.stringify(record))
    expect(() => analyzePairedRun(root)).toThrow('Wrong host fingerprint')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
