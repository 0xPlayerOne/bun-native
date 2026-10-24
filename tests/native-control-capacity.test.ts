import assert from 'node:assert/strict'
import { test } from 'bun:test'
import { PassThrough, Writable } from 'node:stream'
import { NativeTransport } from '../packages/runtime/src/native-transport.ts'
import capacity from '../packages/runtime/src/native-capacity.json'
import { nativePeer, turn } from './helpers/native-peer.ts'

const control = capacity.controlOperations
const denied = (value: Promise<unknown>) => assert.rejects(value, /capacity/)

test('ordinary saturation reserves cleanup slots without raising total pending capacity or reordering IDs', async () => {
  const peer = await nativePeer()
  const pending: Promise<unknown>[] = []
  try {
    for (let i = 0; i < capacity.ordinaryRequests; i++) {
      const call = peer.transport.call('rpc.deliver', { packet: 'aa', connection: i + 1 })
      void call.catch(() => {})
      pending.push(call)
    }
    await denied(peer.transport.call('rpc.deliver', { packet: 'aa' }))
    assert.equal(peer.transport.diagnostics().ordinaryRequests, 96)
    for (let i = 0; i < capacity.requests - capacity.ordinaryRequests; i++) {
      const call = peer.transport.call(control[i % control.length]!, { id: 1 })
      void call.catch(() => {})
      pending.push(call)
    }
    assert.equal(peer.transport.diagnostics().requests, 128)
    assert.equal(peer.transport.diagnostics().controlAdmissionsUnderPressure, 32)
    await denied(peer.transport.call('quit'))
    assert.deepEqual(
      peer.commands.map((command) => command.id),
      Array.from({ length: 128 }, (_, i) => i + 1)
    )
    // Native responses may arrive out of order. Both classes release exact ownership.
    for (const command of [...peer.commands].reverse()) peer.reply(command)
    await Promise.all(pending)
    assert.equal(peer.transport.diagnostics().ordinaryRequests, 0)
    assert.equal(peer.transport.diagnostics().requests, 0)
  } finally {
    await peer.stop()
    await Promise.allSettled(pending)
  }
})

test('cancellation cannot recycle ordinary capacity before native acknowledgment', async () => {
  const peer = await nativePeer()
  try {
    for (let i = 0; i < capacity.ordinaryRequests; i++) {
      const abort = new AbortController()
      const call = peer.transport.call('rpc.deliver', { packet: 'aa' }, abort.signal)
      const rejected = assert.rejects(call, /abort/i)
      abort.abort()
      await rejected
    }
    assert.equal(peer.transport.diagnostics().abandoned, 96)
    assert.equal(peer.transport.diagnostics().ordinaryRequests, 96)
    await denied(peer.transport.call('rpc.deliver', { packet: 'aa' }))
    const ack = peer.transport.call('rpc.ack', { sequence: 1 })
    peer.reply(peer.commands.at(-1)!)
    await ack
    assert.equal(peer.transport.diagnostics().ordinaryRequests, 96)
    peer.reply(peer.commands[0]!)
    await turn()
    const next = peer.transport.call('rpc.deliver', { packet: 'bb' })
    peer.reply(peer.commands.at(-1)!)
    await next
    for (const command of peer.commands.slice(1, 96)) peer.reply(command)
    // The real reader yields between bounded batches; wait for a receipt after
    // those abandoned replies instead of treating one event-loop turn as drain.
    const barrier = peer.transport.call('rpc.ack')
    peer.reply(peer.commands.at(-1)!)
    await barrier
    assert.equal(peer.transport.diagnostics().ordinaryRequests, 0)
    assert.equal(peer.transport.diagnostics().abandoned, 0)
  } finally {
    await peer.stop()
  }
})

test('only small exact control operations can use the reserve after ordinary saturation', async () => {
  const peer = await nativePeer()
  const pending = Array.from({ length: 96 }, () => peer.transport.call('diagnostics'))
  const settled = Promise.allSettled(pending)
  try {
    for (const operation of ['rpc.ack.more', 'window.resize', 'view.navigate', 'unknown'])
      await denied(peer.transport.call(operation))
    for (const operation of control) {
      await denied(peer.transport.call(operation, { text: 'x'.repeat(capacity.controlFrameBytes) }))
      const call = peer.transport.call(operation)
      peer.reply(peer.commands.at(-1)!)
      await call
    }
    assert.equal(peer.transport.diagnostics().requests, 96)
  } finally {
    await peer.stop()
    await settled
  }
})

test('reentrant serialization cannot spend ordinary headroom twice or forge a control class', async () => {
  const peer = await nativePeer()
  const pending = Array.from({ length: 95 }, () =>
    peer.transport.call('rpc.deliver', { packet: 'aa' })
  )
  const settled = Promise.allSettled(pending)
  let nested: Promise<unknown> | undefined
  try {
    await denied(
      peer.transport.call('rpc.deliver', {
        toJSON() {
          nested = peer.transport.call('rpc.deliver', { packet: 'bb' })
          void nested.catch(() => {})
          return { control: true, priority: 'control', packet: 'cc' }
        },
      })
    )
    assert.equal(peer.commands.length, 96)
    const close = peer.transport.call('window.close', { id: 1 })
    peer.reply(peer.commands.at(-1)!)
    await close
    peer.reply(peer.commands[95]!)
    await nested
    assert.equal(peer.transport.diagnostics().ordinaryRequests, 95)
  } finally {
    await peer.stop()
    await settled
    await nested?.catch(() => {})
  }
})

async function blockedPeer() {
  let release: ((error?: Error | null) => void) | undefined
  const input = new PassThrough()
  const output = new Writable({
    highWaterMark: 1,
    write(_bytes, _encoding, done) {
      release = done
    },
  })
  const transport = new NativeTransport(input, output)
  input.write('{"v":1,"event":"ready","abi":1}\n')
  await transport.ready
  return { input, output, transport, release: () => release?.() }
}

test('stalled native writes preserve a byte reserve for cleanup and retain active bytes after close', async () => {
  const peer = await blockedPeer()
  const pending: Promise<unknown>[] = []
  try {
    // 50 KiB frames reach the ordinary byte bound well before the count bound.
    for (let i = 0; i < 15; i++) {
      const call = peer.transport.call('rpc.deliver', { packet: 'a'.repeat(50_000) })
      void call.catch(() => {})
      pending.push(call)
    }
    await denied(peer.transport.call('rpc.deliver', { packet: 'a'.repeat(50_000) }))
    const ordinary = peer.transport.diagnostics().ordinaryQueuedBytes
    assert.ok(ordinary > 750_000 && ordinary <= capacity.ordinaryQueuedBytes)
    for (const operation of control) {
      const call = peer.transport.call(operation)
      void call.catch(() => {})
      pending.push(call)
    }
    assert.ok(peer.transport.diagnostics().queuedBytes > ordinary)
    assert.ok(peer.transport.diagnostics().queuedBytes <= capacity.queuedBytes)
    peer.transport.fail(new Error('fixture closed'))
    await peer.transport.closed
    await Promise.allSettled(pending)
    await turn()
    assert.ok(peer.transport.diagnostics().queuedBytes > 0, 'A held raw write is still owned')
    assert.equal(peer.transport.diagnostics().ordinaryRequests, 0)
    peer.release()
    await turn()
    assert.equal(peer.transport.diagnostics().queuedBytes, 0)
    assert.equal(peer.transport.diagnostics().ordinaryQueuedBytes, 0)
  } finally {
    peer.transport.fail(new Error('fixture cleanup'))
    peer.release()
    await Promise.allSettled(pending)
  }
})

test('failed writes release ordinary and control byte reservations exactly once', async () => {
  for (const operation of ['rpc.deliver', 'rpc.ack']) {
    const input = new PassThrough()
    const output = new Writable({
      write(_bytes, _encoding, done) {
        done(new Error('owned write failure'))
      },
    })
    const transport = new NativeTransport(input, output)
    input.write('{"v":1,"event":"ready","abi":1}\n')
    await transport.ready
    await assert.rejects(transport.call(operation), /write failure/)
    await transport.closed
    await turn()
    assert.equal(transport.diagnostics().queuedBytes, 0)
    assert.equal(transport.diagnostics().ordinaryQueuedBytes, 0)
    assert.equal(transport.diagnostics().ordinaryRequests, 0)
  }
})
