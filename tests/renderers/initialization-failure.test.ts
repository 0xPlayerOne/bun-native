import { expect, test } from 'bun:test'
import assert from 'node:assert/strict'
import { createRenderRoot, createTextNode, insertNode } from '@bun-native/renderer'
import { withApp } from './support.ts'

for (const mode of ['throw', 'register-cleanup', 'throwing-cleanup'] as const) {
  test(`initialization preserves a reported failure before ${mode}`, () =>
    withApp(async (app) => {
      const window = await app.openWindow({ title: 'First initialization failure' })
      const sibling = createRenderRoot(window, ({ container }) =>
        insertNode(container, createTextNode('Unaffected'))
      )
      await sibling.ready
      const original = new Error('Original initialization failure')
      const secondary = new Error('Secondary initialization failure')
      let cleanups = 0
      let lateCleanups = 0
      const root = createRenderRoot(window, ({ container, onCleanup, fail }) => {
        onCleanup(() => {
          cleanups++
          if (mode === 'throwing-cleanup') throw new Error('Cleanup failure')
        })
        insertNode(container, createTextNode('Uncommitted'))
        fail(original)
        if (mode === 'register-cleanup') onCleanup(() => lateCleanups++)
        else throw secondary
      })
      for (const completion of [
        () => root.ready,
        () => root.closed,
        () => root.flush(),
        () => root.dispose(),
      ])
        await assert.rejects(completion, (error) => error === original)
      expect(cleanups).toBe(1)
      expect(lateCleanups).toBe(0)
      expect(root.diagnostics.nodes).toBe(0)
      expect(root.diagnostics.listeners).toBe(0)
      expect(root.diagnostics.pending).toBe(false)
      expect(sibling.diagnostics.nodes).toBe(2)
      expect(app.diagnostics.nodes).toBe(3)
      await sibling.dispose()
    }))
}

test('a normalized reported cause remains the same error across initialization completion', () =>
  withApp(async (app) => {
    const window = await app.openWindow({ title: 'Normalized initialization failure' })
    const root = createRenderRoot(window, ({ fail }) => {
      fail('Original non-Error cause')
      throw new Error('Secondary initialization failure')
    })
    let original: unknown
    await assert.rejects(root.ready, (error) => {
      original = error
      return error instanceof Error && error.message === 'Original non-Error cause'
    })
    for (const completion of [() => root.closed, () => root.flush(), () => root.dispose()])
      await assert.rejects(completion, (error) => error === original)
    expect(root.diagnostics.nodes).toBe(0)
    expect(app.diagnostics.nodes).toBe(1)
  }))
