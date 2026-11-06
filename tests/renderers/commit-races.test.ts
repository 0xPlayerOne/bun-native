import { expect, test } from 'bun:test'
import assert from 'node:assert/strict'
import { createRenderRoot, createTextNode, insertNode, type Node } from '@bun-native/renderer'
import { scheduledWindow, withApp } from './support.ts'

// Enough microtask boundaries to cross the whole commit/finally chain.
const DEPTHS = Array.from({ length: 16 }, (_, depth) => depth)

test('a failed cleanup after a failed commit reports both causes', () =>
  withApp(async (app) => {
    const native = await app.openWindow({ title: 'Cleanup failure' })
    const { window, control } = scheduledWindow(native)
    let container!: Node
    const root = createRenderRoot(window, (context) => {
      container = context.container
      insertNode(container, createTextNode('Committed'))
    })
    await root.ready
    const failure = new Error('Native transport unavailable')
    control.failure = failure
    insertNode(container, createTextNode('Rejected'))
    await assert.rejects(root.closed, (error: unknown) => {
      assert.ok(error instanceof AggregateError)
      expect(error.message).toBe('Native renderer cleanup failed')
      expect(error.errors).toEqual([failure, failure])
      return true
    })
    await assert.rejects(root.flush(), AggregateError)
    expect(root.diagnostics.pending).toBe(false)
    // The unremoved subtree stays owned by the window, which closes it.
    expect(app.diagnostics.nodes).toBe(3)
    await native.close()
    expect(app.diagnostics.nodes).toBe(0)
  }))

test('disposal at every microtask of the initial acknowledgement removes the subtree', () =>
  withApp(async (app) => {
    const native = await app.openWindow({ title: 'Disposal race' })
    const { window, control } = scheduledWindow(native)
    for (const depth of DEPTHS) {
      let disposing: Promise<void> | undefined
      const root = createRenderRoot(window, ({ container }) =>
        insertNode(container, createTextNode('Raced ' + depth))
      )
      control.afterAck = { depth, run: () => (disposing = root.dispose()) }
      await root.ready
      await root.closed
      await disposing
      expect(root.diagnostics).toMatchObject({ nodes: 0, listeners: 0, pending: false })
      expect(app.diagnostics.nodes).toBe(1)
    }
  }))

test('a mutation at every microtask of an acknowledgement is committed', () =>
  withApp(async (app) => {
    const native = await app.openWindow({ title: 'Mutation race' })
    const { window, control } = scheduledWindow(native)
    for (const depth of DEPTHS) {
      let container!: Node
      const root = createRenderRoot(window, (context) => {
        container = context.container
        insertNode(container, createTextNode('First'))
      })
      let inserted = false
      control.afterAck = {
        depth,
        run: () => {
          insertNode(container, createTextNode('Second'))
          inserted = true
        },
      }
      await root.ready
      for (let turn = 0; !inserted && turn < 64; turn += 1) await Promise.resolve()
      expect(inserted).toBe(true)
      await root.flush()
      expect(root.diagnostics.nodes).toBe(3)
      expect(root.diagnostics.pending).toBe(false)
      expect(app.diagnostics.nodes).toBe(4)
      await root.dispose()
      expect(app.diagnostics.nodes).toBe(1)
    }
  }))
