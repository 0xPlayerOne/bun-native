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
import { bootstrapMedian, describe } from './stats.ts'

const MAX_REPORT_BYTES = 4_194_304
const cleanup = {
  windows: 0,
  nodes: 0,
  callbacks: 0,
  queuedTransactions: 0,
  queuedCallbacks: 0,
  activeCallbacks: 0,
  serviceRequests: 0,
}
type Fingerprint = { bytes: number; sha256: string }
type Prepared = {
  status: string
  source: { commit: string; dirty: boolean }
  nativeHost: Fingerprint & { profile: string }
  target: { os: string; architecture: string; cpuModels: string[]; logicalCpus: number }
  toolchain: { bunRevision: string }
  builds: {
    core: {
      aot: Fingerprint & {
        inspection: { hasCompiledProgram: boolean }
        runtimeFeatures: { jit: string; jitRemovedRanges: { count: number } }
      }
    }
  }
  calibrations: Array<{
    name: string
    initial: { renderer: { gpu: unknown }; paint: { nodes: unknown } }
    final: { renderer: { gpu: unknown }; paint: { nodes: unknown } }
  }>
}
type Variant = {
  name: 'baseline' | 'candidate'
  source: string
  host: string
  binary: string
  report: Prepared
}
type Observation = {
  trial: number
  variant: Variant['name']
  status: 'passed' | 'failed'
  latencyMs: number | null
  error: string | null
  loadAverage?: string
  driverReport?: Fingerprint
  childReport?: Fingerprint
}
type DriverReport = {
  status: string
  checks: Record<string, string>
  renderer: { status: string; gpu: unknown }
  native_host: { path: string; declared_profile: string }
  cleanup: {
    forced_termination: boolean
    remaining_observed_pids: unknown[]
    unreaped_observed_pids: unknown[]
    application_exit_code: number
  }
  paint_observer_cleanup: { reader_stopped: boolean; open_descriptors: number }
  measurements: { native_paint_file_observation: { command_start_to_paint_observed_ms: number } }
}
type ChildReport = {
  status: string
  nonce: string
  adapter: string
  declaredMode: string
  bunRevision: string
  executable: string
  workload: unknown
  input: { clicks: number; label: string }
  cleanup: unknown
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

/** Reject incomplete preparations and unequal calibrated trees before timing. */
export function verifyPreparations(
  baseline: Prepared,
  candidate: Prepared,
  baselineCommit: string,
  candidateCommit: string
): void {
  for (const [name, report, commit] of [
    ['baseline', baseline, baselineCommit],
    ['candidate', candidate, candidateCommit],
  ] as const) {
    assert.match(commit, /^[0-9a-f]{40}$/, `${name} commit must be a full SHA`)
    assert.equal(report.status, 'passed', `${name} preparation did not pass`)
    assert.equal(report.source.commit, commit, `${name} source mismatch`)
    assert.equal(report.source.dirty, false, `${name} source is dirty`)
    assert.equal(report.nativeHost.profile, 'release', `${name} host is not release`)
    assert.equal(report.target.os, 'linux', `${name} is not Linux`)
    assert.equal(report.builds.core.aot.inspection.hasCompiledProgram, true, `${name} is not AOT`)
    assert(
      ['unused', 'requested'].includes(report.builds.core.aot.runtimeFeatures.jit),
      `${name} JIT is present`
    )
    assert(
      report.builds.core.aot.runtimeFeatures.jitRemovedRanges.count > 0,
      `${name} JIT omission is not established`
    )
    assert(
      report.calibrations.some((entry) => entry.name === 'core-aot-calibration'),
      `${name} calibration missing`
    )
  }
  assert.equal(
    baseline.toolchain.bunRevision,
    candidate.toolchain.bunRevision,
    'Bun revisions differ'
  )
  assert.deepEqual(baseline.target, candidate.target, 'Runner environment differs')
  const a = baseline.calibrations.find((entry) => entry.name === 'core-aot-calibration')!
  const b = candidate.calibrations.find((entry) => entry.name === 'core-aot-calibration')!
  for (const phase of ['initial', 'final'] as const) {
    assert.deepEqual(a[phase].renderer.gpu, b[phase].renderer.gpu, `${phase} renderers differ`)
    assert.deepEqual(a[phase].paint.nodes, b[phase].paint.nodes, `${phase} trees differ`)
  }
  const rows = Array.from({ length: 32 }, (_, id) => ({ id, text: `Row ${id}` }))
  assert.deepEqual(
    a.initial.paint.nodes,
    expectedNodes(rows, 'Initial'),
    'Unexpected input fixture'
  )
}

/** Report only complete ordered pairs; failures never disappear from a comparison. */
export function summarizePairs(entries: readonly Observation[], pairs: number) {
  assert(Number.isSafeInteger(pairs) && pairs >= 3 && pairs <= 30, 'Expected 3–30 pairs')
  assert.equal(entries.length, pairs * 2, 'Incomplete paired launches')
  const baseline: number[] = []
  const candidate: number[] = []
  for (let i = 0; i < pairs; i++) {
    const ordered = i % 2 === 0 ? ['baseline', 'candidate'] : ['candidate', 'baseline']
    for (let j = 0; j < 2; j++) {
      const entry = entries[i * 2 + j]!
      assert.equal(entry.trial, i + 1, 'Pair order changed')
      assert.equal(entry.variant, ordered[j], 'Variant order changed')
      assert.equal(entry.status, 'passed', `Failed paired launch: ${entry.error}`)
      assert(
        typeof entry.latencyMs === 'number' &&
          Number.isFinite(entry.latencyMs) &&
          entry.latencyMs > 0,
        'Invalid latency'
      )
      ;(entry.variant === 'baseline' ? baseline : candidate).push(entry.latencyMs)
    }
  }
  const ratios = baseline.map((value, i) => candidate[i]! / value)
  const differences = baseline.map((value, i) => candidate[i]! - value)
  return {
    baseline: describe(baseline),
    candidate: describe(candidate),
    pairedRatios: ratios,
    pairedRatioInterval: bootstrapMedian(ratios),
    pairedDifferencesMs: differences,
    pairedDifferenceInterval: bootstrapMedian(differences),
  }
}

/** Only accept a successful, owned OS-input launch with complete cleanup. */
export function verifyLaunch(
  driver: DriverReport,
  app: ChildReport,
  nonce: string,
  host: string,
  binary: string,
  revision: string,
  gpu: unknown
): number {
  assert.equal(driver.status, 'passed', 'Driver failed')
  for (const check of [
    'window',
    'app_input_event',
    'app_initial_render_report',
    'app_render_report',
    'native_paint_file_observation',
    'os_close',
  ])
    assert.equal(driver.checks[check], 'passed', `Driver check ${check} failed`)
  assert.equal(driver.checks['os_input'], 'injected-through-XTest', 'OS input missing')
  assert.equal(driver.renderer.status, 'reported-by-native-window', 'Native renderer missing')
  assert.deepEqual(driver.renderer.gpu, gpu, 'Input renderer differs from calibration')
  assert.equal(driver.native_host.path, host, 'Wrong native host')
  assert.equal(driver.native_host.declared_profile, 'release', 'Host profile mismatch')
  assert.deepEqual(
    driver.cleanup,
    {
      forced_termination: false,
      remaining_observed_pids: [],
      unreaped_observed_pids: [],
      application_exit_code: 0,
    },
    'Native process cleanup failed'
  )
  assert.deepEqual(
    driver.paint_observer_cleanup,
    { reader_stopped: true, open_descriptors: 0 },
    'Paint observer cleanup failed'
  )
  assert.equal(app.status, 'passed', 'Application failed')
  assert.equal(app.nonce, nonce, 'Wrong child report')
  assert.equal(app.executable, binary, 'Wrong executable')
  assert.equal(app.adapter, 'core')
  assert.equal(app.declaredMode, 'aot')
  assert.equal(app.bunRevision, revision)
  assert.deepEqual(app.workload, { scenario: 'input-latency', rows: 32 })
  assert.equal(app.input.clicks, 1)
  assert.equal(app.input.label, INPUT_LABEL)
  assert.deepEqual(app.cleanup, cleanup)
  const latency =
    driver.measurements.native_paint_file_observation.command_start_to_paint_observed_ms
  assert(typeof latency === 'number' && Number.isFinite(latency) && latency > 0, 'Invalid latency')
  return latency
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
  verifyPreparations(
    baseline.report,
    candidate.report,
    values['baseline-commit'] ?? '',
    values['candidate-commit'] ?? ''
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
  const rows = Array.from({ length: 32 }, (_, id) => ({ id, text: `Row ${id}` }))
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
          calibration.initial.renderer.gpu
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
