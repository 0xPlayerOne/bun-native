import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { analyzePairedRun } from '../../benchmarks/comparison/paired-analysis.ts'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'paired-analysis-'))
  mkdirSync(join(root, 'launches'))
  const pairedDiagnostics = []
  for (let trial = 1; trial <= 3; trial++) {
    const order = trial % 2 ? ['baseline', 'candidate'] : ['candidate', 'baseline']
    for (const variant of order) {
      const name = `core-aot-paired-${variant}-${trial}`
      const samples = variant === 'baseline' ? [1, 20] : [1, 2]
      const phase = { acknowledgement: { count: 2, samplesMs: samples }, mutations: { set: 2 } }
      const signals = {
        acknowledgement: {
          count: 20,
          samplesMs: [...Array(10).fill(samples[0]), ...Array(10).fill(samples[1])],
        },
        mutations: { set: 20 },
      }
      const report = {
        status: 'passed',
        adapter: 'core',
        declaredMode: 'aot',
        bunRevision: 'test-revision',
        workload: { iterations: 20, rotations: 2, mounts: 1 },
        phases: { signals, coalesced: phase, keyedRotations: phase },
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
        status: 'passed',
        process: { exitCode: 0, wallMs: 10 },
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
    expect(result.pairs[0]!.baseline!.phases.signals).toMatchObject({
      medianMs: 10.5,
      p95Ms: 20,
      slowAtLeast10Ms: 10,
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

test('rejects report counts that disagree with the declared workload', () => {
  const { root, record } = fixture()
  try {
    const entry = record.pairedDiagnostics[0]!
    const child = join(root, 'launches', `${entry.name}.json`)
    const report = JSON.parse(readFileSync(child, 'utf8'))
    report.workload.iterations = 30
    const raw = JSON.stringify(report)
    writeFileSync(child, raw)
    entry.report = {
      bytes: Buffer.byteLength(raw),
      sha256: createHash('sha256').update(raw).digest('hex'),
    }
    writeFileSync(join(root, 'comparison.json'), JSON.stringify(record))
    expect(() => analyzePairedRun(root)).toThrow(/Signal count differs/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
