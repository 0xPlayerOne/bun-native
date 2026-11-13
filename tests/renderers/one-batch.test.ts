// Protocol 12 sends one transaction as one native batch. Through the renderer
// and real core IPC, this commit is one batch; protocol 11 rejected it (more
// than 256 changes to committed nodes) and closed the render root. The
// appending case is large-append.test.ts.
import { expect, test } from 'bun:test'
import { createElement, createRenderRoot, insertNode, setProperty } from '@bun-native/renderer'
import { withApp } from './support.ts'

function row(index: number) {
  const box = createElement('box')
  setProperty(box, 'style', { direction: 'row' })
  const label = createElement('text')
  setProperty(label, 'text', `Row ${index}`)
  insertNode(box, label)
  insertNode(box, createElement('button'))
  return { box, label }
}

test('updates to more than 256 committed nodes commit as one batch', () =>
  withApp(async (app) => {
    const window = await app.openWindow({ title: 'Update' })
    const list = createElement('box')
    const labels = Array.from({ length: 1_000 }, (_, index) => row(index))
    const root = createRenderRoot(window, ({ container }) => {
      insertNode(container, list)
      for (const { box } of labels) insertNode(list, box)
    })
    await root.ready
    const revision = window.revision
    for (const [index, { label }] of labels.entries())
      setProperty(label, 'text', `Updated ${index}`)
    await root.flush()
    expect(window.revision - revision).toBe(1)
    expect(root.diagnostics.mutations.set).toBeGreaterThanOrEqual(1_000)
    await root.dispose()
    await root.closed
  }))
