import assert from 'node:assert/strict'
import { describe, expect, test } from 'bun:test'
import type { NativeEventType, NativeNode, NativeUIEvent, NativeWindow } from '@bun-native/core'
import {
  createElement,
  createRenderRoot,
  eventProperties,
  inputState,
  insertNode,
  isEventProperty,
  removeNode,
  setProperty,
  type EventProperty,
  type Node,
} from '@bun-native/renderer'
import { withApp } from './support.ts'

async function until(condition: () => boolean) {
  const deadline = performance.now() + 1_000
  while (!condition()) {
    if (performance.now() > deadline) throw new Error('Renderer event state did not settle')
    await Bun.sleep(1)
  }
}

async function controls(window: NativeWindow) {
  const marker = await window.batch((batch) => {
    const node = batch.create({ kind: 'text', text: 'Event fixture' })
    batch.append(window.root, node)
    return node
  })
  const outer = createElement('box')
  const destination = createElement('box')
  const button = createElement('button')
  const input = createElement('input')
  setProperty(button, 'text', 'target')
  setProperty(input, 'value', '')
  setProperty(input, 'placeholder', 'input')
  insertNode(outer, button)
  insertNode(outer, input)
  return { marker, outer, destination, button, input }
}

function trigger(window: NativeWindow, marker: NativeNode<'text'>, type: NativeEventType) {
  return window.batch((batch) =>
    batch.set(marker, {
      kind: 'text',
      text: 'event:' + JSON.stringify({ type, target: type === 'input' ? 'input' : 'target' }),
    })
  )
}

type Call = { name: string; event: NativeUIEvent }
function listen(node: Node, property: EventProperty, calls: Call[], name: string) {
  setProperty(node, property, (event: NativeUIEvent) => calls.push({ name, event }))
}

describe('shared event props over the actual public-core subprocess contract', () => {
  test('container capture and bubble handlers preserve native target and phase', () =>
    withApp(async (app) => {
      const window = await app.openWindow({ title: 'Renderer propagation' })
      const { outer, button, marker } = await controls(window)
      const calls: Call[] = []
      listen(outer, 'onClickCapture', calls, 'outer capture')
      listen(button, 'onClickCapture', calls, 'target capture')
      listen(button, 'onClick', calls, 'target bubble')
      listen(outer, 'onClick', calls, 'outer bubble')
      const root = createRenderRoot(window, ({ container }) => insertNode(container, outer))
      await root.ready
      const before = root.diagnostics
      expect(before.listeners).toBe(4)
      await trigger(window, marker, 'click')
      await until(() => calls.length === 4)
      expect(calls.map(({ name }) => name)).toEqual([
        'outer capture',
        'target capture',
        'target bubble',
        'outer bubble',
      ])
      expect(calls.map(({ event }) => event.phase)).toEqual([
        'capture',
        'target',
        'target',
        'bubble',
      ])
      const target = calls[1]!.event.node
      for (const { event } of calls) {
        expect(event.type).toBe('click')
        expect(event.node).toBe(target)
        expect(event.path[0]).toBe(window.root)
        expect(event.path.at(-1)).toBe(target)
        expect(Object.isFrozen(event.path)).toBe(true)
      }
      expect(calls[0]!.event.currentTarget).toBe(calls[3]!.event.currentTarget)
      expect(calls[1]!.event.currentTarget).toBe(target)
      expect(root.diagnostics.mutations).toEqual(before.mutations)
      await root.dispose()
      expect(calls.every(({ event }) => event.signal.aborted)).toBe(true)
      expect(root.diagnostics.listeners).toBe(0)
      expect(Object.keys(outer.properties).some(isEventProperty)).toBe(false)
    }, 'events-peer.ts'))

  test('all keyboard, pointer, focus and input props use the shared typed core events', () =>
    withApp(async (app) => {
      const window = await app.openWindow({ title: 'Renderer event fields' })
      const { outer, button, input, marker } = await controls(window)
      const cases = [
        ['onClick', 'click'],
        ['onInput', 'input'],
        ['onKeyDown', 'key_down'],
        ['onKeyUp', 'key_up'],
        ['onPointerDown', 'pointer_down'],
        ['onPointerUp', 'pointer_up'],
        ['onFocus', 'focus'],
        ['onBlur', 'blur'],
      ] as const
      const calls: Call[] = []
      for (const [property, type] of cases) {
        const target = type === 'input' ? input : button
        for (const [node, name] of [
          [outer, 'outer'],
          [target, 'target'],
        ] as const)
          for (const suffix of ['Capture', ''] as const)
            setProperty(node, property + suffix, (event: NativeUIEvent) => {
              expect(event.type).toBe(type)
              if (event.type === 'input') setProperty(input, 'value', event)
              calls.push({ name: `${name}:${property}${suffix}`, event })
            })
      }
      const root = createRenderRoot(window, ({ container }) => insertNode(container, outer))
      await root.ready
      const before = root.diagnostics
      expect(before.listeners).toBe(32)
      for (const [index, [property, type]] of cases.entries()) {
        await trigger(window, marker, type)
        await until(() => calls.length === (index + 1) * 4)
        const group = calls.slice(index * 4)
        expect(group.map(({ name }) => name)).toEqual([
          `outer:${property}Capture`,
          `target:${property}Capture`,
          `target:${property}`,
          `outer:${property}`,
        ])
        for (const { event } of group) {
          expect(event.treeRevision).toBe(window.revision)
          expect(event.propagationStopped).toBe(false)
          if (event.type === 'key_down' || event.type === 'key_up') {
            expect(event.key).toBe('enter')
            expect(event.keyChar).toBe('\r')
            expect(event.modifiers).toEqual({
              control: true,
              alt: false,
              shift: true,
              platform: false,
              function: false,
            })
            expect(Object.isFrozen(event.modifiers)).toBe(true)
          } else if (event.type === 'pointer_down' || event.type === 'pointer_up') {
            expect([event.button, event.x, event.y]).toEqual(['right', 12.5, -4.25])
          } else if (event.type === 'input') {
            expect([event.value, event.revision]).toEqual(['native edit', 1])
          }
        }
      }
      await root.flush()
      expect(inputState(input)).toEqual({ value: 'native edit', revision: 1 })
      // Even ancestor/capture input handlers preserve the native-echo brand.
      expect(root.diagnostics.mutations).toEqual(before.mutations)
      await root.dispose()
      expect(calls.every(({ event }) => event.signal.aborted)).toBe(true)
    }, 'events-peer.ts'))

  test('replacing one event phase preserves other registrations and their signals', () =>
    withApp(async (app) => {
      const window = await app.openWindow({ title: 'Renderer event replacement' })
      const { outer, button, marker } = await controls(window)
      const calls: Call[] = []
      listen(button, 'onKeyDownCapture', calls, 'capture')
      listen(button, 'onKeyDown', calls, 'old')
      listen(button, 'onPointerDown', calls, 'pointer')
      const root = createRenderRoot(window, ({ container }) => insertNode(container, outer))
      await root.ready
      await trigger(window, marker, 'key_down')
      await until(() => calls.length === 2)
      const capture = calls[0]!.event.signal
      const old = calls[1]!.event.signal
      listen(button, 'onKeyDown', calls, 'new')
      await root.flush()
      expect(old.aborted).toBe(true)
      expect(capture.aborted).toBe(false)
      expect(root.diagnostics.listeners).toBe(3)
      await trigger(window, marker, 'key_down')
      await trigger(window, marker, 'pointer_down')
      await until(() => calls.length === 5)
      expect(calls.map(({ name }) => name)).toEqual(['capture', 'old', 'capture', 'new', 'pointer'])
      const replacement = calls[3]!.event.signal
      setProperty(button, 'onKeyDown', undefined)
      await root.flush()
      expect(replacement.aborted).toBe(true)
      expect(capture.aborted).toBe(false)
      await trigger(window, marker, 'key_down')
      await until(() => calls.length === 6)
      expect(calls.at(-1)!.name).toBe('capture')
      expect(root.diagnostics.listeners).toBe(2)
      await root.dispose()
      expect(capture.aborted).toBe(true)
    }, 'events-peer.ts'))

  test.each(['stopPropagation', 'stopImmediatePropagation'] as const)(
    '%s delegates target-phase control to the public core',
    (method) =>
      withApp(async (app) => {
        const window = await app.openWindow({ title: 'Renderer propagation stop' })
        const { outer, button, marker } = await controls(window)
        const calls: string[] = []
        setProperty(button, 'onClickCapture', (event: NativeUIEvent) => {
          calls.push('capture')
          event[method]()
          expect(event.propagationStopped).toBe(true)
        })
        setProperty(button, 'onClick', () => calls.push('target bubble'))
        setProperty(outer, 'onClick', () => calls.push('ancestor bubble'))
        const root = createRenderRoot(window, ({ container }) => insertNode(container, outer))
        await root.ready
        await trigger(window, marker, 'click')
        await until(() => calls.length > 0)
        await until(() => app.diagnostics.activeCallbacks === 0)
        expect(calls).toEqual(
          method === 'stopPropagation' ? ['capture', 'target bubble'] : ['capture']
        )
        await root.dispose()
      }, 'events-peer.ts')
  )

  test('a held event keeps its native route when a keyed node moves', () =>
    withApp(async (app) => {
      const window = await app.openWindow({ title: 'Renderer captured path' })
      const { outer, destination, button, marker } = await controls(window)
      let entered = false
      const release = Promise.withResolvers<void>()
      const calls: string[] = []
      setProperty(outer, 'onClickCapture', async () => {
        calls.push('old capture')
        entered = true
        await release.promise
      })
      setProperty(outer, 'onClick', () => calls.push('old bubble'))
      setProperty(button, 'onClick', () => calls.push('target'))
      setProperty(destination, 'onClick', () => calls.push('new bubble'))
      const root = createRenderRoot(window, ({ container }) => {
        insertNode(container, outer)
        insertNode(container, destination)
      })
      await root.ready
      try {
        await trigger(window, marker, 'click')
        await until(() => entered)
        const before = root.diagnostics.mutations
        insertNode(destination, button)
        await root.flush()
        expect(root.diagnostics.mutations.create).toBe(before.create)
        expect(root.diagnostics.mutations.remove).toBe(before.remove)
        release.resolve()
        await until(() => calls.length === 3)
        expect(calls).toEqual(['old capture', 'target', 'old bubble'])
        await trigger(window, marker, 'click')
        await until(() => calls.length === 5)
        expect(calls.slice(3)).toEqual(['target', 'new bubble'])
      } finally {
        release.resolve()
        await root.dispose()
      }
    }, 'events-peer.ts'))

  test('deletion revokes a held route without redirecting it to a remounted handler', () =>
    withApp(async (app) => {
      const window = await app.openWindow({ title: 'Renderer event remount' })
      const { outer, button, marker } = await controls(window)
      let entered = false
      const release = Promise.withResolvers<void>()
      let oldCalls = 0
      let newCalls = 0
      let held = true
      setProperty(outer, 'onClickCapture', async () => {
        if (!held) return
        entered = true
        await release.promise
      })
      setProperty(button, 'onClick', () => oldCalls++)
      const root = createRenderRoot(window, ({ container }) => insertNode(container, outer))
      await root.ready
      try {
        await trigger(window, marker, 'click')
        await until(() => entered)
        removeNode(outer, button)
        const replacement = createElement('button')
        setProperty(replacement, 'text', 'target')
        setProperty(replacement, 'onClick', () => newCalls++)
        insertNode(outer, replacement)
        await root.flush()
        held = false
        release.resolve()
        await until(() => app.diagnostics.activeCallbacks === 0)
        expect([oldCalls, newCalls]).toEqual([0, 0])
        await trigger(window, marker, 'click')
        await until(() => newCalls === 1)
        expect(oldCalls).toBe(0)
        expect(root.diagnostics.listeners).toBe(2)
      } finally {
        release.resolve()
        await root.dispose()
      }
    }, 'events-peer.ts'))

  test('native event descriptors are immutable and unsupported names do not gain authority', () => {
    expect(Object.isFrozen(eventProperties)).toBe(true)
    for (const value of Object.values(eventProperties)) expect(Object.isFrozen(value)).toBe(true)
    expect(isEventProperty('onPointerDownCapture')).toBe(true)
    for (const name of [
      'constructor',
      '__proto__',
      'onChange',
      'onWheel',
      'onKeyDownCaptureCapture',
    ])
      expect(() => setProperty(createElement('box'), name, () => {})).toThrow('native-property:')
  })

  test('shared leaf snapshots reject scroll layout without changing native ownership', () =>
    withApp(async (app) => {
      const window = await app.openWindow({ title: 'Leaf overflow contract' })
      const node = createElement('text')
      setProperty(node, 'style', { overflow: 'scroll_y' })
      const root = createRenderRoot(window, ({ container }) => insertNode(container, node))
      await assert.rejects(root.ready, /Only native boxes support scrolling/)
      await assert.rejects(root.closed, /Only native boxes support scrolling/)
      expect(root.diagnostics.nodes).toBe(0)
      expect(app.diagnostics.nodes).toBe(1)
    }))
})
