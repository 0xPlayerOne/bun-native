/** Validation and statistics for the paired input diagnostic. */
import assert from 'node:assert/strict'
import { expectedNodes, INPUT_LABEL } from '../solid/workload.ts'
import { bootstrapMedian, describe } from './stats.ts'

const cleanup = {
  windows: 0,
  nodes: 0,
  callbacks: 0,
  queuedTransactions: 0,
  queuedCallbacks: 0,
  activeCallbacks: 0,
  serviceRequests: 0,
}
export type Fingerprint = { bytes: number; sha256: string }
export type Prepared = {
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
export type Observation = {
  trial: number
  variant: 'baseline' | 'candidate'
  status: 'passed' | 'failed'
  latencyMs: number | null
  error: string | null
  loadAverage?: string
  driverReport?: Fingerprint
  childReport?: Fingerprint
}
export type DriverReport = {
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
export type ChildReport = {
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
