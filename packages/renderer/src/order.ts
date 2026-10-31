/** Retain a longest existing sibling subsequence; every other child needs a move. */
export function stableChildren<T extends object>(
  current: readonly T[],
  desired: readonly T[]
): ReadonlySet<T> {
  const positions = new Map(current.map((node, index) => [node, index]))
  const tails: { node: T; position: number }[] = []
  const preceding = new Map<T, T | undefined>()
  for (const node of desired) {
    const position = positions.get(node)
    if (position === undefined) continue
    let start = 0
    let end = tails.length
    while (start < end) {
      const middle = (start + end) >>> 1
      if (tails[middle]!.position < position) start = middle + 1
      else end = middle
    }
    preceding.set(node, tails[start - 1]?.node)
    tails[start] = { node, position }
  }
  const stable = new Set<T>()
  let node = tails.at(-1)?.node
  while (node !== undefined) {
    stable.add(node)
    node = preceding.get(node)
  }
  return stable
}
