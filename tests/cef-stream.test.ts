import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { defineRpc, procedure, rpcLimits } from '../packages/contracts/src/rpc.ts'
import { encodeRpc, decodeRpc } from '../packages/contracts/src/rpc-wire.ts'
import { encodeStream, decodeStream, streamFrame } from '../packages/contracts/src/stream-wire.ts'
import type { BinaryStreamSender, BinaryStreamWriter } from '../packages/contracts/src/streams.ts'
import { CefBackend } from '../packages/runtime/src/cef.ts'
import { nativePeer, turn, type Command } from './helpers/native-peer.ts'

const text = (value: unknown) => {
  if (typeof value !== 'string') throw new TypeError('Expected string')
  return value
}
const schema = defineRpc({ echo: procedure(text, text) })
const rpcLimitsNative = rpcLimits({ maxFrameBytes: 24 * 1024, maxMetadataBytes: 16 * 1024 })

function streamEvent(packet: Uint8Array, sequence: number, connection = 4) {
  return {
    v: 1,
    event: 'stream.packet',
    target: 3,
    data: {
      connection,
      context: 1,
      generation: 1,
      sequence,
      packet: Buffer.from(packet).toString('hex'),
      copiedBytes: packet.byteLength,
    },
  }
}

test('native stream pause withholds consumer ACK while RPC progresses; streams cancel independently', async () => {
  const peer = await nativePeer()
  let next = 0
  peer.handle((command) => {
    peer.reply(command, command.op.endsWith('.create') ? { id: ++next } : null)
    if (command.op === 'quit') peer.send({ v: 1, event: 'shutdown' })
  })
  const backend = new CefBackend(peer.transport)
  let sender: BinaryStreamSender | undefined
  let documentSignal: AbortSignal | undefined
  let connections = 0
  backend.serveStreams(['app://ui'], (connection) => {
    connections++
    documentSignal = connection.signal
    sender = connection.sender()
  })
  backend.serveRpc(
    schema,
    { echo: { capability: 'rpc.echo', handle: async (value: string) => `rpc:${value}` } },
    ['app://ui'],
    ['rpc.echo']
  )
  const session = await backend.createSession({ partition: 'streams', persistence: 'ephemeral' })
  const window = await backend.createWindow({
    title: 'streams',
    bounds: { x: 0, y: 0, width: 640, height: 480 },
  })
  const view = await backend.createView({
    window,
    session,
    url: 'app://ui/index.html',
    trust: { kind: 'application', origin: 'app://ui' },
  })
  peer.send({
    v: 1,
    event: 'stream.connected',
    target: 3,
    data: {
      connection: 4,
      context: 1,
      generation: 1,
      frameId: 'native-main',
      documentId: 'native-3-1',
      origin: 'app://ui',
    },
  })
  peer.send({
    v: 1,
    event: 'rpc.connected',
    target: 3,
    data: {
      connection: 4,
      context: 1,
      generation: 1,
      frameId: 'native-main',
      documentId: 'native-3-1',
      origin: 'app://ui',
    },
  })
  await turn()
  assert.ok(sender)

  let incomingSequence = 0
  const nextDelivery = (after = 0): Command => {
    const deliveries = peer.commands.filter((command) => command.op === 'stream.deliver')
    const command = deliveries[after]
    assert.ok(command)
    return command
  }
  const open = async (index: number): Promise<BinaryStreamWriter> => {
    const pending = sender!.open('terminal')
    await turn()
    const frame = decodeStream(Uint8Array.fromHex(String(nextDelivery(index).args['packet'])))
    assert.equal(frame.kind, 'open')
    peer.send(streamEvent(encodeStream(streamFrame('opened', frame.id)), ++incomingSequence))
    return pending
  }
  try {
    const first = await open(0)
    const write = first.write(new Uint8Array([1, 2, 3, 4]))
    let writeSettled = false
    void write.finally(() => (writeSettled = true))
    await turn()
    const data = decodeStream(Uint8Array.fromHex(String(nextDelivery(1).args['packet'])))
    assert.equal(data.kind, 'data')
    assert.equal(writeSettled, false, 'native handoff is not renderer-consumption credit')

    peer.send({
      v: 1,
      event: 'rpc.packet',
      target: 3,
      data: {
        connection: 4,
        context: 1,
        generation: 1,
        sequence: 1,
        packet: Buffer.from(
          encodeRpc(
            { type: 'request', id: 1, method: 'echo', timeoutMs: 1000, value: 'control' },
            rpcLimitsNative
          )
        ).toString('hex'),
        copiedBytes: encodeRpc(
          { type: 'request', id: 1, method: 'echo', timeoutMs: 1000, value: 'control' },
          rpcLimitsNative
        ).byteLength,
      },
    })
    await turn()
    await turn()
    const rpcDelivery = [...peer.commands].reverse().find((command) => command.op === 'rpc.deliver')
    assert.ok(rpcDelivery)
    assert.deepEqual(
      decodeRpc(Uint8Array.fromHex(String(rpcDelivery.args['packet'])), rpcLimitsNative),
      { type: 'success', id: 1, value: 'rpc:control' }
    )
    assert.equal(writeSettled, false)
    peer.send(
      streamEvent(
        encodeStream(streamFrame('ack', data.id, data.sequence, data.body.byteLength)),
        ++incomingSequence
      )
    )
    await write

    const second = await open(2)
    first.cancel()
    await turn()
    assert.equal(sender!.diagnostics().closed, false)
    const secondWrite = second.write(new Uint8Array([9]))
    await turn()
    const secondData = decodeStream(Uint8Array.fromHex(String(nextDelivery(4).args['packet'])))
    peer.send(
      streamEvent(
        encodeStream(
          streamFrame('ack', secondData.id, secondData.sequence, secondData.body.byteLength)
        ),
        ++incomingSequence
      )
    )
    await secondWrite
    second.cancel()
    await turn()
    assert.deepEqual(backend.streamDiagnostics().budget, {
      reservedBytes: 0,
      streams: 0,
      views: 0,
    })

    await backend.navigate(view, 'app://ui/next.html')
    assert.equal(documentSignal?.aborted, true)
    peer.send({
      v: 1,
      event: 'stream.connected',
      target: 3,
      data: {
        connection: 5,
        context: 2,
        generation: 2,
        frameId: 'native-main',
        documentId: 'native-3-2',
        origin: 'app://ui',
      },
    })
    await turn()
    assert.equal(connections, 1, 'navigation back must not create another stream grant')
    assert.ok(peer.commands.some((command) => command.op === 'stream.disconnect'))
  } finally {
    await backend.dispose()
  }
})

test('stream service must be configured before native resources', async () => {
  const peer = await nativePeer()
  let next = 0
  peer.handle((command) => {
    peer.reply(command, command.op.endsWith('.create') ? { id: ++next } : null)
    if (command.op === 'quit') peer.send({ v: 1, event: 'shutdown' })
  })
  const backend = new CefBackend(peer.transport)
  backend.serveStreams(['app://ui'], (connection) => {
    connection.sender()
  })
  await backend.createSession({ partition: 'forged-stream', persistence: 'ephemeral' })
  assert.throws(() => backend.serveStreams(['app://ui'], () => {}), /before creating|already/i)
  await backend.dispose()
})

test('valid native documents outside the configured stream origins are disconnected', async () => {
  const peer = await nativePeer()
  let next = 0
  peer.handle((command) => {
    peer.reply(command, command.op.endsWith('.create') ? { id: ++next } : null)
    if (command.op === 'quit') peer.send({ v: 1, event: 'shutdown' })
  })
  const backend = new CefBackend(peer.transport)
  let connections = 0
  backend.serveStreams(['app://other'], () => {
    connections++
  })
  const session = await backend.createSession({
    partition: 'denied-stream',
    persistence: 'ephemeral',
  })
  const window = await backend.createWindow({
    title: 'denied stream',
    bounds: { x: 0, y: 0, width: 640, height: 480 },
  })
  await backend.createView({
    window,
    session,
    url: 'app://ui/index.html',
    trust: { kind: 'application', origin: 'app://ui' },
  })
  peer.send({
    v: 1,
    event: 'stream.connected',
    target: 3,
    data: {
      connection: 4,
      context: 1,
      generation: 1,
      frameId: 'native-main',
      documentId: 'native-3-1',
      origin: 'app://ui',
    },
  })
  await turn()
  assert.equal(connections, 0)
  assert.ok(peer.commands.some((command) => command.op === 'stream.disconnect'))
  await backend.dispose()
})

test('stream connection rejects forged native document metadata', async () => {
  const peer = await nativePeer()
  let next = 0
  peer.handle((command) => {
    peer.reply(command, command.op.endsWith('.create') ? { id: ++next } : null)
  })
  const backend = new CefBackend(peer.transport)
  backend.serveStreams(['app://ui'], (connection) => {
    connection.sender()
  })
  const session = await backend.createSession({
    partition: 'forged-stream',
    persistence: 'ephemeral',
  })
  const window = await backend.createWindow({
    title: 'forged stream',
    bounds: { x: 0, y: 0, width: 640, height: 480 },
  })
  await backend.createView({
    window,
    session,
    url: 'app://ui/index.html',
    trust: { kind: 'application', origin: 'app://ui' },
  })
  const failed = assert.rejects(backend.closed, /Invalid native stream connection/)
  peer.send({
    v: 1,
    event: 'stream.connected',
    target: 3,
    data: {
      connection: 4,
      context: 1,
      generation: 1,
      frameId: 'native-main',
      documentId: 'renderer-forged-document',
      origin: 'app://ui',
    },
  })
  await failed
  assert.match(peer.transport.failure?.message ?? '', /Invalid native stream connection/)
})

test('stream service can construct a receiver with consumer-completion credit', async () => {
  const peer = await nativePeer()
  let next = 0
  peer.handle((command) => {
    peer.reply(command, command.op.endsWith('.create') ? { id: ++next } : null)
    if (command.op === 'quit') peer.send({ v: 1, event: 'shutdown' })
  })
  const backend = new CefBackend(peer.transport)
  const consumed: number[] = []
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  backend.serveStreams(['app://ui'], (connection) => {
    connection.receiver({
      terminal: {
        async consume(chunk) {
          consumed.push(...chunk)
          await held
        },
      },
    })
  })
  const session = await backend.createSession({
    partition: 'receiver-stream',
    persistence: 'ephemeral',
  })
  const window = await backend.createWindow({
    title: 'receiver stream',
    bounds: { x: 0, y: 0, width: 640, height: 480 },
  })
  await backend.createView({
    window,
    session,
    url: 'app://ui/index.html',
    trust: { kind: 'application', origin: 'app://ui' },
  })
  peer.send({
    v: 1,
    event: 'stream.connected',
    target: 3,
    data: {
      connection: 4,
      context: 1,
      generation: 1,
      frameId: 'native-main',
      documentId: 'native-3-1',
      origin: 'app://ui',
    },
  })
  await turn()
  peer.send(
    streamEvent(encodeStream(streamFrame('open', 1, 0, 0, new TextEncoder().encode('terminal'))), 1)
  )
  await turn()
  assert.equal(
    decodeStream(
      Uint8Array.fromHex(
        String(peer.commands.find((command) => command.op === 'stream.deliver')!.args['packet'])
      )
    ).kind,
    'opened'
  )
  peer.send(streamEvent(encodeStream(streamFrame('data', 1, 1, 0, new Uint8Array([7, 8]))), 2))
  await turn()
  assert.deepEqual(consumed, [7, 8])
  assert.equal(
    peer.commands.filter((command) => command.op === 'stream.deliver').length,
    1,
    'BLST ACK must wait for sink completion'
  )
  release()
  await turn()
  await turn()
  const deliveries = peer.commands.filter((command) => command.op === 'stream.deliver')
  assert.equal(decodeStream(Uint8Array.fromHex(String(deliveries[1]!.args['packet']))).kind, 'ack')
  peer.send(streamEvent(encodeStream(streamFrame('close', 1, 1)), 3))
  await turn()
  await turn()
  const closed = peer.commands.filter((command) => command.op === 'stream.deliver')[2]
  assert.ok(closed)
  assert.equal(decodeStream(Uint8Array.fromHex(String(closed.args['packet']))).kind, 'closed')
  assert.deepEqual(backend.streamDiagnostics().budget, {
    reservedBytes: 0,
    streams: 0,
    views: 0,
  })
  await backend.dispose()
})

test('common native document revocation aborts a stream-only owner and fences delayed regrant', async () => {
  const peer = await nativePeer()
  let next = 0
  peer.handle((command) => {
    peer.reply(command, command.op.endsWith('.create') ? { id: ++next } : null)
    if (command.op === 'quit') peer.send({ v: 1, event: 'shutdown' })
  })
  const backend = new CefBackend(peer.transport)
  let signal: AbortSignal | undefined
  let connections = 0
  backend.serveStreams(['app://ui'], (connection) => {
    signal = connection.signal
    connections++
    connection.sender()
  })
  try {
    const session = await backend.createSession({
      partition: 'revoke-stream',
      persistence: 'ephemeral',
    })
    const window = await backend.createWindow({
      title: 'streams',
      bounds: { x: 0, y: 0, width: 640, height: 480 },
    })
    await backend.createView({
      window,
      session,
      url: 'app://ui/index.html',
      trust: { kind: 'application', origin: 'app://ui' },
    })
    const data = {
      connection: 4,
      context: 1,
      generation: 1,
      frameId: 'native-main',
      documentId: 'native-3-1',
      origin: 'app://ui',
    }
    peer.send({ v: 1, event: 'stream.connected', target: 3, data })
    await turn()
    assert.equal(connections, 1)
    peer.send({ v: 1, event: 'rpc.revoked', target: 3, data })
    await turn()
    assert.equal(
      signal?.aborted,
      true,
      'native binding revocation must retire streams even without an RPC service'
    )
    assert.equal(backend.streamDiagnostics().connections, 0)
    peer.send({ v: 1, event: 'stream.connected', target: 3, data })
    await turn()
    assert.equal(connections, 1, 'a delayed subscription cannot recreate a retired stream owner')
  } finally {
    await backend.dispose()
  }
})
