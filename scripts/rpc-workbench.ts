/** Executable M4 protocol workbench. MessagePort is real; native-view policy uses the explicit mock. */
import assert from 'node:assert/strict'
import { defineRpc, procedure } from '../packages/contracts/src/rpc.ts'
import { RpcClient, rpcMessagePort } from '../packages/client/src/index.ts'
import { MockBackend, RpcServer, RpcViewAuthority } from '../packages/runtime/src/index.ts'
const string = (value: unknown) => {
  if (typeof value !== 'string') throw new TypeError('Expected string')
  return value
}
const binary = (value: unknown) => {
  if (!(value instanceof Uint8Array)) throw new TypeError('Expected bytes')
  return value
}
const contract = defineRpc({ greet: procedure(string, string), reverse: procedure(binary, binary) })
const backend = new MockBackend()
const session = await backend.createSession({ partition: 'rpc-demo', persistence: 'ephemeral' })
const window = await backend.createWindow({
  title: 'RPC policy fixture',
  bounds: { x: 0, y: 0, width: 640, height: 480 },
})
const view = await backend.createView({
  window,
  session,
  url: 'app://ui/index.html',
  trust: { kind: 'application', origin: 'app://ui' },
})
const authority = new RpcViewAuthority(backend, ['app://ui'])
const lease = authority.issue(
  view,
  { frameId: 'mock-main-frame', documentId: backend.state(view).documentId, mainFrame: true },
  ['greet', 'reverse']
)
const ports = new MessageChannel()
const server = new RpcServer(
  contract,
  {
    greet: { capability: 'greet', handle: (name) => `Hello, ${name}` },
    reverse: { capability: 'reverse', handle: (data) => data.slice().reverse() },
  },
  lease,
  rpcMessagePort(ports.port1)
)
const client = new RpcClient(contract, rpcMessagePort(ports.port2))
try {
  assert.equal(await client.call('greet', 'Bunly'), 'Hello, Bunly')
  assert.deepEqual(
    await client.call('reverse', new Uint8Array([1, 2, 3])),
    new Uint8Array([3, 2, 1])
  )
  await backend.navigate(view, 'app://ui/next.html')
  assert.equal((await server.closed).code, 'REVOKED')
  await assert.rejects(client.call('greet', 'stale connection'))
  assert.equal(
    backend.diagnostics().windows,
    1,
    'Revoking a connection must not destroy its window'
  )
  console.log(
    JSON.stringify({
      passed: true,
      transport: 'real MessageChannel',
      viewPolicy: 'explicit mock backend',
      binaryRoundTrip: true,
      sameOriginRevocation: true,
      nativeCefBridge: false,
    })
  )
} finally {
  client.close()
  server.close()
  authority.dispose()
  await backend.dispose()
}
