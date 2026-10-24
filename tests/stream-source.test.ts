import { test, expect } from 'bun:test'
import { CallbackStreamSource } from '../packages/runtime/src/stream-source.ts'
import { StreamBudget } from '../packages/contracts/src/stream-budget.ts'
import type { BinaryStreamWriter, StreamOutcome } from '../packages/contracts/src/streams.ts'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve))
function fixture(write: (bytes: Uint8Array) => Promise<void> = async () => {}) {
  const result = deferred<StreamOutcome>()
  const budget = new StreamBudget()
  let stops = 0,
    cancellations = 0
  const writer: BinaryStreamWriter = {
    write,
    end: async () => {
      result.resolve({ ok: true })
    },
    cancel: () => {
      cancellations++
      result.resolve({ ok: false, code: 'CANCELLED' })
    },
    finished: result.promise,
  }
  const source = new CallbackStreamSource(writer, {
    budget,
    owner: {},
    maxChunkBytes: 4,
    maxRetainedBytes: 16,
    maxQueuedChunks: 4,
    stopSource: () => {
      stops++
    },
  })
  return { source, budget, writer, stops: () => stops, cancellations: () => cancellations }
}
test('callback source owns sliced bytes, preserves order and ends only after consumer ACKs', async () => {
  const consumed: number[] = []
  const first = deferred<void>()
  const f = fixture(async (bytes) => {
    await first.promise
    consumed.push(...bytes)
  })
  const input = new Uint8Array([99, 1, 2, 3, 4, 5, 6, 88])
  expect(f.source.push(input.subarray(1, 7))).toBe(true)
  input.fill(0)
  let ended = false
  const done = f.source.end().then((result) => {
    ended = true
    return result
  })
  await tick()
  expect(ended).toBe(false)
  expect(consumed).toEqual([])
  expect(f.source.diagnostics().retainedBytes).toBe(6)
  first.resolve()
  expect(await done).toEqual({ ok: true })
  await f.source.drained
  expect(consumed).toEqual([1, 2, 3, 4, 5, 6])
  expect(f.stops()).toBe(0)
  expect(f.budget.diagnostics()).toEqual({ reservedBytes: 0, streams: 0, views: 0 })
})
test('overload stops the source once, releases queued copies, and retains an unsettled active reservation', async () => {
  const held = deferred<void>()
  const f = fixture(() => held.promise)
  expect(f.source.push(new Uint8Array(8))).toBe(true)
  await tick()
  expect(f.source.push(new Uint8Array(9))).toBe(false)
  expect(await f.source.finished).toEqual({ ok: false, code: 'OVERLOADED' })
  expect(f.source.diagnostics().retainedBytes).toBe(4)
  expect(f.budget.diagnostics().reservedBytes).toBe(16)
  f.source.cancel()
  expect(f.source.push(new Uint8Array(1))).toBe(false)
  expect(f.stops()).toBe(1)
  expect(f.cancellations()).toBe(1)
  held.resolve()
  await f.source.drained
  expect(f.source.diagnostics().retainedBytes).toBe(0)
  expect(f.budget.diagnostics().reservedBytes).toBe(0)
})
test('many tiny callbacks cannot evade the chunk-count bound', async () => {
  const f = fixture()
  for (let i = 0; i < 4; i++) expect(f.source.push(new Uint8Array([i]))).toBe(true)
  expect(f.source.push(new Uint8Array([5]))).toBe(false)
  expect(await f.source.finished).toEqual({ ok: false, code: 'OVERLOADED' })
  await f.source.drained
  expect(f.budget.diagnostics().reservedBytes).toBe(0)
})
test('consumer failure is explicit and cancellation cannot hide active retained storage', async () => {
  const f = fixture(async () => {
    throw new Error('private adapter error')
  })
  f.source.push(new Uint8Array([1]))
  expect(await f.source.finished).toEqual({ ok: false, code: 'CONSUMER_FAILED' })
  await f.source.drained
  expect(f.stops()).toBe(1)
  const held = deferred<void>()
  const g = fixture(() => held.promise)
  g.source.push(new Uint8Array([2]))
  await tick()
  g.source.cancel()
  expect(await g.source.finished).toEqual({ ok: false, code: 'CANCELLED' })
  expect(g.source.diagnostics().retainedBytes).toBe(1)
  held.resolve()
  await g.source.drained
  expect(g.budget.diagnostics().reservedBytes).toBe(0)
})
test('all sources share admission reservations and release even on pre-aborted lifetime', async () => {
  const budget = new StreamBudget({ maxBytes: 16, maxBytesPerView: 16, maxBytesPerStream: 16 })
  const owner = {}
  const f = fixture()
  const options = { budget, owner, maxChunkBytes: 4, maxRetainedBytes: 16, stopSource() {} }
  const source = new CallbackStreamSource(f.writer, options)
  expect(() => new CallbackStreamSource(f.writer, options)).toThrow('Stream overloaded')
  source.cancel()
  await source.drained
  const cancelled = new CallbackStreamSource(f.writer, { ...options, signal: AbortSignal.abort() })
  expect(await cancelled.finished).toEqual({ ok: false, code: 'CANCELLED' })
  await cancelled.drained
  f.source.cancel()
  expect(budget.diagnostics().reservedBytes).toBe(0)
})
test('invalid input and stop callback failures remain observable without secret error text', async () => {
  const f = fixture()
  expect(f.source.push(new Uint8Array())).toBe(false)
  expect(await f.source.finished).toEqual({ ok: false, code: 'PROTOCOL_ERROR' })
  const budget = new StreamBudget()
  const source = new CallbackStreamSource(f.writer, {
    budget,
    owner: {},
    stopSource() {
      throw new Error('private source')
    },
  })
  source.cancel()
  await source.drained
  expect(source.diagnostics().sourceStopFailed).toBe(true)
  expect(JSON.stringify(source.diagnostics())).not.toContain('private source')
})

test('oversized input rejects before slicing or allocating queued copies', async () => {
  const f = fixture()
  const bytes = new Uint8Array(17)
  bytes.subarray = () => {
    throw new Error('must not slice rejected input')
  }
  expect(f.source.push(bytes)).toBe(false)
  expect(await f.source.finished).toEqual({ ok: false, code: 'OVERLOADED' })
  await f.source.drained
  expect(f.source.diagnostics().peakRetainedBytes).toBe(0)
})
test('source end failure and cancellation while ending never report successful completion', async () => {
  const held = deferred<void>()
  const f = fixture()
  const writer = { ...f.writer, end: () => held.promise }
  const budget = new StreamBudget()
  const source = new CallbackStreamSource(writer, { budget, owner: {}, stopSource() {} })
  const ending = source.end()
  await tick()
  source.cancel()
  expect(await ending).toEqual({ ok: false, code: 'CANCELLED' })
  expect(budget.diagnostics().reservedBytes).toBeGreaterThan(0)
  held.resolve()
  await source.drained
  expect(budget.diagnostics().reservedBytes).toBe(0)
  f.source.cancel()
})

test('producer overrides cannot hide byte size or replace the sliced snapshot', async () => {
  const seen: number[] = []
  const f = fixture(async (bytes) => {
    seen.push(...bytes)
  })
  const bytes = new Uint8Array([1, 2, 3, 4])
  bytes.subarray = () => {
    throw new Error('producer override must not execute')
  }
  Object.defineProperty(bytes, 'byteLength', { value: 1 })
  expect(f.source.push(bytes)).toBe(true)
  expect(await f.source.end()).toEqual({ ok: true })
  await f.source.drained
  expect(seen).toEqual([1, 2, 3, 4])
  const g = fixture()
  const huge = new Uint8Array(17)
  Object.defineProperty(huge, 'byteLength', { value: 1 })
  expect(g.source.push(huge)).toBe(false)
  expect(await g.source.finished).toEqual({ ok: false, code: 'OVERLOADED' })
  await g.source.drained
})
test('a disconnected idle writer immediately stops its source and releases its reservation', async () => {
  const f = fixture()
  f.writer.cancel()
  expect(await f.source.finished).toEqual({ ok: false, code: 'CANCELLED' })
  await f.source.drained
  expect(f.stops()).toBe(1)
  expect(f.budget.diagnostics().reservedBytes).toBe(0)
})
