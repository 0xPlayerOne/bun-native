import { expect, test } from 'bun:test'
import { stableChildren as flags } from '@bun-native/core/order'

/** The flagged desired children, as a set. */
function stableChildren<T>(current: readonly T[], desired: readonly T[]): Set<T> {
  const flagged = flags(current, desired)
  expect(flagged.length).toBe(desired.length)
  return new Set(desired.filter((_, index) => flagged[index] === 1))
}

function permutations<T>(values: readonly T[]): T[][] {
  if (!values.length) return [[]]
  return values.flatMap((value, index) =>
    permutations(values.filter((_, candidate) => candidate !== index)).map((rest) => [
      value,
      ...rest,
    ])
  )
}

/** Independent exhaustive-subset oracle, deliberately different from the planner. */
function longestSubsequence<T>(current: readonly T[], desired: readonly T[]): number {
  let longest = 0
  for (let mask = 0; mask < 2 ** desired.length; mask++) {
    const subset = desired.filter((_, index) => (mask & (1 << index)) !== 0)
    const positions = subset.map((node) => current.indexOf(node))
    if (
      positions.every(
        (position, index) => position >= 0 && (index === 0 || position > positions[index - 1]!)
      )
    )
      longest = Math.max(longest, subset.length)
  }
  return longest
}

test('keyed ordering retains the maximum existing subsequence for every four-item permutation', () => {
  const orders = permutations(Array.from({ length: 4 }, (_, id) => ({ id })))
  for (const current of orders) {
    for (const desired of orders) {
      const stable = stableChildren(current, desired)
      expect(stable.size).toBe(longestSubsequence(current, desired))
      expect(desired.filter((node) => stable.has(node))).toEqual(
        current.filter((node) => stable.has(node))
      )
    }
  }
})

test('new children are never retained and unchanged/empty sibling lists need no moves', () => {
  const nodes = [{}, {}, {}]
  expect(stableChildren([], nodes).size).toBe(0)
  expect(stableChildren(nodes, []).size).toBe(0)
  expect(stableChildren(nodes, nodes).size).toBe(3)
  const fresh = {}
  const stable = stableChildren(nodes, [fresh, nodes[2]!, nodes[0]!])
  expect(stable.has(fresh)).toBe(false)
  expect(stable.size).toBe(1)
})

test('keyed ordering stays maximal with added, removed and shared end children', () => {
  // Deterministic xorshift so a failure names a reproducible case.
  let state = 2463534242
  const next = (limit: number) => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return (state >>> 0) % limit
  }
  const pool = Array.from({ length: 8 }, (_, id) => ({ id }))
  const sample = () => {
    const shuffled = pool.toSorted(() => next(3) - 1)
    return shuffled.slice(0, next(pool.length + 1))
  }
  for (let round = 0; round < 2000; round += 1) {
    const current = sample()
    let desired = sample()
    // Often keep a shared prefix and suffix around an edited middle.
    if (next(2) && current.length > 2) {
      const middle = desired.filter((node) => node !== current[0] && node !== current.at(-1))
      desired = [current[0]!, ...middle, current.at(-1)!]
    }
    const stable = stableChildren(current, desired)
    expect(stable.size).toBe(longestSubsequence(current, desired))
    expect(desired.filter((node) => stable.has(node))).toEqual(
      current.filter((node) => stable.has(node))
    )
  }
})

test('native node identities keep the same longest run as renderer nodes', () => {
  // The staged commit planner orders numeric identities with the same search.
  const stable = stableChildren([1, 2, 3, 4, 5, 6], [7, 1, 4, 2, 5, 6, 3])
  expect(stable.size).toBe(longestSubsequence([1, 2, 3, 4, 5, 6], [7, 1, 4, 2, 5, 6, 3]))
  expect([...stable]).toEqual([1, 2, 5, 6])
})
