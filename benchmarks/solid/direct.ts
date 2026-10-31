import type { NativeNode } from '@bun-native/core'
import { CONTENT_STYLE, LIST_STYLE, ROW_STYLE, runWorkload, type Mutations } from './workload.ts'

await runWorkload('core', async (window, initial) => {
  const counts: Mutations = { create: 0, set: 0, insert: 0, remove: 0 }
  let rowsDisposed = 0
  let unexpectedClicks = 0
  let disposed = false
  const listener = () => {
    unexpectedClicks++
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
      await window.batch((batch) => batch.remove(root))
      rowsDisposed = initial.length
      counts.remove++
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
