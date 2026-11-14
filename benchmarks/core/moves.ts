/** Reorder siblings in a full native core transaction, including validation. */
import { DEFAULT_LIMITS } from '@bun-native/protocol'
import {
  CommittedText,
  makeNode,
  Transaction,
  type NodeState,
} from '../../packages/core/src/tree.ts'

const count = DEFAULT_LIMITS.max_nodes_per_window - 1
const root = makeNode(1, { kind: 'box' })
const nodes = new Map<number, NodeState>([[root.id, root]])
const children = Array.from({ length: count }, (_, index) => {
  const child = makeNode(index + 2, { kind: 'text', text: 'x' })
  child.parent = root.id
  root.children.push(child.id)
  nodes.set(child.id, child)
  return child
})
const text = new CommittedText(DEFAULT_LIMITS.max_text_bytes, nodes.values())
const samples = Number(process.argv[2] ?? 30)
if (!Number.isSafeInteger(samples) || samples < 1) throw new Error('Expected positive samples')
const n = Math.floor(count / 2)
const results = []
for (const pattern of ['tail-to-front', 'front-to-tail', 'adjacent', 'tail-noop'] as const) {
  const moves = Array.from({ length: n }, (_, i) =>
    pattern === 'tail-to-front'
      ? ([children[count - 1 - i]!, 0] as const)
      : pattern === 'front-to-tail'
        ? ([children[i]!, count - 1] as const)
        : pattern === 'adjacent'
          ? ([children[i * 2]!, i * 2 + 1] as const)
          : ([children[count - 1]!, count - 1] as const)
  )
  const expected = children.map((child) => child.id)
  for (const [node, index] of moves) {
    expected.splice(expected.indexOf(node.id), 1)
    expected.splice(index, 0, node.id)
  }
  const timings: number[] = []
  for (let run = 0; run < samples + 5; run += 1) {
    const batch = new Transaction(nodes, root.id, () => 5000, DEFAULT_LIMITS, [], text)
    const start = performance.now()
    for (const [child, index] of moves) batch.insert(root.handle, child.handle, index)
    batch.validate()
    const elapsed = performance.now() - start
    const actual = batch.nodes.get(root.id)!.children
    if (
      batch.operations.length !== n ||
      actual.length !== count ||
      actual.some((id, index) => id !== expected[index])
    )
      throw new Error('Unexpected move result')
    if (run >= 5) timings.push(elapsed)
  }
  const sorted = timings.toSorted((a, b) => a - b)
  results.push({
    pattern,
    moves: n,
    p50Ms: sorted[Math.ceil(samples * 0.5) - 1],
    p95Ms: sorted[Math.ceil(samples * 0.95) - 1],
    samplesMs: timings,
  })
}
console.log(
  JSON.stringify(
    { bun: Bun.revision, platform: process.platform, arch: process.arch, results },
    null,
    2
  )
)
