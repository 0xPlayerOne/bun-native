import { expect, test } from 'bun:test'
import { stableChildren } from '../../packages/renderer/src/order.ts'

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
