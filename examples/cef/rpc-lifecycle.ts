import { RpcClient } from '../../packages/client/src/rpc.ts'
import { waitForCefRpcTransport } from '../../packages/client/src/cef-rpc.ts'
import { cefRpcSchema } from './rpc-contract.ts'

const mode = new URL(location.href).searchParams.get('mode')
if (mode === 'unprivileged') {
  try {
    await waitForCefRpcTransport(100)
    throw new Error('Revoked or remote document received a bridge')
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'DEADLINE_EXCEEDED')
      throw error
    console.log('BUNLY_RPC_UNPRIVILEGED')
  }
} else {
  const client = new RpcClient(cefRpcSchema, await waitForCefRpcTransport(), {
    limits: { maxFrameBytes: 24 * 1024, maxMetadataBytes: 16 * 1024 },
  })
  const pending = client.call('wait', mode ?? 'lifecycle', { timeoutMs: 5000 })
  void pending.then(
    () => console.error('BUNLY_RPC_STALE_DELIVERED'),
    () => console.log('BUNLY_RPC_LIFECYCLE_REVOKED')
  )
  if ((await client.call('waitStarted', mode ?? 'lifecycle')) !== 'started')
    throw new Error('Lifecycle handler was not active')
  console.log('BUNLY_RPC_LIFECYCLE_STARTED:' + mode)
}
