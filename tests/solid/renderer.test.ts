import { describe, expect, test } from 'bun:test'
import {
  createComponent,
  createElement,
  createTextNode,
  For,
  insert,
  insertNode,
  render,
  setProp,
  type RenderRoot,
  type SolidNode,
} from '@bun-native/solid'
import { asNode } from '@bun-native/renderer'
import { batch, createEffect, createSignal, onCleanup } from 'solid-js'
import assert from 'node:assert/strict'

import { observeWindow, withApp } from '../renderers/support.ts'

function label(text: string) {
  const node = createElement('text')
  setProp(node, 'text', text)
  return node
}

describe('Solid universal adapter over the public core (headless subprocess)', () => {
  test('dynamic regions replace text and keyed children without consuming adjacent siblings', () =>
    withApp(async (app) => {
      const window = await app.openWindow({ title: 'Solid dynamic region' })
      const box = createElement('box')
      const before = label('Before')
      const after = label('After')
      const a = label('A')
      const b = label('B')
      type Content = string | SolidNode[] | null
      let replace!: (value: Content) => void
      const root = render(() => {
        const [content, setContent] = createSignal<Content>('Initial')
        replace = (value) => {
          setContent(value)
        }
        insertNode(box, before)
        insertNode(box, after)
        insert(box, content, after)
        return box
      }, window)
      const order = () =>
        asNode(box).children.map((node) =>
          node.kind === 'text-node' ? node.data : node.properties.text
        )
      await root.ready
      expect(order()).toEqual(['Before', 'Initial', 'After'])
      const initial = root.diagnostics
      replace('Updated')
      await root.flush()
      expect(order()).toEqual(['Before', 'Updated', 'After'])
      expect(root.diagnostics.mutations.create).toBe(initial.mutations.create)
      expect(root.diagnostics.mutations.set - initial.mutations.set).toBe(1)

      replace([a, b])
      await root.flush()
      expect(order()).toEqual(['Before', 'A', 'B', 'After'])
      const mounted = root.diagnostics
      replace([b, a])
      await root.flush()
      expect(order()).toEqual(['Before', 'B', 'A', 'After'])
      expect(root.diagnostics.mutations.create).toBe(mounted.mutations.create)
      expect(root.diagnostics.mutations.remove).toBe(mounted.mutations.remove)

      replace(null)
      await root.flush()
      expect(order()).toEqual(['Before', '', 'After'])
      replace('Final')
      await root.flush()
      expect(order()).toEqual(['Before', 'Final', 'After'])
      await root.dispose()
      replace('After disposal')
      expect(root.diagnostics.nodes).toBe(0)
      expect(app.diagnostics.nodes).toBe(1)
    }))

  test('signals coalesce native updates; unmount disposes effects and owned nodes', () =>
    withApp(async (app) => {
      const window = await app.openWindow({ title: 'Solid signals' })
      let setCount!: (value: number) => number
      const effects: number[] = []
      let cleaned = 0
      const root = render(() => {
        const [count, set] = createSignal(0)
        setCount = set
        createEffect(() => effects.push(count()))
        onCleanup(() => cleaned++)
        const box = createElement('box')
        insert(box, () => `Count: ${count()}`)
        return box
      }, window)
      await root.ready
      expect(effects).toEqual([0])
      expect(app.diagnostics.nodes).toBe(4)
      const before = root.diagnostics
      batch(() => {
        setCount(1)
        setCount(2)
        setCount(3)
      })
      await root.flush()
      expect(effects).toEqual([0, 3])
      expect(root.diagnostics.mutations.set - before.mutations.set).toBe(1)
      expect(root.diagnostics.mutations.create).toBe(before.mutations.create)
      await root.dispose()
      await root.dispose()
      setCount(4)
      expect(effects).toEqual([0, 3])
      expect(cleaned).toBe(1)
      expect(root.diagnostics.nodes).toBe(0)
      expect(app.diagnostics.nodes).toBe(1)
    }))

  test('keyed moves preserve native identities and dispose only removed owners', () =>
    withApp(async (app) => {
      const window = await app.openWindow({ title: 'Solid keyed list' })
      const a = { id: 'a' }
      const b = { id: 'b' }
      const c = { id: 'c' }
      let update!: (value: { id: string }[]) => { id: string }[]
      const created: string[] = []
      const removed: string[] = []
      const root = render(() => {
        const [items, set] = createSignal([a, b, c])
        update = set
        const box = createElement('box')
        insert(box, () =>
          createComponent(For, {
            get each() {
              return items()
            },
            children: (item: { id: string }) => {
              created.push(item.id)
              onCleanup(() => removed.push(item.id))
              return label(item.id)
            },
          })
        )
        return box
      }, window)
      await root.ready
      const before = root.diagnostics
      update([c, a, b])
      await root.flush()
      expect(created).toEqual(['a', 'b', 'c'])
      expect(removed).toEqual([])
      expect(root.diagnostics.mutations.create).toBe(before.mutations.create)
      expect(root.diagnostics.mutations.remove).toBe(before.mutations.remove)
      expect(root.diagnostics.mutations.insert).toBeGreaterThan(before.mutations.insert)
      update([c, b])
      await root.flush()
      expect(removed).toEqual(['a'])
      expect(root.diagnostics.nodes).toBe(4)
      await root.dispose()
      expect(removed.sort()).toEqual(['a', 'b', 'c'])
    }))

  test('rotating a retained 32-item keyed list emits one native move', () =>
    withApp(async (app) => {
      const window = await app.openWindow({ title: 'Solid keyed rotation' })
      const initial = Array.from({ length: 32 }, (_, id) => ({ id }))
      const [items, setItems] = createSignal(initial)
      let created = 0
      let disposed = 0
      const root = render(() => {
        const box = createElement('box')
        insert(box, () =>
          createComponent(For, {
            get each() {
              return items()
            },
            children: (item: { id: number }) => {
              created++
              onCleanup(() => disposed++)
              return label(String(item.id))
            },
          })
        )
        return box
      }, window)
      await root.ready
      const before = root.diagnostics
      setItems([...initial.slice(1), initial[0]!])
      await root.flush()
      const after = root.diagnostics
      expect(after.mutations.insert - before.mutations.insert).toBe(1)
      expect(after.mutations.create).toBe(before.mutations.create)
      expect(after.mutations.remove).toBe(before.mutations.remove)
      expect(created).toBe(32)
      expect(disposed).toBe(0)
      await root.dispose()
      expect(disposed).toBe(32)
    }))

  test('event replacement and removal revoke old subscriptions', () =>
    withApp(async (app) => {
      const window = await app.openWindow({ title: 'Solid events' })
      let clicks = 0
      const button = createElement('button')
      const text = label('initial')
      setProp(button, 'text', 'Click')
      setProp(button, 'onClick', () => clicks++)
      const root = render(() => {
        const box = createElement('box')
        insert(box, [text, button])
        return box
      }, window)
      await root.ready
      expect(app.diagnostics.callbacks).toBe(1)
      setProp(button, 'onClick', () => (clicks += 10))
      setProp(text, 'text', 'emit click')
      await root.flush()
      for (let attempt = 0; attempt < 100 && clicks === 0; attempt++) await Bun.sleep(5)
      expect(clicks).toBe(10)
      await root.dispose()
      expect(app.diagnostics.callbacks).toBe(0)
    }))

  test('a throwing native callback terminates its application and disposes the Solid owner', () =>
    withApp(async (app) => {
      const window = await app.openWindow({ title: 'Solid callback failure' })
      const marker = await window.batch((batch) => {
        const node = batch.create({ kind: 'text', text: 'Marker' })
        batch.append(window.root, node)
        return node
      })
      const error = new Error('Solid native callback failed')
      let cleaned = 0
      const root = render(() => {
        onCleanup(() => cleaned++)
        const button = createElement('button')
        setProp(button, 'text', 'Fail')
        setProp(button, 'onClick', () => {
          throw error
        })
        return button
      }, window)
      await root.ready
      await window.batch((batch) => batch.set(marker, { kind: 'text', text: 'emit click' }))
      await expect(app.closed).rejects.toBe(error)
      await root.closed
      expect(cleaned).toBe(1)
      expect(root.diagnostics.nodes).toBe(0)
      expect(root.diagnostics.listeners).toBe(0)
      expect(app.diagnostics.nodes).toBe(0)
      expect(app.diagnostics.callbacks).toBe(0)
    }))

  test('removal and reinsertion during an acknowledgement preserves a working registration', () =>
    withApp(async (app) => {
      const window = await app.openWindow({ title: 'Solid acknowledgement ownership' })
      const button = createElement('button')
      const input = createElement('input')
      const marker = label('Initial')
      const [shown, setShown] = createSignal(true)
      let clicks = 0
      let edits = 0
      setProp(button, 'text', 'Click')
      setProp(button, 'onClick', () => clicks++)
      setProp(input, 'onInput', () => {
        edits++
        setShown(false)
        expect(app.diagnostics.callbacks).toBe(1)
        setShown(true)
      })
      const root = render(() => {
        const box = createElement('box')
        insert(box, () => (shown() ? [button, input, marker] : [input, marker]))
        return box
      }, window)
      await root.ready
      const before = root.diagnostics
      // This existing peer emits native input before acknowledging the batch,
      // so the Solid callback detaches/reinserts during the pending commit.
      setProp(marker, 'text', 'input before acknowledgement')
      await root.flush()
      expect(edits).toBe(1)
      expect(app.diagnostics.callbacks).toBe(2)
      expect(root.diagnostics.listeners).toBe(2)
      expect(root.diagnostics.mutations.create).toBe(before.mutations.create)
      expect(root.diagnostics.mutations.remove).toBe(before.mutations.remove)
      setProp(marker, 'text', 'emit click')
      await root.flush()
      for (let attempt = 0; attempt < 100 && clicks === 0; attempt++) await Bun.sleep(1)
      expect(clicks).toBe(1)
      await root.dispose()
      expect(app.diagnostics.callbacks).toBe(0)
      expect(root.diagnostics.listeners).toBe(0)
    }))

  test('moving a live node into an unowned container revokes its listener immediately', () =>
    withApp(async (app) => {
      const window = await app.openWindow({ title: 'Solid unowned destination' })
      const button = createElement('button')
      setProp(button, 'text', 'Click')
      setProp(button, 'onClick', () => {})
      const parent = createElement('box')
      insert(parent, button)
      const root = render(() => parent, window)
      await root.ready
      const before = root.diagnostics
      const detached = createElement('box')
      insertNode(detached, button)
      expect(app.diagnostics.callbacks).toBe(0)
      expect(root.diagnostics.listeners).toBe(0)
      insertNode(parent, button)
      await root.flush()
      expect(root.diagnostics.mutations.create).toBe(before.mutations.create)
      expect(root.diagnostics.mutations.remove).toBe(before.mutations.remove)
      expect(app.diagnostics.callbacks).toBe(1)
      await root.dispose()
    }))

  test('OS/window close disposes Solid owners without retaining a subtree', () =>
    withApp(async (app) => {
      const window = await app.openWindow({ title: 'Solid close' })
      let cleaned = 0
      const root = render(() => {
        onCleanup(() => cleaned++)
        return label('Native lifetime')
      }, window)
      await root.ready
      await window.close()
      await root.closed
      await root.dispose()
      expect(cleaned).toBe(1)
      expect(root.diagnostics.nodes).toBe(0)
    }))

  test('failed property commit cleans the root and exposes the original error', () =>
    withApp(async (app) => {
      const window = await app.openWindow({ title: 'Solid failure' })
      const node = label('valid')
      const root = render(() => node, window)
      await root.ready
      setProp(node, 'style', { font_size: -1 })
      await assert.rejects(root.flush(), /font_size/)
      await assert.rejects(root.closed, /font_size/)
      expect(app.diagnostics.nodes).toBe(1)
      expect(root.diagnostics.nodes).toBe(0)
    }))

  test('rejects browser tags, forged children and cross-root ownership', () =>
    withApp(async (app) => {
      assert.throws(() => createElement('div'), /native-element:div/)
      const window = await app.openWindow({ title: 'Solid ownership' })
      const node = createTextNode('owned')
      let first: RenderRoot | undefined
      try {
        first = render(() => node, window)
        await first.ready
        const second = render(() => node, window)
        await assert.rejects(second.ready, /between render roots/)
        expect(app.diagnostics.nodes).toBe(3)
        const forged = render(() => ({}) as never, window)
        await assert.rejects(forged.ready, /owned staged native node/)
      } finally {
        await first?.dispose()
      }
    }))
  test('repeated unmounts share one window completion observer and release each owner', () =>
    withApp(async (app) => {
      const actual = await app.openWindow({ title: 'Solid repeated ownership' })
      const { window, observations } = observeWindow(actual)
      let cleaned = 0
      for (let index = 0; index < 25; index++) {
        const root = render(() => {
          onCleanup(() => cleaned++)
          return label(String(index))
        }, window)
        await root.ready
        await root.dispose()
        expect(root.diagnostics.nodes).toBe(0)
        expect(app.diagnostics.nodes).toBe(1)
      }
      expect(cleaned).toBe(25)
      expect(observations.completionReads).toBe(1)
      await actual.close()
      assert.throws(() => render(() => label('closed'), window), /already closed/)
    }))

  test('disposed roots are collectable while their native window stays open', () =>
    withApp(async (app) => {
      const window = await app.openWindow({ title: 'Solid root retention' })
      async function cycle(index: number) {
        const root = render(() => label(String(index)), window)
        await root.ready
        await root.dispose()
        return new WeakRef(root)
      }
      const references: WeakRef<RenderRoot>[] = []
      for (let index = 0; index < 10; index++) references.push(await cycle(index))
      // WeakRef keeps targets alive until this job ends. Run the pinned Bun's
      // explicit full collection after that boundary, outside the mount scope.
      await Bun.sleep(0)
      Bun.gc(true)
      await Bun.sleep(0)
      Bun.gc(true)
      expect(references.filter((reference) => reference.deref() !== undefined)).toHaveLength(0)
      expect(app.diagnostics.windows).toBe(1)
      expect(app.diagnostics.nodes).toBe(1)
    }))

  test('a closed window or immediate disposal cannot report a successful initial mount', () =>
    withApp(async (app) => {
      const closedWindow = await app.openWindow({ title: 'Already closed' })
      await closedWindow.close()
      const neverMounted = render(() => label('Unreachable'), closedWindow)
      await assert.rejects(neverMounted.ready, /before initial native acknowledgement/)
      await neverMounted.closed
      const window = await app.openWindow({ title: 'Cancelled mount' })
      const cancelled = render(() => label('Cancelled'), window)
      await cancelled.dispose()
      await assert.rejects(cancelled.ready, /before initial native acknowledgement/)
      expect(cancelled.diagnostics.commits).toBe(0)
      expect(app.diagnostics.nodes).toBe(1)
    }))

  test('moving a retained child out of a deleted ancestor keeps its native identity', () =>
    withApp(async (app) => {
      const window = await app.openWindow({ title: 'Solid subtree move' })
      const parent = createElement('box')
      const previousParent = createElement('box')
      const destination = createElement('box')
      const retained = label('Retained')
      insert(previousParent, retained)
      const [children, setChildren] = createSignal([previousParent, destination])
      insert(parent, children)
      const root = render(() => parent, window)
      await root.ready
      const before = root.diagnostics
      insertNode(destination, retained)
      setChildren([destination])
      await root.flush()
      expect(root.diagnostics.mutations.create).toBe(before.mutations.create)
      expect(root.diagnostics.mutations.remove - before.mutations.remove).toBe(1)
      expect(root.diagnostics.nodes).toBe(4)
      await root.dispose()
    }))
})
