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
const turn = () => new Promise<void>((resolve) => setImmediate(resolve))
function source(write: BinaryStreamWriter['write'], bytes = 16, frames = 4) {
  const outcome = deferred<StreamOutcome>(),
    budget = new StreamBudget()
  let stopped = 0
  const writer: BinaryStreamWriter = {
    write,
    finished: outcome.promise,
    async end() {
      outcome.resolve({ ok: true })
    },
    cancel() {
      outcome.resolve({ ok: false, code: 'CANCELLED' })
    },
  }
  const result = new CallbackStreamSource(writer, {
    budget,
    owner: {},
    maxChunkBytes: 4,
    maxRetainedBytes: bytes,
    maxQueuedChunks: frames,
    coalescePending: true,
    stopSource() {
      stopped++
    },
  })
  return { source: result, budget, stopped: () => stopped }
}
test('pending tiny callbacks coalesce within unchanged frame and allocation budgets', async () => {
  const seen: number[] = [],
    f = source(async (bytes) => {
      seen.push(...bytes)
    })
  for (let i = 0; i < 16; i++) expect(f.source.push(new Uint8Array([i]))).toBe(true)
  expect(f.source.diagnostics().queuedChunks).toBe(4)
  expect(f.source.diagnostics().allocatedBytes).toBe(16)
  expect(await f.source.end()).toEqual({ ok: true })
  await f.source.drained
  expect(seen).toEqual(Array.from({ length: 16 }, (_, i) => i))
  expect(f.source.diagnostics().coalescedBytes).toBe(12)
  expect(f.source.diagnostics().allocatedBytes).toBe(0)
  expect(f.budget.diagnostics().reservedBytes).toBe(0)
})
test('coalescing never waits for a full batch or mutates an active writer buffer', async () => {
  const gate = deferred<void>(),
    seen: number[] = []
  let active: Uint8Array | undefined
  const f = source(async (bytes) => {
    if (!active) {
      active = bytes
      await gate.promise
    }
    seen.push(...bytes)
  })
  f.source.push(new Uint8Array([1]))
  await turn()
  expect(active).toEqual(new Uint8Array([1]))
  for (let i = 2; i <= 9; i++) {
    const bytes = new Uint8Array([i])
    expect(f.source.push(bytes)).toBe(true)
    bytes.fill(0)
  }
  expect(active).toEqual(new Uint8Array([1]))
  expect(f.source.diagnostics().queuedChunks).toBe(3)
  gate.resolve()
  expect(await f.source.end()).toEqual({ ok: true })
  await f.source.drained
  expect(seen).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9])
})
test('allocated slack and transferred active buffers remain charged through settlement', async () => {
  const gate = deferred<void>()
  const f = source(
    async (bytes) => {
      structuredClone(bytes, { transfer: [bytes.buffer] })
      await gate.promise
    },
    8,
    2
  )
  f.source.push(new Uint8Array([1]))
  await turn()
  expect(f.source.diagnostics().allocatedBytes).toBe(4)
  expect(f.source.push(new Uint8Array([2, 3, 4, 5]))).toBe(true)
  expect(f.source.push(new Uint8Array([6]))).toBe(false)
  expect(await f.source.finished).toEqual({ ok: false, code: 'OVERLOADED' })
  expect(f.source.diagnostics().retainedBytes).toBe(1)
  expect(f.source.diagnostics().allocatedBytes).toBe(4)
  expect(f.budget.diagnostics().reservedBytes).toBe(8)
  gate.resolve()
  await f.source.drained
  expect(f.source.diagnostics().allocatedBytes).toBe(0)
  expect(f.stopped()).toBe(1)
})
test('a fractional final block uses only the remaining reserved allocation', async () => {
  const seen: number[] = [],
    f = source(
      async (bytes) => {
        seen.push(...bytes)
      },
      10,
      3
    )
  for (let i = 0; i < 10; i++) expect(f.source.push(new Uint8Array([i]))).toBe(true)
  expect(f.source.diagnostics().allocatedBytes).toBe(10)
  expect(await f.source.end()).toEqual({ ok: true })
  await f.source.drained
  expect(seen).toEqual(Array.from({ length: 10 }, (_, i) => i))
  expect(f.source.diagnostics().peakAllocatedBytes).toBe(10)
})
