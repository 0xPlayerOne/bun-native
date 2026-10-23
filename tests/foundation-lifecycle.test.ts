import { expect, test } from 'bun:test'
import { RpcChannel } from '../packages/contracts/src/rpc-channel.ts'
import { rpcLimits } from '../packages/contracts/src/rpc.ts'
import type { RpcScheduler, RpcTransport } from '../packages/contracts/src/rpc.ts'
import { StreamBudget } from '../packages/contracts/src/stream-budget.ts'
import { decodeRpc, encodeRpc } from '../packages/contracts/src/rpc-wire.ts'

test('repeated RPC ownership cycles release every timer and subscription', async () => {
  const timers = new Set<object>()
  let subscriptions = 0
  let adapters = 0
  const scheduler: RpcScheduler = {
    now: () => 0,
    set: () => {
      const timer = {}
      timers.add(timer)
      return timer
    },
    clear: (timer) => {
      timers.delete(timer as object)
    },
  }
  for (let generation = 0; generation < 128; generation++) {
    let complete!: () => void
    const pending = new Promise<void>((resolve) => {
      complete = resolve
    })
    const wire: RpcTransport = {
      send: () => pending,
      subscribe: () => {
        subscriptions++
        return () => {
          subscriptions--
        }
      },
      close: () => {
        adapters--
      },
    }
    adapters++
    const channel = new RpcChannel(
      wire,
      rpcLimits(),
      scheduler,
      () => {},
      () => {}
    )
    channel.start()
    const controller = new AbortController()
    const sent = channel
      .send(new Uint8Array(512), controller.signal)
      .catch((error: unknown) => error)
    expect(timers.size).toBe(1)
    expect(channel.diagnostics().queuedBytes).toBe(512)
    if (generation % 2 === 0) controller.abort()
    else complete()
    await sent
    // In-flight cancellation is charged until completion or explicit adapter teardown.
    if (generation % 2 === 0) expect(channel.diagnostics().queuedBytes).toBe(512)
    channel.close()
    complete()
    await Promise.resolve()
    expect(channel.diagnostics()).toEqual({ queuedBytes: 0, queuedFrames: 0, closed: true })
    expect(timers.size).toBe(0)
    expect(subscriptions).toBe(0)
    expect(adapters).toBe(0)
  }
})

test('aggregate stream reservations stay bounded and return to baseline across generations', () => {
  const budget = new StreamBudget({
    maxBytes: 1024,
    maxBytesPerView: 512,
    maxBytesPerStream: 256,
    maxStreams: 4,
    maxStreamsPerView: 2,
  })
  for (let generation = 0; generation < 256; generation++) {
    const first = {},
      second = {}
    const releases = [
      budget.reserve(first, 256),
      budget.reserve(first, 256),
      budget.reserve(second, 256),
      budget.reserve(second, 256),
    ]
    expect(budget.diagnostics()).toEqual({ reservedBytes: 1024, streams: 4, views: 2 })
    expect(() => budget.reserve({}, 1)).toThrow()
    expect(() => budget.reserve(first, 1)).toThrow()
    for (const release of releases.reverse()) {
      release()
      release()
    }
    expect(budget.diagnostics()).toEqual({ reservedBytes: 0, streams: 0, views: 0 })
  }
})

test('small valid RPC packets cannot authorize their mutated multi-gigabyte lengths', () => {
  const limits = rpcLimits()
  const valid = encodeRpc({ type: 'success', id: 1, value: null }, limits)
  expect(decodeRpc(valid, limits)).toEqual({ type: 'success', id: 1, value: null })
  for (const offset of [4, 8]) {
    for (const length of [0x7fffffff, 0xffffffff]) {
      const packet = new Uint8Array(valid)
      new DataView(packet.buffer).setUint32(offset, length)
      for (let repeat = 0; repeat < 128; repeat++) expect(() => decodeRpc(packet, limits)).toThrow()
      expect(packet.buffer.byteLength).toBe(valid.length)
    }
  }
})
