import { expect, test } from 'bun:test'
import assert from 'node:assert/strict'
import {
  createElement,
  createRenderRoot,
  createTextNode,
  insertNode,
  removeNode,
  setProperty,
  type Node,
} from '@bun-native/renderer'
import { observeWindow, withApp } from './support.ts'

test('shared root publishes framework cleanup before initialization can fail', () =>
  withApp(async (app) => {
    const window = await app.openWindow({ title: 'Renderer initialization failure' })
    let cleaned = 0
    const root = createRenderRoot(window, ({ onCleanup }) => {
      onCleanup(() => cleaned++)
      throw new Error('Component initialization failed')
    })
    await assert.rejects(root.ready, /Component initialization failed/)
    await assert.rejects(root.closed, /Component initialization failed/)
    await assert.rejects(root.dispose(), /Component initialization failed/)
    expect(cleaned).toBe(1)
    expect(root.diagnostics.nodes).toBe(0)
    expect(app.diagnostics.nodes).toBe(1)
    const duplicate = createRenderRoot(window, ({ onCleanup }) => {
      onCleanup(() => cleaned++)
      onCleanup(() => cleaned++)
    })
    await assert.rejects(duplicate.ready, /cleanup is already registered/)
    await assert.rejects(duplicate.closed, /cleanup is already registered/)
    expect(cleaned).toBe(2)
  }))

test('shared root failure cleans only its subtree and remains terminal after disposal', () =>
  withApp(async (app) => {
    const window = await app.openWindow({ title: 'Renderer independent lifetime' })
    const sibling = createRenderRoot(window, ({ container }) => {
      insertNode(container, createTextNode('Unaffected'))
    })
    let fail!: (cause: unknown) => void
    let cleaned = 0
    const root = createRenderRoot(window, ({ container, onCleanup, fail: stop }) => {
      fail = stop
      onCleanup(() => cleaned++)
      insertNode(container, createTextNode('Owned'))
    })
    await Promise.all([root.ready, sibling.ready])
    fail('Asynchronous framework failure')
    await assert.rejects(root.closed, /Asynchronous framework failure/)
    await assert.rejects(root.flush(), /Asynchronous framework failure/)
    fail(new Error('Later error must not replace the original cause'))
    await assert.rejects(root.dispose(), /Asynchronous framework failure/)
    expect(cleaned).toBe(1)
    expect(root.diagnostics.nodes).toBe(0)
    expect(sibling.diagnostics.nodes).toBe(2)
    expect(app.diagnostics.nodes).toBe(3)
    await sibling.dispose()
  }))

test('shared staging rejects cross-root movement while retaining the original owner', () =>
  withApp(async (app) => {
    const window = await app.openWindow({ title: 'Renderer ownership rejection' })
    const node = createElement('button')
    setProperty(node, 'onClick', () => {})
    const first = createRenderRoot(window, ({ container }) => insertNode(container, node))
    await first.ready
    const second = createRenderRoot(window, ({ container }) => insertNode(container, node))
    await assert.rejects(second.ready, /between render roots/)
    await assert.rejects(second.closed, /between render roots/)
    expect(first.diagnostics.nodes).toBe(2)
    expect(app.diagnostics.callbacks).toBe(1)
    const detached = createElement('box')
    insertNode(detached, node)
    expect(app.diagnostics.callbacks).toBe(0)
    await first.flush()
    expect(first.diagnostics.nodes).toBe(1)
    await first.dispose()
  }))

test('retained native descendants are rescued before their obsolete ancestor is deleted', () =>
  withApp(async (app) => {
    const window = await app.openWindow({ title: 'Renderer retained descendants' })
    const ancestor = createElement('box')
    const removedInner = createElement('box')
    const destination = createElement('box')
    const retained = createTextNode('Retained')
    insertNode(ancestor, removedInner)
    insertNode(removedInner, retained)
    let container!: Node
    const root = createRenderRoot(window, (context) => {
      container = context.container
      insertNode(container, ancestor)
      insertNode(container, destination)
    })
    await root.ready
    const before = root.diagnostics
    insertNode(destination, retained)
    removeNode(container, ancestor)
    await root.flush()
    expect(root.diagnostics.nodes).toBe(3)
    expect(root.diagnostics.mutations.create).toBe(before.mutations.create)
    expect(root.diagnostics.mutations.remove - before.mutations.remove).toBe(1)
    expect(app.diagnostics.nodes).toBe(4)
    await root.dispose()
  }))

test('repeated shared roots keep one window observer and run each cleanup exactly once', () =>
  withApp(async (app) => {
    const actual = await app.openWindow({ title: 'Renderer window observer' })
    const { window, observations } = observeWindow(actual)
    let cleaned = 0
    let laterFail!: (cause: unknown) => void
    for (let index = 0; index < 25; index++) {
      const root = createRenderRoot(window, ({ container, onCleanup, fail }) => {
        laterFail = fail
        onCleanup(() => cleaned++)
        insertNode(container, createTextNode(String(index)))
      })
      await root.ready
      expect(window.revision).toBe(actual.revision)
      await root.dispose()
      laterFail(new Error('Late failure'))
      await root.dispose()
      expect(root.diagnostics.nodes).toBe(0)
      expect(app.diagnostics.nodes).toBe(1)
    }
    expect(cleaned).toBe(25)
    expect(observations.completionReads).toBe(1)
    await actual.close()
    expect(() => createRenderRoot(window, () => {})).toThrow('already closed')
  }))

test('conflicting text sources fail the shared native snapshot and run teardown', () =>
  withApp(async (app) => {
    const window = await app.openWindow({ title: 'Renderer conflicting text' })
    let cleaned = false
    const root = createRenderRoot(window, ({ container, onCleanup }) => {
      onCleanup(() => {
        cleaned = true
      })
      const label = createElement('text')
      setProperty(label, 'text', 'Property')
      insertNode(label, createTextNode('Child'))
      insertNode(container, label)
    })
    await assert.rejects(root.ready, /Choose text properties or text children/)
    await assert.rejects(root.closed, /Choose text properties or text children/)
    expect(cleaned).toBe(true)
    expect(app.diagnostics.nodes).toBe(1)
  }))
