import assert from 'node:assert/strict'
import {
  WINDOW_COMMAND_WORKLOAD_MS,
  windowCommandFixtureEvents,
} from '../../examples/window-commands/contract.ts'
import { nativeEvents } from '../lib/cef-acceptance.ts'
import { validateCommandObservation } from '../lib/observed-command.ts'
import {
  acceptDesktopEvidence,
  acceptDesktopObservation,
  desktopSourceSelectors,
} from './acceptance.ts'

export const COMMANDS_PROFILE = 'native-window-commands-v1'
// Historical profile selectors remain unchanged for replay of retained evidence.
export const commandsSourceSelectors = [
  ...desktopSourceSelectors,
  'examples/window-commands',
  'examples/managed-desktop/document-readiness.ts',
] as const
const requiredSources = [
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
] as const

function record(input: unknown): Record<string, unknown> {
  assert.ok(input && typeof input === 'object' && !Array.isArray(input), 'Expected record')
  return input as Record<string, unknown>
}

export function acceptWindowCommandsReceipt(input: unknown) {
  const receipt = record(input)
  assert.ok(Buffer.byteLength(JSON.stringify(receipt)) <= 8192)
  assert.deepEqual(Object.keys(receipt).sort(), [
    'abortReleased',
    'assistiveTechnologyQualified',
    'denied',
    'disposedOpenMenu',
    'duplicate',
    'event',
    'failure',
    'final',
    'forged',
    'hardwareDpiQualified',
    'input',
    'nativeFinal',
    'observations',
    'oversized',
    'passed',
    'performanceEligible',
    'physicalInputQualified',
    'schema',
    'sdkFinal',
    'shutdownSucceeded',
    'stale',
    'workloadMs',
  ])
  assert.equal(receipt['event'], 'bunly.native.window-commands')
  assert.equal(receipt['schema'], 1)
  assert.equal(receipt['passed'], true)
  assert.equal(receipt['failure'], null)
  assert.ok(
    typeof receipt['workloadMs'] === 'number' &&
      Number.isFinite(receipt['workloadMs']) &&
      receipt['workloadMs'] > 0 &&
      receipt['workloadMs'] <= WINDOW_COMMAND_WORKLOAD_MS
  )
  for (const check of [
    'denied',
    'forged',
    'oversized',
    'duplicate',
    'stale',
    'abortReleased',
    'disposedOpenMenu',
    'shutdownSucceeded',
  ])
    assert.equal(receipt[check], true, `Incomplete window command check: ${check}`)
  assert.deepEqual(receipt['input'], { syntheticNative: true, physical: false })
  for (const flag of [
    'physicalInputQualified',
    'hardwareDpiQualified',
    'assistiveTechnologyQualified',
    'performanceEligible',
  ])
    assert.equal(receipt[flag], false)
  assert.deepEqual(receipt['observations'], windowCommandFixtureEvents)
  assert.deepEqual(receipt['final'], { registrations: 0, shortcuts: 0, popups: 0 })
  assert.deepEqual(receipt['nativeFinal'], {
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
  })
  assert.deepEqual(receipt['sdkFinal'], {
    windows: 0,
    views: 0,
    sessions: 0,
    listeners: 0,
    listenerErrors: 0,
  })
  return Object.freeze({
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
}

export function acceptWindowCommands(input: unknown) {
  const result = acceptDesktopObservation(
    input,
    'bunly.native.window-commands',
    acceptWindowCommandsReceipt
  )
  const events = nativeEvents(validateCommandObservation(input))
  const receipt = events.findIndex((event) => event['event'] === 'bunly.native.window-commands')
  const processStop = events.findIndex(
    (event) =>
      event['event'] === 'bunly.host.shutdown-phase' &&
      event['phase'] === 'process-stop' &&
      event['state'] === 'start'
  )
  const backendExit = events.findIndex((event) => event['event'] === 'bunly.backend.exit')
  assert.ok(
    processStop < receipt && receipt < backendExit,
    'Application receipt must follow the private shutdown response and precede backend exit'
  )
  return result
}

export function acceptCommandsReport(input: unknown) {
  return acceptDesktopEvidence(input, COMMANDS_PROFILE, requiredSources, acceptWindowCommands)
}
