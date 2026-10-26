import { loadConsumers } from './consumer.ts'
import { RpcClient } from '../../packages/client/src/rpc.ts'
import { waitForCefRpcTransport } from '../../packages/client/src/cef-rpc.ts'
import { waitForCefStreamTransport } from '../../packages/client/src/cef-streams.ts'
import { BinaryStreamReceiver } from '../../packages/contracts/src/streams.ts'
import { StreamBudget } from '../../packages/contracts/src/stream-budget.ts'
import { schema } from './contract.ts'
const rpc = new RpcClient(schema, await waitForCefRpcTransport())
const visibility = () => (document.visibilityState === 'visible' ? 'visible' : 'hidden')
addEventListener('visibilitychange', () => {
  void rpc.call('visibility', visibility())
})
const consumers = loadConsumers(rpc)
const receiver = new BinaryStreamReceiver(
  await waitForCefStreamTransport(),
  { budget: new StreamBudget(), owner: {}, timeoutMs: 15_000 },
  Object.fromEntries(consumers.map((consumer, index) => [`load-${index}`, consumer]))
)
addEventListener(
  'pagehide',
  () => {
    receiver.close()
    rpc.close()
    for (const consumer of consumers) consumer.terminal.dispose()
  },
  { once: true }
)
await rpc.call('ready', visibility())
