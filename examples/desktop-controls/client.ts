import { RpcClient } from '../../packages/client/src/rpc.ts'
import { waitForCefRpcTransport } from '../../packages/client/src/cef-rpc.ts'
import { desktopControlsSchema } from './contract.ts'

const client = new RpcClient(desktopControlsSchema, await waitForCefRpcTransport())
await client.call('ready', {
  instance: crypto.randomUUID(),
  width: innerWidth,
  height: innerHeight,
  devicePixelRatio,
})
