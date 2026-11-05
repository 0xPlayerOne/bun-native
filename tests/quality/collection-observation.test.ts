import { expect, test } from 'bun:test'
import { observeCollection } from '../../benchmarks/solid/collection.ts'

/** Allocate in a separate frame so the caller holds only weak references. */
function released(count: number): WeakRef<object>[] {
  return Array.from({ length: count }, (_, index) => new WeakRef({ index, data: [index] }))
}

const owner: object[] = []

test('released targets become collectable within the settled rounds', async () => {
  const observation = await observeCollection(released(10))
  expect(observation.survivors).toEqual([])
  expect(observation.rounds).toBeGreaterThanOrEqual(1)
  expect(observation.rounds).toBeLessThanOrEqual(observation.maxRounds)
})

test('a strongly owned target is still reported after every round (negative control)', async () => {
  const references = released(10)
  const retained = { index: 'owned' }
  owner.push(retained)
  references.splice(4, 0, new WeakRef(retained))
  const observation = await observeCollection(references)
  expect(observation.survivors).toEqual([4])
  expect(observation.rounds).toBe(observation.maxRounds)
  owner.length = 0
  // The helper itself keeps nothing: the released owner's target now clears.
  expect((await observeCollection(references)).survivors).toEqual([])
})

test('a strong edge removed only after observation still fails that observation', async () => {
  const retained = { index: 'late' }
  owner.push(retained)
  const references = [new WeakRef(retained)]
  const observation = await observeCollection(references, 2)
  owner.length = 0
  expect(observation).toEqual({ survivors: [0], rounds: 2, maxRounds: 2 })
})

test('round bounds are validated', async () => {
  for (const rounds of [0, 21, 1.5, Number.NaN])
    await expect(observeCollection([], rounds)).rejects.toThrow(RangeError)
})
