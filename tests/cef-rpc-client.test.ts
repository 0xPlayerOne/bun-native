import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { cefRpcTransport, waitForCefRpcTransport } from '../packages/client/src/cef-rpc.ts'

test('CEF bridge readiness uses one timer/listener and removes both on success, abort and deadline', async () => {
  const originalSet = globalThis.setTimeout,
    originalClear = globalThis.clearTimeout
  const originalAdd = globalThis.addEventListener,
    originalRemove = globalThis.removeEventListener
  const timers = new Set<unknown>()
  const listeners = new Set<EventListenerOrEventListenerObject>()
  const globals = globalThis as typeof globalThis & { __bunlyRpc?: unknown }
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
    options?: AddEventListenerOptions
  ) => {
    if (type === 'bunly:rpc-ready') listeners.add(callback)
    originalAdd.call(globalThis, type, callback, options)
  }) as typeof addEventListener
  globalThis.removeEventListener = ((
    type: string,
    callback: EventListenerOrEventListenerObject,
    options?: EventListenerOptions
  ) => {
    if (type === 'bunly:rpc-ready') listeners.delete(callback)
    originalRemove.call(globalThis, type, callback, options)
  }) as typeof removeEventListener
  try {
    for (let cycle = 0; cycle < 10; cycle++) {
      const controller = new AbortController()
      const waiting = waitForCefRpcTransport(1000, controller.signal)
      assert.equal(timers.size, 1)
      assert.equal(listeners.size, 1)
      globalThis.dispatchEvent(new Event('bunly:rpc-ready'))
      assert.equal(listeners.size, 1, 'Forged readiness event cannot create a bridge')
      controller.abort()
      await assert.rejects(waiting)
      assert.equal(timers.size, 0)
      assert.equal(listeners.size, 0)
    }
    const ready = waitForCefRpcTransport()
    globals.__bunlyRpc = { send() {}, subscribe() {}, close() {} }
    globalThis.dispatchEvent(new Event('bunly:rpc-ready'))
    const transport = await ready
    transport.close()
    assert.equal(timers.size, 0)
    assert.equal(listeners.size, 0)
    delete globals.__bunlyRpc
    await assert.rejects(waitForCefRpcTransport(1), { code: 'DEADLINE_EXCEEDED' })
    assert.equal(timers.size, 0)
    assert.equal(listeners.size, 0)
  } finally {
    delete globals.__bunlyRpc
    globalThis.setTimeout = originalSet
    globalThis.clearTimeout = originalClear
    globalThis.addEventListener = originalAdd
    globalThis.removeEventListener = originalRemove
  }
})

test('CEF sends settle once on revoke and close; rejected callbacks do not acknowledge consumption', async () => {
  const globals = globalThis as typeof globalThis & { __bunlyRpc?: unknown }
  let receive!: (packet?: ArrayBuffer) => boolean
  let ack!: (accepted: boolean) => void
  globals.__bunlyRpc = {
    send(_packet: ArrayBuffer, callback: typeof ack) {
      ack = callback
    },
    subscribe(callback: typeof receive) {
      receive = callback
    },
    close() {},
  }
  try {
    for (const action of ['revoke', 'close', 'negative-ack', 'unsubscribe']) {
      const transport = cefRpcTransport()
      let closed = 0
      const unsubscribe = transport.subscribe(
        () => {},
        () => closed++
      )
      const sending = transport.send(new Uint8Array([1]))
      assert.ok(sending instanceof Promise)
      if (action === 'revoke') assert.equal(receive(), false)
      else if (action === 'close') transport.close()
      else if (action === 'unsubscribe') unsubscribe()
      else ack(false)
      await assert.rejects(sending, { code: 'DISCONNECTED' })
      ack(true)
      assert.equal(closed, action === 'unsubscribe' ? 0 : 1)
      assert.equal(receive(new ArrayBuffer(1)), false)
    }
  } finally {
    delete globals.__bunlyRpc
  }
})
