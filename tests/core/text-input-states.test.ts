import { describe, expect, test } from 'bun:test'
import {
  createApplication,
  UnsupportedFeatureError,
  type Element,
  type NativeApplication,
  type NativeBatch,
  type NativeWindow,
} from '@bun-native/core'
import { createElement, createRenderRoot, insertNode, setProperty } from '@bun-native/renderer'
import assert from 'node:assert/strict'
import { resolve } from 'node:path'

async function withApp(
  mode: 'normal' | 'input-states',
  run: (app: NativeApplication) => Promise<void>
) {
  const app = await createApplication({
    executable: process.execPath,
    args: [resolve(import.meta.dir, 'protocol-peer.ts'), mode],
    requestTimeoutMs: 1_000,
  })
  try {
    await run(app)
  } finally {
    await app.shutdown().catch(() => {})
    await app.closed.catch(() => {})
  }
  expect(app.diagnostics.nodes).toBe(0)
}

const unsupported = (feature: string) => (error: unknown) =>
  error instanceof UnsupportedFeatureError && error.feature === feature

/** Record the input elements and revisions the renderer sends through real core batches. */
function recordInputSets(window: NativeWindow) {
  const sets: { element: Element; revision: number | undefined }[] = []
  const observe = (batch: NativeBatch): NativeBatch =>
    new Proxy(batch, {
      get(target, key) {
        if (key === 'set')
          return (node: never, element: Element, revision?: number) => {
            if (element.kind === 'input') sets.push({ element, revision })
            ;(target.set as (...values: unknown[]) => void)(node, element, revision)
          }
        const value = Reflect.get(target, key, target)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
  const recorded = new Proxy(window, {
    get(target, key) {
      if (key === 'batch')
        return (update: (batch: NativeBatch) => unknown) =>
          target.batch((batch) => update(observe(batch)))
      const value = Reflect.get(target, key, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  return { window: recorded, sets }
}

describe('input states through core (headless)', () => {
  test('a set that adds a state is rejected locally on a host without input_states_v1', () =>
    withApp('normal', async (app) => {
      const window = await app.openWindow({ title: 'State set' })
      const input = await window.batch((batch) => {
        const node = batch.create({ kind: 'input', value: 'kept' })
        batch.append(window.root, node)
        return node
      })
      const current = window.input(input)
      for (const [state, feature] of [
        [{ read_only: true }, 'input:read_only'],
        [{ disabled: true }, 'input:disabled'],
        // Both states report the disabled feature first.
        [{ disabled: true, read_only: true }, 'input:disabled'],
      ] as const)
        await assert.rejects(
          window.batch((batch) =>
            batch.set(input, { kind: 'input', value: 'kept', ...state }, current.revision)
          ),
          unsupported(feature)
        )
      expect(window.revision).toBe(1)
      expect(window.input(input)).toEqual(current)
      // Explicit false states are the ordinary wire form and still apply.
      await window.batch((batch) =>
        batch.set(
          input,
          { kind: 'input', value: 'kept', disabled: false, read_only: false },
          current.revision
        )
      )
      expect(window.revision).toBe(2)
      await window.close()
    }))

  test('a state change needs the current input revision', () =>
    withApp('input-states', async (app) => {
      const window = await app.openWindow({ title: 'Stale state' })
      const input = await window.batch((batch) => {
        const node = batch.create({ kind: 'input', value: 'a' })
        batch.append(window.root, node)
        return node
      })
      const { revision } = window.input(input)
      await window.batch((batch) =>
        batch.set(input, { kind: 'input', value: 'a', read_only: true }, revision)
      )
      await expect(
        window.batch((batch) =>
          batch.set(input, { kind: 'input', value: 'a', disabled: true }, revision)
        )
      ).rejects.toThrow()
      expect(window.input(input).revision).toBe(revision + 1)
      await window.close()
    }))
})

describe('input states through the shared renderer (headless)', () => {
  test('a state-only change resends the current value at the current revision', () =>
    withApp('input-states', async (app) => {
      const { window, sets } = recordInputSets(await app.openWindow({ title: 'Renderer states' }))
      const field = createElement('input')
      const root = createRenderRoot(window, ({ container }) => {
        setProperty(field, 'value', 'draft')
        insertNode(container, field)
      })
      await root.ready
      expect(sets).toEqual([])

      setProperty(field, 'readOnly', true)
      await root.flush()
      expect(sets.splice(0)).toEqual([
        { element: { kind: 'input', value: 'draft', read_only: true }, revision: 0 },
      ])

      setProperty(field, 'readOnly', undefined)
      setProperty(field, 'disabled', true)
      await root.flush()
      expect(sets.splice(0)).toEqual([
        { element: { kind: 'input', value: 'draft', disabled: true }, revision: 1 },
      ])

      // Clearing the state is one more set; `false` then matches omission and sends nothing.
      setProperty(field, 'disabled', false)
      await root.flush()
      expect(sets.splice(0)).toEqual([{ element: { kind: 'input', value: 'draft' }, revision: 2 }])
      setProperty(field, 'disabled', undefined)
      setProperty(field, 'readOnly', false)
      await root.flush()
      expect(sets).toEqual([])
      await root.dispose()
      await window.close()
    }))

  test('a renderer state on a host without the capability fails the root locally', () =>
    withApp('normal', async (app) => {
      const window = await app.openWindow({ title: 'Renderer unsupported' })
      const field = createElement('input')
      const root = createRenderRoot(window, ({ container }) => insertNode(container, field))
      await root.ready
      setProperty(field, 'readOnly', true)
      const failure = await Promise.allSettled([root.flush(), root.closed])
      expect(
        failure.some(
          (result) => result.status === 'rejected' && unsupported('input:read_only')(result.reason)
        )
      ).toBe(true)
      await root.dispose().catch(() => {})
      await window.close().catch(() => {})
    }))
})
