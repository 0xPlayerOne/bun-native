// Eden-collection trigger for the AOT retention in #287: the core workload
// (benchmarks/solid/direct.ts) with one `Bun.gc(false)` queued during the
// update of mount EDEN_AT (EDEN_FULL=1 queues a full collection instead).
// Results and method: aot-eden-collection.md.
import type { NativeNode } from '@bun-native/core'
import {
  CONTENT_STYLE,
  LIST_STYLE,
  ROW_STYLE,
  runWorkload,
  type Mutations,
} from '../solid/workload.ts'

const edenAt = Number(process.env['EDEN_AT'] ?? -1)
const edenFull = process.env['EDEN_FULL'] === '1'
let mountIndex = -1
await runWorkload('core', async (window, initial, onClick) => {
  mountIndex++
  const thisMount = mountIndex
  let injected = false
  const counts: Mutations = { create: 0, set: 0, insert: 0, remove: 0 }
  let rowsDisposed = 0
  let unexpectedClicks = 0
  let disposed = false
  const listener = () => {
    if (onClick) onClick()
    else unexpectedClicks++
  }
  const { root, label, button, list, rows } = await window.batch((batch) => {
    // Match the Solid adapter-owned container and the exact native element tree.
    const root = batch.create({ kind: 'box' })
    const content = batch.create({ kind: 'box', style: CONTENT_STYLE })
    const label = batch.create({ kind: 'text', text: 'Initial' })
    const button = batch.create({ kind: 'button', text: 'Benchmark fixture' })
    const list = batch.create({ kind: 'box', style: LIST_STYLE })
    const rows = new Map<number, NativeNode<'text'>>()
    for (const row of initial)
      rows.set(row.id, batch.create({ kind: 'text', text: row.text, style: ROW_STYLE }))
    batch.append(window.root, root)
    batch.append(root, content)
    for (const node of [label, button, list]) batch.append(content, node)
    for (const node of rows.values()) batch.append(list, node)
    counts.create = 5 + initial.length
    counts.insert = counts.create
    return { root, label, button, list, rows }
  })
  const unsubscribe = window.onClick(button, listener)
  return {
    async update(values) {
      if (thisMount === edenAt && !injected) {
        injected = true
        setTimeout(() => Bun.gc(edenFull), 0)
      }
      let pending = ''
      for (const value of values) pending = value
      await window.batch((batch) => batch.set(label, { kind: 'text', text: pending }))
      counts.set++
    },
    async rotate(next) {
      if (next.length < 2) return
      // This workload rotates the first retained row to the end each time.
      await window.batch((batch) => batch.append(list, rows.get(next.at(-1)!.id)!))
      counts.insert++
    },
    async dispose() {
      if (disposed) return
      disposed = true
      unsubscribe()
      // The input scenario disposes after its OS close, which revoked every node.
      if (!onClick) {
        await window.batch((batch) => batch.remove(root))
        counts.remove++
      }
      rowsDisposed = initial.length
      rows.clear()
    },
    probes: [new WeakRef(root), new WeakRef(label), new WeakRef(listener)],
    inspect: () => ({
      mutations: { ...counts },
      rowsCreated: initial.length,
      rowsDisposed,
      unexpectedClicks,
    }),
  }
})
