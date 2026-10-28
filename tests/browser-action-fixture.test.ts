/** Receipt-validator tests do not qualify native CEF behavior. */
import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { acceptBrowserActionReceipt } from '../scripts/qualify-browser-actions.ts'
const checks = [
  'ungrantedDenied',
  'png',
  'approvedEvaluation',
  'boundedObservations',
  'syntheticInput',
  'beforeinputRevalidated',
  'crossOriginFrameDenied',
  'oversizedResultsDenied',
  'otherSessionDenied',
  'cancellationSettled',
  'navigationRevoked',
  'closeSettled',
  'zeroOwners',
]
const receipt = () => ({
  event: 'bunly.native.browser-actions',
  schema: 1,
  passed: true,
  failure: null,
  workloadMs: 1000,
  checks: Object.fromEntries(checks.map((key) => [key, true])),
  screenshot: { bytes: 100, width: 128, height: 96, sha256: 'a'.repeat(64) },
  accessibility: 'supported',
  nativeSettled: {
    operations: 0,
    registrations: 0,
    callbacks: 0,
    byteLeases: 0,
    ownedBytes: 0,
    reservedBytes: 0,
    deadlineWorkers: 0,
    admitted: 20,
    completed: 15,
    failed: 5,
  },
  final: { views: 0, windows: 0, sessions: 0, listeners: 0, listenerErrors: 0 },
  syntheticInput: true,
  trustedInputQualified: false,
  performanceEligible: false,
})
test('browser qualification accepts explicit AX unavailability without claiming an empty tree', () => {
  acceptBrowserActionReceipt(receipt())
  acceptBrowserActionReceipt({ ...receipt(), accessibility: 'unsupported' })
  assert.throws(() => acceptBrowserActionReceipt({ ...receipt(), accessibility: 'empty-success' }))
})
test('browser qualification requires every declared actual fixture check', () => {
  for (const key of checks) {
    const value = receipt()
    value.checks[key] = false
    assert.throws(() => acceptBrowserActionReceipt(value), key)
  }
})
test('browser qualification rejects retained owners or inconsistent terminal accounting', () => {
  for (const key of [
    'operations',
    'registrations',
    'callbacks',
    'byteLeases',
    'ownedBytes',
    'reservedBytes',
    'deadlineWorkers',
  ]) {
    const value = receipt()
    assert.throws(
      () =>
        acceptBrowserActionReceipt({
          ...value,
          nativeSettled: { ...value.nativeSettled, [key]: 1 },
        }),
      key
    )
  }
  const value = receipt()
  assert.throws(() =>
    acceptBrowserActionReceipt({
      ...value,
      nativeSettled: { ...value.nativeSettled, admitted: 21 },
    })
  )
})
test('browser qualification refuses oversized screenshots, raw payload fields and physical input claims', () => {
  for (const extra of [
    { trustedInputQualified: true },
    { performanceEligible: true },
    { rawProtocolPayload: 'sensitive' },
    { workloadMs: 45001 },
    { failure: 'native:Error' },
  ])
    assert.throws(() => acceptBrowserActionReceipt({ ...receipt(), ...extra }))
  const value = receipt()
  assert.throws(() =>
    acceptBrowserActionReceipt({
      ...value,
      screenshot: { ...value.screenshot, bytes: 1024 * 1024 + 1 },
    })
  )
})
