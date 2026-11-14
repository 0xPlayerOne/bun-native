import { describe, expect, test } from 'bun:test'
import {
  summarizePairs,
  verifyLaunch,
  verifyPreparations,
} from '../../benchmarks/comparison/paired-input-verify.ts'

type Prepared = Parameters<typeof verifyPreparations>[0]
type Observation = Parameters<typeof summarizePairs>[0][number]
const before = 'a'.repeat(40)
const after = 'b'.repeat(40)
const expectedInitial = [{ id: 1 }]
function preparation(commit: string): Prepared {
  const paint = { nodes: expectedInitial }
  const renderer = { gpu: { name: 'test renderer' } }
  return {
    status: 'passed',
    source: { commit, dirty: false },
    nativeHost: { profile: 'release', bytes: 1, sha256: 'x' },
    target: { os: 'linux', architecture: 'x64', cpuModels: ['test'], logicalCpus: 4 },
    toolchain: { bunRevision: 'same' },
    builds: {
      core: {
        aot: {
          bytes: 1,
          sha256: 'x',
          inspection: { hasCompiledProgram: true },
          runtimeFeatures: { jit: 'unused', jitRemovedRanges: { count: 1 } },
        },
      },
    },
    calibrations: [
      { name: 'core-aot-calibration', initial: { renderer, paint }, final: { renderer, paint } },
    ],
  }
}
const observations: Observation[] = [
  { trial: 1, variant: 'baseline', status: 'passed', latencyMs: 10, error: null },
  { trial: 1, variant: 'candidate', status: 'passed', latencyMs: 20, error: null },
  { trial: 2, variant: 'candidate', status: 'passed', latencyMs: 9, error: null },
  { trial: 2, variant: 'baseline', status: 'passed', latencyMs: 6, error: null },
  { trial: 3, variant: 'baseline', status: 'passed', latencyMs: 8, error: null },
  { trial: 3, variant: 'candidate', status: 'passed', latencyMs: 4, error: null },
]

describe('paired input comparison', () => {
  test('requires exact source, AOT, identical renderer and calibrated tree', () => {
    const a = preparation(before)
    const b = preparation(after)
    expect(() => verifyPreparations(a, b, before, after, expectedInitial)).not.toThrow()
    expect(() => verifyPreparations(a, b, before, after, [])).toThrow('Unexpected input fixture')
    b.source.dirty = true
    expect(() => verifyPreparations(a, b, before, after, expectedInitial)).toThrow(
      'source is dirty'
    )
    b.source.dirty = false
    b.builds.core.aot.inspection.hasCompiledProgram = false
    expect(() => verifyPreparations(a, b, before, after, expectedInitial)).toThrow('not AOT')
    b.builds.core.aot.inspection.hasCompiledProgram = true
    b.calibrations[0]!.initial.paint.nodes = []
    expect(() => verifyPreparations(a, b, before, after, expectedInitial)).toThrow('trees differ')
  })
  test('preserves pairing and rejects failed, incomplete or reordered launches', () => {
    const summary = summarizePairs(observations, 3)
    expect(summary.pairedRatios).toEqual([2, 1.5, 0.5])
    expect(summary.pairedDifferencesMs).toEqual([10, 3, -4])
    expect(() => summarizePairs(observations.slice(1), 3)).toThrow('Incomplete')
    expect(() =>
      summarizePairs([observations[1]!, observations[0]!, ...observations.slice(2)], 3)
    ).toThrow('Variant order')
    const failed = observations.map((value) => ({ ...value }))
    failed[0] = { ...failed[0]!, status: 'failed', error: 'driver failed', latencyMs: null }
    expect(() => summarizePairs(failed, 3)).toThrow('driver failed')
  })
  test('requires OS input, matching renderer and process and observer cleanup', () => {
    const driver: Parameters<typeof verifyLaunch>[0] = {
      status: 'passed',
      checks: {
        window: 'passed',
        app_input_event: 'passed',
        app_initial_render_report: 'passed',
        app_render_report: 'passed',
        native_paint_file_observation: 'passed',
        os_close: 'passed',
        os_input: 'injected-through-XTest',
      },
      renderer: { status: 'reported-by-native-window', gpu: { name: 'renderer' } },
      native_host: { path: '/host', declared_profile: 'release' },
      cleanup: {
        forced_termination: false,
        remaining_observed_pids: [],
        unreaped_observed_pids: [],
        application_exit_code: 0,
      },
      paint_observer_cleanup: { reader_stopped: true, open_descriptors: 0 },
      measurements: { native_paint_file_observation: { command_start_to_paint_observed_ms: 5 } },
    }
    const app: Parameters<typeof verifyLaunch>[1] = {
      status: 'passed',
      nonce: 'nonce',
      adapter: 'core',
      declaredMode: 'aot',
      bunRevision: 'revision',
      executable: '/application',
      workload: { scenario: 'input-latency', rows: 32 },
      input: { clicks: 1, label: 'Clicked' },
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
    const check = () =>
      verifyLaunch(
        driver,
        app,
        'nonce',
        '/host',
        '/application',
        'revision',
        { name: 'renderer' },
        'Clicked'
      )
    expect(check()).toBe(5)
    app.input.label = 'Wrong'
    expect(check).toThrow()
    app.input.label = 'Clicked'
    driver.cleanup.forced_termination = true
    expect(check).toThrow('cleanup failed')
    driver.cleanup.forced_termination = false
    driver.checks['os_input'] = 'not-injected'
    expect(check).toThrow('OS input missing')
    driver.checks['os_input'] = 'injected-through-XTest'
    expect(() =>
      verifyLaunch(
        driver,
        app,
        'nonce',
        '/host',
        '/application',
        'revision',
        { name: 'different' },
        'Clicked'
      )
    ).toThrow('renderer differs')
  })
})
