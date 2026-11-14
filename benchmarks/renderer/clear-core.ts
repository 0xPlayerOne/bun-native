/**
 * Clear half of a full window through the shared renderer and real core
 * transactions. The in-process window acknowledges immediately; this does
 * not measure framing, IPC, native preflight, rendering or display latency.
 *
 *   bun benchmarks/renderer/clear-core.ts [samples=12]
 */
import type { NativeBatch, NativeWindow } from '@bun-native/core'
import { DEFAULT_LIMITS, REQUIRED_CAPABILITIES } from '@bun-native/protocol'
import {
  createElement,
  createRenderRoot,
  insertNode,
  removeNode,
  type Node,
} from '@bun-native/renderer'
import {
  CommittedText,
  makeNode,
  Transaction,
  type NodeState,
} from '../../packages/core/src/tree.ts'

type Pattern = 'front' | 'tail'

async function measure(pattern: Pattern) {
  let next = 1
  const allocate = () => next++
  const root = makeNode(allocate(), { kind: 'box' })
  const nodes = new Map<number, NodeState>([[root.id, root]])
  const text = new CommittedText(DEFAULT_LIMITS.max_text_bytes, nodes.values())
  let deletions = 0
  const window = {
    root: root.handle,
    closed: new Promise<void>(() => {}),
    revision: 0,
    batch: async (update: (batch: NativeBatch) => unknown) => {
      const transaction = new Transaction(
        nodes,
        root.id,
        allocate,
        DEFAULT_LIMITS,
        REQUIRED_CAPABILITIES,
        text
      )
      const result = update(transaction)
      transaction.validate()
      transaction.finish()
      for (const operation of transaction.operations)
        if (operation.type === 'delete') deletions += 1
      transaction.commit(nodes, text)
      return result
    },
    on: () => () => {},
    input: () => ({ value: '', revision: 0 }),
    close: async () => {},
  } as unknown as NativeWindow
  const rows: Node[] = []
  let container!: Node
  const render = createRenderRoot(window, (context) => {
    container = context.container
    for (let index = 0; index < DEFAULT_LIMITS.max_nodes_per_window - 2; index += 1) {
      const row = createElement('text')
      insertNode(container, row)
      rows.push(row)
    }
  })
  await render.ready
  const half = rows.length / 2
  const selected = pattern === 'tail' ? rows.slice(half).reverse() : rows.slice(0, half)
  const expected = pattern === 'tail' ? rows.slice(0, half) : rows.slice(half)
  const handles = expected.map((node) => node.handle)
  const before = deletions
  const start = performance.now()
  for (const row of selected) removeNode(container, row)
  const staged = performance.now()
  await render.flush()
  const finished = performance.now()
  const parent = [...nodes.values()].find((node) => node.handle === container.handle)
  if (
    deletions - before !== selected.length ||
    !parent ||
    parent.children.length !== handles.length ||
    parent.children.some((id, index) => nodes.get(id)?.handle !== handles[index]) ||
    render.diagnostics.nodes !== handles.length + 1
  )
    throw new Error('Unexpected removal count or remaining order')
  await render.dispose()
  if (nodes.size !== 1) throw new Error('Disposed tree retained nodes')
  return { stageMs: staged - start, commitMs: finished - staged }
}

const samples = Number(process.argv[2] ?? 12)
if (!Number.isSafeInteger(samples) || samples < 1) throw new Error('Expected positive samples')
const results = []
for (const pattern of ['tail', 'front'] as const) {
  const timings = []
  for (let run = 0; run < samples + 3; run += 1) {
    const result = await measure(pattern)
    if (run >= 3) timings.push(result)
  }
  const values = timings.map((sample) => sample.commitMs).toSorted((a, b) => a - b)
  results.push({ pattern, samples: timings, commitP50Ms: values[Math.ceil(samples * 0.5) - 1] })
}
console.log(
  JSON.stringify(
    { bun: Bun.revision, platform: process.platform, arch: process.arch, results },
    null,
    2
  )
)
