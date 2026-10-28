import assert from 'node:assert/strict'
import {
  parentCloseDocumentTarget,
  parentClosePanes,
} from '../../examples/view-parent-close/receipts.ts'
import {
  acceptDesktopEvidence,
  acceptDesktopObservation,
  desktopSourceSelectors,
} from './acceptance.ts'

export const PARENT_CLOSE_PROFILE = 'native-view-parent-close-v1'
export const parentCloseSourceSelectors = [
  ...desktopSourceSelectors,
  'examples/view-parent-close',
  'examples/view-composition/lifetime.ts',
  'examples/managed-desktop/document-readiness.ts',
] as const
export const parentCloseRequiredSources = [
  'native/cef-host/src/view_close.rs',
  'examples/view-parent-close/fixture.ts',
  'examples/view-parent-close/receipts.ts',
  'examples/view-parent-close/public/index.html',
  'examples/view-composition/lifetime.ts',
  'examples/managed-desktop/document-readiness.ts',
  'benchmarks/desktop/parent-close-acceptance.ts',
] as const

function record(input: unknown): Record<string, unknown> {
  assert.ok(input && typeof input === 'object' && !Array.isArray(input))
  return input as Record<string, unknown>
}
function identity(input: unknown): asserts input is string {
  assert.ok(typeof input === 'string' && /^[A-Za-z0-9_-]{1,128}$/.exec(input)?.[0] === input)
}

export function acceptParentCloseReceipt(input: unknown) {
  const receipt = record(input)
  assert.ok(Buffer.byteLength(JSON.stringify(receipt)) <= 8192)
  assert.deepEqual(Object.keys(receipt).sort(), [
    'assistiveTechnologyQualified',
    'before',
    'controlSurvived',
    'event',
    'failure',
    'final',
    'hardwareDpiQualified',
    'nativeFinal',
    'observations',
    'osQuitQualified',
    'passed',
    'performanceEligible',
    'physicalInputQualified',
    'schema',
    'sessionsReleasedAfterNativeClose',
  ])
  assert.equal(receipt['event'], 'bunly.native.view-parent-close')
  assert.equal(receipt['schema'], 1)
  assert.equal(receipt['passed'], true)
  assert.equal(receipt['failure'], null)
  for (const field of [
    'osQuitQualified',
    'physicalInputQualified',
    'hardwareDpiQualified',
    'assistiveTechnologyQualified',
    'performanceEligible',
  ])
    assert.equal(receipt[field], false)
  assert.deepEqual(receipt['before'], { windows: 2, views: 4, sessions: 4 })
  assert.equal(receipt['sessionsReleasedAfterNativeClose'], 4)
  assert.equal(receipt['controlSurvived'], true)
  const observations = record(receipt['observations'])
  assert.deepEqual(Object.keys(observations).sort(), [
    'nativeViewCloseCallbacks',
    'nativeWindowCloseCallbacks',
    'nativeWindowTarget',
    'panes',
  ])
  assert.equal(observations['nativeViewCloseCallbacks'], 4)
  assert.equal(observations['nativeWindowCloseCallbacks'], 1)
  assert.ok(
    Number.isSafeInteger(observations['nativeWindowTarget']) &&
      Number(observations['nativeWindowTarget']) > 0
  )
  const panes = observations['panes']
  assert.ok(Array.isArray(panes) && panes.length === parentClosePanes.length)
  const targets = new Set<number>()
  const views = new Set<string>()
  const sessions = new Set<string>()
  const documents = new Set<string>()
  for (const [index, value] of panes.entries()) {
    const pane = record(value)
    assert.deepEqual(Object.keys(pane).sort(), [
      'closed',
      'documentId',
      'nativeTarget',
      'pane',
      'sessionId',
      'viewId',
    ])
    assert.equal(pane['pane'], parentClosePanes[index])
    identity(pane['viewId'])
    identity(pane['sessionId'])
    identity(pane['documentId'])
    const target = parentCloseDocumentTarget(pane['documentId'])
    assert.equal(pane['nativeTarget'], target)
    assert.notEqual(target, observations['nativeWindowTarget'])
    assert.equal(pane['closed'], true)
    assert.ok(
      !targets.has(target) &&
        !views.has(pane['viewId']) &&
        !sessions.has(pane['sessionId']) &&
        !documents.has(pane['documentId'])
    )
    targets.add(target)
    views.add(pane['viewId'])
    sessions.add(pane['sessionId'])
    documents.add(pane['documentId'])
  }
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
  return Object.freeze({
    livePanesAtParentClose: 4,
    nativeViewCloseCallbacks: 4,
    nativeWindowCloseCallbacks: 1,
    controlSurvived: true,
    sessionsReleasedAfterNativeClose: 4,
    osQuitQualified: false,
    physicalInputQualified: false,
    hardwareDpiQualified: false,
    assistiveTechnologyQualified: false,
    performanceEligible: false,
  })
}

export function acceptParentClose(input: unknown) {
  return acceptDesktopObservation(input, 'bunly.native.view-parent-close', acceptParentCloseReceipt)
}
export function acceptParentCloseReport(input: unknown) {
  return acceptDesktopEvidence(
    input,
    PARENT_CLOSE_PROFILE,
    parentCloseRequiredSources,
    acceptParentClose
  )
}
