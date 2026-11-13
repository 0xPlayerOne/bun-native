/**
 * Flag, by index in `desired`, a longest existing sibling subsequence; every
 * other desired child needs a move. Children are distinct within each list:
 * renderer nodes or native node identities.
 */
export function stableChildren<T>(current: readonly T[], desired: readonly T[]): Uint8Array {
  const stable = new Uint8Array(desired.length)
  // A common prefix and suffix extend some longest subsequence, so only the
  // middle needs the search; keyed edits usually leave both ends in place.
  let start = 0
  const shorter = Math.min(current.length, desired.length)
  while (start < shorter && current[start] === desired[start]) stable[start++] = 1
  let currentEnd = current.length
  let desiredEnd = desired.length
  while (
    currentEnd > start &&
    desiredEnd > start &&
    current[currentEnd - 1] === desired[desiredEnd - 1]
  ) {
    currentEnd -= 1
    stable[--desiredEnd] = 1
  }
  if (start === currentEnd || start === desiredEnd) return stable
  const positions = new Map<T, number>()
  for (let index = start; index < currentEnd; index += 1) positions.set(current[index]!, index)
  // tails[length - 1]: desired index ending the lowest-positioned run of that length.
  const size = desiredEnd - start
  const tails = new Int32Array(size)
  const tailPositions = new Int32Array(size)
  const preceding = new Int32Array(size)
  let length = 0
  for (let index = start; index < desiredEnd; index += 1) {
    const position = positions.get(desired[index]!)
    if (position === undefined) continue
    let low = 0
    let high = length
    while (low < high) {
      const middle = (low + high) >>> 1
      if (tailPositions[middle]! < position) low = middle + 1
      else high = middle
    }
    preceding[index - start] = low > 0 ? tails[low - 1]! : -1
    tails[low] = index
    tailPositions[low] = position
    if (low === length) length += 1
  }
  for (let index = length ? tails[length - 1]! : -1; index >= 0; index = preceding[index - start]!)
    stable[index] = 1
  return stable
}
