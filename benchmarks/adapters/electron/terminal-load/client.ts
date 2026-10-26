import type { RpcClient } from '../../../../packages/client/src/rpc.ts'
import { BinaryStreamReceiver } from '../../../../packages/contracts/src/streams.ts'
import { StreamBudget } from '../../../../packages/contracts/src/stream-budget.ts'
import { loadConsumers } from '../../../../examples/cef-terminal-load/consumer.ts'
import { schema, check } from '../../../../examples/cef-terminal-load/contract.ts'
interface LoadHost {
  security(nodeDisabled: boolean): Promise<void>
  call(method: string, value: unknown): Promise<unknown>
  send(packet: Uint8Array): Promise<void>
  subscribe(receive: (packet: Uint8Array) => void): () => void
}
const host = (globalThis as typeof globalThis & { terminalLoadHost: LoadHost }).terminalLoadHost
check(host && !('require' in globalThis) && !('process' in globalThis), 'Node exposed in renderer')
await host.security(true)
const rpc: Pick<RpcClient<typeof schema>, 'call'> = {
  async call(method, value) {
    const route = schema[method]
    return route.output(await host.call(method, route.input(value))) as never
  },
}
const consumers = loadConsumers(rpc)
const receiver = new BinaryStreamReceiver(
  {
    send: (packet) => host.send(packet),
    subscribe: (receive) => host.subscribe(receive),
    close() {},
  },
  { budget: new StreamBudget(), owner: {}, timeoutMs: 15_000 },
  Object.fromEntries(consumers.map((consumer, index) => [`load-${index}`, consumer]))
)
addEventListener('visibilitychange', () => {
  void rpc.call('visibility', document.visibilityState)
})
addEventListener(
  'pagehide',
  () => {
    receiver.close()
    for (const consumer of consumers) consumer.terminal.dispose()
  },
  { once: true }
)
await rpc.call('ready', document.visibilityState)
