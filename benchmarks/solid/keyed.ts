/**
 * Headless Solid keyed-list adapter micro benchmark.
 *
 * Mounts a real Solid `<For>` through `@bun-native/solid` against an in-process
 * NativeWindow whose batch acknowledges immediately. `sync` times only Solid's
 * reconciliation and the universal renderer callbacks (the adapter hot path);
 * `total` additionally awaits the renderer's snapshot/diff/publish. Neither is
 * IPC, native or paint latency.
 *
 *   bun --conditions=browser benchmarks/solid/keyed.ts [rows] [samples]
 */
import type { NativeBatch, NativeNode, NativeWindow } from '@bun-native/core'
import {
  createComponent,
  createElement,
  createTextNode,
  For,
  insert,
  insertNode,
  render,
} from '@bun-native/solid'
import { createSignal } from 'solid-js'

function fakeWindow(): NativeWindow {
  let id = 0
  const handle = (kind: string) => ({ kind, id: id++ }) as unknown as NativeNode
  const batch: NativeBatch = {
    create: (element) => handle(element.kind) as never,
    set: () => {},
    insert: () => {},
    append: () => {},
    remove: () => {},
    focus: () => {},
    scrollTo: () => {},
    scrollIntoView: () => {},
  }
  return {
    root: handle('box'),
    closed: new Promise<void>(() => {}),
    revision: 0,
    batch: async (update: (batch: NativeBatch) => unknown) => update(batch),
    on: () => () => {},
    input: () => ({ value: '', revision: 0 }),
    close: async () => {},
  } as unknown as NativeWindow
}

const now = () => Number(process.hrtime.bigint()) / 1e3
const median = (values: number[]) => values.sort((a, b) => a - b)[values.length >> 1]!
const warmup = 20

async function scenario(rows: number, samples: number) {
  const [items, setItems] = createSignal(Array.from({ length: rows }, (_, index) => index))
  let next = rows
  const list = createElement('box')
  const root = render(() => {
    insert(
      list,
      createComponent(For, {
        get each() {
          return items()
        },
        children: (item: number) => {
          const row = createElement('box')
          const text = createElement('text')
          insertNode(text, createTextNode('row ' + item))
          insertNode(row, text)
          return row
        },
      }),
      null
    )
    return list
  }, fakeWindow())
  await root.ready
  // Each operation keeps the row count stable around `rows`.
  const operations: Record<string, () => void> = {
    append: () => setItems((current) => [...current.slice(1), next++]),
    swap: () =>
      setItems((current) => {
        const copy = current.slice()
        const first = copy[1]!
        copy[1] = copy[copy.length - 2]!
        copy[copy.length - 2] = first
        return copy
      }),
    remove: () =>
      setItems((current) => [
        ...current.filter((_, index) => index !== current.length >> 1),
        next++,
      ]),
    prepend: () => setItems((current) => [next++, ...current.slice(0, -1)]),
  }
  const results: Record<string, { sync: number; total: number }> = {}
  for (const [name, operation] of Object.entries(operations)) {
    const sync: number[] = []
    const total: number[] = []
    for (let sample = 0; sample < samples + warmup; sample += 1) {
      const start = now()
      operation()
      const submitted = now()
      await root.flush()
      const end = now()
      if (sample < warmup) continue
      sync.push(submitted - start)
      total.push(end - start)
    }
    results[name] = { sync: median(sync), total: median(total) }
  }
  // Clearing removes every keyed row; Solid detaches them from the region's end.
  const clears: number[] = []
  for (let sample = 0; sample < 10; sample += 1) {
    setItems(Array.from({ length: rows }, () => next++))
    await root.flush()
    const start = now()
    setItems([])
    clears.push(now() - start)
    await root.flush()
  }
  await root.dispose()
  return { results, clear: median(clears) }
}

const rows = Number(process.argv[2] ?? 1000)
const samples = Number(process.argv[3] ?? 200)
const { results, clear } = await scenario(rows, samples)
console.log(`rows=${rows} samples=${samples} median µs`)
for (const [name, { sync, total }] of Object.entries(results))
  console.log(
    `${name.padEnd(8)} sync ${sync.toFixed(1).padStart(8)}  total ${total.toFixed(1).padStart(9)}`
  )
console.log(`clear    sync ${clear.toFixed(1).padStart(8)}`)
