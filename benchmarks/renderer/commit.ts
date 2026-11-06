/**
 * Shared renderer commit-path micro benchmark.
 *
 * Drives `createRenderRoot` against an in-process NativeWindow whose batch
 * records operation counts and acknowledges immediately. It isolates the
 * renderer's snapshot/diff/publish cost from IPC, core validation and native
 * work; it is not an end-to-end latency measurement.
 *
 *   bun benchmarks/renderer/commit.ts [rows...]
 */
import type { NativeBatch, NativeNode, NativeWindow } from '@bun-native/core'
import {
  createElement,
  createRenderRoot,
  createTextNode,
  insertNode,
  removeNode,
  replaceText,
  setProperty,
  type RendererNode,
} from '@bun-native/renderer'

type Operations = { create: number; set: number; insert: number; remove: number }

function fakeWindow() {
  const operations: Operations = { create: 0, set: 0, insert: 0, remove: 0 }
  let id = 0
  const handle = (kind: string) => ({ kind, id: id++ }) as unknown as NativeNode
  const batch: NativeBatch = {
    create: (element) => {
      operations.create += 1
      return handle(element.kind) as never
    },
    set: () => {
      operations.set += 1
    },
    insert: () => {
      operations.insert += 1
    },
    append: () => {
      operations.insert += 1
    },
    remove: () => {
      operations.remove += 1
    },
  }
  let close!: () => void
  const closed = new Promise<void>((resolve) => (close = resolve))
  const window = {
    root: handle('box'),
    closed,
    revision: 0,
    batch: async (update: (batch: NativeBatch) => unknown) => update(batch),
    on: () => () => {},
    input: () => ({ value: '', revision: 0 }),
    close: async () => close(),
  } as unknown as NativeWindow
  return { window, operations, close }
}

function nanoseconds(): number {
  return Number(process.hrtime.bigint())
}

function percentile(sorted: readonly number[], fraction: number): number {
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]!
}

type Scenario = 'text' | 'row' | 'move'

/** Native operations one commit of each scenario must send. */
const expected: Record<Scenario, Operations> = {
  // One replaceText: one set.
  text: { create: 0, set: 1, insert: 0, remove: 0 },
  // Replace one keyed row in place: remove it, create box/text/button, insert three.
  row: { create: 3, set: 0, insert: 3, remove: 1 },
  // Move one box holding every row to the other of two sibling boxes: one insert.
  move: { create: 0, set: 0, insert: 1, remove: 0 },
}

async function measure(scenario: Scenario, rows: number, samples: number) {
  const { window, operations, close } = fakeWindow()
  const labels: RendererNode[] = []
  let container!: RendererNode
  const row = (index: number) => {
    const box = createElement('box')
    setProperty(box, 'style', { flexDirection: 'row', gap: 4 })
    const text = createElement('text')
    const label = createTextNode('row ' + index)
    insertNode(text, label)
    insertNode(box, text)
    const button = createElement('button')
    setProperty(button, 'text', 'select')
    setProperty(button, 'onClick', () => {})
    insertNode(box, button)
    return { box, label }
  }
  const boxes: RendererNode[] = []
  const groups: RendererNode[] = []
  let group!: RendererNode
  const root = createRenderRoot(window, (context) => {
    container = context.container
    let parent = container
    if (scenario === 'move') {
      for (let index = 0; index < 2; index += 1) {
        groups.push(createElement('box'))
        insertNode(container as never, groups[index] as never)
      }
      group = createElement('box')
      insertNode(groups[0] as never, group as never)
      parent = group
    }
    for (let index = 0; index < rows; index += 1) {
      const { box, label } = row(index)
      insertNode(parent as never, box)
      boxes.push(box)
      labels.push(label)
    }
  })
  await root.ready
  const nodes = root.diagnostics.nodes
  const update = async (sample: number) => {
    const index = (sample * 7919) % rows
    if (scenario === 'text') replaceText(labels[index]! as never, 'row ' + sample + '!')
    else if (scenario === 'move') insertNode(groups[(sample + 1) % 2] as never, group as never)
    else {
      const { box } = row(sample)
      insertNode(container as never, box, boxes[index] as never)
      removeNode(container as never, boxes[index] as never)
      boxes[index] = box
    }
    const staged = nanoseconds()
    await root.flush()
    return staged
  }
  for (let sample = 0; sample < 50; sample += 1) await update(sample)
  const before = { ...operations }
  Bun.gc(true)
  const timings: number[] = []
  const stages: number[] = []
  let total = 0
  for (let sample = 0; sample < samples; sample += 1) {
    const start = nanoseconds()
    const staged = await update(sample + 50)
    const elapsed = nanoseconds() - start
    timings.push(elapsed)
    stages.push(staged - start)
    total += elapsed
  }
  for (const field of ['create', 'set', 'insert', 'remove'] as const)
    if (operations[field] - before[field] !== expected[scenario][field] * samples)
      throw new Error('Unexpected native operations: ' + JSON.stringify({ before, operations }))
  if (root.diagnostics.nodes !== nodes) throw new Error('Committed node count drifted')
  await root.dispose().catch(() => {})
  close()
  const sorted = timings.toSorted((left, right) => left - right)
  const ms = (value: number) => Number((value / 1e6).toFixed(4))
  return {
    scenario,
    rows,
    nodes,
    samples,
    meanMs: ms(total / samples),
    p50Ms: ms(percentile(sorted, 0.5)),
    p95Ms: ms(percentile(sorted, 0.95)),
    stageP50Ms: ms(
      percentile(
        stages.toSorted((left, right) => left - right),
        0.5
      )
    ),
  }
}

const sizes = process.argv.slice(2).map(Number)
const results = []
for (const scenario of ['text', 'row', 'move'] as const)
  for (const rows of sizes.length ? sizes : [333, 1667]) {
    const samples = rows > 1000 ? 1000 : 2000
    results.push(await measure(scenario, rows, samples))
  }
console.log(
  JSON.stringify(
    { bun: Bun.revision, platform: process.platform, arch: process.arch, results },
    null,
    2
  )
)
