import assert from 'node:assert/strict'
import { nativeEvents } from './cef-acceptance.ts'
import { assertCleanCommand, type CommandObservation } from './observed-command.ts'
import { observeNativeShutdown, requireNativeShutdown } from '../foundation/native-shutdown.ts'

export const nativeNetworkCases = Object.freeze([
  'default-session-denial',
  'exact-session-isolation',
  'allowed-subresources',
  'denied-resource-redirect',
  'hostile-cross-origin-frame',
  'service-worker-denial',
  'allowed-cross-origin-redirect',
  'denied-navigation-redirect',
  'remote-application-trust-denied',
  'certificate-error-denied',
  'ordinary-https-navigation',
  'trusted-navigation-aborts-rpc',
  'return-does-not-regrant',
  'resources-converge',
] as const)

export function acceptNativeNetwork(
  report: CommandObservation,
  traffic: {
    readonly forbidden: number
    readonly untrustedTls: number
    readonly child: number
    readonly isolatedLeak: number
    readonly worker: number
    readonly allowedData: number
  }
): void {
  assertCleanCommand(report)
  requireNativeShutdown(observeNativeShutdown(report))
  assert.equal(traffic.forbidden, 0, 'Forbidden origin received HTTP traffic')
  assert.equal(traffic.isolatedLeak, 0, 'Another session borrowed network origins')
  assert.ok(Number.isSafeInteger(traffic.worker) && traffic.worker >= 1 && traffic.worker <= 32)
  assert.equal(traffic.untrustedTls, 0, 'Untrusted TLS server received an application request')
  assert.ok(Number.isSafeInteger(traffic.child) && traffic.child >= 1 && traffic.child <= 32)
  assert.ok(
    Number.isSafeInteger(traffic.allowedData) &&
      traffic.allowedData >= 2 &&
      traffic.allowedData <= 128
  )
  const records = nativeEvents(report).filter((event) => event['event'] === 'bunly.native.network')
  assert.equal(records.length, 1, 'Network acceptance record is missing or duplicated')
  assert.deepEqual(records[0], {
    event: 'bunly.native.network',
    schema: 1,
    passed: true,
    cases: nativeNetworkCases,
    certificatePolicy: 'ordinary-verifier-no-exception',
    fixture: 'loopback-public-https-and-untrusted-tls',
  })
}
