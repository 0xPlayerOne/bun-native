import assert from 'node:assert/strict'
import { nativeEvents, acceptNativeSmoke } from './cef-acceptance.ts'
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
export function acceptNativeRpc(report: CommandObservation): void {
  acceptNativeSmoke(report)
  const records = nativeEvents(report).filter((event) => event['event'] === 'bunly.native.rpc')
  assert.equal(records.length, 1, 'Native RPC evidence missing or duplicated')
  assert.deepEqual(
    records[0],
    {
      event: 'bunly.native.rpc',
      schema: 2,
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
