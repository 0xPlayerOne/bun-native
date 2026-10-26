/** Recompute capture metrics from actual workload/process evidence, not stored metric claims. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { LOAD } from '../../examples/cef-terminal-load/workload.ts'
import { acceptTerminalLoad } from './terminal-load-acceptance.ts'
import { decodeExportedNativeReport } from './exported-native-evidence.ts'
import {
  TERMINAL_WORKLOAD_SOURCES,
  validateTerminalCapture,
  type TerminalProfileCapture,
  type TerminalMode,
} from './terminal-regression.ts'
const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex')
const record = (value: unknown): Record<string, unknown> => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value))
  return value as Record<string, unknown>
}
const finite = (value: unknown): number => {
  assert.ok(typeof value === 'number' && Number.isFinite(value) && value >= 0)
  return value
}

export async function captureTerminalProfile(path: string): Promise<TerminalProfileCapture> {
  const meta = await stat(path)
  assert.ok(
    meta.isFile() && meta.size > 0 && meta.size <= 512 * 1024 * 1024,
    'Bounded profile report required'
  )
  const bytes = await readFile(path)
  assert.equal(bytes.length, meta.size)
  const parsed = record(JSON.parse(bytes.toString()))
  const report = Object.hasOwn(parsed, 'nativeEvidenceExport')
    ? decodeExportedNativeReport(parsed)
    : parsed
  assert.equal(report['schema'], 2)
  assert.equal(report['passed'], true, 'Failed trials cannot supply a regression baseline')
  assert.equal(report['profile'], 'graphical-pty-window-load-v3')
  assert.equal(
    LOAD.id,
    'graphical-pty-window-load-v3',
    'Use the explicit isolated window-profile review command'
  )
  assert.deepEqual(report['workload'], LOAD)
  assert.equal(report['bun'], '1.4.3')
  assert.equal(report['terminalOwnership'], 'native-non-detaching')
  assert.equal(report['inputArtifactUnchanged'], true)
  assert.equal(report['preparedArtifactUnchanged'], true)
  const before = record(report['sourceBefore'])
  assert.match(String(before['commit']), /^[0-9a-f]{40}$/)
  assert.equal(before['clean'], true)
  assert.deepEqual(report['sourceAfter'], before)
  assert.deepEqual(report['sourceHashesAfter'], report['sourceHashes'])
  const hashes = record(report['sourceHashes'])
  const workloadSources = Object.fromEntries(
    TERMINAL_WORKLOAD_SOURCES.map((path) => {
      assert.match(String(hashes[path]), /^[0-9a-f]{64}$/)
      return [path, String(hashes[path])]
    })
  )
  const identity = record(report['runtimeIdentity'])
  assert.equal(identity['event'], 'cef-binary-identity')
  assert.equal(identity['source'], 'exported-api')
  assert.equal(identity['cefVersion'], '156.0.7')
  assert.equal(identity['chromiumVersion'], '156.0.8078.17')
  const trials = report['trials']
  assert.ok(Array.isArray(trials) && trials.length <= 440)
  const count = finite(report['samples']),
    warmups = finite(report['warmups'])
  assert.ok(
    Number.isInteger(count) &&
      count >= 1 &&
      count <= 100 &&
      Number.isInteger(warmups) &&
      warmups <= 10
  )
  assert.equal(trials.length, (count + warmups) * LOAD.modes.length)
  const samples: TerminalProfileCapture['samples'][number][] = []
  const seen = new Set<string>()
  let environment: unknown
  for (const item of trials) {
    const trial = record(item),
      index = trial['index'],
      mode = trial['mode']
    assert.equal(trial['passed'], true)
    assert.ok(
      typeof index === 'number' && Number.isInteger(index) && index >= -warmups && index < count
    )
    assert.ok((LOAD.modes as readonly string[]).includes(String(mode)))
    assert.equal(trial['warmup'], index < 0)
    const key = `${index}:${mode}`
    assert.ok(!seen.has(key))
    seen.add(key)
    const rows = trial['workloadRows']
    let raw: string
    if (rows !== undefined) {
      assert.ok(Array.isArray(rows) && rows.length <= 1600)
      raw = rows.map((row) => JSON.stringify(row)).join('\n') + '\n'
    } else {
      const rawPath = join(dirname(path), `trial-${index}-${mode}.jsonl`)
      const info = await stat(rawPath)
      assert.ok(info.isFile() && info.size <= 4 * 1024 * 1024)
      raw = await readFile(rawPath, 'utf8')
    }
    assert.ok(Buffer.byteLength(raw) <= 4 * 1024 * 1024)
    assert.equal(sha(raw), trial['rawSha256'], 'Workload evidence hash mismatch')
    const metrics = acceptTerminalLoad(
      trial['observation'],
      raw,
      String(mode),
      'native-non-detaching'
    )
    assert.deepEqual(metrics, trial['metrics'], 'Stored metric claims differ from replay')
    const observation = record(trial['observation'])
    const current = record(observation['environment'])
    if (environment === undefined) environment = current
    assert.deepEqual(current, environment, 'Observer context changed between launches')
    if (index < 0) continue
    const phase = metrics.phases.find((row) => row.phase === 'sustained')!
    const process = metrics.process.find((row) => row.phase === 'sustained')!
    assert.ok(phase && process)
    const rss = process.rssQuarterMedians
    assert.ok(rss.length === 4)
    const control = phase.controlMs,
      consumer = phase.consumerMs,
      roundtrip = phase.triggerToConsumptionAckMs,
      ptyCallback = phase.ptyCallbackToConsumptionAckMs
    samples.push({
      index,
      mode: mode as TerminalMode,
      rawSha256: sha(raw),
      observationSha256: sha(JSON.stringify(trial['observation'])),
      metrics: {
        controlP95Ms: finite(control.p95),
        controlP99Ms: finite(control.p99),
        consumerP95Ms: finite(consumer.p95),
        consumerP99Ms: finite(consumer.p99),
        roundtripP95Ms: finite(roundtrip.p95),
        roundtripP99Ms: finite(roundtrip.p99),
        ptyCallbackP95Ms: finite(ptyCallback.p95),
        ptyCallbackP99Ms: finite(ptyCallback.p99),
        throughputBytesPerSecond: finite(phase.bytesPerSecond),
        treeCpuPercentOfOneCore: finite(process.treeCpuPercentOfOneCore),
        treePeakRssBytes: finite(observation['peakTreeRssBytes']),
        lateSustainedRssIncreaseBytes: Math.max(0, finite(rss[3]) - finite(rss[2])),
      },
    })
  }
  return validateTerminalCapture({
    schema: 1,
    classification: 'validated-native-terminal-profile-capture',
    adapter: 'cef',
    source: before['commit'],
    reportSha256: sha(bytes),
    context: {
      workload: LOAD,
      runtime: {
        bun: '1.4.3',
        cef: identity['cefVersion'],
        chromium: identity['chromiumVersion'],
        engineSha256: identity['sha256'],
        terminalOwnership: 'native-non-detaching',
      },
      environment,
      workloadSources,
    },
    samples,
  })
}
