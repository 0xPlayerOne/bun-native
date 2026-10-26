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

test('queued cancellation removes only its task while held work retains its reservation', async () => {
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

for (const microtaskRefill of [false, true]) {
  test(`cancel-last stale microtasks cannot multiply the turn budget (microtask refill: ${microtaskRefill})`, async () => {
    const scheduler = new FairWorkScheduler({
      maxWorkPerTurn: 2,
      maxQueuedWork: 32,
      reservedControlWork: 1,
    })
    const owner = {}
    let count = 0
    for (let index = 0; index < 6; index++) scheduler.schedule(owner, () => {})!.cancel()
    const pump = () => {
      count++
      if (count < 50) {
        const refill = () => {
          scheduler.schedule(owner, pump)
        }
        if (microtaskRefill) queueMicrotask(() => queueMicrotask(refill))
        else refill()
      }
    }
    const observed = new Promise<number[]>((resolve) =>
      setImmediate(() => {
        const first = count
        setImmediate(() => resolve([first, count]))
      })
    )
    scheduler.schedule(owner, pump)
    const [first, second] = await observed
    // Drain even when the regression fails, leaving no test-owned callbacks.
    while (count < 50 || scheduler.diagnostics().yieldPending) await turn()
    expect(first).toBe(2)
    expect(second! - first!).toBeLessThanOrEqual(2)
    expect(scheduler.diagnostics()).toMatchObject({
      queueDepth: 0,
      owners: 0,
      bulkQueued: 0,
      controlQueued: 0,
      dispatched: 50,
      cancelled: 6,
      yieldPending: false,
    })
    const idle = scheduler.diagnostics()
    await turn()
    await turn()
    expect(scheduler.diagnostics()).toEqual(idle)
  })
}

test('yield observers include pre-saturation items and isolate throwing/reentrant hooks', async () => {
  const scheduler = new FairWorkScheduler({ maxWorkPerTurn: 1 })
  const seen: string[] = []
  let startedYields = 0,
    cancelledYields = 0
  scheduler.schedule({}, () => seen.push('first'), { onYield: () => startedYields++ })
  scheduler.schedule({}, () => seen.push('throwing'), {
    onYield: () => {
      seen.push('yield')
      cancelled.cancel()
      scheduler.schedule({}, () => seen.push('reentrant'))
      throw new Error('observer failed')
    },
  })
  const cancelled = scheduler.schedule({}, () => seen.push('cancelled'), {
    onYield: () => cancelledYields++,
  })!
  scheduler.schedule({}, () => seen.push('peer'))
  for (let index = 0; index < 8; index++) await turn()
  expect(seen).toEqual(['first', 'yield', 'throwing', 'peer', 'reentrant'])
  expect(startedYields).toBe(0)
  expect(cancelledYields).toBe(0)
  expect(scheduler.diagnostics()).toMatchObject({
    queueDepth: 0,
    owners: 0,
    bulkQueued: 0,
    controlQueued: 0,
    dispatched: 4,
    cancelled: 1,
    yieldPending: false,
  })
})

test('optional scheduler hooks must be callable before admission', () => {
  const scheduler = new FairWorkScheduler()
  for (const key of ['onYield', 'onCancel'] as const) {
    for (const value of [null, false, 1, {}]) {
      expect(() => scheduler.schedule({}, () => {}, { [key]: value } as never)).toThrow(TypeError)
    }
  }
  expect(scheduler.diagnostics()).toMatchObject({ queueDepth: 0, owners: 0, enqueued: 0 })
})

test('quiet owner finishes while the first writer remains held and reserved', async () => {
  const scheduler = new FairWorkScheduler({ maxWorkPerTurn: 1 })
  const held = sourceFixture(scheduler, {}, true)
  const quiet = sourceFixture(scheduler, {}, false)
  held.source.push(new Uint8Array([1]))
  quiet.source.push(new Uint8Array([2, 3, 4]))
  const finished = quiet.source.end()
  expect(await finished).toEqual({ ok: true })
  await quiet.source.drained
  expect(held.received).toEqual([1])
  expect(quiet.received).toEqual([2, 3, 4])
  expect(quiet.budget.diagnostics()).toEqual({ reservedBytes: 0, streams: 0, views: 0 })
  expect(held.source.diagnostics()).toMatchObject({
    retainedBytes: 1,
    queuedChunks: 1,
    acknowledgedBytes: 0,
    reservedBytes: 8,
  })
  expect(held.budget.diagnostics().reservedBytes).toBe(8)
  // Even cancellation cannot release the active writer's reservation early.
  held.source.cancel()
  expect(held.budget.diagnostics().reservedBytes).toBe(8)
  held.hold.resolve()
  await held.source.drained
  expect(held.budget.diagnostics()).toEqual({ reservedBytes: 0, streams: 0, views: 0 })
  expect(scheduler.diagnostics()).toMatchObject({
    queueDepth: 0,
    owners: 0,
    bulkQueued: 0,
    controlQueued: 0,
    yieldPending: false,
    dropped: 0,
  })
  const idle = scheduler.diagnostics()
  await turn()
  await turn()
  expect(scheduler.diagnostics()).toEqual(idle)
})

for (const delayed of [false, true]) {
  test(`many sources share their noisy owner's quantum with a quiet owner (microtask refill: ${delayed})`, async () => {
    const scheduler = new FairWorkScheduler({ maxWorkPerTurn: 4 })
    const noisy = {},
      quiet = {},
      budget = new StreamBudget()
    const order: number[] = []
    const total = 64
    const sources = Array.from({ length: 13 }, (_, index) => {
      const result = deferred<StreamOutcome>()
      const received: number[] = []
      const source = new CallbackStreamSource(
        {
          async write(bytes) {
            received.push(...bytes)
            order.push(index)
            const refill = () => {
              if (received.length < total) source.push(new Uint8Array([received.length]))
              else void source.end()
            }
            if (delayed) queueMicrotask(() => queueMicrotask(refill))
            else refill()
          },
          async end() {
            result.resolve({ ok: true })
          },
          cancel() {
            result.resolve({ ok: false, code: 'CANCELLED' })
          },
          finished: result.promise,
        },
        {
          scheduler,
          budget,
          owner: index === 12 ? quiet : noisy,
          maxChunkBytes: 1,
          maxRetainedBytes: 8,
          maxQueuedChunks: 8,
          stopSource() {},
        }
      )
      return { source, received }
    })
    const observed = new Promise<number[]>((resolve) =>
      setImmediate(() => {
        const first = scheduler.diagnostics().dispatched
        setImmediate(() => resolve([first, scheduler.diagnostics().dispatched]))
      })
    )
    for (const { source } of sources) source.push(new Uint8Array([0]))
    const [first, second] = await observed
    expect(first).toBe(4)
    expect(second! - first!).toBeLessThanOrEqual(4)
    expect(order[1]).toBe(12)
    for (const { source } of sources) expect(await source.finished).toEqual({ ok: true })
    await Promise.all(sources.map(({ source }) => source.drained))
    const expected = Uint8Array.from({ length: total }, (_, index) => index)
    const hash = (bytes: Uint8Array) => new Bun.CryptoHasher('sha256').update(bytes).digest('hex')
    for (const { source, received } of sources) {
      expect(received).toEqual([...expected])
      expect(hash(new Uint8Array(received))).toBe(hash(expected))
      expect(source.diagnostics()).toMatchObject({
        retainedBytes: 0,
        allocatedBytes: 0,
        queuedChunks: 0,
        reservedBytes: 0,
        acknowledgedBytes: total,
        droppedBytes: 0,
        yieldPending: false,
      })
    }
    // A quiet owner finishes while most of the noisy owner's aggregate work is
    // still pending, despite that owner having twelve independently ready sources.
    expect(order.lastIndexOf(12)).toBeLessThan(total * 4)
    expect(budget.diagnostics()).toEqual({ reservedBytes: 0, streams: 0, views: 0 })
    expect(scheduler.diagnostics()).toMatchObject({
      queueDepth: 0,
      owners: 0,
      bulkQueued: 0,
      controlQueued: 0,
      dispatched: 13 * (total + 1),
      yieldPending: false,
      rejected: 0,
      dropped: 0,
    })
    const idle = scheduler.diagnostics()
    await turn()
    await turn()
    expect(scheduler.diagnostics()).toEqual(idle)
  })
}

test('reentrant cancel-last/refill during dispatch and yield owns only one continuation', async () => {
  const scheduler = new FairWorkScheduler({ maxWorkPerTurn: 1 })
  let runs = 0,
    cancelledHooks = 0
  scheduler.schedule({}, () => {
    const cancelled = scheduler.schedule({}, () => {}, {
      onCancel: () => {
        for (let index = 0; index < 6; index++) scheduler.schedule({}, () => {})!.cancel()
        scheduler.schedule({}, () => runs++)
      },
    })!
    cancelled.cancel()
  })
  await Promise.resolve()
  const last = scheduler.schedule({}, () => {}, {
    onYield: () => {
      last.cancel()
      scheduler.schedule({}, () => runs++)
    },
    onCancel: () => cancelledHooks++,
  })!
  const counts: number[] = []
  for (let index = 0; index < 6; index++) {
    await turn()
    counts.push(scheduler.diagnostics().dispatched)
  }
  for (let index = 1; index < counts.length; index++)
    expect(counts[index]! - counts[index - 1]!).toBeLessThanOrEqual(1)
  expect(runs).toBe(2)
  expect(cancelledHooks).toBe(1)
  expect(scheduler.diagnostics()).toMatchObject({
    queueDepth: 0,
    owners: 0,
    bulkQueued: 0,
    controlQueued: 0,
    dispatched: 3,
    cancelled: 8,
    yieldPending: false,
  })
})

test('a yield observer can cancel the entire queue and refill without an extra turn reset', async () => {
  const scheduler = new FairWorkScheduler({ maxWorkPerTurn: 1 })
  let dispatched = 0,
    cancelledYield = 0
  scheduler.schedule({}, () => dispatched++)
  const waiting = scheduler.schedule({}, () => dispatched++, {
    onYield: () => {
      waiting.cancel()
      victim.cancel()
      for (let index = 0; index < 4; index++) scheduler.schedule({}, () => dispatched++)
    },
  })!
  const victim = scheduler.schedule({}, () => dispatched++, { onYield: () => cancelledYield++ })!
  let previous = 0
  for (let index = 0; index < 8; index++) {
    await turn()
    expect(dispatched - previous).toBeLessThanOrEqual(1)
    previous = dispatched
  }
  expect(dispatched).toBe(5)
  expect(cancelledYield).toBe(0)
  expect(scheduler.diagnostics()).toMatchObject({
    queueDepth: 0,
    owners: 0,
    cancelled: 2,
    dispatched: 5,
    bulkQueued: 0,
    controlQueued: 0,
    yieldPending: false,
  })
})
