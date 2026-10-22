import { test, expect } from 'bun:test'
import { Buffer } from 'node:buffer'
import { rpcLimits, rpcScheduler } from '../packages/contracts/src/rpc.ts'
import type { RpcTransport } from '../packages/contracts/src/rpc.ts'
import { RpcChannel } from '../packages/contracts/src/rpc-channel.ts'
import { encodeRpc, decodeRpc } from '../packages/contracts/src/rpc-wire.ts'
import { StreamLink } from '../packages/contracts/src/stream-link.ts'
import { StreamBudget } from '../packages/contracts/src/stream-budget.ts'
import { BinaryStreamReceiver, BinaryStreamSender } from '../packages/contracts/src/streams.ts'
import { encodeStream, streamFrame } from '../packages/contracts/src/stream-wire.ts'
import { rpcMessagePort } from '../packages/client/src/rpc-port.ts'

function deferred<T = void>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
const turn = () => new Promise<void>((resolve) => setImmediate(resolve))
const limits = rpcLimits()

test('transferred stream packets release their original byte reservation', async () => {
  const wire: RpcTransport = {
    send(packet) {
      structuredClone(packet, { transfer: [packet.buffer] })
    },
    subscribe() {
      return () => {}
    },
    close() {},
  }
  const link = new StreamLink(
    wire,
    128,
    304,
    2,
    1000,
    rpcScheduler,
    () => {},
    () => {}
  )
  link.start()
  let drained = 0
  try {
    for (let i = 0; i < 16; i++) {
      await link.send(
        encodeStream(streamFrame('data', 1, i + 1, 0, new Uint8Array(128)), 128),
        () => true,
        () => {
          drained++
        }
      )
      expect(link.diagnostics().queuedBytes).toBe(0)
    }
    expect(drained).toBe(16)
  } finally {
    link.close()
  }
})

test('a detached in-flight stream remains charged until its adapter actually settles', async () => {
  const gate = deferred()
  const wire: RpcTransport = {
    send(packet) {
      structuredClone(packet, { transfer: [packet.buffer] })
      return gate.promise
    },
    subscribe() {
      return () => {}
    },
    close() {},
  }
  const link = new StreamLink(
    wire,
    128,
    304,
    2,
    1000,
    rpcScheduler,
    () => {},
    () => {}
  )
  link.start()
  let drained = 0
  const pending = link.send(
    encodeStream(streamFrame('data', 1, 1, 0, new Uint8Array(128)), 128),
    () => true,
    () => {
      drained++
    }
  )
  const rejected = pending.catch((error: unknown) => error)
  try {
    expect(link.diagnostics().queuedBytes).toBe(152)
    link.close()
    await rejected
    expect(drained).toBe(0)
    expect(link.diagnostics().queuedBytes).toBe(152)
    gate.resolve()
    await turn()
    expect(drained).toBe(1)
    expect(link.diagnostics().queuedBytes).toBe(0)
  } finally {
    gate.resolve()
    link.close()
  }
})

test('actual MessagePort streams can exceed the queue limit cumulatively without accumulating debt', async () => {
  const ports = new MessageChannel(),
    senderBudget = new StreamBudget(),
    receiverBudget = new StreamBudget()
  let consumed = 0
  const receiver = new BinaryStreamReceiver(
    rpcMessagePort(ports.port1),
    {
      budget: receiverBudget,
      owner: {},
      maxChunkBytes: 128,
      maxQueuedBytes: 304,
      timeoutMs: 1000,
    },
    {
      terminal: {
        consume(bytes) {
          expect(bytes.length).toBe(128)
          expect(bytes[0]).toBe(consumed++)
        },
      },
    }
  )
  const sender = new BinaryStreamSender(rpcMessagePort(ports.port2), {
    budget: senderBudget,
    owner: {},
    maxChunkBytes: 128,
    maxQueuedBytes: 304,
    timeoutMs: 1000,
  })
  try {
    const writer = await sender.open('terminal')
    for (let i = 0; i < 64; i++) {
      const bytes = new Uint8Array(128)
      bytes[0] = i
      await writer.write(bytes)
    }
    await writer.end()
    await turn()
    expect(consumed).toBe(64)
    expect(sender.diagnostics().queuedBytes).toBe(0)
    expect(receiver.diagnostics().queuedBytes).toBe(0)
    expect(senderBudget.diagnostics().reservedBytes).toBe(0)
    expect(receiverBudget.diagnostics().reservedBytes).toBe(0)
  } finally {
    sender.close()
    receiver.close()
  }
})

test('RPC binary decoding owns only the selected Buffer bytes', () => {
  const packet = Buffer.from(
    encodeRpc({ type: 'success', id: 1, value: new Uint8Array([1, 2, 3]) }, limits)
  )
  const decoded = decodeRpc(packet, limits)
  if (decoded.type !== 'success' || !(decoded.value instanceof Uint8Array))
    throw new Error('Expected binary response')
  packet.fill(0)
  expect(Array.from(decoded.value)).toEqual([1, 2, 3])
  expect(decoded.value.buffer.byteLength).toBe(3)
})

test('queued RPC Buffer payloads cannot be mutated through their original allocation', async () => {
  const gate = deferred(),
    seen: number[][] = []
  const wire: RpcTransport = {
    send(packet) {
      seen.push(Array.from(packet))
      return seen.length === 1 ? gate.promise : undefined
    },
    subscribe() {
      return () => {}
    },
    close() {},
  }
  const channel = new RpcChannel(
    wire,
    limits,
    rpcScheduler,
    () => {},
    () => {}
  )
  channel.start()
  try {
    const first = channel.send(new Uint8Array([7]))
    const backing = Buffer.alloc(32, 99)
    backing[10] = 1
    backing[11] = 2
    const second = channel.send(backing.subarray(10, 12))
    backing.fill(0)
    gate.resolve()
    await Promise.all([first, second])
    expect(seen).toEqual([[7], [1, 2]])
    expect(channel.diagnostics().queuedBytes).toBe(0)
  } finally {
    gate.resolve()
    channel.close()
  }
})

test('MessagePort copies sliced Buffers without exposing or detaching their backing allocation', async () => {
  const ports = new MessageChannel(),
    transport = rpcMessagePort(ports.port1)
  const observed = deferred<Uint8Array>()
  transport.subscribe(
    () => {},
    () => {}
  )
  ports.port2.addEventListener('message', (event: MessageEvent) => {
    if (event.data.kind === 'packet') {
      observed.resolve(event.data.packet)
      ports.port2.postMessage({ kind: 'ack', id: event.data.id })
    }
  })
  ports.port2.start()
  const original = Buffer.alloc(64, 99)
  original[16] = 1
  original[17] = 2
  try {
    const sent = transport.send(original.subarray(16, 18))
    const received = await observed.promise
    await sent
    expect(Array.from(received)).toEqual([1, 2])
    expect(received.buffer.byteLength).toBe(2)
    expect(original.length).toBe(64)
    expect(original[0]).toBe(99)
  } finally {
    transport.close()
    ports.port2.close()
  }
})

test('stream sinks own a bounded copy when an adapter delivers a Buffer', async () => {
  let message!: (packet: Uint8Array) => void
  let chunk: Uint8Array | undefined
  const gate = deferred()
  const wire: RpcTransport = {
    send() {},
    subscribe(receive) {
      message = receive
      return () => {}
    },
    close() {},
  }
  const receiver = new BinaryStreamReceiver(
    wire,
    { budget: new StreamBudget(), owner: {}, maxChunkBytes: 128 },
    {
      terminal: {
        consume(bytes) {
          chunk = bytes
          return gate.promise
        },
      },
    }
  )
  try {
    message(
      Buffer.from(
        encodeStream(streamFrame('open', 1, 0, 0, new TextEncoder().encode('terminal')), 128)
      )
    )
    await turn()
    const packet = Buffer.from(
      encodeStream(streamFrame('data', 1, 1, 0, new Uint8Array([1, 2, 3])), 128)
    )
    message(packet)
    packet.fill(0)
    expect(chunk).toBeDefined()
    expect(Array.from(chunk!)).toEqual([1, 2, 3])
    expect(chunk!.buffer.byteLength).toBe(3)
  } finally {
    gate.resolve()
    receiver.close()
    await turn()
  }
})

test('RPC send rejects shared backing memory before invoking the adapter', async () => {
  let sends = 0
  const wire: RpcTransport = {
    send() {
      sends++
    },
    subscribe() {
      return () => {}
    },
    close() {},
  }
  const channel = new RpcChannel(
    wire,
    limits,
    rpcScheduler,
    () => {},
    () => {}
  )
  channel.start()
  try {
    await expect(channel.send(new Uint8Array(new SharedArrayBuffer(128)))).rejects.toMatchObject({
      code: 'PROTOCOL_ERROR',
    })
    expect(sends).toBe(0)
  } finally {
    channel.close()
  }
})
