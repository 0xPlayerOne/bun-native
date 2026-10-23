import { expect, test } from 'bun:test'
import { nativeRpcProbeReadiness } from '../examples/cef/rpc-readiness.ts'
import { nativeRpcCases } from '../benchmarks/lib/cef-rpc-acceptance.ts'
import type { NativeEvent } from '../packages/runtime/src/native-transport.ts'

function fixture(early: string[] = []) {
  const listeners = new Set<(event: NativeEvent) => void>()
  const timers = new Set<() => void>()
  let scheduled = 0
  const ready = nativeRpcProbeReadiness(
    (listener) => {
      listeners.add(listener)
      for (const name of early) listener({ v: 1, event: 'rpc.qualification', data: { case: name } })
      return () => {
        listeners.delete(listener)
      }
    },
    10000,
    {
      set(callback) {
        scheduled++
        timers.add(callback)
        return callback
      },
      clear(handle) {
        timers.delete(handle as () => void)
      },
    }
  )
  return {
    ready,
    listeners,
    timers,
    scheduled: () => scheduled,
    emit(event: NativeEvent) {
      for (const listener of Array.from(listeners)) listener(event)
    },
    reject(name: string) {
      this.emit({ v: 1, event: 'rpc.qualification', data: { case: name } })
    },
    expire() {
      for (const callback of Array.from(timers)) callback()
    },
  }
}

test('RPC probe barrier waits for actual native wrong-frame evidence, not page success', async () => {
  const f = fixture(nativeRpcCases.filter((name) => name !== 'wrong-frame'))
  let settled = false
  const waiting = f.ready.wait().then(() => {
    settled = true
  })
  f.emit({
    v: 1,
    event: 'view.console',
    data: { message: 'BUNLY_RPC_HOSTILE_OK', case: 'wrong-frame' },
  })
  f.reject('invented-probe')
  await Promise.resolve()
  expect(settled).toBe(false)
  expect(f.listeners.size).toBe(1)
  f.reject('wrong-frame')
  await waiting
  expect(f.listeners.size).toBe(0)
  expect(f.timers.size).toBe(0)
})
test('RPC probe barrier retains synchronous and pre-wait receipts without adding timers', async () => {
  const f = fixture([...nativeRpcCases])
  await f.ready.wait()
  expect(f.listeners.size).toBe(0)
  expect(f.scheduled()).toBe(0)
  f.ready.close()
})
test('RPC probe barrier rejects a missing case and disposes its listener/deadline', async () => {
  const f = fixture(nativeRpcCases.filter((name) => name !== 'wrong-frame'))
  const first = f.ready.wait()
  expect(f.ready.wait()).toBe(first)
  expect(f.scheduled()).toBe(1)
  f.expire()
  await expect(first).rejects.toThrow('Native RPC probes missing: wrong-frame')
  expect(f.listeners.size).toBe(0)
  expect(f.timers.size).toBe(0)
})
test('RPC probe barrier cancellation is idempotent and never qualifies missing evidence', async () => {
  const f = fixture()
  const waiting = f.ready.wait()
  f.ready.close()
  f.ready.close()
  await expect(waiting).rejects.toThrow('cancelled')
  expect(f.listeners.size).toBe(0)
  expect(f.timers.size).toBe(0)
})
