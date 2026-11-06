// Runs inside an empty network namespace: only loopback exists, so any network
// dependency in launch, negotiation, a round trip or shutdown fails here.
import { NativeHost } from '@bun-native/runtime'
import { networkInterfaces } from 'node:os'
import { resolve } from 'node:path'

const external = Object.keys(networkInterfaces()).filter((name) => name !== 'lo')
if (external.length) throw new Error('Offline launch requires an isolated network namespace')
const host = await NativeHost.launch({
  executable: process.execPath,
  args: [resolve(import.meta.dir, 'protocol-peer.ts')],
  requestTimeoutMs: 2_000,
})
const opened = await host.send({
  type: 'open',
  window_id: 1,
  root_id: 1,
  title: 'Offline',
  width: 320,
  height: 240,
})
await host.shutdown()
console.log(JSON.stringify({ external, opened: opened.type, exit: await host.exited }))
