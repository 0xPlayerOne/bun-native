import assert from 'node:assert/strict'
import {
  acceptDesktopEvidence,
  acceptDesktopObservation,
  desktopSourceSelectors,
} from './acceptance.ts'

export const SERVICES_PROFILE = 'native-desktop-services-v1'
export const servicesSourceSelectors = [
  ...desktopSourceSelectors,
  'examples/desktop-services',
  'examples/managed-desktop/document-readiness.ts',
] as const
const requiredSources = [
  'packages/contracts/src/desktop.ts',
  'packages/runtime/src/application-lifecycle.ts',
  'native/cef-host/src/clipboard.rs',
  'examples/desktop-services/fixture.ts',
  'examples/desktop-services/clipboard-fixture.ts',
  'examples/managed-desktop/document-readiness.ts',
  'scripts/cef-desktop-services-precondition.ts',
  'benchmarks/desktop/services-acceptance.ts',
] as const

function record(input: unknown): Record<string, unknown> {
  assert.ok(input && typeof input === 'object' && !Array.isArray(input), 'Expected record')
  return input as Record<string, unknown>
}

export function acceptDesktopServicesReceipt(input: unknown) {
  const receipt = record(input)
  assert.ok(Buffer.byteLength(JSON.stringify(receipt)) <= 4096)
  assert.deepEqual(Object.keys(receipt).sort(), [
    'assistiveTechnologyQualified',
    'clipboard',
    'event',
    'eventOverflow',
    'events',
    'failure',
    'final',
    'hardwareDpiQualified',
    'nativeFinal',
    'passed',
    'performanceEligible',
    'physicalInputQualified',
    'ready',
    'schema',
    'staleScopeRejected',
  ])
  assert.equal(receipt['event'], 'bunly.native.desktop-services')
  assert.equal(receipt['schema'], 1)
  assert.equal(receipt['passed'], true)
  assert.equal(receipt['failure'], null)
  assert.equal(receipt['ready'], true)
  assert.equal(receipt['staleScopeRejected'], true)
  assert.equal(receipt['eventOverflow'], false)
  for (const flag of [
    'physicalInputQualified',
    'hardwareDpiQualified',
    'assistiveTechnologyQualified',
    'performanceEligible',
  ])
    assert.equal(receipt[flag], false)
  const clipboard = record(receipt['clipboard'])
  if (clipboard['status'] === 'unsupported') {
    assert.deepEqual(clipboard, { status: 'unsupported' })
  } else {
    assert.deepEqual(clipboard, {
      status: 'executed',
      deniedRead: true,
      deniedWrite: true,
      deniedClear: true,
      initiallyEmpty: true,
      oversizedRejected: true,
      preAbortedReadRejected: true,
      unicodeRoundTrip: true,
      emptyStringDistinct: true,
      utf8ByteBoundary: true,
      clearRemovedFormats: true,
      restoredEmpty: true,
    })
  }
  assert.deepEqual(receipt['events'], [
    { type: 'quit-requested' },
    { type: 'quitting', reason: 'requested' },
    { type: 'closed', outcome: 'orderly' },
  ])
  assert.deepEqual(receipt['final'], {
    phase: 'closed',
    quitRequested: true,
    quitReason: 'requested',
    outcome: 'orderly',
  })
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
  return Object.freeze({
    clipboard: clipboard['status'] as 'executed' | 'unsupported',
    applicationEvents: 3,
    staleScopeRejected: true,
    physicalInputQualified: false,
    hardwareDpiQualified: false,
    assistiveTechnologyQualified: false,
    performanceEligible: false,
  })
}

export function acceptDesktopServices(input: unknown) {
  return acceptDesktopObservation(
    input,
    'bunly.native.desktop-services',
    acceptDesktopServicesReceipt
  )
}

export function acceptServicesReport(input: unknown) {
  const result = acceptDesktopEvidence(
    input,
    SERVICES_PROFILE,
    requiredSources,
    acceptDesktopServices
  )
  const report = record(input)
  const target = report['target']
  if (target === 'linux-x64') {
    assert.equal(result.clipboard, 'unsupported')
    assert.deepEqual(report['clipboardLaunch'], { mode: 'unsupported', target })
  } else {
    assert.equal(result.clipboard, 'executed')
    const launch = record(report['clipboardLaunch'])
    const runId = launch['runId']
    assert.ok(typeof runId === 'string' && /^[1-9][0-9]{0,19}$/.test(runId))
    assert.deepEqual(launch, {
      mode: 'disposable-github-hosted',
      target,
      explicitOptIn: true,
      runId,
    })
    assert.equal(record(record(report['observation'])['environment'])['runClass'], 'ci-smoke')
  }
  return result
}
