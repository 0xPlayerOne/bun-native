/**
 * Core transaction bulk removals from a full 4,096-node window.
 * Measures removal and validation only, without IPC, native work or paint.
 *
 *   bun benchmarks/core/removals.ts [samples=30]
 */
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

const results = []
for (const pattern of ['front', 'tail', 'alternate'] as const) {
  const selected =
    pattern === 'front'
      ? children.slice(0, Math.ceil(count / 2))
      : pattern === 'tail'
        ? children.slice(-Math.ceil(count / 2)).reverse()
        : children.filter((_, index) => index % 2 === 0)
  const removed = new Set(selected.map((node) => node.id))
  const expected = children.filter((node) => !removed.has(node.id)).map((node) => node.id)
  const timings: number[] = []
  for (let run = 0; run < samples + 5; run += 1) {
    const batch = new Transaction(nodes, root.id, () => 5000, DEFAULT_LIMITS, [], text)
    const start = performance.now()
    for (const child of selected) batch.remove(child.handle)
    batch.validate()
    const elapsed = performance.now() - start
    const actual = batch.nodes.get(root.id)!.children
    if (
      batch.operations.length !== selected.length ||
      batch.nodes.size !== nodes.size - selected.length ||
      actual.length !== expected.length ||
      actual.some((id, index) => id !== expected[index])
    )
      throw new Error('Unexpected removal result')
    if (run >= 5) timings.push(elapsed)
  }
  const sorted = timings.toSorted((a, b) => a - b)
  results.push({
    pattern,
    removed: selected.length,
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
