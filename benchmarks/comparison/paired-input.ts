/** Same-session, alternating Core/AOT click-to-paint diagnostic for #675. */
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { expectedNodes, INPUT_LABEL, WINDOW_TITLE } from '../solid/workload.ts'
import {
  summarizePairs,
  verifyLaunch,
  verifyPreparations,
  type Fingerprint,
  type Prepared,
  type Observation,
  type DriverReport,
  type ChildReport,
} from './paired-input-verify.ts'

const MAX_REPORT_BYTES = 4_194_304
type Variant = {
  name: 'baseline' | 'candidate'
  source: string
  host: string
  binary: string
  report: Prepared
}
function readJson(path: string): unknown {
  const stat = statSync(path)
  assert(stat.isFile() && stat.size <= MAX_REPORT_BYTES, `Invalid report size: ${path}`)
  const bytes = readFileSync(path)
  assert.equal(bytes.length, stat.size, `Report changed while reading: ${path}`)
  return JSON.parse(bytes.toString('utf8'))
}
async function digest(path: string): Promise<Fingerprint> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return { bytes: statSync(path).size, sha256: hash.digest('hex') }
}
async function verifyArtifacts(variant: Variant): Promise<void> {
  assert.deepEqual(
    await digest(variant.host),
    { bytes: variant.report.nativeHost.bytes, sha256: variant.report.nativeHost.sha256 },
    `${variant.name} host changed`
  )
  assert.deepEqual(
    await digest(variant.binary),
    { bytes: variant.report.builds.core.aot.bytes, sha256: variant.report.builds.core.aot.sha256 },
    `${variant.name} binary changed`
  )
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      baseline: { type: 'string' },
      candidate: { type: 'string' },
      output: { type: 'string' },
      'baseline-source': { type: 'string' },
      'candidate-source': { type: 'string' },
      'baseline-host': { type: 'string' },
      'candidate-host': { type: 'string' },
      'baseline-commit': { type: 'string' },
      'candidate-commit': { type: 'string' },
      pairs: { type: 'string', default: '12' },
    },
    strict: true,
  })
  const required = (key: keyof typeof values) => {
    const value = values[key]
    assert(typeof value === 'string' && isAbsolute(value), `${key} must be absolute`)
    return value
  }
  const baselineDir = required('baseline')
  const candidateDir = required('candidate')
  const output = required('output')
  assert(!existsSync(output), 'Output already exists')
  assert(
    process.platform === 'linux' && process.env['DISPLAY'],
    'An isolated Linux X11 session is required'
  )
  assert(!process.env['BUN_NATIVE_PHASE_TRACE'], 'Phase tracing must be off for timed launches')
  const pairs = Number(values.pairs)
  assert(Number.isSafeInteger(pairs) && pairs >= 3 && pairs <= 30, 'Expected 3–30 pairs')
  const baseline: Variant = {
    name: 'baseline',
    source: required('baseline-source'),
    host: required('baseline-host'),
    binary: join(baselineDir, 'core/application'),
    report: readJson(join(baselineDir, 'comparison.json')) as Prepared,
  }
  const candidate: Variant = {
    name: 'candidate',
    source: required('candidate-source'),
    host: required('candidate-host'),
    binary: join(candidateDir, 'core/application'),
    report: readJson(join(candidateDir, 'comparison.json')) as Prepared,
  }
  const rows = Array.from({ length: 32 }, (_, id) => ({ id, text: `Row ${id}` }))
  verifyPreparations(
    baseline.report,
    candidate.report,
    values['baseline-commit'] ?? '',
    values['candidate-commit'] ?? '',
    expectedNodes(rows, 'Initial')
  )
  await verifyArtifacts(baseline)
  await verifyArtifacts(candidate)
  assert.equal(
    baseline.report.toolchain.bunRevision,
    Bun.revision,
    'Controller Bun revision differs'
  )
  mkdirSync(output)
  const driver = resolve(import.meta.dir, '../../scripts/quality/native-input-linux.py')
  const expectation = (label: string, revision?: number) =>
    JSON.stringify({
      type: 'rendered',
      stage: 'native-paint',
      window_id: 1,
      ...(revision === undefined ? {} : { tree_revision: revision }),
      nodes: expectedNodes(rows, label),
    })
  const entries: Observation[] = []
  for (let i = 0; i < pairs; i++) {
    const order = i % 2 === 0 ? [baseline, candidate] : [candidate, baseline]
    for (const variant of order) {
      await verifyArtifacts(variant)
      const name = `${String(i + 1).padStart(2, '0')}-${variant.name}`
      const directory = join(output, name)
      const reportPath = join(output, `${name}.json`)
      const nonce = randomUUID()
      const args = [
        'python3',
        driver,
        '--output',
        directory,
        '--mode',
        'aot',
        '--title',
        WINDOW_TITLE,
        '--timeout',
        '30',
        '--require-unforced-cleanup',
        '--expect-initial-render',
        expectation('Initial', 1),
        '--expect-render',
        expectation(INPUT_LABEL),
        '--expect-event',
        JSON.stringify({
          type: 'click',
          stage: 'bun-application',
          target: 'benchmark-fixture',
          adapter: 'core',
        }),
        '--click',
        '100',
        '75',
        '--',
        variant.binary,
        '--host',
        variant.host,
        '--output',
        reportPath,
        '--nonce',
        nonce,
        '--mode',
        'aot',
        '--iterations',
        '1000',
        '--rotations',
        '1000',
        '--mounts',
        '100',
        '--rows',
        '32',
        '--input-latency',
      ]
      const env: Record<string, string> = {}
      for (const [key, value] of Object.entries(process.env))
        if (value !== undefined && !key.startsWith('BUN_NATIVE_EVIDENCE_')) env[key] = value
      env['BUN_NATIVE_HOST'] = variant.host
      env['BUN_NATIVE_HOST_PROFILE'] = 'release'
      const loadAverage = readFileSync('/proc/loadavg', 'utf8').trim()
      const child = Bun.spawn(args, {
        cwd: variant.source,
        env,
        stdout: Bun.file(join(output, `${name}.stdout.log`)),
        stderr: Bun.file(join(output, `${name}.stderr.log`)),
      })
      const exit = await child.exited
      let latencyMs: number | null = null
      let error: string | null = null
      try {
        assert.equal(exit, 0, `driver exited ${exit}`)
        const driverReport = readJson(join(directory, 'result.json')) as DriverReport
        const app = readJson(reportPath) as ChildReport
        const calibration = variant.report.calibrations.find(
          (item) => item.name === 'core-aot-calibration'
        )!
        latencyMs = verifyLaunch(
          driverReport,
          app,
          nonce,
          variant.host,
          variant.binary,
          Bun.revision,
          calibration.initial.renderer.gpu,
          INPUT_LABEL
        )
      } catch (cause) {
        error = cause instanceof Error ? cause.message : String(cause)
        latencyMs = null
      }
      const driverPath = join(directory, 'result.json')
      entries.push({
        trial: i + 1,
        variant: variant.name,
        status: error ? 'failed' : 'passed',
        latencyMs,
        error,
        loadAverage,
        ...(existsSync(driverPath) ? { driverReport: await digest(driverPath) } : {}),
        ...(existsSync(reportPath) ? { childReport: await digest(reportPath) } : {}),
      })
      writeFileSync(join(output, 'progress.json'), JSON.stringify({ entries }, null, 2) + '\n')
      console.log(JSON.stringify(entries.at(-1)))
    }
  }
  await verifyArtifacts(baseline)
  await verifyArtifacts(candidate)
  const result = {
    schemaVersion: 1,
    baseline: {
      commit: baseline.report.source.commit,
      host: baseline.report.nativeHost,
      artifact: baseline.report.builds.core.aot,
    },
    candidate: {
      commit: candidate.report.source.commit,
      host: candidate.report.nativeHost,
      artifact: candidate.report.builds.core.aot,
    },
    target: baseline.report.target,
    methodology:
      'Fresh AOT Core process per observation; pair order alternates; metric starts immediately before xdotool click and ends at validated native paint-record observation, not display presentation. Load and cache uncontrolled.',
    entries,
    summary: summarizePairs(entries, pairs),
  }
  writeFileSync(join(output, 'paired-input.json'), JSON.stringify(result, null, 2) + '\n', {
    flag: 'wx',
  })
}
if (import.meta.main) await main()
