import { test } from 'bun:test'
import assert from 'node:assert/strict'
import {
  cefStreamTransport,
  waitForCefStreamTransport,
} from '../packages/client/src/cef-streams.ts'

test('native stream readiness owns one timer/listener and forged wakeups grant nothing', async () => {
  const globals = globalThis as typeof globalThis & { __bunlyStreams?: unknown }
  const originalSet = globalThis.setTimeout
  const originalClear = globalThis.clearTimeout
  const originalAdd = globalThis.addEventListener
  const originalRemove = globalThis.removeEventListener
  const timers = new Set<unknown>()
  const listeners = new Set<EventListenerOrEventListenerObject>()
  globalThis.setTimeout = ((callback: TimerHandler, timeout?: number, ...args: unknown[]) => {
    const timer = originalSet(callback, timeout, ...args)
    timers.add(timer)
    return timer
  }) as typeof setTimeout
  globalThis.clearTimeout = ((timer: ReturnType<typeof setTimeout>) => {
    timers.delete(timer)
    originalClear(timer)
  }) as typeof clearTimeout
  globalThis.addEventListener = ((
    type: string,
    callback: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions
  ) => {
    if (type === 'bunly:streams-ready') listeners.add(callback)
    originalAdd.call(globalThis, type, callback, options)
  }) as typeof addEventListener
  globalThis.removeEventListener = ((
    type: string,
    callback: EventListenerOrEventListenerObject,
    options?: boolean | EventListenerOptions
  ) => {
    if (type === 'bunly:streams-ready') listeners.delete(callback)
    originalRemove.call(globalThis, type, callback, options)
  }) as typeof removeEventListener
  try {
    const controller = new AbortController()
    const waiting = waitForCefStreamTransport(1000, controller.signal)
    globalThis.dispatchEvent(new Event('bunly:streams-ready'))
    assert.equal(timers.size, 1)
    assert.equal(listeners.size, 1)
    controller.abort()
    await assert.rejects(waiting, { name: 'AbortError' })
    assert.equal(timers.size, 0)
    assert.equal(listeners.size, 0)

    const ready = waitForCefStreamTransport()
    globals.__bunlyStreams = { send() {}, subscribe() {}, close() {} }
    globalThis.dispatchEvent(new Event('bunly:streams-ready'))
    const transport = await ready
    transport.close()
    assert.equal(timers.size, 0)
    assert.equal(listeners.size, 0)
  } finally {
    delete globals.__bunlyStreams
    globalThis.setTimeout = originalSet
    globalThis.clearTimeout = originalClear
    globalThis.addEventListener = originalAdd
    globalThis.removeEventListener = originalRemove
  }
})

test('native stream bridge permits one pending packet and settles exactly once', async () => {
  const globals = globalThis as typeof globalThis & { __bunlyStreams?: unknown }
  let receive!: (packet?: ArrayBuffer) => boolean
  let acknowledge!: (accepted: boolean) => void
  let closed = 0
  globals.__bunlyStreams = {
    send(_packet: ArrayBuffer, callback: typeof acknowledge) {
      acknowledge = callback
    },
    subscribe(callback: typeof receive) {
      receive = callback
    },
    close() {},
  }
  try {
    const transport = cefStreamTransport()
    transport.subscribe(
      () => {},
      () => closed++
    )
    const pending = transport.send(new Uint8Array([1]))
    await assert.rejects(Promise.resolve(transport.send(new Uint8Array([2]))), {
      code: 'OVERLOADED',
    })
    acknowledge(true)
    await pending
    assert.equal(receive(new ArrayBuffer(1)), true)
    assert.equal(receive(), false)
    assert.equal(closed, 1)
    acknowledge(false)
    assert.equal(closed, 1)
  } finally {
    delete globals.__bunlyStreams
  }
})

test('stream packet admission reads intrinsic slots before copying and ignores producer overrides', async () => {
  const globals = globalThis as typeof globalThis & { __bunlyStreams?: unknown }
  const sent: Uint8Array[] = []
  globals.__bunlyStreams = {
    send(packet: ArrayBuffer, acknowledged: (ok: boolean) => void) {
      sent.push(new Uint8Array(packet))
      acknowledged(true)
    },
    subscribe() {},
    close() {},
  }
  try {
    const transport = cefStreamTransport()
    transport.subscribe(
      () => {},
      () => {}
    )
    const large = new Uint8Array(24 * 1024 + 1)
    Object.defineProperty(large, 'byteLength', { value: 1 })
    await assert.rejects(
      Promise.resolve().then(() => transport.send(large)),
      { code: 'PROTOCOL_ERROR' }
    )
    assert.equal(sent.length, 0)
    const input = new Uint8Array([99, 1, 2, 3, 88]).subarray(1, 4)
    Object.defineProperty(input, 'buffer', {
      get() {
        throw new Error('producer accessor')
      },
    })
    Object.defineProperty(input, 'byteLength', { value: 999999 })
    input.slice = () => {
      throw new Error('producer slice')
    }
    await transport.send(input)
    assert.deepEqual([...sent[0]!], [1, 2, 3])
    transport.close()
  } finally {
    delete globals.__bunlyStreams
  }
})

test('invalid, shared and detached stream views fail with fixed errors before bridge handoff', async () => {
  const globals = globalThis as typeof globalThis & { __bunlyStreams?: unknown }
  let sent = 0
  globals.__bunlyStreams = {
    send() {
      sent++
    },
    subscribe() {},
    close() {},
  }
  const detached = new Uint8Array([1])
  structuredClone(detached, { transfer: [detached.buffer] })
  const revoked = Proxy.revocable(new Uint8Array([1]), {})
  revoked.revoke()
  try {
    const transport = cefStreamTransport()
    transport.subscribe(
      () => {},
      () => {}
    )
    for (const value of [
      Object.create(Uint8Array.prototype),
      new Proxy(new Uint8Array([1]), {}),
      revoked.proxy,
      new Uint8Array(new SharedArrayBuffer(2)),
      detached,
      new Uint16Array(2),
    ])
      await assert.rejects(
        Promise.resolve().then(() => transport.send(value)),
        { code: 'PROTOCOL_ERROR' }
      )
    assert.equal(sent, 0)
    transport.close()
  } finally {
    delete globals.__bunlyStreams
  }
})
