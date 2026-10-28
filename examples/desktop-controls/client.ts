import { RpcClient } from '../../packages/client/src/rpc.ts'
import { waitForCefRpcTransport } from '../../packages/client/src/cef-rpc.ts'
import { desktopControlsSchema } from './contract.ts'

const client = new RpcClient(desktopControlsSchema, await waitForCefRpcTransport())
let chain = client.call('ready', {
  instance: crypto.randomUUID(),
  width: innerWidth,
  height: innerHeight,
  devicePixelRatio,
})
let sequence = 0
const report = () => {
  if (sequence >= 5) throw new Error('Desktop visibility budget exceeded')
  // Capture browser state synchronously; dispatch exactly these five receipts.
  const receipt = { sequence: sequence++, visibility: document.visibilityState }
  if (sequence === 5) document.removeEventListener('visibilitychange', report)
  chain = chain.then(() => client.call('visibility', receipt))
  void chain.catch((error: unknown) => console.error('Desktop visibility receipt failed', error))
}
document.addEventListener('visibilitychange', report)
report()
