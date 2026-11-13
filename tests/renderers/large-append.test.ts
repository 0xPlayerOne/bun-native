import { expect, test } from 'bun:test'
import type { NativeNode, NativeWindow } from '@bun-native/core'
import {
  createElement,
  createRenderRoot,
  insertNode,
  setProperty,
  type Node,
} from '@bun-native/renderer'
import { withApp } from './support.ts'

/** The headless peer's committed text order, reported through a rejected set. */
async function nativeTexts(window: NativeWindow, marker: NativeNode<'text'>) {
  const error = await window
    .batch((batch) => batch.set(marker, { kind: 'text', text: 'report texts' }))
    .then(
      () => undefined,
      (cause: Error) => cause
    )
  return error?.message.replace(/^Native invalid_state: /, '').split('|')
}

test('one commit appends 1,000 rows to a committed list without ending the root', () =>
  withApp(async (app) => {
    const window = await app.openWindow({ title: 'Large append' })
    let list!: Node
    const root = createRenderRoot(window, ({ container }) => {
      list = createElement('box')
      insertNode(container, list)
      for (const label of ['first', 'second']) {
        const row = createElement('text')
        setProperty(row, 'text', label)
        insertNode(list, row)
      }
    })
    await root.ready
    const marker = await window.batch((batch) => {
      const marker = batch.create({ kind: 'text', text: 'marker' })
      batch.append(window.root, marker)
      return marker
    })
    const revision = window.revision
    const rows: Node[] = []
    for (let index = 0; index < 1_000; index += 1) {
      const row = createElement('text')
      setProperty(row, 'text', `row ${index}`)
      insertNode(list, row)
      rows.push(row)
    }
    await root.flush()
    // Protocol 12: one transaction is one native batch.
    expect(window.revision - revision).toBe(1)
    expect(root.diagnostics.nodes).toBe(1 + 1 + 2 + 1_000) // container, list, rows
    expect(app.diagnostics.nodes).toBe(1 + 1 + 1 + 2 + 1_000 + 1) // window root and marker
    expect(await nativeTexts(window, marker)).toEqual([
      'first',
      'second',
      ...rows.map((_, index) => `row ${index}`),
      'marker',
    ])
    // The root stays usable: a later update commits normally.
    setProperty(rows[999]!, 'text', 'last')
    await root.flush()
    await root.dispose()
    await window.close()
  }))
