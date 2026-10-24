import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { CefBackend } from '../packages/runtime/src/cef.ts'
import { RpcClient } from '../packages/client/src/rpc.ts'
import { RpcLoopbackTransport } from '../packages/client/src/rpc-loopback.ts'
import { defineRpc, procedure } from '../packages/contracts/src/rpc.ts'
import {
  decodeNativeLoopbackHandoff,
  encodeNativeLoopbackConfirmation,
} from '../packages/contracts/src/rpc-native-handoff.ts'
import { nativePeer, turn } from './helpers/native-peer.ts'
const text = (value: unknown): string => {
  if (typeof value !== 'string') throw new TypeError('Expected text')
  return value
}
const schema = defineRpc({ echo: procedure(text, text) })
const BunWebSocket = WebSocket as unknown as {
  new (url: string, options: Bun.WebSocketOptions): WebSocket
}

test('CEF adapter provisions and confirms only native-known connection identity before real socket RPC', async () => {
  const peer = await nativePeer()
  let next = 0
  peer.handle((command) => {
    peer.reply(command, command.op.endsWith('.create') ? { id: ++next } : null)
    if (command.op === 'quit') peer.send({ v: 1, event: 'shutdown' })
  })
  const backend = new CefBackend(peer.transport)
  let client: RpcClient<typeof schema> | undefined
  try {
    await backend.serveLoopbackRpc(
      schema,
      { echo: { capability: 'echo', handle: (value) => 'bound:' + value } },
      ['app://ui'],
      ['echo']
    )
    assert.equal(peer.commands[0]!.op, 'rpc.loopback.configure')
    assert.ok(Number(peer.commands[0]!.args['port']) > 0)
    const session = await backend.createSession({
      persistence: 'ephemeral',
      partition: 'native-handoff',
    })
    const window = await backend.createWindow({
      title: 'fixture',
      bounds: { x: 0, y: 0, width: 640, height: 480 },
    })
    const view = await backend.createView({
      window,
      session,
      url: 'app://ui/transport.html',
      trust: { kind: 'application', origin: 'app://ui' },
    })
    peer.send({
      v: 1,
      event: 'rpc.connected',
      target: 3,
      data: {
        connection: 4,
        context: 1,
        generation: 1,
        frameId: 'main',
        documentId: 'native-3-1',
        origin: 'app://ui',
      },
    })
    await turn()
    await turn()
    assert.equal(peer.transport.failure, null)
    const delivery = peer.commands.find((command) => command.op === 'rpc.deliver')
    assert.ok(delivery)
    const offer = decodeNativeLoopbackHandoff(Uint8Array.fromHex(String(delivery.args['packet'])))
    client = new RpcClient(
      schema,
      new RpcLoopbackTransport({
        ...offer,
        socket: (url) => new BunWebSocket(url, { headers: { Origin: 'app://ui' } }),
        confirmNative: async (challenge) => {
          const packet = encodeNativeLoopbackConfirmation(challenge)
          peer.send({
            v: 1,
            event: 'rpc.packet',
            target: 3,
            data: {
              connection: 4,
              context: 1,
              generation: 1,
              sequence: 1,
              packet: Buffer.from(packet).toString('hex'),
              copiedBytes: packet.length,
            },
          })
          await turn()
          assert.ok(peer.commands.some((command) => command.op === 'rpc.ack'))
        },
      })
    )
    assert.equal(await client.call('echo', 'proof'), 'bound:proof')
    assert.equal(backend.rpcDiagnostics().nativeConfirmations, 1)
    const navigation = backend.navigate(view, 'app://ui/next').catch(() => {})
    await assert.rejects(client.call('echo', 'stale'))
    // The modeled native peer does not provide a navigation result/state; only
    // local pre-dispatch retirement is relevant to this regression.
    await navigation.catch(() => {})
  } finally {
    client?.close()
    await backend.dispose()
  }
  assert.equal(backend.rpcDiagnostics().connections, 0)
})
