import assert from 'node:assert/strict'
import { test, spyOn } from 'bun:test'
import {
  acceptCompositionResourceReceipt,
  acceptCompositionResourceReport,
  acceptCompositionResources,
  compositionResourceRequiredSources,
  compositionResourceSamples,
  COMPOSITION_RESOURCE_PROFILE,
} from '../benchmarks/desktop/composition-profile.ts'
import { desktopProfile } from '../benchmarks/desktop/profiles.ts'
import {
  compositionPlan,
  compositionPhaseMarkers,
  compositionResize,
} from '../examples/composition-profile/plan.ts'
import profileComposition from '../examples/composition-profile/fixture.ts'
import type { CefBackend } from '../packages/runtime/src/cef.ts'
import { CONTRACT_VERSION, PROFILE_CAPABILITY_VERSION } from '../packages/contracts/src/index.ts'
import { desktopReportFixture } from './helpers/desktop-evidence.ts'

/** Deliberately synthetic parser inputs. They are not native or performance evidence. */
function fixture() {
  let ended = 0
  const receipt = {
    event: 'bunly.native.composition-profile',
    schema: 1,
    passed: true,
    phases: compositionPlan.map((phase) => {
      const startedMs = ended
      ended += phase.durationMs
      return {
        name: phase.name,
        startedMs,
        endedMs: ended,
        operationMs: Array.from({ length: phase.operations }, () => 1),
        visible: true,
        minimized: false,
        activeAtStart: true,
      }
    }),
    incarnations: { left: 5, right: 1, overlay: 5 },
    nativeFinal: {
      windows: 1,
      views: 0,
      sessions: 0,
      pending: 0,
      nativeDeliveryPackets: 0,
      nativeDeliveryBytes: 0,
      rpcIncomingBytes: 0,
      streamIncomingBytes: 0,
    },
    final: { windows: 0, views: 0, sessions: 0, listeners: 0, listenerErrors: 0 },
    failure: null,
    pendingPhase: null,
    physicalInputQualified: false,
    hardwareDpiQualified: false,
    assistiveTechnologyQualified: false,
    gpuMeasured: false,
    performanceEligible: false,
  }
  const report = desktopReportFixture({
    receipt,
    acceptance: null,
    profile: COMPOSITION_RESOURCE_PROFILE,
    sourcePaths: compositionResourceRequiredSources,
  })
  const observation = report['observation'] as {
    elapsedMs: number
    stderr: string[]
    samples: {
      elapsedMs: number
      phase: string
      rssBytes: number
      processes: { pid: number; creationTime: number; cpuSeconds: number; rssBytes: number }[]
    }[]
  }
  observation.elapsedMs = 30_000
  observation.stderr.unshift(
    ...compositionPhaseMarkers.map((phase) =>
      JSON.stringify({ event: 'bunly.composition.phase', schema: 1, phase })
    )
  )
  observation.samples = receipt.phases.flatMap((phase, index) =>
    [100, phase.endedMs - phase.startedMs - 100].map((offset, position) => ({
      elapsedMs: 1000 + phase.startedMs + offset,
      phase: `composition-${phase.name}`,
      rssBytes: 1000 + index,
      processes: [
        { pid: 1, creationTime: 10, cpuSeconds: index + position * 0.5, rssBytes: 1000 + index },
      ],
    }))
  )
  return { receipt, report, observation }
}

test('composition profile validates workload counts and preserves descriptive measurement limits', () => {
  const { receipt, report, observation } = fixture()
  assert.equal(acceptCompositionResourceReceipt(receipt).length, 6)
  const result = acceptCompositionResources(observation)
  assert.equal(result.classification, 'descriptive-windowed-cef-resources')
  assert.deepEqual(
    result.resources.map((row) => row.sampledCpuSeconds),
    [0.5, 0.5, 0.5, 0.5, 0.5, 0.5]
  )
  assert.equal(result.phases[2]!.operationRoundTripMs?.count, 40)
  assert.equal(result.gpuMeasured, false)
  assert.equal(result.performanceEligible, false)
  report['acceptance'] = result
  assert.deepEqual(acceptCompositionResourceReport(report), result)
  assert.equal(desktopProfile('composition-profile').profile, COMPOSITION_RESOURCE_PROFILE)
})

test('incomplete, reordered, shortened or inflated native phase receipts are rejected', () => {
  for (const change of [
    (value: ReturnType<typeof fixture>['receipt']) => {
      value.phases.pop()
    },
    (value: ReturnType<typeof fixture>['receipt']) => {
      value.phases.reverse()
    },
    (value: ReturnType<typeof fixture>['receipt']) => {
      value.phases[1]!.endedMs--
    },
    (value: ReturnType<typeof fixture>['receipt']) => {
      value.phases[2]!.operationMs.pop()
    },
    (value: ReturnType<typeof fixture>['receipt']) => {
      value.phases[3]!.operationMs[0] = 9999
    },
    (value: ReturnType<typeof fixture>['receipt']) => {
      value.gpuMeasured = true
    },
    (value: ReturnType<typeof fixture>['receipt']) => {
      value.nativeFinal.views = 1
    },
  ]) {
    const { receipt } = fixture()
    change(receipt)
    assert.throws(() => acceptCompositionResourceReceipt(receipt))
  }
})

test('phase markers require exact order, completeness and schema', () => {
  for (const change of [
    (lines: string[]) => {
      lines.splice(0, 1)
    },
    (lines: string[]) => {
      lines.splice(1, 0, lines[0]!)
    },
    (lines: string[]) => {
      ;[lines[0], lines[1]] = [lines[1]!, lines[0]!]
    },
    (lines: string[]) => {
      lines[0] = JSON.stringify({ event: 'bunly.composition.phase', schema: 1, phase: 'unknown' })
    },
    (lines: string[]) => {
      lines[0] = JSON.stringify({
        event: 'bunly.composition.phase',
        schema: 1,
        phase: compositionPhaseMarkers[0],
        passed: true,
      })
    },
  ]) {
    const { observation } = fixture()
    change(observation.stderr)
    assert.throws(() => compositionResourceSamples(observation))
  }
  const { observation } = fixture()
  const shifted = { ...observation, stdoutTail: [observation.stderr.shift()!] }
  assert.throws(() => compositionResourceSamples(shifted), 'Stdout cannot supply a phase marker')
})

test('CPU accounting uses PID plus birth and exposes unobserved birth/exit intervals', () => {
  const { observation } = fixture()
  const sample = observation.samples[3]!
  sample.processes.push({ pid: 2, creationTime: 20, cpuSeconds: 100, rssBytes: 100 })
  sample.rssBytes += 100
  const later = observation.samples[5]!
  later.processes[0]!.creationTime = 30 // PID reused: prior accumulated CPU is not work.
  later.processes.push({ pid: 3, creationTime: 40, cpuSeconds: 0, rssBytes: 10 })
  later.rssBytes += 10
  observation.samples[4]!.processes.push({ pid: 3, creationTime: 40, cpuSeconds: 0, rssBytes: 10 })
  observation.samples[4]!.rssBytes += 10
  const result = compositionResourceSamples(observation)
  assert.equal(result[1]!.sampledCpuSeconds, 0.5)
  assert.equal(result[1]!.unmatchedProcessIntervals, 1)
  assert.equal(result[2]!.sampledCpuSeconds, 0)
  assert.equal(result[2]!.matchedProcessIntervals, 1)
  assert.equal(result[2]!.unmatchedProcessIntervals, 2)
})

test('counter resets, missing samples, nonmonotonic time and altered RSS fail visibly', () => {
  for (const change of [
    (value: ReturnType<typeof fixture>['observation']) => {
      value.samples[1]!.processes[0]!.cpuSeconds = -1
    },
    (value: ReturnType<typeof fixture>['observation']) => {
      value.samples[3]!.processes[0]!.cpuSeconds = 0.5
    },
    (value: ReturnType<typeof fixture>['observation']) => {
      value.samples.splice(2, 2)
    },
    (value: ReturnType<typeof fixture>['observation']) => {
      value.samples[1]!.elapsedMs = 0
    },
    (value: ReturnType<typeof fixture>['observation']) => {
      value.samples[1]!.rssBytes++
    },
    (value: ReturnType<typeof fixture>['observation']) => {
      value.samples[3]!.phase = 'composition-warmup'
    },
    (value: ReturnType<typeof fixture>['observation']) => {
      value.samples[3]!.phase = 'unknown'
    },
  ]) {
    const { observation } = fixture()
    change(observation)
    assert.throws(() => compositionResourceSamples(observation))
  }
  for (const index of [-1, 0.5, 40, NaN]) assert.throws(() => compositionResize(index))
})

test('fixture setup failure retains failed outcome, bounded identity and actual cleanup attempt', async () => {
  const lines: string[] = []
  let cleanup = 0
  const backend = {
    descriptor: {
      contractVersion: CONTRACT_VERSION,
      capabilityVersion: PROFILE_CAPABILITY_VERSION,
      capabilities: ['view.composition', 'window.state'],
    },
    closed: new Promise<void>(() => {}),
    createWindow: async () => {
      throw new Error('/private/fixture?secret=never-export')
    },
    dispose: async () => {
      cleanup++
    },
    diagnostics: () => ({ windows: 0, views: 0, sessions: 0, listeners: 0, listenerErrors: 0 }),
  } as unknown as CefBackend
  const output = spyOn(console, 'error').mockImplementation((line) => {
    lines.push(String(line))
  })
  try {
    await assert.rejects(profileComposition(backend), /setup-or-cleanup: Error/)
  } finally {
    output.mockRestore()
  }
  assert.equal(cleanup, 1)
  assert.equal(lines.length, 1)
  const result = JSON.parse(lines[0]!)
  assert.equal(result.passed, false)
  assert.deepEqual(result.phases, [])
  assert.equal(lines[0]!.includes('never-export'), false)
  assert.throws(() => acceptCompositionResourceReceipt(result))
})
