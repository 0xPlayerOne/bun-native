import { describe, expect, test } from 'bun:test'
import { ProtocolError, type NativeBatch, type NativeNode } from '@bun-native/core'
import { MAX_OVERLAY_DEPTH } from '@bun-native/protocol'
import assert from 'node:assert/strict'
import { state, withPeer } from './overlays-support.ts'

type Parent = NativeNode<'box' | 'overlay'>

/** Nest `count` overlays below `parent`, optionally each inside its own box. */
function chain(batch: NativeBatch, parent: Parent, count: number, boxed = false) {
  const layers: NativeNode<'overlay'>[] = []
  for (let index = 0; index < count; index++) {
    if (boxed) {
      const box = batch.create({ kind: 'box' })
      batch.append(parent, box)
      parent = box
    }
    const overlay = batch.create({ kind: 'overlay', anchor: 'parent' })
    batch.append(parent, overlay)
    layers.push(overlay)
    parent = overlay
  }
  return layers
}

describe('overlay nesting bound (headless subprocess)', () => {
  test('the bound counts overlay layers only, not the boxes between them', () =>
    withPeer(['--overlays'], async (app) => {
      expect(MAX_OVERLAY_DEPTH).toBe(8)
      const window = await app.openWindow({ title: 'Boxed nesting' })
      const layers = await window.batch((batch) =>
        chain(batch, window.root, MAX_OVERLAY_DEPTH, true)
      )
      expect(window.revision).toBe(1)
      const deepest = layers.at(-1)!
      // Wrapping the ninth layer in further boxes does not hide it from the bound.
      await assert.rejects(
        window.batch((batch) => {
          const box = batch.create({ kind: 'box' })
          const inner = batch.create({ kind: 'box' })
          batch.append(deepest, box)
          batch.append(box, inner)
          batch.append(inner, batch.create({ kind: 'overlay' }))
        }),
        state('limit_exceeded')
      )
      // Width is not depth: siblings at the deepest level are accepted.
      await window.batch((batch) => {
        for (let index = 0; index < 3; index++)
          batch.append(layers.at(-2)!, batch.create({ kind: 'overlay', anchor: 'parent' }))
      })
      expect(window.revision).toBe(2)
      expect(app.diagnostics.nodes).toBe(1 + 2 * MAX_OVERLAY_DEPTH + 3)
    }))

  test('moving a committed overlay subtree is bounded by its new ancestry', () =>
    withPeer(['--overlays'], async (app) => {
      const window = await app.openWindow({ title: 'Moved nesting' })
      const { host, moved } = await window.batch((batch) => {
        const host = chain(batch, window.root, 5)
        const moved = chain(batch, window.root, 4)
        return { host, moved }
      })
      const top = moved[0]!
      // 5 + 4 would make nine layers.
      await assert.rejects(
        window.batch((batch) => batch.append(host[4]!, top)),
        state('limit_exceeded')
      )
      expect(window.revision).toBe(1)
      // 4 + 4 is exactly the bound.
      await window.batch((batch) => batch.append(host[3]!, top))
      await window.batch((batch) => batch.insert(host[2]!, top, 0))
      expect(window.revision).toBe(3)
      // Moving deeper again in a later batch is checked the same way.
      await assert.rejects(
        window.batch((batch) => batch.insert(host[4]!, top, 0)),
        state('limit_exceeded')
      )
      await window.batch((batch) => batch.append(host[3]!, top))
      // Growing the moved chain past the bound fails.
      await assert.rejects(
        window.batch((batch) => batch.append(moved[3]!, batch.create({ kind: 'overlay' }))),
        state('limit_exceeded')
      )
      // Moving it back to the root makes room again in the same batch.
      await window.batch((batch) => {
        batch.append(window.root, top)
        batch.append(moved[3]!, batch.create({ kind: 'overlay' }))
      })
      expect(window.revision).toBe(5)
    }))

  test('set keeps the overlay kind and revalidates modal anchoring', () =>
    withPeer(['--overlays'], async (app) => {
      const window = await app.openWindow({ title: 'Overlay set' })
      const popover = await window.batch((batch) => {
        const popover = batch.create({ kind: 'overlay', anchor: 'parent' })
        batch.append(window.root, popover)
        return popover
      })
      await assert.rejects(
        window.batch((batch) => batch.set(popover as never, { kind: 'box' })),
        state('invalid_state')
      )
      await assert.rejects(
        window.batch((batch) =>
          batch.set(popover, {
            kind: 'overlay',
            anchor: 'parent',
            modal: true,
          } as never)
        ),
        ProtocolError
      )
      // A window overlay may become modal; `set` replaces every property.
      await window.batch((batch) => batch.set(popover, { kind: 'overlay', modal: true }))
      expect(window.revision).toBe(2)
    }))
})
