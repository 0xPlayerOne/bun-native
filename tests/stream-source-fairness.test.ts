import { test, expect } from 'bun:test'
import { CallbackStreamSource } from '../packages/runtime/src/stream-source.ts'
import { StreamBudget } from '../packages/contracts/src/stream-budget.ts'
import type { BinaryStreamWriter, StreamOutcome } from '../packages/contracts/src/streams.ts'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
const turn = () => new Promise<void>((resolve) => setImmediate(resolve))

/** Continuously ready acknowledgments and reentrant input, with at most two owned bytes. */
function flowing(total: number, delayedRefill = false) {
  const budget = new StreamBudget()
  const outcome = deferred<StreamOutcome>()
  const received: number[] = []
  let stops = 0
  let source!: CallbackStreamSource
  const writer: BinaryStreamWriter = {
    async write(bytes) {
      received.push(...bytes)
      const refill = () => {
        if (received.length < total) source.push(new Uint8Array([received.length % 256]))
        else void source.end()
      }
      if (delayedRefill) queueMicrotask(() => queueMicrotask(refill))
      else refill()
    },
    async end() {
      outcome.resolve({ ok: true })
    },
    cancel() {
      outcome.resolve({ ok: false, code: 'CANCELLED' })
    },
    finished: outcome.promise,
  }
  source = new CallbackStreamSource(writer, {
    budget,
    owner: {},
    maxChunkBytes: 1,
    maxRetainedBytes: 8,
    maxQueuedChunks: 8,
    stopSource() {
      stops++
    },
  })
  return { source, budget, received, stops: () => stops }
}

test('continuously ready callback output yields to control before completing its backlog', async () => {
  const f = flowing(2048)
  const control = deferred<number>()
  const task = setImmediate(() => control.resolve(f.received.length))
  try {
    expect(f.source.push(new Uint8Array([0]))).toBe(true)
    const atControl = await control.promise
    expect(atControl).toBeGreaterThan(0)
    expect(atControl).toBeLessThanOrEqual(16)
    expect(await f.source.finished).toEqual({ ok: true })
    await f.source.drained
    expect(f.received).toEqual(Array.from({ length: 2048 }, (_, index) => index % 256))
    expect(f.source.diagnostics().acknowledgedBytes).toBe(2048)
    expect(f.stops()).toBe(0)
    expect(f.budget.diagnostics()).toEqual({ reservedBytes: 0, streams: 0, views: 0 })
  } finally {
    clearImmediate(task)
    f.source.cancel()
    await f.source.drained
  }
})

test('event-loop cancellation interrupts a continuously ready source without dropping a successful stream', async () => {
  const f = flowing(2048)
  const task = setImmediate(() => f.source.cancel())
  try {
    f.source.push(new Uint8Array([0]))
    expect(await f.source.finished).toEqual({ ok: false, code: 'CANCELLED' })
    await f.source.drained
    expect(f.received.length).toBeGreaterThan(0)
    expect(f.received.length).toBeLessThanOrEqual(16)
    const before = f.received.length
    await turn()
    expect(f.received.length).toBe(before)
    expect(f.stops()).toBe(1)
    expect(f.source.diagnostics().retainedBytes).toBe(0)
    expect(f.budget.diagnostics()).toEqual({ reservedBytes: 0, streams: 0, views: 0 })
  } finally {
    clearImmediate(task)
    f.source.cancel()
    await f.source.drained
  }
})

test('separate default schedulers each bound their own source, not their aggregate work', async () => {
  const sources = [flowing(512), flowing(512), flowing(512)]
  const control = deferred<number[]>()
  const task = setImmediate(() => control.resolve(sources.map((f) => f.received.length)))
  try {
    for (const f of sources) f.source.push(new Uint8Array([0]))
    for (const count of await control.promise) {
      expect(count).toBeGreaterThan(0)
      expect(count).toBeLessThanOrEqual(16)
    }
    for (const f of sources) {
      expect(await f.source.finished).toEqual({ ok: true })
      await f.source.drained
      expect(f.received.length).toBe(512)
      expect(f.budget.diagnostics()).toEqual({ reservedBytes: 0, streams: 0, views: 0 })
    }
  } finally {
    clearImmediate(task)
    for (const f of sources) f.source.cancel()
    await Promise.all(sources.map((f) => f.source.drained))
  }
})

// An empty internal queue does not establish that a real event-loop turn occurred.
test('microtask-separated refills cannot reset the drain quantum and starve control', async () => {
  const f = flowing(2048, true)
  const control = deferred<number>()
  const task = setImmediate(() => control.resolve(f.received.length))
  try {
    f.source.push(new Uint8Array([0]))
    const atControl = await control.promise
    expect(atControl).toBeGreaterThan(0)
    expect(atControl).toBeLessThanOrEqual(16)
    expect(await f.source.finished).toEqual({ ok: true })
    await f.source.drained
    expect(f.received).toEqual(Array.from({ length: 2048 }, (_, index) => index % 256))
    expect(f.source.diagnostics().yieldPending).toBe(false)
    expect(f.source.diagnostics().yieldCount).toBeGreaterThan(0)
    expect(f.budget.diagnostics()).toEqual({ reservedBytes: 0, streams: 0, views: 0 })
  } finally {
    clearImmediate(task)
    f.source.cancel()
    await f.source.drained
  }
})

test('an idle source creates no recurring yield and cancellation removes a pending yield', async () => {
  const f = flowing(128)
  try {
    await turn()
    await turn()
    expect(f.source.diagnostics().yieldCount).toBe(0)
    expect(f.source.diagnostics().yieldPending).toBe(false)
    const control = deferred<boolean>()
    const task = setImmediate(() => {
      control.resolve(f.source.diagnostics().yieldPending)
      f.source.cancel()
    })
    try {
      f.source.push(new Uint8Array([0]))
      expect(await control.promise).toBe(true)
      expect(await f.source.finished).toEqual({ ok: false, code: 'CANCELLED' })
      await f.source.drained
      const stopped = f.source.diagnostics()
      expect(stopped.yieldPending).toBe(false)
      expect(stopped.yieldCount).toBe(0)
      await turn()
      expect(f.source.diagnostics()).toEqual(stopped)
      expect(f.budget.diagnostics()).toEqual({ reservedBytes: 0, streams: 0, views: 0 })
    } finally {
      clearImmediate(task)
    }
  } finally {
    f.source.cancel()
    await f.source.drained
  }
})
