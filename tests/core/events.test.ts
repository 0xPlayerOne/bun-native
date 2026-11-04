import { describe, expect, test } from 'bun:test'
import {
  createApplication,
  NativeStateError,
  ProtocolError,
  type ClickEvent,
  type NativeApplication,
  type NativeEventType,
  type NativeNode,
  type NativeUIEvent,
  type NativeWindow,
} from '@bun-native/core'
import assert from 'node:assert/strict'
import { resolve } from 'node:path'

async function within<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Event test did not finish')), 1_000)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

async function until(condition: () => boolean): Promise<void> {
  const deadline = performance.now() + 1_000
  while (!condition()) {
    if (performance.now() > deadline) throw new Error('Event state did not settle')
    await Bun.sleep(1)
  }
}

async function withApp(
  run: (application: NativeApplication) => Promise<void>,
  failure?: RegExp
): Promise<void> {
  const app = await createApplication({
    executable: process.execPath,
    args: [resolve(import.meta.dir, 'events-peer.ts')],
    requestTimeoutMs: 1_000,
  })
  try {
    await run(app)
  } finally {
    if (failure)
      await Promise.all([
        assert.rejects(within(app.shutdown()), failure),
        assert.rejects(within(app.closed), failure),
      ])
    else await Promise.all([within(app.shutdown()), within(app.closed)])
    expect(app.diagnostics).toEqual({
      windows: 0,
      nodes: 0,
      callbacks: 0,
      queuedTransactions: 0,
      queuedCallbacks: 0,
      activeCallbacks: 0,
      serviceRequests: 0,
    })
  }
}

async function controls(window: NativeWindow) {
  return window.batch((batch) => {
    const marker = batch.create({ kind: 'text', text: 'Fixture trigger' })
    const outer = batch.create({ kind: 'box' })
    const inner = batch.create({ kind: 'box' })
    const target = batch.create({ kind: 'button', text: 'target' })
    const blocker = batch.create({ kind: 'button', text: 'blocker' })
    const input = batch.create({ kind: 'input', value: '', placeholder: 'input' })
    const destination = batch.create({ kind: 'box' })
    for (const node of [marker, outer, blocker, destination]) batch.append(window.root, node)
    batch.append(outer, inner)
    batch.append(inner, target)
    batch.append(inner, input)
    return { marker, outer, inner, target, blocker, input, destination }
  })
}
type Controls = Awaited<ReturnType<typeof controls>>

function trigger(
  window: NativeWindow,
  marker: NativeNode<'text'>,
  type: NativeEventType = 'click',
  target = 'target',
  variant?: string
) {
  return window.batch((batch) =>
    batch.set(marker, {
      kind: 'text',
      text: 'event:' + JSON.stringify({ type, target, ...(variant ? { variant } : {}) }),
    })
  )
}

async function block(window: NativeWindow, fields: Controls) {
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  window.onClick(fields.blocker, () => {
    entered.resolve()
    return release.promise
  })
  await trigger(window, fields.marker, 'click', 'blocker')
  await within(entered.promise)
  return release.resolve
}

describe('shared native event propagation (headless real subprocess)', () => {
  test('captures root-to-target, then bubbles over the exact immutable native path', () =>
    withApp(async (app) => {
      const window = await app.openWindow({ title: 'Propagation order' })
      const fields = await controls(window)
      const path = [window.root, fields.outer, fields.inner, fields.target]
      const names = ['root', 'outer', 'inner', 'target']
      const calls: string[] = []
      const done = Promise.withResolvers<void>()
      for (const [index, node] of path.entries()) {
        for (const capture of [true, false]) {
          window.on(
            node,
            'click',
            (event) => {
              expect(event.node).toBe(fields.target)
              expect(event.currentTarget).toBe(node)
              expect(event.path).toEqual(path)
              expect(Object.isFrozen(event.path)).toBe(true)
              expect(Object.isFrozen(event)).toBe(true)
              expect(event.treeRevision).toBe(2)
              expect(event.phase).toBe(index === 3 ? 'target' : capture ? 'capture' : 'bubble')
              calls.push(`${names[index]}:${capture ? 'capture' : 'bubble'}`)
              if (!capture && index === 0) done.resolve()
            },
            { capture }
          )
        }
      }
      expect(app.diagnostics.callbacks).toBe(8)
      await trigger(window, fields.marker)
      await within(done.promise)
      expect(calls).toEqual([
        'root:capture',
        'outer:capture',
        'inner:capture',
        'target:capture',
        'target:bubble',
        'inner:bubble',
        'outer:bubble',
        'root:bubble',
      ])
    }))

  for (const stop of ['ancestor', 'target', 'immediate'] as const)
    test(`${stop} propagation control affects only subsequent JavaScript delivery`, () =>
      withApp(async (app) => {
        const window = await app.openWindow({ title: 'Propagation stop' })
        const fields = await controls(window)
        const calls: string[] = []
        window.on(
          fields.outer,
          'click',
          (event) => {
            calls.push('ancestor')
            if (stop === 'ancestor') event.stopPropagation()
          },
          { capture: true }
        )
        window.on(
          fields.target,
          'click',
          (event) => {
            calls.push('target:capture')
            if (stop === 'target') event.stopPropagation()
            if (stop === 'immediate') event.stopImmediatePropagation()
          },
          { capture: true }
        )
        window.onClick(fields.target, (event) => {
          calls.push('target:bubble')
          expect(event.propagationStopped).toBe(true)
        })
        window.on(window.root, 'click', () => {
          calls.push('root')
        })
        await trigger(window, fields.marker)
        await until(() => calls.length > 0 && app.diagnostics.activeCallbacks === 0)
        expect(calls).toEqual(
          stop === 'ancestor'
            ? ['ancestor']
            : stop === 'immediate'
              ? ['ancestor', 'target:capture']
              : ['ancestor', 'target:capture', 'target:bubble']
        )
      }))

  test('capture stop does not jump directly to a later bubble binding on the same ancestor', () =>
    withApp(async (app) => {
      const window = await app.openWindow({ title: 'Sparse propagation path' })
      const fields = await controls(window)
      const calls: string[] = []
      window.on(
        window.root,
        'click',
        (event) => {
          calls.push('capture')
          event.stopPropagation()
        },
        { capture: true }
      )
      window.on(window.root, 'click', () => {
        calls.push('bubble')
      })
      await trigger(window, fields.marker)
      await until(() => calls.length > 0 && app.diagnostics.activeCallbacks === 0)
      expect(calls).toEqual(['capture'])
    }))

  test('a completed listener cannot later stop a still-running dispatch through a retained event', () =>
    withApp(async (app) => {
      const window = await app.openWindow({ title: 'Propagation control lifetime' })
      const fields = await controls(window)
      const entered = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      const done = Promise.withResolvers<void>()
      let previous: ClickEvent | undefined
      window.on(
        fields.target,
        'click',
        (event) => {
          previous = event
        },
        { capture: true }
      )
      window.onClick(fields.target, () => {
        entered.resolve()
        return release.promise
      })
      window.on(window.root, 'click', () => {
        done.resolve()
      })
      await trigger(window, fields.marker)
      await within(entered.promise)
      assert(previous)
      previous.stopImmediatePropagation()
      expect(previous.propagationStopped).toBe(false)
      release.resolve()
      await within(done.promise)
    }))

  test('freezes typed key/pointer/focus fields and ingests input before capture listeners', () =>
    withApp(async (app) => {
      const window = await app.openWindow({ title: 'Typed event fields' })
      const fields = await controls(window)
      const kinds = [
        'key_down',
        'key_up',
        'pointer_down',
        'pointer_up',
        'focus',
        'blur',
        'input',
      ] as const
      const seen: NativeUIEvent[] = []
      for (const type of kinds) {
        const done = Promise.withResolvers<void>()
        const remove = window.on(
          window.root,
          type,
          (event) => {
            seen.push(event)
            expect(event.currentTarget).toBe(window.root)
            expect(event.node).toBe(fields.input)
            if (event.type === 'key_down' || event.type === 'key_up') {
              expect(event.key).toBe('enter')
              expect(event.keyChar).toBe('\r')
              expect('repeat' in event).toBe(false)
              expect('code' in event).toBe(false)
            }
            if (event.type === 'pointer_down' || event.type === 'pointer_up')
              expect([event.button, event.x, event.y]).toEqual(['right', 12.5, -4.25])
            if ('modifiers' in event) {
              expect(event.modifiers).toEqual({
                control: true,
                alt: false,
                shift: true,
                platform: false,
                function: false,
              })
              expect(Object.isFrozen(event.modifiers)).toBe(true)
            }
            if (event.type === 'input') {
              expect([event.value, event.revision]).toEqual(['native edit', 1])
              expect(window.input(fields.input)).toEqual({ value: 'native edit', revision: 1 })
            }
            expect('preventDefault' in event).toBe(false)
            done.resolve()
          },
          { capture: true }
        )
        await trigger(window, fields.marker, type, 'input')
        await within(done.promise)
        remove()
        expect(seen.at(-1)!.signal.aborted).toBe(true)
      }
      expect(seen.map((event) => event.type)).toEqual([...kinds])
      expect(seen.map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7])
    }))

  test('a later keyed move does not redirect an already-queued event to its new parent', () =>
    withApp(async (app) => {
      const window = await app.openWindow({ title: 'Queued route survives move' })
      const fields = await controls(window)
      const calls: string[] = []
      const done = Promise.withResolvers<ClickEvent>()
      const release = await block(window, fields)
      window.on(fields.outer, 'click', () => {
        calls.push('old-parent')
      })
      window.on(fields.destination, 'click', () => {
        calls.push('new-parent')
      })
      window.onClick(fields.target, (event) => done.resolve(event))
      await trigger(window, fields.marker)
      await until(() => app.diagnostics.queuedCallbacks === 1)
      const capturedRevision = window.revision
      await window.batch((batch) => batch.append(fields.destination, fields.target))
      release()
      const event = await within(done.promise)
      await until(() => app.diagnostics.activeCallbacks === 0)
      expect(calls).toEqual(['old-parent'])
      expect(event.path).toEqual([window.root, fields.outer, fields.inner, fields.target])
      expect(event.treeRevision).toBe(capturedRevision)
      expect(window.revision).toBe(capturedRevision + 1)
    }))

  test('removing an old ancestor skips its revoked binding but preserves a rescued target', () =>
    withApp(async (app) => {
      const window = await app.openWindow({ title: 'Ancestor ownership after move' })
      const fields = await controls(window)
      const release = await block(window, fields)
      let staleCalls = 0
      const done = Promise.withResolvers<ClickEvent>()
      window.on(fields.outer, 'click', () => {
        staleCalls++
      })
      window.on(fields.destination, 'click', () => {
        staleCalls++
      })
      window.onClick(fields.target, (event) => done.resolve(event))
      await trigger(window, fields.marker)
      await until(() => app.diagnostics.queuedCallbacks === 1)
      await window.batch((batch) => {
        batch.append(fields.destination, fields.target)
        batch.remove(fields.outer)
      })
      release()
      const event = await within(done.promise)
      await until(() => app.diagnostics.activeCallbacks === 0)
      expect(staleCalls).toBe(0)
      expect(event.path).toEqual([window.root, fields.outer, fields.inner, fields.target])
      assert.throws(() => window.on(fields.outer, 'click', () => {}), /disposed/)
    }))

  test('deleting a queued target purges the event without revoking a live ancestor binding', () =>
    withApp(async (app) => {
      const window = await app.openWindow({ title: 'Deleted queued target' })
      const fields = await controls(window)
      const release = await block(window, fields)
      let calls = 0
      window.on(fields.outer, 'click', () => {
        calls++
      })
      await trigger(window, fields.marker)
      await until(() => app.diagnostics.queuedCallbacks === 1)
      await window.batch((batch) => batch.remove(fields.target))
      expect(app.diagnostics.queuedCallbacks).toBe(0)
      expect(app.diagnostics.callbacks).toBe(2)
      release()
      await until(() => app.diagnostics.activeCallbacks === 0)
      expect(calls).toBe(0)
    }))

  test('target deletion releases an uncooperative ancestor callback and leaves its registration usable', () =>
    withApp(async (app) => {
      const window = await app.openWindow({ title: 'Active ancestor cancellation' })
      const fields = await controls(window)
      const entered = Promise.withResolvers<AbortSignal>()
      const sibling = Promise.withResolvers<void>()
      window.on(
        window.root,
        'click',
        (event) => {
          if (event.node === fields.target) {
            entered.resolve(event.signal)
            return new Promise<void>(() => {})
          }
          sibling.resolve()
        },
        { capture: true }
      )
      await trigger(window, fields.marker)
      const signal = await within(entered.promise)
      await window.batch((batch) => batch.remove(fields.target))
      await until(() => app.diagnostics.activeCallbacks === 0)
      // The signal belongs to this still-live ancestor registration.
      expect(signal.aborted).toBe(false)
      await trigger(window, fields.marker, 'click', 'blocker')
      await within(sibling.promise)
    }))

  test('new or replacement registrations never receive earlier queued events', () =>
    withApp(async (app) => {
      const window = await app.openWindow({ title: 'Registration snapshot' })
      const fields = await controls(window)
      const release = await block(window, fields)
      let calls = 0
      let captured = 0
      const done = Promise.withResolvers<void>()
      window.on(fields.outer, 'click', () => {
        captured++
      })
      const removeOld = window.onClick(fields.target, () => {
        calls += 100
      })
      await trigger(window, fields.marker)
      await until(() => app.diagnostics.queuedCallbacks === 1)
      window.onClick(fields.target, () => {
        calls++
        done.resolve()
      })
      removeOld()
      release()
      await until(
        () => app.diagnostics.activeCallbacks === 0 && app.diagnostics.queuedCallbacks === 0
      )
      expect(calls).toBe(0)
      expect(captured).toBe(1)
      await trigger(window, fields.marker)
      await within(done.promise)
      expect(calls).toBe(1)
    }))

  test('binding identity is independent across event types and capture/bubble phases', () =>
    withApp(async (app) => {
      const window = await app.openWindow({ title: 'Binding slots' })
      const fields = await controls(window)
      const calls: string[] = []
      const done = Promise.withResolvers<void>()
      const removeCapture = window.on(
        fields.target,
        'click',
        () => {
          calls.push('capture')
        },
        { capture: true }
      )
      const removeClick = window.onClick(fields.target, () => {
        calls.push('click')
      })
      window.on(fields.target, 'pointer_down', () => {
        calls.push('pointer')
        done.resolve()
      })
      expect(app.diagnostics.callbacks).toBe(3)
      removeCapture()
      removeClick()
      expect(app.diagnostics.callbacks).toBe(1)
      await trigger(window, fields.marker, 'pointer_down')
      await within(done.promise)
      expect(calls).toEqual(['pointer'])
    }))

  test('validates generic registrations before changing listener ownership', () =>
    withApp(async (app) => {
      const window = await app.openWindow({ title: 'JavaScript listener validation' })
      const fields = await controls(window)
      for (const options of [null, [], { capture: undefined }, { capture: 1 }, { once: true }])
        assert.throws(
          () => window.on(fields.target, 'click', () => {}, options as never),
          NativeStateError
        )
      assert.throws(() => window.on(fields.target, 'wheel' as never, () => {}), NativeStateError)
      assert.throws(() => window.on(fields.target, 'click', null as never), NativeStateError)
      assert.throws(() => window.on({ kind: 'button' } as NativeNode, 'click', () => {}), /forged/)
      expect(app.diagnostics.callbacks).toBe(0)
    }))

  for (const [variant, reason] of [
    ['future', /ahead of its acknowledgement/],
    ['wrong-root', /outside its window root/],
    ['wrong-ancestry', /does not match/],
    ['foreign-ancestor', /outside its owner/],
  ] as const)
    test(`rejects ${variant} event routes instead of granting callback authority`, () =>
      withApp(async (app) => {
        const window = await app.openWindow({ title: 'Malformed native route' })
        const fields = await controls(window)
        if (variant === 'foreign-ancestor') await app.openWindow({ title: 'Other owner' })
        window.onClick(fields.target, () => {
          throw new Error('Malformed route reached a listener')
        })
        await trigger(window, fields.marker, 'click', 'target', variant)
        await assert.rejects(
          within(app.closed),
          (error: unknown) => error instanceof ProtocolError && reason.test(error.message)
        )
      }, reason))

  test('rejects a replayed input revision before updating state or dispatching', () =>
    withApp(async (app) => {
      const window = await app.openWindow({ title: 'Input replay' })
      const fields = await controls(window)
      await trigger(window, fields.marker, 'input', 'input', 'replayed-input')
      await assert.rejects(within(app.closed), /edit revision is invalid/)
    }, /edit revision is invalid/))
})
