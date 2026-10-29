import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'bun:test'
import {
  COMMANDS_PROFILE,
  acceptWindowCommandsReceipt,
  acceptWindowCommands,
  acceptCommandsReport,
} from '../benchmarks/desktop/commands-acceptance.ts'
import { desktopProfile, desktopReportProfile } from '../benchmarks/desktop/profiles.ts'
import {
  WINDOW_COMMAND_WORKLOAD_MS,
  windowCommandFixtureEvents,
} from '../examples/window-commands/contract.ts'
import { desktopReportFixture } from './helpers/desktop-evidence.ts'

// Synthetic parser/rejection inputs only. No test here is native execution evidence.
function receipt() {
  return {
    event: 'bunly.native.window-commands',
    schema: 1,
    passed: true,
    workloadMs: 1000,
    input: { syntheticNative: true, physical: false },
    denied: true,
    forged: true,
    oversized: true,
    duplicate: true,
    stale: true,
    abortReleased: true,
    disposedOpenMenu: true,
    observations: windowCommandFixtureEvents.map((event): Record<string, unknown> => ({
      ...event,
    })),
    final: { registrations: 0, shortcuts: 0, popups: 0 },
    nativeFinal: {
      windows: 1,
      views: 0,
      sessions: 0,
      rpcBindings: 0,
      pending: 0,
      downloads: 0,
      nativeDeliveryPackets: 0,
      nativeDeliveryBytes: 0,
      rpcIncomingBytes: 0,
      streamIncomingBytes: 0,
    },
    sdkFinal: { windows: 0, views: 0, sessions: 0, listeners: 0, listenerErrors: 0 },
    shutdownSucceeded: true,
    failure: null as string | null,
    physicalInputQualified: false,
    hardwareDpiQualified: false,
    assistiveTechnologyQualified: false,
    performanceEligible: false,
  }
}
function report(target = 'linux-x64') {
  const value = receipt()
  const output = desktopReportFixture({
    receipt: value,
    acceptance: acceptWindowCommandsReceipt(value),
    profile: COMMANDS_PROFILE,
    target,
    sourcePaths: [
      'packages/contracts/src/window-commands.ts',
      'packages/runtime/src/cef-window-commands.ts',
      'packages/runtime/src/managed-desktop.ts',
      'packages/runtime/src/managed-generations.ts',
      'packages/runtime/src/native-capacity.json',
      'native/cef-host/Cargo.toml',
      'native/cef-host/Cargo.lock',
      'native/cef-host/src/capability_policy.rs',
      'native/cef-host/src/command_budget.rs',
      'native/cef-host/src/window_commands.rs',
      'native/cef-host/src/native_modal.rs',
      'native/cef-host/src/file_guards.rs',
      'native/cef-host/src/lib.rs',
      'examples/window-commands/fixture.ts',
      'examples/window-commands/observations.ts',
      'examples/window-commands/contract.ts',
      'examples/window-commands/public/index.html',
      'examples/managed-desktop/document-readiness.ts',
      'benchmarks/desktop/commands-acceptance.ts',
      'benchmarks/desktop/profiles.ts',
      'benchmarks/lib/native-diagnostic-events.json',
      'scripts/hosted_cef.py',
      'scripts/qualify-cef-window-modes-linux.py',
    ],
  })
  const observation = output['observation'] as { stderr: string[] }
  const application = observation.stderr.shift()!
  observation.stderr.splice(1, 0, application)
  return output
}

test('menu acceptance requires exact ordered native shortcut and popup callback observations', () => {
  assert.deepEqual(acceptWindowCommandsReceipt(receipt()), {
    events: 7,
    popupOpenings: 3,
    selectedCommands: 2,
    cancelledMenus: 1,
    disposedOpenMenus: 1,
    nativeOwnershipReleased: true,
    syntheticNativeInput: true,
    physicalInputQualified: false,
    hardwareDpiQualified: false,
    assistiveTechnologyQualified: false,
    performanceEligible: false,
  })
  for (const mutate of [
    (r: ReturnType<typeof receipt>) => r.observations.pop(),
    (r: ReturnType<typeof receipt>) => r.observations.reverse(),
    (r: ReturnType<typeof receipt>) => r.observations.push({ type: 'menu-closed', sequence: 8 }),
    (r: ReturnType<typeof receipt>) => (r.observations[0]!['sequence'] = 0),
    (r: ReturnType<typeof receipt>) => (r.observations[1]!['sequence'] = 1),
    (r: ReturnType<typeof receipt>) => (r.observations[1]!['type'] = 'menu-failed'),
    (r: ReturnType<typeof receipt>) => (r.observations[2]!['source'] = 'shortcut'),
    (r: ReturnType<typeof receipt>) => (r.observations[2]!['command'] = 'disabled'),
    (r: ReturnType<typeof receipt>) => (r.observations[5]!['type'] = 'menu-shown'),
  ]) {
    const value = receipt()
    mutate(value)
    assert.throws(() => acceptWindowCommandsReceipt(value))
  }
})

test('menu acceptance rejects omitted policy, cancellation or native ownership checks', () => {
  for (const field of [
    'denied',
    'forged',
    'oversized',
    'duplicate',
    'stale',
    'abortReleased',
    'disposedOpenMenu',
    'shutdownSucceeded',
  ] as const) {
    const value = receipt()
    value[field] = false
    assert.throws(() => acceptWindowCommandsReceipt(value))
  }
  for (const mutate of [
    (r: ReturnType<typeof receipt>) => (r.final.registrations = 1),
    (r: ReturnType<typeof receipt>) => (r.final.shortcuts = 1),
    (r: ReturnType<typeof receipt>) => (r.final.popups = 1),
    (r: ReturnType<typeof receipt>) => (r.nativeFinal.windows = 0),
    (r: ReturnType<typeof receipt>) => (r.nativeFinal.views = 1),
    (r: ReturnType<typeof receipt>) => (r.nativeFinal.sessions = 1),
    (r: ReturnType<typeof receipt>) => (r.nativeFinal.pending = 1),
    (r: ReturnType<typeof receipt>) => (r.nativeFinal.rpcBindings = 1),
    (r: ReturnType<typeof receipt>) => (r.sdkFinal.windows = 1),
    (r: ReturnType<typeof receipt>) => (r.sdkFinal.listeners = 1),
    (r: ReturnType<typeof receipt>) => (r.sdkFinal.listenerErrors = 1),
  ]) {
    const value = receipt()
    mutate(value)
    assert.throws(() => acceptWindowCommandsReceipt(value))
  }
})

test('menu acceptance retains deadline, failure and nonphysical qualification boundaries', () => {
  for (const mutate of [
    (r: ReturnType<typeof receipt>) => (r.workloadMs = 0),
    (r: ReturnType<typeof receipt>) => (r.workloadMs = Number.NaN),
    (r: ReturnType<typeof receipt>) => (r.workloadMs = WINDOW_COMMAND_WORKLOAD_MS + 1),
    (r: ReturnType<typeof receipt>) => (r.passed = false),
    (r: ReturnType<typeof receipt>) => (r.failure = 'cleanup'),
    (r: ReturnType<typeof receipt>) => (r.input.syntheticNative = false),
    (r: ReturnType<typeof receipt>) => (r.input.physical = true),
    (r: ReturnType<typeof receipt>) => (r.physicalInputQualified = true),
    (r: ReturnType<typeof receipt>) => (r.hardwareDpiQualified = true),
    (r: ReturnType<typeof receipt>) => (r.assistiveTechnologyQualified = true),
    (r: ReturnType<typeof receipt>) => (r.performanceEligible = true),
  ]) {
    const value = receipt()
    mutate(value)
    assert.throws(() => acceptWindowCommandsReceipt(value))
  }
  assert.throws(() => acceptWindowCommandsReceipt({ ...receipt(), extra: true }))
  assert.throws(() => acceptWindowCommandsReceipt({ ...receipt(), input: { physical: false } }))
})

test('menu observations require completed shutdown and one application result after process-stop', () => {
  const value = report()
  assert.deepEqual(acceptWindowCommands(value['observation']), value['acceptance'])
  for (const mutate of [
    (lines: string[]) => lines.splice(1, 1),
    (lines: string[]) => lines.splice(2, 0, lines[1]!),
    (lines: string[]) => lines.unshift(lines.splice(1, 1)[0]!),
    (lines: string[]) => lines.push(lines.splice(1, 1)[0]!),
    (lines: string[]) => lines.pop(),
    (lines: string[]) => {
      const index = lines.findIndex((line) => line.includes('bunly.native.output-drained'))
      const drain = JSON.parse(lines[index]!) as Record<string, unknown>
      drain['frames'] = 1
      lines[index] = JSON.stringify(drain)
    },
  ]) {
    const observation = structuredClone(value['observation']) as { stderr: string[] }
    mutate(observation.stderr)
    assert.throws(() => acceptWindowCommands(observation))
  }
})

test('menu reports preserve source, binary identity, platform and observer acceptance gates', () => {
  for (const target of ['linux-x64', 'win32-x64']) {
    const value = report(target)
    assert.deepEqual(acceptCommandsReport(value), value['acceptance'])
  }
  // This synthetic helper supplies no positive macOS signing-clone cleanup evidence.
  assert.throws(() => acceptCommandsReport(report('darwin-arm64')), /cleanup/)
  for (const mutate of [
    (r: Record<string, unknown>) => (r['profile'] = desktopProfile().profile),
    (r: Record<string, unknown>) => (r['observerTimeoutMs'] = 45_001),
    (r: Record<string, unknown>) => (r['inputArtifactUnchanged'] = false),
    (r: Record<string, unknown>) => (r['preparedArtifactUnchanged'] = false),
    (r: Record<string, unknown>) => {
      const source = r['sourceHashes'] as { path: string }[]
      r['sourceHashes'] = source.filter(
        (entry) => entry.path !== 'native/cef-host/src/native_modal.rs'
      )
      r['sourceHashesAfter'] = structuredClone(r['sourceHashes'])
    },
    (r: Record<string, unknown>) => {
      const observer = r['observation'] as Record<string, unknown>
      observer['cleanupSurvivors'] = [123]
    },
    (r: Record<string, unknown>) => {
      const observer = r['observation'] as Record<string, unknown>
      observer['elapsedMs'] = 60_001
    },
  ]) {
    const value = report()
    mutate(value)
    assert.throws(() => acceptCommandsReport(value))
  }
})

test('menu profile inventories its fixture without changing historical desktop selectors', () => {
  const profile = desktopProfile('commands')
  assert.equal(profile.profile, COMMANDS_PROFILE)
  assert.equal(profile.browserEntry, null)
  assert.equal(profile.directory, 'window-commands')
  assert.equal(desktopReportProfile(COMMANDS_PROFILE), profile)
  assert.ok(
    profile.sourceSelectors.some((selector: string) => selector === 'examples/window-commands')
  )
  for (const prior of ['windows', 'composition', 'services', 'downloads'])
    assert.ok(
      !desktopProfile(prior).sourceSelectors.some(
        (selector: string) => selector === 'examples/window-commands'
      )
    )
  const events = JSON.parse(
    readFileSync(
      new URL('../benchmarks/lib/native-diagnostic-events.json', import.meta.url),
      'utf8'
    )
  ) as string[]
  assert.equal(events.filter((event) => event === 'bunly.native.window-commands').length, 1)
})
