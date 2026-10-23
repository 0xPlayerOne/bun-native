import assert from 'node:assert/strict'
import { nativeEvents, acceptNativeSmoke } from './cef-acceptance.ts'
import { observeNativeShutdown, requireNativeShutdown } from '../foundation/native-shutdown.ts'
import type { CommandObservation } from './observed-command.ts'

export const nativeRpcCases = Object.freeze(
  [
    'duplicate-ready',
    'duplicate-subscription',
    'invalid-number',
    'stale-ack',
    'stale-generation',
    'stale-grant',
    'stale-result',
    'stale-revoke',
    'wrong-connection',
    'wrong-context',
    'wrong-frame',
  ].sort()
)

/** Validate retained native observations; a generic/older smoke flag is insufficient. */
export function acceptNativeRpc(report: CommandObservation, requireMacCleanup = false): void {
  acceptNativeSmoke(report)
  requireNativeShutdown(observeNativeShutdown(report))
  if (requireMacCleanup)
    assert.equal(
      report.postExitCleanup?.qualified,
      true,
      'Native RPC helper/clone cleanup was not qualified'
    )
  const records = nativeEvents(report).filter((event) => event['event'] === 'bunly.native.rpc')
  assert.equal(records.length, 1, 'Native RPC evidence missing or duplicated')
  assert.deepEqual(
    records[0],
    {
      event: 'bunly.native.rpc',
      schema: 4,
      sessionAuthority: 'native-owner-isolation-and-partition-reuse',
      viewDisposal: 'isolated-and-parent-close',
      renderer: {
        schema: 2,
        json: 'bun:renderer',
        binary: [0, 1, 2, 127, 128, 255],
        cancellation: 'backend-started-and-aborted',
        validation: 'backend-rejected-invalid-input',
      },
      hostileExternalScript: true,
      lifecycleCycles: 2,
      navigationPending: true,
      closePending: true,
      returnUnprivileged: true,
      remoteUnprivileged: true,
      staleDelivered: false,
      resourcesBounded: true,
      protocolCases: nativeRpcCases,
    },
    'Native RPC workload evidence does not match the required cases'
  )
}
