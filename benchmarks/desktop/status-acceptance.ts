import assert from 'node:assert/strict'
import { nativeEvents } from '../lib/cef-acceptance.ts'
import { validateCommandObservation } from '../lib/observed-command.ts'
import {
  acceptDesktopEvidence,
  acceptDesktopObservation,
  desktopSourceSelectors,
} from './acceptance.ts'

export const STATUS_PROFILE = 'native-status-items-v1'
export const statusSourceSelectors = [
  ...desktopSourceSelectors,
  'examples/status-items',
  'examples/managed-desktop/document-readiness.ts',
] as const
const requiredSources = [
  'packages/contracts/src/status-items.ts',
  'packages/runtime/src/cef-status-items.ts',
  'packages/runtime/src/managed-desktop.ts',
  'packages/runtime/src/managed-generations.ts',
  'native/cef-host/src/status_items.rs',
  'native/cef-host/src/status_items_macos.rs',
  'native/cef-host/src/capability_policy.rs',
  'native/cef-host/Cargo.toml',
  'examples/status-items/fixture.ts',
  'examples/status-items/public/index.html',
  'examples/managed-desktop/document-readiness.ts',
  'benchmarks/desktop/status-acceptance.ts',
] as const
function record(input: unknown): Record<string, unknown> {
  assert.ok(input && typeof input === 'object' && !Array.isArray(input))
  return input as Record<string, unknown>
}
export function acceptStatusItemsReceipt(input: unknown) {
  const receipt = record(input)
  assert.ok(Buffer.byteLength(JSON.stringify(receipt)) <= 4096)
  assert.deepEqual(Object.keys(receipt).sort(), [
    'assistiveTechnologyQualified',
    'backendFinal',
    'callbacks',
    'checks',
    'event',
    'failure',
    'final',
    'keepaliveQualified',
    'passed',
    'performanceEligible',
    'physicalInputQualified',
    'schema',
    'shutdown',
    'shutdowns',
    'status',
    'trayMenusQualified',
  ])
  assert.equal(receipt['event'], 'bunly.native.status-items')
  assert.equal(receipt['schema'], 1)
  assert.equal(receipt['passed'], true)
  assert.equal(receipt['failure'], null)
  assert.ok(receipt['status'] === 'executed' || receipt['status'] === 'unsupported')
  const executed = receipt['status'] === 'executed'
  assert.deepEqual(
    receipt['checks'],
    executed
      ? {
          missingGrantDenied: true,
          oversizedRejected: true,
          forgedRejected: true,
          duplicateRejected: true,
          updated: true,
          explicitRemoval: true,
          managedJournalRetained: true,
          managedRemoval: true,
          viewCloseRemoval: true,
          quitRemoval: true,
        }
      : { capabilityUnavailable: true, createUnsupported: true, quitRemoval: true }
  )
  assert.equal(receipt['callbacks'], executed ? 2 : 0)
  assert.equal(receipt['shutdowns'], 1)
  assert.deepEqual(receipt['shutdown'], {
    supported: executed,
    items: 0,
    delegates: 0,
    weakOwners: 0,
    created: executed ? 4 : 0,
    removed: executed ? 4 : 0,
    clicks: executed ? 2 : 0,
  })
  assert.deepEqual(receipt['final'], { items: 0, listeners: 0 })
  assert.deepEqual(receipt['backendFinal'], {
    windows: 0,
    views: 0,
    sessions: 0,
    listeners: 0,
    listenerErrors: 0,
  })
  for (const flag of [
    'physicalInputQualified',
    'trayMenusQualified',
    'keepaliveQualified',
    'assistiveTechnologyQualified',
    'performanceEligible',
  ])
    assert.equal(receipt[flag], false)
  return Object.freeze({
    status: executed ? 'executed' : 'unsupported',
    creations: executed ? 4 : 0,
    callbacks: executed ? 2 : 0,
    nativeOwners: 0,
    physicalInputQualified: false,
    trayMenusQualified: false,
    keepaliveQualified: false,
    assistiveTechnologyQualified: false,
    performanceEligible: false,
  })
}
export function acceptStatusItems(input: unknown) {
  const result = acceptDesktopObservation(
    input,
    'bunly.native.status-items',
    acceptStatusItemsReceipt
  )
  const events = nativeEvents(validateCommandObservation(input))
  const shutdowns = events.filter((event) => event['event'] === 'bunly.host.status-shutdown')
  assert.equal(shutdowns.length, 1)
  assert.deepEqual(Object.keys(shutdowns[0]!).sort(), ['event', 'state'])
  const receipt = events.find((event) => event['event'] === 'bunly.native.status-items')!
  assert.deepEqual(shutdowns[0]!['state'], receipt['shutdown'])
  const processStop = events.findIndex(
    (event) =>
      event['event'] === 'bunly.host.shutdown-phase' &&
      event['phase'] === 'process-stop' &&
      event['state'] === 'start'
  )
  const backendExit = events.findIndex((event) => event['event'] === 'bunly.backend.exit')
  assert.ok(events.indexOf(shutdowns[0]!) < processStop)
  assert.ok(processStop < events.indexOf(receipt) && events.indexOf(receipt) < backendExit)
  return result
}
export function acceptStatusReport(input: unknown) {
  const result = acceptDesktopEvidence(input, STATUS_PROFILE, requiredSources, acceptStatusItems)
  assert.equal(
    result.status,
    record(input)['target'] === 'darwin-arm64' ? 'executed' : 'unsupported'
  )
  return result
}
