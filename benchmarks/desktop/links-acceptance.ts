import assert from 'node:assert/strict'
import { applicationLinkChecks } from '../../examples/application-links/contract.ts'
import { nativeEvents } from '../lib/cef-acceptance.ts'
import { validateCommandObservation } from '../lib/observed-command.ts'
import {
  acceptDesktopEvidence,
  acceptDesktopObservation,
  desktopSourceSelectors,
} from './acceptance.ts'

export const LINKS_PROFILE = 'native-application-links-v1'
export const linksSourceSelectors = [
  ...desktopSourceSelectors,
  'examples/application-links',
  'examples/managed-desktop/document-readiness.ts',
  'examples/file-dialogs/readiness.ts',
] as const
const requiredSources = [
  'packages/contracts/src/application-links.ts',
  'packages/runtime/src/cef-application-links.ts',
  'packages/runtime/src/managed-desktop.ts',
  'packages/runtime/src/managed-generations.ts',
  'native/cef-host/src/application_links.rs',
  'native/cef-host/src/application_links_macos.rs',
  'native/cef-host/src/application_links_windows.rs',
  'native/cef-host/src/capability_policy.rs',
  'examples/application-links/fixture.ts',
  'examples/application-links/contract.ts',
  'examples/application-links/public/index.html',
  'examples/file-dialogs/readiness.ts',
  'benchmarks/desktop/links-acceptance.ts',
] as const
function record(input: unknown): Record<string, unknown> {
  assert.ok(input && typeof input === 'object' && !Array.isArray(input))
  return input as Record<string, unknown>
}
export function acceptApplicationLinksReceipt(input: unknown) {
  const receipt = record(input)
  assert.ok(Buffer.byteLength(JSON.stringify(receipt)) <= 4096)
  assert.deepEqual(Object.keys(receipt).sort(), [
    'backendFinal',
    'checks',
    'event',
    'externalLaunchQualified',
    'failure',
    'final',
    'liveOsDeliveryQualified',
    'osRegistrationQualified',
    'passed',
    'performanceEligible',
    'physicalInputQualified',
    'schema',
    'shutdown',
    'shutdowns',
  ])
  assert.equal(receipt['event'], 'bunly.native.application-links')
  assert.equal(receipt['schema'], 1)
  assert.equal(receipt['passed'], true)
  assert.equal(receipt['failure'], null)
  assert.deepEqual(
    receipt['checks'],
    Object.fromEntries(applicationLinkChecks.map((check) => [check, true]))
  )
  assert.equal(receipt['shutdowns'], 1)
  assert.deepEqual(receipt['shutdown'], {
    readers: 0,
    queued: 0,
    bytes: 0,
    overflow: 0,
    startup: 2,
    macos: 0,
    rejected: 1,
    acknowledged: 2,
    delegates: 0,
  })
  assert.deepEqual(receipt['final'], { readers: 0 })
  assert.deepEqual(receipt['backendFinal'], {
    windows: 0,
    views: 0,
    sessions: 0,
    listeners: 0,
    listenerErrors: 0,
  })
  for (const flag of [
    'osRegistrationQualified',
    'liveOsDeliveryQualified',
    'externalLaunchQualified',
    'physicalInputQualified',
    'performanceEligible',
  ])
    assert.equal(receipt[flag], false)
  return Object.freeze({
    startupAccepted: 2,
    startupRejected: 1,
    acknowledged: 2,
    nativeOwners: 0,
    osRegistrationQualified: false,
    liveOsDeliveryQualified: false,
    externalLaunchQualified: false,
    physicalInputQualified: false,
    performanceEligible: false,
  })
}
export function acceptApplicationLinks(input: unknown) {
  const result = acceptDesktopObservation(
    input,
    'bunly.native.application-links',
    acceptApplicationLinksReceipt
  )
  const events = nativeEvents(validateCommandObservation(input))
  const shutdowns = events.filter((event) => event['event'] === 'bunly.host.links-shutdown')
  assert.equal(shutdowns.length, 1)
  assert.deepEqual(Object.keys(shutdowns[0]!).sort(), ['event', 'state'])
  const receipt = events.find((event) => event['event'] === 'bunly.native.application-links')!
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
export function acceptApplicationLinksReport(input: unknown) {
  return acceptDesktopEvidence(input, LINKS_PROFILE, requiredSources, acceptApplicationLinks)
}
