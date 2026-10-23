import assert from 'node:assert/strict'
import { nativeEvents } from './cef-acceptance.ts'
import { observeNativeShutdown, requireNativeShutdown } from '../foundation/native-shutdown.ts'
import { assertCleanCommand, type CommandObservation } from './observed-command.ts'

export const nativePolicyCallbacks = Object.freeze([
  'policy.media-denied',
  'policy.permission-denied',
  'policy.popup-denied',
  'policy.download-denied',
] as const)

/** A generic development success or a page marker cannot substitute for native
 * callback receipts, scope revocation and the completed ordered host teardown.
 */
export function acceptNativePolicy(report: CommandObservation, deniedRequests: number): void {
  assertCleanCommand(report)
  requireNativeShutdown(observeNativeShutdown(report))
  assert.equal(deniedRequests, 0, 'Forbidden origin received a network request')
  const records = nativeEvents(report).filter(
    (event) => event['event'] === 'bunly.native.development'
  )
  assert.equal(records.length, 1, 'Native policy evidence missing or duplicated')
  assert.deepEqual(records[0], {
    event: 'bunly.native.development',
    schema: 2,
    passed: true,
    scopeRevoked: true,
    activation: 'native-fixed-fixture',
    policyCallbacks: nativePolicyCallbacks,
  })
}
