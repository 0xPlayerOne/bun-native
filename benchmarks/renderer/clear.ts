/**
 * Staged removal micro benchmark: mount N text rows under one root, remove half
 * of them in one batch with `removeNode`, then commit. Reports the staging time
 * (renderer sibling bookkeeping only) and the commit time separately, using the
 * same in-process acknowledging window as `commit.ts`.
 *
 *   bun benchmarks/renderer/clear.ts [rows] [runs]
 */
import type { NativeBatch, NativeNode, NativeWindow } from '@bun-native/core'
import {
  createElement,
  createRenderRoot,
  createTextNode,
  insertNode,
  removeNode,
  type RendererNode,
} from '@bun-native/renderer'

function fakeWindow() {
  const operations = { create: 0, set: 0, insert: 0, remove: 0 }
  let id = 0
  const handle = (kind: string) => ({ kind, id: id++ }) as unknown as NativeNode
  const batch: NativeBatch = {
    create: (element) => {
      operations.create += 1
      return handle(element.kind) as never
    },
    set: () => void (operations.set += 1),
    insert: () => void (operations.insert += 1),
    append: () => void (operations.insert += 1),
    remove: () => void (operations.remove += 1),
  }
  const window = {
    root: handle('box'),
    closed: new Promise<void>(() => {}),
    revision: 0,
    batch: async (update: (batch: NativeBatch) => unknown) => update(batch),
    on: () => () => {},
    input: () => ({ value: '', revision: 0 }),
    close: async () => {},
  } as unknown as NativeWindow
  return { window, operations }
}

type Pattern = 'front' | 'alternate' | 'middle' | 'random' | 'tail'

/** The rows each pattern removes, in removal order. */
function removals(pattern: Pattern, rows: readonly RendererNode[]): RendererNode[] {
  const half = rows.length / 2
  if (pattern === 'front') return rows.slice(0, half)
  if (pattern === 'alternate') return rows.filter((_, index) => index % 2)
  if (pattern === 'middle') return rows.slice(half / 2, half / 2 + half)
  if (pattern === 'tail') return rows.slice(half).reverse()
  let state = 12345
  const remaining = rows.slice()
  return Array.from({ length: half }, () => {
    state = (state * 1103515245 + 12345) % 2147483648
    return remaining.splice(state % remaining.length, 1)[0]!
  })
}

async function measure(pattern: Pattern, count: number) {
  const { window, operations } = fakeWindow()
  const rows: RendererNode[] = []
  let container!: RendererNode
  const root = createRenderRoot(window, (context) => {
    container = context.container
    for (let index = 0; index < count; index += 1) {
      const text = createElement('text')
      insertNode(text, createTextNode('row ' + index))
      insertNode(container as never, text)
      rows.push(text)
    }
  })
  await root.ready
  const removed = removals(pattern, rows)
  const before = operations.remove
  Bun.gc(true)
  const start = performance.now()
  for (const row of removed) removeNode(container as never, row as never)
  const staged = performance.now()
  await root.flush()
  const committed = performance.now()
  if (operations.remove - before !== removed.length) throw new Error('Unexpected removals')
  if (root.diagnostics.nodes !== count - removed.length + 1)
    throw new Error('Committed node count drifted')
  await root.dispose().catch(() => {})
  return { stage: staged - start, commit: committed - staged }
}

const rows = Number(process.argv[2] ?? 20_000)
const runs = Number(process.argv[3] ?? 5)
const median = (values: number[]) => values.toSorted((a, b) => a - b)[values.length >> 1]!
const results = []
for (const pattern of ['front', 'alternate', 'middle', 'random', 'tail'] as const) {
  const samples = []
  // One warm-up run per pattern.
  for (let run = 0; run <= runs; run += 1) samples.push(await measure(pattern, rows))
  samples.shift()
  const ms = (value: number) => Number(value.toFixed(2))
  results.push({
    pattern,
    rows,
    stageMs: ms(median(samples.map((sample) => sample.stage))),
    commitMs: ms(median(samples.map((sample) => sample.commit))),
  })
}
console.log(
  JSON.stringify(
    { bun: Bun.revision, platform: process.platform, arch: process.arch, results },
    null,
    2
  )
)
