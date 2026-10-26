import { RpcClient } from '../../packages/client/src/rpc.ts'
import { waitForCefRpcTransport } from '../../packages/client/src/cef-rpc.ts'
import { visibilitySchema } from './contract.ts'

const client = new RpcClient(visibilitySchema, await waitForCefRpcTransport())
let sequence = 0
let chain = Promise.resolve()
const report = () => {
  // Capture the actual browser state in the callback, before any async handoff.
  if (sequence >= 16) throw new Error('Window fixture visibility bound exceeded')
  const receipt = { sequence: sequence++, visibility: document.visibilityState }
  // Five states are the complete fixed workload. Teardown must not create a sixth RPC.
  if (sequence === 5) document.removeEventListener('visibilitychange', report)
  const stage = (stage: string) =>
    console.log('BUNLY_WINDOW_STAGE:' + JSON.stringify({ ...receipt, stage }))
  stage('observed')
  chain = chain.then(async () => {
    stage('sending')
    try {
      await client.call('visibility', receipt)
      stage('acknowledged')
    } catch (error) {
      stage('failed')
      throw error
    }
  })
  void chain.catch((error: unknown) => console.error('Window visibility receipt failed', error))
}
document.addEventListener('visibilitychange', report)
report()
