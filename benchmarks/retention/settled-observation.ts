/**
 * Settled collectability observation for weakly referenced targets.
 *
 * Pinned Bun/JSC marks the native stack conservatively. A disposed object can
 * remain reachable from a stale stack or register word for a turn after its
 * last use, most often the final object of a loop (measured in
 * `benchmarks/retention/settled-collection.md`). One forced collection
 * therefore cannot distinguish that residue from an application-owned edge.
 *
 * Each round ends the current job on a fresh timer turn (which also releases
 * the job-scoped WeakRef pins created by `deref()`), overwrites the reusable
 * stack region, then runs a full collection. A strongly owned target can never
 * become unreachable through additional collection, so a genuine ownership
 * leak is still reported after the final round. Rounds are bounded and the
 * used count is returned for evidence; callers assert on `survivors`.
 */
export type CollectionObservation = {
  /** Indexes of targets that remained reachable after the final round. */
  readonly survivors: readonly number[]
  /** Rounds performed, from 1 to `maxRounds`. */
  readonly rounds: number
  readonly maxRounds: number
}

export const defaultCollectionRounds = 5

/** Overwrite stack slots that earlier frames may have left holding cells. */
function overwriteStack(depth: number): number {
  const slots = [depth, depth + 1, depth + 2, depth + 3, depth + 4, depth + 5, depth + 6, depth + 7]
  return depth === 0 ? slots.length : overwriteStack(depth - 1) + slots[depth % 8]!
}

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

export async function observeCollection(
  references: readonly Pick<WeakRef<object>, 'deref'>[],
  maxRounds = defaultCollectionRounds
): Promise<CollectionObservation> {
  if (!Number.isInteger(maxRounds) || maxRounds < 1 || maxRounds > 20)
    throw new RangeError('Collection rounds must be an integer from 1 to 20')
  let survivors: number[] = []
  for (let round = 1; round <= maxRounds; round++) {
    await nextTurn()
    overwriteStack(256)
    Bun.gc(true)
    survivors = references.flatMap((reference, index) =>
      reference.deref() === undefined ? [] : [index]
    )
    if (survivors.length === 0) return { survivors, rounds: round, maxRounds }
  }
  return { survivors, rounds: maxRounds, maxRounds }
}
