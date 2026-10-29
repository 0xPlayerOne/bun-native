import assert from 'node:assert/strict'
import {
  compositionPhaseMarkers,
  compositionPlan,
  type CompositionPhaseReceipt,
} from '../../examples/composition-profile/plan.ts'
import { nativeEvents } from '../lib/cef-acceptance.ts'
import { quantile } from '../lib/statistics.ts'
import { validateCommandObservation } from '../lib/observed-command.ts'
import {
  acceptDesktopEvidence,
  acceptDesktopObservation,
  desktopSourceSelectors,
} from './acceptance.ts'

export const COMPOSITION_RESOURCE_PROFILE = 'descriptive-windowed-composition-v1'
export const compositionResourceSourceSelectors = [
  ...desktopSourceSelectors,
  'examples/composition-profile',
  'examples/view-composition/lifetime.ts',
  'examples/managed-desktop/document-readiness.ts',
] as const
export const compositionResourceRequiredSources = [
  'examples/composition-profile/fixture.ts',
  'examples/composition-profile/plan.ts',
  'examples/composition-profile/public/index.html',
  'benchmarks/desktop/composition-profile.ts',
] as const
function record(input: unknown): Record<string, unknown> {
  assert.ok(input && typeof input === 'object' && !Array.isArray(input), 'Expected record')
  return input as Record<string, unknown>
}
function nonnegative(input: unknown): number {
  assert.ok(typeof input === 'number' && Number.isFinite(input) && input >= 0)
  return input
}
function count(input: unknown): number {
  const value = nonnegative(input)
  assert.ok(Number.isSafeInteger(value))
  return value
}
function distribution(values: readonly number[]) {
  assert.ok(values.length > 0)
  return {
    count: values.length,
    median: quantile(values, 0.5),
    p95: quantile(values, 0.95),
    max: Math.max(...values),
  }
}

export function acceptCompositionResourceReceipt(input: unknown) {
  const receipt = record(input)
  assert.ok(Buffer.byteLength(JSON.stringify(receipt)) <= 16 * 1024)
  assert.equal(receipt['event'], 'bunly.native.composition-profile')
  assert.equal(receipt['schema'], 1)
  assert.equal(receipt['passed'], true)
  assert.equal(receipt['failure'], null)
  assert.equal(receipt['pendingPhase'], null)
  for (const key of [
    'physicalInputQualified',
    'hardwareDpiQualified',
    'assistiveTechnologyQualified',
    'gpuMeasured',
    'performanceEligible',
  ])
    assert.equal(receipt[key], false)
  assert.deepEqual(receipt['incarnations'], { left: 5, right: 1, overlay: 5 })
  assert.deepEqual(receipt['nativeFinal'], {
    windows: 1,
    views: 0,
    sessions: 0,
    pending: 0,
    nativeDeliveryPackets: 0,
    nativeDeliveryBytes: 0,
    rpcIncomingBytes: 0,
    streamIncomingBytes: 0,
  })
  assert.deepEqual(receipt['final'], {
    windows: 0,
    views: 0,
    sessions: 0,
    listeners: 0,
    listenerErrors: 0,
  })
  const phases = receipt['phases']
  assert.ok(Array.isArray(phases) && phases.length === compositionPlan.length)
  let previousEnd = 0
  for (const [index, input] of phases.entries()) {
    const phase = record(input)
    const plan = compositionPlan[index]!
    assert.deepEqual(Object.keys(phase).sort(), [
      'activeAtStart',
      'endedMs',
      'minimized',
      'name',
      'operationMs',
      'startedMs',
      'visible',
    ])
    assert.equal(phase['name'], plan.name)
    const started = nonnegative(phase['startedMs'])
    const ended = nonnegative(phase['endedMs'])
    assert.ok(started >= previousEnd && ended <= 35_000)
    assert.ok(ended - started >= plan.durationMs, 'Phase ended before its declared dwell')
    previousEnd = ended
    assert.equal(phase['visible'], true)
    assert.equal(phase['minimized'], false)
    assert.equal(typeof phase['activeAtStart'], 'boolean')
    const operations = phase['operationMs']
    assert.ok(Array.isArray(operations) && operations.length === plan.operations)
    let operationTotal = 0
    for (const value of operations) operationTotal += nonnegative(value)
    assert.ok(operationTotal <= ended - started, 'Operation time exceeds sequential phase')
  }
  return phases as CompositionPhaseReceipt[]
}

/** Only adjacent samples within a phase and exact PID/birth identity contribute CPU.
 * Sampling gaps, births and exits are visible limitations, never invented zero CPU.
 */
export function compositionResourceSamples(input: unknown) {
  const observation = validateCommandObservation(input)
  const expected = [...compositionPhaseMarkers]
  const markers = nativeEvents({ ...observation, stdoutTail: [] }).filter(
    (event) => event['event'] === 'bunly.composition.phase'
  )
  assert.deepEqual(
    markers,
    expected.map((phase) => ({ event: 'bunly.composition.phase', schema: 1, phase })),
    'Missing, duplicate, unknown or out-of-order composition markers'
  )
  const phases = ['startup', ...expected, 'post-exit-cleanup']
  let previousElapsed = -1
  let previousPhase = -1
  const samples = observation.samples.map((input) => {
    const sample = record(input)
    const elapsedMs = nonnegative(sample['elapsedMs'])
    assert.ok(elapsedMs > previousElapsed && elapsedMs <= observation.elapsedMs)
    previousElapsed = elapsedMs
    const phase = phases.indexOf(String(sample['phase']))
    assert.ok(phase >= previousPhase && phase >= 0, 'Unknown or reordered sampled phase')
    previousPhase = phase
    const inputProcesses = sample['processes']
    assert.ok(Array.isArray(inputProcesses))
    const identities = new Set<string>()
    const pids = new Set<number>()
    const processes = inputProcesses.map((value: unknown) => {
      const process = record(value)
      const pid = count(process['pid'])
      assert.ok(pid > 0 && !pids.has(pid), 'Duplicate sampled PID')
      pids.add(pid)
      const identity = `${pid}:${nonnegative(process['creationTime'])}`
      assert.ok(!identities.has(identity))
      identities.add(identity)
      return {
        identity,
        cpuSeconds: nonnegative(process['cpuSeconds']),
        rssBytes: count(process['rssBytes']),
      }
    })
    const rssBytes = count(sample['rssBytes'])
    assert.equal(
      rssBytes,
      processes.reduce((sum, process) => sum + process.rssBytes, 0)
    )
    return { elapsedMs, phase: String(sample['phase']), processes, rssBytes }
  })
  for (let index = 1; index < samples.length; index++) {
    const before = new Map(samples[index - 1]!.processes.map((value) => [value.identity, value]))
    for (const process of samples[index]!.processes) {
      const previous = before.get(process.identity)
      if (previous)
        assert.ok(process.cpuSeconds >= previous.cpuSeconds, 'Sampled CPU counter moved backwards')
    }
  }
  return compositionPlan.map((plan) => {
    const selected = samples.filter((sample) => sample.phase === `composition-${plan.name}`)
    assert.ok(selected.length >= 2, 'Each phase requires multiple process samples')
    assert.ok(
      selected.every((sample) => sample.processes.length > 0),
      'Missing observed process tree'
    )
    let sampledCpuSeconds = 0,
      matchedProcessIntervals = 0,
      unmatchedProcessIntervals = 0,
      maxSampleGapMs = 0
    for (let index = 1; index < selected.length; index++) {
      const previous = selected[index - 1]!
      const current = selected[index]!
      const before = new Map(previous.processes.map((value) => [value.identity, value]))
      const after = new Set(current.processes.map((value) => value.identity))
      maxSampleGapMs = Math.max(maxSampleGapMs, current.elapsedMs - previous.elapsedMs)
      for (const process of current.processes) {
        const old = before.get(process.identity)
        if (old) {
          sampledCpuSeconds += process.cpuSeconds - old.cpuSeconds
          matchedProcessIntervals++
        } else unmatchedProcessIntervals++
      }
      for (const identity of before.keys()) if (!after.has(identity)) unmatchedProcessIntervals++
    }
    assert.ok(matchedProcessIntervals > 0, 'No same-identity CPU intervals observed')
    return {
      phase: plan.name,
      sampleCount: selected.length,
      sampledSpanMs: selected.at(-1)!.elapsedMs - selected[0]!.elapsedMs,
      maxSampleGapMs,
      sampledCpuSeconds,
      matchedProcessIntervals,
      unmatchedProcessIntervals,
      treeRssBytes: distribution(selected.map((sample) => sample.rssBytes)),
      peakObservedProcesses: Math.max(...selected.map((sample) => sample.processes.length)),
    }
  })
}

export function acceptCompositionResources(input: unknown) {
  const phases = acceptDesktopObservation(
    input,
    'bunly.native.composition-profile',
    acceptCompositionResourceReceipt
  )
  return {
    classification: 'descriptive-windowed-cef-resources',
    phases: phases.map((phase) => ({
      name: phase.name,
      elapsedMs: phase.endedMs - phase.startedMs,
      operationRoundTripMs: phase.operationMs.length ? distribution(phase.operationMs) : null,
    })),
    resources: compositionResourceSamples(input),
    gpuMeasured: false,
    physicalInputQualified: false,
    assistiveTechnologyQualified: false,
    performanceEligible: false,
  }
}
export function acceptCompositionResourceReport(input: unknown) {
  return acceptDesktopEvidence(
    input,
    COMPOSITION_RESOURCE_PROFILE,
    compositionResourceRequiredSources,
    acceptCompositionResources
  )
}
