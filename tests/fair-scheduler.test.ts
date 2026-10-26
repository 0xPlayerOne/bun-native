import { expect, test } from 'bun:test'
import { StreamBudget } from '../packages/contracts/src/stream-budget.ts'
import type { BinaryStreamWriter, StreamOutcome } from '../packages/contracts/src/streams.ts'
import { CallbackStreamSource } from '../packages/runtime/src/stream-source.ts'
import { FairWorkScheduler } from '../packages/runtime/src/fair-scheduler.ts'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const turn = () => new Promise<void>((resolve) => setImmediate(resolve))

test('owner round robin bounds total work independently of active source count', async () => {
  const scheduler = new FairWorkScheduler({
    maxWorkPerTurn: 4,
    maxQueuedWork: 32,
    reservedControlWork: 4,
  })
  const noisyOwner = {},
    quietOwner = {}
  const seen: string[] = []
  const firstTurn = deferred<number>()
  setImmediate(() => firstTurn.resolve(seen.length))
  for (let index = 0; index < 24; index++)
    scheduler.schedule(noisyOwner, () => seen.push(`noisy-${index}`))
  scheduler.schedule(quietOwner, () => seen.push('quiet'))
  expect(await firstTurn.promise).toBeLessThanOrEqual(4)
  expect(seen[1]).toBe('quiet')
  while (scheduler.diagnostics().queueDepth || scheduler.diagnostics().yieldPending) await turn()
  expect(seen).toHaveLength(25)
  expect(scheduler.diagnostics()).toMatchObject({
    queueDepth: 0,
    owners: 0,
    maxWorkPerTurn: 4,
    dropped: 0,
    coalesced: 0,
  })
  expect(scheduler.diagnostics().yields).toBeGreaterThan(0)
})

test('control reserve admits bounded control work while bulk capacity denies excess', async () => {
  const scheduler = new FairWorkScheduler({
    maxWorkPerTurn: 2,
    maxQueuedWork: 4,
    reservedControlWork: 1,
  })
  const owner = {}
  expect(scheduler.schedule(owner, () => {})).toBeDefined()
  expect(scheduler.schedule(owner, () => {})).toBeDefined()
  expect(scheduler.schedule(owner, () => {})).toBeDefined()
  expect(scheduler.schedule(owner, () => {})).toBeUndefined()
  expect(scheduler.schedule(owner, () => {}, { priority: 'control' })).toBeDefined()
  const queued = scheduler.diagnostics()
  expect(queued).toMatchObject({ queueDepth: 4, bulkQueued: 3, controlQueued: 1, rejected: 1 })
  await turn()
  while (scheduler.diagnostics().queueDepth || scheduler.diagnostics().yieldPending) await turn()
  expect(scheduler.diagnostics()).toMatchObject({ queueDepth: 0, dropped: 0, coalesced: 0 })
})

interface SourceFixture {
  readonly source: CallbackStreamSource
  readonly received: number[]
  readonly hold: ReturnType<typeof deferred<void>>
  readonly budget: StreamBudget
}

function sourceFixture(scheduler: FairWorkScheduler, owner: object, held: boolean): SourceFixture {
  const outcome = deferred<StreamOutcome>()
  const received: number[] = []
  const hold = deferred<void>()
  const writer: BinaryStreamWriter = {
    async write(bytes) {
      received.push(...bytes)
      if (held) await hold.promise
    },
    async end() {
      outcome.resolve({ ok: true })
    },
    cancel() {
      outcome.resolve({ ok: false, code: 'CANCELLED' })
    },
    finished: outcome.promise,
  }
  const budget = new StreamBudget()
  const source = new CallbackStreamSource(writer, {
    budget,
    owner,
    scheduler,
    maxChunkBytes: 1,
    maxRetainedBytes: 8,
    maxQueuedChunks: 8,
    stopSource() {},
  })
  return { source, received, hold, budget }
}

test('held work does not block another owner and queued cancellation removes only its task', async () => {
  const scheduler = new FairWorkScheduler({
    maxWorkPerTurn: 1,
    maxQueuedWork: 8,
    reservedControlWork: 1,
  })
  const held = sourceFixture(scheduler, {}, true)
  const quiet = sourceFixture(scheduler, {}, false)
  expect(held.source.push(new Uint8Array([1]))).toBe(true)
  expect(quiet.source.push(new Uint8Array([2]))).toBe(true)
  await Promise.resolve()
  expect(held.received).toEqual([1])
  expect(quiet.received).toEqual([])
  expect(held.budget.diagnostics().reservedBytes).toBe(8)
  quiet.source.cancel()
  expect(await quiet.source.finished).toEqual({ ok: false, code: 'CANCELLED' })
  await quiet.source.drained
  expect(scheduler.diagnostics().queueDepth).toBe(0)
  expect(held.budget.diagnostics().reservedBytes).toBe(8)
  held.hold.resolve()
  held.source.cancel()
  await held.source.drained
  expect(scheduler.diagnostics()).toMatchObject({
    queueDepth: 0,
    owners: 0,
    dropped: 0,
    coalesced: 0,
  })
  expect(held.budget.diagnostics()).toEqual({ reservedBytes: 0, streams: 0, views: 0 })
})

test('scheduler rejects malformed bounds and settles counters after cancellation', async () => {
  expect(() => new FairWorkScheduler({ maxWorkPerTurn: 0 })).toThrow(TypeError)
  expect(() => new FairWorkScheduler({ maxQueuedWork: 1, reservedControlWork: 1 })).toThrow(
    TypeError
  )
  const scheduler = new FairWorkScheduler({ maxQueuedWork: 2, reservedControlWork: 1 })
  const owner = {}
  const first = scheduler.schedule(owner, () => {})!
  const second = scheduler.schedule(owner, () => {})
  expect(second).toBeUndefined()
  expect(first.cancel()).toBe(true)
  expect(first.cancel()).toBe(false)
  await turn()
  expect(scheduler.diagnostics()).toMatchObject({
    queueDepth: 0,
    owners: 0,
    cancelled: 1,
    rejected: 1,
    dropped: 0,
    coalesced: 0,
  })
})
