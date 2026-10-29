/** Descriptive per-launch review envelopes, not wall-clock gates on unit tests. */
import assert from 'node:assert/strict'
import { summarize } from './statistics.ts'
export const TERMINAL_MODES = ['foreground', 'background', 'hidden', 'minimized'] as const
export const TERMINAL_METRICS = [
  'controlP95Ms',
  'controlP99Ms',
  'consumerP95Ms',
  'consumerP99Ms',
  'roundtripP95Ms',
  'roundtripP99Ms',
  'ptyCallbackP95Ms',
  'ptyCallbackP99Ms',
  'throughputBytesPerSecond',
  'treeCpuPercentOfOneCore',
  'treePeakRssBytes',
  'lateSustainedRssIncreaseBytes',
] as const
export const TERMINAL_WORKLOAD_SOURCES = [
  'examples/cef-terminal-load/fixture.ts',
  'examples/cef-terminal-load/client.ts',
  'examples/cef-terminal-load/consumer.ts',
  'examples/cef-terminal-load/diagnostics.ts',
  'examples/cef-terminal-load/probe.ts',
  'examples/cef-terminal-load/child.ts',
  'examples/cef-terminal-load/contract.ts',
  'examples/cef-terminal-load/workload.ts',
  'examples/cef-terminal-load/profile.ts',
  'examples/cef-terminal-load/mode-state.ts',
  'examples/cef-terminal-load/window-modes.ts',
  'examples/cef-terminal/terminal-records.ts',
  'benchmarks/lib/terminal-load-acceptance.ts',
  'scripts/qualify-cef-terminals.ts',
  'scripts/observe-process.py',
  'scripts/qualify-terminal-window-load.ts',
  'scripts/qualify-terminal-soak.ts',
  'scripts/build-terminal-backend.ts',
  'scripts/probe_cef_identity.py',
  'benchmarks/lib/statistics.ts',
  'benchmarks/lib/observed-command.ts',
  'benchmarks/lib/observation.ts',
  'benchmarks/lib/native-diagnostic-events.json',
  'benchmarks/foundation/native-shutdown.ts',
  'examples/cef-terminal/public/index.html',
  'examples/cef-terminal/public/fixture.css',
]
export type TerminalMetric = (typeof TERMINAL_METRICS)[number]
export type TerminalMode = (typeof TERMINAL_MODES)[number]
export interface TerminalProfileCapture {
  readonly schema: 1
  readonly classification: 'validated-native-terminal-profile-capture'
  readonly adapter: 'cef'
  readonly source: string
  readonly reportSha256: string
  readonly context: {
    readonly workload: unknown
    readonly runtime: unknown
    readonly environment: unknown
    readonly workloadSources: Readonly<Record<string, string>>
  }
  readonly samples: readonly {
    readonly index: number
    readonly mode: TerminalMode
    readonly rawSha256: string
    readonly observationSha256: string
    readonly metrics: Readonly<Record<TerminalMetric, number>>
  }[]
}
function object(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), 'Expected profile object')
  return value as Record<string, unknown>
}
function digest(value: unknown) {
  assert.ok(typeof value === 'string' && /^[0-9a-f]{64}$/.test(value), 'Invalid evidence digest')
}
/** Validate again when reading a capture; a prior passed flag does not grant admission. */
export function validateTerminalCapture(input: unknown): TerminalProfileCapture {
  const value = object(input)
  assert.equal(value['schema'], 1)
  assert.equal(value['classification'], 'validated-native-terminal-profile-capture')
  assert.equal(value['adapter'], 'cef')
  assert.match(String(value['source']), /^[0-9a-f]{40}$/)
  digest(value['reportSha256'])
  const context = object(value['context'])
  const workload = object(context['workload'])
  assert.equal(workload['id'], 'graphical-pty-window-load-v3')
  assert.deepEqual(workload['modes'], TERMINAL_MODES)
  assert.equal(workload['terminals'], 2)
  assert.equal(workload['recordsPerBatch'], 32)
  assert.deepEqual(workload['phases'], [
    { name: 'warmup', batches: 20, intervalMs: 100 },
    { name: 'ramp', batches: 40, intervalMs: 50 },
    { name: 'sustained', batches: 600, intervalMs: 50 },
    { name: 'recovery', batches: 40, intervalMs: 100 },
  ])
  assert.equal(workload['maxBatchBytes'], 32768)
  assert.equal(workload['maxCallbacksPerBatch'], 256)
  const runtime = object(context['runtime'])
  assert.equal(runtime['bun'], '1.4.4')
  assert.equal(runtime['cef'], '156.0.7')
  assert.equal(runtime['chromium'], '156.0.8078.17')
  digest(runtime['engineSha256'])
  assert.equal(runtime['terminalOwnership'], 'native-non-detaching')
  const environment = object(context['environment'])
  for (const key of ['os', 'release', 'arch', 'psutil', 'python', 'runClass'])
    assert.ok(
      typeof environment[key] === 'string' &&
        (environment[key] as string).length > 0 &&
        (environment[key] as string).length <= 128
    )
  for (const key of ['logicalCpus', 'memoryBytes'])
    assert.ok(Number.isSafeInteger(environment[key]) && Number(environment[key]) > 0)
  const sources = object(context['workloadSources'])
  assert.deepEqual(Object.keys(sources).sort(), [...TERMINAL_WORKLOAD_SOURCES].sort())
  for (const [path, hash] of Object.entries(sources)) {
    assert.ok(path.length <= 256 && !path.startsWith('/') && !path.split('/').includes('..'))
    digest(hash)
  }
  const samples = value['samples']
  assert.ok(Array.isArray(samples) && samples.length >= 4 && samples.length <= 400)
  const seen = new Set<string>(),
    observations = new Set<string>()
  for (const entry of samples) {
    const row = object(entry),
      index = row['index'],
      mode = row['mode']
    assert.ok(typeof index === 'number' && Number.isSafeInteger(index) && index >= 0 && index < 100)
    assert.ok(TERMINAL_MODES.includes(mode as TerminalMode))
    const identity = `${index}:${mode}`
    assert.ok(!seen.has(identity), 'Duplicated launch')
    seen.add(identity)
    digest(row['rawSha256'])
    digest(row['observationSha256'])
    assert.ok(!observations.has(String(row['observationSha256'])), 'Duplicated process observation')
    observations.add(String(row['observationSha256']))
    const metrics = object(row['metrics'])
    assert.deepEqual(Object.keys(metrics).sort(), [...TERMINAL_METRICS].sort())
    for (const metric of TERMINAL_METRICS)
      assert.ok(
        typeof metrics[metric] === 'number' &&
          Number.isFinite(metrics[metric]) &&
          Number(metrics[metric]) >= 0,
        'Unavailable or invalid ' + metric
      )
    assert.ok(
      Number(metrics['throughputBytesPerSecond']) > 0 && Number(metrics['treePeakRssBytes']) > 0
    )
  }
  const count = samples.length / TERMINAL_MODES.length
  assert.ok(Number.isInteger(count))
  for (const mode of TERMINAL_MODES)
    for (let index = 0; index < count; index++)
      assert.ok(seen.has(`${index}:${mode}`), 'Incomplete mode/launch matrix')
  return input as TerminalProfileCapture
}
/** Bootstrap over independent launches, never over the correlated 1,400 batch rows. */
export function terminalReviewEnvelope(input: unknown) {
  const capture = validateTerminalCapture(input)
  const launchesPerMode = capture.samples.length / TERMINAL_MODES.length
  assert.ok(launchesPerMode >= 5, 'At least five independent launches per mode are required')
  return {
    schema: 1,
    classification: 'terminal-measured-review-envelope-not-a-release-threshold',
    source: capture.source,
    reportSha256: capture.reportSha256,
    context: capture.context,
    launchesPerMode,
    modes: TERMINAL_MODES.map((mode) => ({
      mode,
      metrics: Object.fromEntries(
        TERMINAL_METRICS.map((metric) => [
          metric,
          summarize(
            capture.samples.filter((row) => row.mode === mode).map((row) => row.metrics[metric]),
            0x4d354c44
          ),
        ])
      ),
    })),
    limits: [
      'Descriptive local launch distributions; system load and ordered adapter blocks are not experimentally isolated.',
      'Confidence intervals describe the mean of per-launch metrics, not a confidence bound on every user interaction.',
      'A 30-second RSS trend is not a memory-plateau or universal leak proof; review the separate longer soak.',
      'A non-overlapping adverse shift requires investigation, not an automatic busy-machine millisecond CI failure.',
      'Hard byte/order/ownership/queue/shutdown gates are checked separately by the actual workload validator.',
    ],
  }
}
export function compareTerminalCaptures(baselineInput: unknown, candidateInput: unknown) {
  const baseline = validateTerminalCapture(baselineInput),
    candidate = validateTerminalCapture(candidateInput)
  assert.deepEqual(
    candidate.context,
    baseline.context,
    'Workload, engine, observer environment or harness changed: explicitly requalify the baseline'
  )
  const before = terminalReviewEnvelope(baseline),
    after = terminalReviewEnvelope(candidate)
  const comparisons = TERMINAL_MODES.flatMap((mode, index) =>
    TERMINAL_METRICS.map((metric) => {
      const first = before.modes[index]!.metrics[metric]!,
        second = after.modes[index]!.metrics[metric]!
      assert.ok(first.meanBootstrap95 && second.meanBootstrap95)
      const higherIsBetter = metric === 'throughputBytesPerSecond'
      const adverse = higherIsBetter
        ? second.meanBootstrap95[1]! < first.meanBootstrap95[0]!
        : second.meanBootstrap95[0]! > first.meanBootstrap95[1]!
      const favorable = higherIsBetter
        ? second.meanBootstrap95[0]! > first.meanBootstrap95[1]!
        : second.meanBootstrap95[1]! < first.meanBootstrap95[0]!
      return {
        mode,
        metric,
        baselineMean: first.mean,
        candidateMean: second.mean,
        baselineMean95: first.meanBootstrap95,
        candidateMean95: second.meanBootstrap95,
        assessment: adverse
          ? 'review-adverse-shift'
          : favorable
            ? 'observed-favorable-shift'
            : 'overlapping-uncertainty',
      }
    })
  )
  return {
    schema: 1,
    classification: 'terminal-regression-review-not-automatic-release-approval',
    reviewRequired: comparisons.some((row) => row.assessment === 'review-adverse-shift'),
    baseline: { source: baseline.source, reportSha256: baseline.reportSha256 },
    candidate: { source: candidate.source, reportSha256: candidate.reportSha256 },
    comparisons,
    releaseApproved: false,
    limits: before.limits,
  }
}
