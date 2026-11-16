/** Isolated append-to-wide-list commit timings; excludes IPC and native paint. */
import { strict as assert } from 'node:assert'
import type { NativeBatch, NativeNode, NativeWindow } from '@bun-native/core'
import {
  createElement,
  createRenderRoot,
  insertNode,
  removeNode,
  setProperty,
} from '@bun-native/renderer'

const rows = Number(process.argv[2] ?? 4000)
const samples = Number(process.argv[3] ?? 200)
assert(Number.isSafeInteger(rows) && rows > 0 && rows <= 10000)
assert(Number.isSafeInteger(samples) && samples > 0 && samples <= 10000)
let id = 0
const count = { created: 0, inserted: 0, removed: 0 }
const node = (kind: string) => ({ kind, id: id++ }) as unknown as NativeNode
const batch = {
  create(element: { kind: string }) {
    count.created++
    return node(element.kind)
  },
  insert() {
    count.inserted++
  },
  append() {
    count.inserted++
  },
  remove() {
    count.removed++
  },
} as unknown as NativeBatch
const window = {
  root: node('box'),
  closed: new Promise<void>(() => {}),
  batch: async (run: (batch: NativeBatch) => unknown) => run(batch),
  on: () => () => {},
} as unknown as NativeWindow
let list!: ReturnType<typeof createElement>
const root = createRenderRoot(window, ({ container }) => {
  list = createElement('box')
  insertNode(container, list)
  for (let i = 0; i < rows; i++) {
    const child = createElement('text')
    setProperty(child, 'text', `row ${i}`)
    insertNode(list, child)
  }
})
await root.ready
const initial = root.diagnostics.nodes
const timings: number[] = []
for (let sample = -20; sample < samples; sample++) {
  const child = createElement('text')
  setProperty(child, 'text', `new ${sample}`)
  insertNode(list, child)
  const before = { ...count }
  const start = performance.now()
  await root.flush()
  const elapsed = performance.now() - start
  assert.deepEqual(
    {
      created: count.created - before.created,
      inserted: count.inserted - before.inserted,
      removed: count.removed - before.removed,
    },
    { created: 1, inserted: 1, removed: 0 }
  )
  assert.equal(root.diagnostics.nodes, initial + 1)
  if (sample >= 0) timings.push(elapsed)
  removeNode(list, child)
  await root.flush()
  assert.equal(root.diagnostics.nodes, initial)
}
await root.dispose()
timings.sort((a, b) => a - b)
console.log(
  JSON.stringify({
    rows,
    samples,
    p50Ms: timings[Math.floor(timings.length / 2)],
    p95Ms: timings[Math.floor(timings.length * 0.95)],
    timingsMs: timings,
  })
)
