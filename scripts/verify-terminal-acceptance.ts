/** Replay committed local evidence in isolated profile processes; never execute desktop workloads. */
import assert from 'node:assert/strict'
import { terminalArchiveReport } from '../benchmarks/lib/terminal-evidence-archive.ts'
import { createHash } from 'node:crypto'
import { readFile, writeFile, mkdtemp, rm, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { gunzipSync } from 'node:zlib'
import type { ObservationSample } from '../benchmarks/lib/observation.ts'
assert.equal(Bun.version, '1.4.3')
const root = resolve(import.meta.dir, '..'),
  base = join(root, 'evidence/m5-terminal-acceptance')
const sha = (data: Uint8Array | string) => createHash('sha256').update(data).digest('hex')
const object = (value: unknown): Record<string, unknown> => {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value))
  return value as Record<string, unknown>
}
interface Entry {
  id: string
  adapter: 'cef' | 'electron'
  profile: 'windowed' | 'soak'
  archive: string
  archiveSha256: string
  archiveBytes: number
  expandedSha256: string
  expandedBytes: number
  source: string
  reportOriginal: { sha256: string; bytes: number }
  passed: boolean
  accepted: number
  failed: number
}
const manifest = object(JSON.parse(await readFile(join(base, 'manifest.json'), 'utf8')))
assert.equal(manifest['schema'], 1)
assert.equal(manifest['releaseApproved'], false)
assert.equal(manifest['performanceRatios'], null)
const runs = manifest['runs']
assert.ok(
  Array.isArray(runs) && runs.length === 7,
  'Require every current and retained-failure evidence run'
)
const expected = [
  'native-functional',
  'native-repeated',
  'native-soak',
  'electron-functional',
  'electron-repeated',
  'retained-native-drain-failure',
  'retained-stale-electron-preflight',
]
assert.deepEqual(
  runs.map((row) => object(row)['id']),
  expected
)
for (const value of runs) {
  const row = object(value)
  assert.equal(row['archive'], `${row['id']}.json.gz`)
  assert.ok(row['adapter'] === 'cef' || row['adapter'] === 'electron')
  assert.ok(row['profile'] === 'windowed' || row['profile'] === 'soak')
  for (const key of ['archiveSha256', 'expandedSha256'])
    assert.match(String(row[key]), /^[a-f0-9]{64}$/)
  assert.match(String(row['source']), /^[a-f0-9]{40}$/)
  assert.ok(typeof row['passed'] === 'boolean')
  for (const key of ['archiveBytes', 'expandedBytes', 'accepted', 'failed'])
    assert.ok(Number.isSafeInteger(row[key]) && Number(row[key]) >= 0)
  assert.ok(
    Number(row['archiveBytes']) <= 64 * 1024 * 1024 &&
      Number(row['expandedBytes']) <= 256 * 1024 * 1024
  )
  assert.ok(Number(row['accepted']) + Number(row['failed']) > 0)
}
const entries = runs as Entry[]
for (const [path, digest] of Object.entries(object(manifest['historicalArchives']))) {
  assert.ok(
    [
      'evidence/m5-terminal-load/raw-evidence.json.gz',
      'evidence/m5-terminal-load-followup/raw-evidence.json.gz',
    ].includes(path)
  )
  assert.equal(sha(await readFile(join(root, path))), digest, 'Historical failures/archive changed')
}
assert.equal(Object.keys(object(manifest['historicalArchives'])).length, 2)
async function replay(entry: Entry) {
  const path = join(base, entry.archive),
    info = await stat(path)
  assert.equal(info.size, entry.archiveBytes)
  const compressed = await readFile(path)
  assert.equal(sha(compressed), entry.archiveSha256)
  const expanded = gunzipSync(compressed, { maxOutputLength: 256 * 1024 * 1024 })
  assert.equal(expanded.length, entry.expandedBytes)
  assert.equal(sha(expanded), entry.expandedSha256)
  const archive = object(JSON.parse(expanded.toString()))
  assert.equal(archive['schema'], 1)
  assert.equal(archive['classification'], 'retained-profile-evidence-not-additional-execution')
  assert.deepEqual(archive['redactions'], [
    'fixture-nonces',
    'local-paths',
    'consistent-positive-process-pseudonyms',
  ])
  assert.deepEqual(archive['reportOriginal'], entry.reportOriginal)
  ;(
    globalThis as typeof globalThis & { __bunlyTerminalLoadProfile?: unknown }
  ).__bunlyTerminalLoadProfile = entry.profile
  const [
    { decodeExportedNativeReport },
    { acceptTerminalLoad, acceptLoadRows, loadProcessPhases },
    { assertCleanCommand, validateCommandObservation },
    { LOAD },
  ] = await Promise.all([
    import('../benchmarks/lib/exported-native-evidence.ts'),
    import('../benchmarks/lib/terminal-load-acceptance.ts'),
    import('../benchmarks/lib/observed-command.ts'),
    import('../examples/cef-terminal-load/workload.ts'),
  ])
  const encodedReport = terminalArchiveReport(archive)
  const report = decodeExportedNativeReport(encodedReport)
  assert.equal(report['passed'], entry.passed)
  assert.deepEqual(report['workload'], LOAD)
  const source = object(report['sourceBefore'])
  assert.equal(source['commit'], entry.source)
  assert.equal(source['clean'], true)
  assert.deepEqual(report['sourceAfter'], source)
  const hashes = object(report['sourceHashes'])
  assert.deepEqual(report['sourceHashesAfter'], hashes)
  for (const [file, digest] of Object.entries(hashes)) {
    assert.ok(file.length <= 256 && !file.startsWith('/') && !file.split('/').includes('..'))
    const child = Bun.spawnSync(['git', 'show', `${entry.source}:${file}`], { cwd: root })
    assert.equal(
      child.exitCode,
      0,
      'Historical source unavailable; fetch the recorded commit before replay: ' + entry.source
    )
    assert.equal(sha(child.stdout), digest, file)
  }
  if (entry.adapter === 'cef') {
    assert.equal(report['terminalOwnership'], 'native-non-detaching')
    assert.equal(report['inputArtifactUnchanged'], true)
    assert.equal(report['preparedArtifactUnchanged'], true)
    const identity = object(report['runtimeIdentity'])
    assert.equal(identity['cefVersion'], '156.0.7')
    assert.equal(identity['chromiumVersion'], '156.0.8078.17')
    assert.equal(identity['source'], 'exported-api')
  }
  const workloads = object(archive['workloads']),
    trials = report['trials']
  assert.ok(Array.isArray(trials))
  assert.equal(trials.length, entry.accepted + entry.failed)
  let accepted = 0,
    failed = 0,
    verifiedHelpers = 0,
    unobservedHelpers = 0
  const metrics: unknown[] = []
  const seen = new Set<string>()
  const samples = trials.length / LOAD.modes.length
  assert.ok(Number.isInteger(samples) && samples >= 1 && samples <= 100)
  for (const item of trials) {
    const trial = object(item),
      index = trial['index'],
      mode = trial['mode']
    assert.ok(typeof index === 'number' && Number.isInteger(index) && index >= 0 && index < 100)
    assert.ok(typeof mode === 'string' && (LOAD.modes as readonly string[]).includes(mode))
    assert.ok(index < samples)
    assert.equal(trial['warmup'], false)
    const launch = `${index}:${mode}`
    assert.ok(!seen.has(launch), 'Duplicated retained launch')
    seen.add(launch)
    const observation = validateCommandObservation(trial['observation'])
    if (entry.id === 'retained-stale-electron-preflight') {
      assert.equal(trial['passed'], false)
      assert.equal(observation.timedOut, true)
      assert.ok(observation.stderr.includes('Error: Unexpected pinned runtime or mode'))
      assert.equal(workloads[`trial-${index}-${mode}.jsonl`], undefined)
      failed++
      continue
    }
    const embedded = trial['workloadRows'],
      sidecar = workloads[`trial-${index}-${mode}.jsonl`]
    const rows = embedded ?? object(sidecar)['rows']
    assert.ok(Array.isArray(rows) && rows.length <= 5200)
    const raw = rows.map((row) => JSON.stringify(row)).join('\n') + '\n'
    assert.ok(Buffer.byteLength(raw) <= 8 * 1024 * 1024)
    assert.equal(sha(raw), trial['rawSha256'])
    if (embedded === undefined)
      assert.equal(object(object(sidecar)['original'])['sha256'], trial['rawSha256'])
    if (trial['passed'] === false) {
      assert.equal(entry.id, 'retained-native-drain-failure')
      assert.equal(mode, 'minimized')
      assertCleanCommand(observation)
      assert.throws(() => acceptTerminalLoad(observation, raw, mode, 'native-non-detaching'))
      const last = object(rows.at(-1)),
        native = object(last['native'])
      assert.equal(last['kind'], 'complete')
      assert.equal(native['rpcDeliveryBytes'], 85)
      assert.equal(native['rpcDeliveryPackets'], 1)
      failed++
      continue
    }
    assert.equal(trial['passed'], true)
    if (entry.adapter === 'cef') {
      const acceptedMetrics = acceptTerminalLoad(observation, raw, mode, 'native-non-detaching')
      assert.deepEqual(acceptedMetrics, trial['metrics'])
      metrics.push({
        mode,
        index,
        phases: acceptedMetrics.phases,
        process: acceptedMetrics.process,
        peakTreeRssBytes: observation.peakTreeRssBytes,
      })
      if (observation.postExitCleanup?.qualified) verifiedHelpers++
      else unobservedHelpers++
    } else {
      assertCleanCommand(observation)
      const identity = object(trial['identity'])
      assert.equal(identity['frameworkVersion'], '44.9.3')
      assert.equal(identity['chromium'], '152.0.7977.167')
      assert.equal(identity['scenario'], LOAD.id)
      assert.equal(identity['backgroundThrottling'], true)
      assert.equal(identity['passed'], true)
      const security = object(identity['security'])
      for (const key of [
        'sandboxed',
        'contextIsolated',
        'nodeDisabled',
        'sandbox',
        'contextIsolation',
      ])
        assert.equal(security[key], true)
      assert.equal(security['nodeIntegration'], false)
      const phases = acceptLoadRows(raw, mode, observation.environment.os, 'electron'),
        process = loadProcessPhases(observation.samples as unknown as ObservationSample[])
      assert.deepEqual(phases, trial['phases'])
      assert.deepEqual(process, trial['process'])
      metrics.push({ mode, index, phases, process, peakTreeRssBytes: observation.peakTreeRssBytes })
    }
    accepted++
  }
  for (const mode of LOAD.modes)
    for (let index = 0; index < samples; index++)
      assert.ok(seen.has(`${index}:${mode}`), 'Missing retained launch')
  assert.equal(accepted, entry.accepted)
  assert.equal(failed, entry.failed)
  assert.equal(report['passed'], failed === 0)
  if (entry.id === 'native-repeated') {
    const temporary = await mkdtemp(join(tmpdir(), 'bunly-evidence-replay-'))
    try {
      const reportPath = join(temporary, 'report.json')
      await writeFile(reportPath, JSON.stringify(encodedReport) + '\n')
      const { captureTerminalProfile } =
        await import('../benchmarks/lib/terminal-profile-review.ts')
      const { terminalReviewEnvelope } = await import('../benchmarks/lib/terminal-regression.ts')
      const capture = await captureTerminalProfile(reportPath)
      assert.deepEqual(
        capture,
        JSON.parse(await readFile(join(base, 'native-capture.json'), 'utf8'))
      )
      assert.deepEqual(
        terminalReviewEnvelope(capture),
        JSON.parse(await readFile(join(base, 'native-review-envelope.json'), 'utf8'))
      )
    } finally {
      await rm(temporary, { recursive: true, force: true })
    }
  }
  return {
    id: entry.id,
    source: entry.source,
    accepted,
    retainedFailures: failed,
    verifiedHelpers,
    unobservedHelpers,
    metrics,
  }
}
const [operation, id] = process.argv.slice(2)
if (operation === '--run') {
  assert.equal(process.argv.slice(2).length, 2)
  const entry = entries.find((row) => row.id === id)
  assert.ok(entry)
  console.log(JSON.stringify(await replay(entry)))
} else {
  assert.equal(process.argv.slice(2).length, 0)
  assert.equal(operation, undefined)
  const results = []
  for (const entry of entries) {
    const child = Bun.spawn([process.execPath, import.meta.filename, '--run', entry.id], {
      cwd: root,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const timer = setTimeout(() => child.kill(), 120000)
    try {
      const [code, out, error] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      assert.equal(code, 0, error)
      assert.ok(Buffer.byteLength(out) <= 2 * 1024 * 1024)
      const result = object(JSON.parse(out))
      results.push(result)
      console.error(
        JSON.stringify({
          id: entry.id,
          accepted: result['accepted'],
          retainedFailures: result['retainedFailures'],
        })
      )
    } finally {
      clearTimeout(timer)
      if (child.exitCode === null) {
        child.kill()
        await child.exited
      }
    }
  }
  console.log(
    JSON.stringify({
      schema: 1,
      classification: 'replay-of-retained-evidence-not-new-execution',
      results,
      releaseApproved: false,
      performanceRatios: null,
    })
  )
}
