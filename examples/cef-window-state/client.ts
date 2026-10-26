import { RpcClient } from '../../packages/client/src/rpc.ts'
import { waitForCefRpcTransport } from '../../packages/client/src/cef-rpc.ts'
import { visibilitySchema } from './contract.ts'

const client = new RpcClient(visibilitySchema, await waitForCefRpcTransport())
let sequence = 0
let chain = Promise.resolve()
const report = () => {
  // Capture the actual browser state in the callback, before any async handoff.
  const receipt = { sequence: sequence++, visibility: document.visibilityState }
  chain = chain.then(async () => {
    await client.call('visibility', receipt)
  })
  void chain.catch((error: unknown) => console.error('Window visibility receipt failed', error))
}
document.addEventListener('visibilitychange', report)
report()
