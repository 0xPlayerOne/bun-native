import { describe, expect, test } from 'bun:test'
import { NativeStateError } from '@bun-native/core'
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
import { resolve } from 'node:path'

import { observeWindow, withApp } from '../renderers/support.ts'
import { observeScenario } from '../renderers/collectability.ts'

function label(text: string) {
  const node = createElement('text')
  setProp(node, 'text', text)
  return node
}

describe('Solid universal adapter over the public core (headless subprocess)', () => {
  test('compiler null markers keep adjacent conditional and keyed regions independent', () =>
    withApp(async (app) => {
      const window = await app.openWindow({ title: 'Solid adjacent dynamic regions' })
      const box = createElement('box')
      const before = label('Before')
      const conditional = label('Conditional')
      const a = label('A')
      const b = label('B')
      const [shown, setShown] = createSignal(false)
      const [items, setItems] = createSignal<SolidNode[]>([a, b])
      const root = render(() => {
        insertNode(box, before)
        // These exact null markers are emitted by the pinned universal JSX
        // compiler for <box><text/><Show/><For/></box>.
        insert(box, () => (shown() ? conditional : null), null)
        insert(box, items, null)
        return box
      }, window)
      const order = () =>
        asNode(box).children.map((node) =>
          node.kind === 'text-node' ? node.data : node.properties.text
        )
      try {
        await root.ready
        expect(order()).toEqual(['Before', '', 'A', 'B'])
        const foreignParent = createElement('box')
        const foreignAnchor = label('Foreign anchor')
        insertNode(foreignParent, foreignAnchor)
        expect(() => insertNode(box, label('Rejected'), foreignAnchor)).toThrow(
          'Insertion anchor belongs to another parent'
        )
        expect(order()).toEqual(['Before', '', 'A', 'B'])
        setShown(true)
        setItems([b, a])
        await root.flush()
        expect(order()).toEqual(['Before', 'Conditional', 'B', 'A'])
        setShown(false)
        setItems([])
        await root.flush()
        expect(order()).toEqual(['Before', '', ''])
        setShown(true)
        setItems([a])
        await root.flush()
        expect(order()).toEqual(['Before', 'Conditional', 'A'])
      } finally {
        await root.dispose()
      }
      expect(root.diagnostics.nodes).toBe(0)
      expect(root.diagnostics.listeners).toBe(0)
      expect(app.diagnostics.nodes).toBe(1)
    }))

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
      // Publish the replacement before asking the peer to deliver a new event.
      // An acknowledgement alone does not publish framework registrations.
      await root.flush()
      setProp(text, 'text', 'emit click')
      await root.flush()
      for (let attempt = 0; attempt < 100 && clicks === 0; attempt++) await Bun.sleep(5)
      expect(clicks).toBe(10)
      await root.dispose()
      expect(app.diagnostics.callbacks).toBe(0)
    }))

  test('an event before replacement publication cannot acquire the newer callback', () =>
    withApp(async (app) => {
      const window = await app.openWindow({ title: 'Solid event publication' })
      const { window: observed } = observeWindow(window)
      const batch = observed.batch.bind(observed)
      const on = observed.on.bind(observed)
      const held = Promise.withResolvers<void>()
      let hold = false
      let acknowledged = false
      let delivered = false
      let registrations = 0
      observed.batch = async (operation) => {
        const value = await batch(operation)
        if (hold) {
          hold = false
          acknowledged = true
          await held.promise
        }
        return value
      }
      observed.on = (node, type, listener, options) => {
        const identity = ++registrations
        return on(
          node,
          type,
          async (event) => {
            await listener(event)
            if (identity === 1) delivered = true
          },
          options
        )
      }
      let clicks = 0
      const button = createElement('button')
      const text = label('initial')
      setProp(button, 'text', 'Click')
      setProp(button, 'onClick', () => clicks++)
      const root = render(() => {
        const box = createElement('box')
        insert(box, [text, button])
        return box
      }, observed)
      await root.ready
      hold = true
      setProp(button, 'onClick', () => (clicks += 10))
      setProp(text, 'text', 'emit click')
      try {
        // The real peer emits this click immediately after its acknowledgement.
        // Hold only the delegating framework continuation, not native/core IPC.
        for (let attempt = 0; attempt < 100 && !(acknowledged && delivered); attempt++)
          await Bun.sleep(5)
        expect(acknowledged).toBe(true)
        expect(delivered).toBe(true)
        expect(registrations).toBe(1)
        expect(clicks).toBe(0)
      } finally {
        held.resolve()
      }
      await root.flush()
      expect(registrations).toBe(2)
      expect(clicks).toBe(0)
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
      await assert.rejects(app.closed, (actual) => actual === error)
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

  test('disposed roots are collectable while their native window stays open', async () => {
    // Real headless IPC in a DFG-disabled child; see collectability-scenarios.ts.
    expect((await observeScenario('solid-roots')).survivors).toEqual([])
  })

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

  test('a keyed pane remount above the native batch limit commits as one Solid update', () =>
    withApp(async (app) => {
      const window = await app.openWindow({ title: 'Solid large remount' })
      // Each row is three nodes, created and inserted: 60 rows exceed 256 operations.
      const pane = (name: string, count: number) => {
        const box = createElement('box')
        for (let index = 0; index < count; index += 1) {
          const row = createElement('box')
          insertNode(row, label(`${name} ${index}`))
          insertNode(row, label('detail'))
          insertNode(box, row)
        }
        return box
      }
      const [selected, select] = createSignal<'a' | 'b'>('a')
      const container = createElement('box')
      const root = render(() => {
        insert(container, () => (selected() === 'a' ? pane('A', 60) : pane('B', 70)))
        return container
      }, window)
      await root.ready
      const text = () => asNode(container).children[0]?.children[0]?.children[0]?.properties.text
      // The initial mount is itself one commit above the batch limit.
      const mounted = root.diagnostics.nodes
      expect(mounted).toBeGreaterThan(60 * 3)
      expect(text()).toBe('A 0')
      const before = root.diagnostics
      select('b')
      await root.flush()
      expect(root.diagnostics.commits - before.commits).toBe(1)
      expect(root.diagnostics.mutations.create - before.mutations.create).toBe(1 + 70 * 3)
      expect(root.diagnostics.nodes).toBe(mounted + 10 * 3)
      expect(app.diagnostics.nodes).toBe(1 + mounted + 10 * 3)
      expect(text()).toBe('B 0')
      select('a')
      await root.flush()
      expect(root.diagnostics.nodes).toBe(mounted)
      expect(text()).toBe('A 0')
      await root.dispose()
      expect(app.diagnostics.nodes).toBe(1)
    }))

  test('render rejects a non-function component before touching the window', () =>
    withApp(async (app) => {
      const window = await app.openWindow({ title: 'Solid component contract' })
      for (const component of [null, 'text', { type: 'text' }])
        assert.throws(
          () => render(component as never, window),
          (error: unknown) =>
            error instanceof NativeStateError &&
            error.code === 'invalid_state' &&
            error.message === 'Solid render requires a component function'
        )
      expect(app.diagnostics.nodes).toBe(1)
    }))

  test('render refuses the non-reactive Solid server exports', () => {
    // A child process without --conditions=browser or the test preload resolves
    // solid-js to its server build, where signals never propagate.
    const child = Bun.spawnSync({
      cmd: [
        process.execPath,
        '-e',
        "import { render } from '@bun-native/solid'; try { render(() => null, {}) } catch (error) { console.log(error.message) }",
      ],
      cwd: resolve(import.meta.dir, '../..'),
      stdout: 'pipe',
      stderr: 'pipe',
    })
    expect(child.exitCode).toBe(0)
    expect(child.stdout.toString().trim()).toBe(
      'Solid native rendering requires Bun --conditions=browser (reactive Solid exports)'
    )
  })
})
