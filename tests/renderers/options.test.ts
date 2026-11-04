import { expect, test } from 'bun:test'
import assert from 'node:assert/strict'
import type { Element, NativeWindow, Style } from '@bun-native/core'
import { createRenderRoot, type RenderOptions, type RenderRoot } from '@bun-native/renderer'
import { render as renderReact } from '@bun-native/react'
import { render as renderSolid } from '@bun-native/solid'
import { observeWindow, withApp } from './support.ts'

const mounts: readonly [string, (window: NativeWindow, options?: RenderOptions) => RenderRoot][] = [
  ['shared', (window, options) => createRenderRoot(window, () => {}, options)],
  ['React', (window, options) => renderReact(null, window, options)],
  ['Solid', (window, options) => renderSolid(() => undefined, window, options)],
]

for (const [name, mount] of mounts) {
  test(`${name} mount captures its native container style and preserves unstyled defaults`, () =>
    withApp(async (app) => {
      const actual = await app.openWindow({ title: `${name} root sizing` })
      const { window } = observeWindow(actual)
      const created: Element[] = []
      window.batch = (operation) =>
        actual.batch((batch) =>
          operation({
            create(element) {
              created.push(element)
              return batch.create(element)
            },
            set: batch.set.bind(batch),
            insert: batch.insert.bind(batch),
            append: batch.append.bind(batch),
            remove: batch.remove.bind(batch),
          })
        )
      const style: Style = { width: 'fill', height: 'fill', overflow: 'hidden' }
      const root = mount(window, { style })
      style.height = 12
      await root.ready
      expect(created).toEqual([
        { kind: 'box', style: { width: 'fill', height: 'fill', overflow: 'hidden' } },
      ])
      await root.dispose()
      const defaultRoot = mount(window)
      await defaultRoot.ready
      expect(created.at(-1)).toEqual({ kind: 'box' })
      await defaultRoot.dispose()
      expect(app.diagnostics.nodes).toBe(1)
      expect(app.diagnostics.callbacks).toBe(0)
    }))

  test(`${name} rejects invalid mount options and native style without retained ownership`, () =>
    withApp(async (app) => {
      const window = await app.openWindow({ title: `${name} root option validation` })
      for (const options of [null, [], 'fill', { unknown: true }, { style: 'fill' }])
        expect(() => mount(window, options as unknown as RenderOptions)).toThrow(TypeError)
      const root = mount(window, { style: { width: -1 } })
      await assert.rejects(root.ready, /width/)
      await assert.rejects(root.closed, /width/)
      expect(root.diagnostics.nodes).toBe(0)
      expect(app.diagnostics.nodes).toBe(1)
      expect(app.diagnostics.callbacks).toBe(0)
    }))
}
