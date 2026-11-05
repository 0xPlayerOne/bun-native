import { describe, expect, test } from 'bun:test'
import {
  createApplication,
  NativeStateError,
  UnsupportedFeatureError,
  type FocusEvent,
  type NativeApplication,
  type NativeNode,
} from '@bun-native/core'
import { MAX_SCROLL_OFFSET, parseCommand, ProtocolError } from '@bun-native/protocol'
import assert from 'node:assert/strict'
import { resolve } from 'node:path'

async function withApp(run: (app: NativeApplication) => Promise<void>, keyboard = true) {
  const app = await createApplication({
    executable: process.execPath,
    args: [
      resolve(import.meta.dir, 'overlay-peer.ts'),
      '--overlays',
      ...(keyboard ? ['--keyboard'] : []),
    ],
    requestTimeoutMs: 1_000,
  })
  try {
    await run(app)
  } finally {
    await app.shutdown().catch(() => {})
    await app.closed.catch(() => {})
  }
  expect(app.diagnostics).toMatchObject({ windows: 0, nodes: 0, callbacks: 0, activeCallbacks: 0 })
}

const unsupported = (feature: string) => (error: unknown) =>
  error instanceof UnsupportedFeatureError && error.feature === feature
const state = (code: string) => (error: unknown) =>
  error instanceof NativeStateError && error.code === code

describe('focus, scroll and overlay keyboard requests (headless subprocess)', () => {
  test('a host without the optional capabilities rejects each feature locally', () =>
    withApp(async (app) => {
      expect(app.capabilities).not.toContain('focus_v1')
      const window = await app.openWindow({ title: 'No keyboard features' })
      const { button, list } = await window.batch((batch) => {
        const button = batch.create({ kind: 'button', text: 'One' })
        const list = batch.create({ kind: 'box', style: { overflow: 'scroll_y' } })
        batch.append(window.root, list)
        batch.append(list, button)
        return { button, list }
      })
      await assert.rejects(
        window.batch((batch) => batch.focus(button)),
        unsupported('operation:focus')
      )
      await assert.rejects(
        window.batch((batch) => batch.scrollTo(list, { y: 4 })),
        unsupported('operation:scroll_to')
      )
      await assert.rejects(
        window.batch((batch) => batch.scrollIntoView(button)),
        unsupported('operation:scroll_into_view')
      )
      await assert.rejects(
        window.batch((batch) => batch.create({ kind: 'overlay', autofocus: true })),
        unsupported('overlay:autofocus')
      )
      await assert.rejects(
        window.batch((batch) => batch.create({ kind: 'overlay', navigation: 'menu' })),
        unsupported('overlay:navigation')
      )
      // Explicit defaults normalize away and still reach an older overlay host.
      await window.batch((batch) =>
        batch.append(
          window.root,
          batch.create({ kind: 'overlay', autofocus: false, navigation: 'tab' })
        )
      )
      expect(window.revision).toBe(2)
    }, false))

  test('focus requests commit with the batch and report through the focus event', () =>
    withApp(async (app) => {
      expect(app.capabilities).toEqual(
        expect.arrayContaining(['focus_v1', 'scroll_control_v1', 'overlay_keyboard_v1'])
      )
      const window = await app.openWindow({ title: 'Focus' })
      const focused: NativeNode[] = []
      // The first event can arrive before its batch promise resolves.
      window.on(window.root, 'focus', (event: FocusEvent<'focus'>) => {
        focused.push(event.node)
      })
      const field = await window.batch((batch) => {
        const field = batch.create({ kind: 'input', value: 'name' })
        batch.append(window.root, field)
        // A control created and attached in the same batch can take focus.
        batch.focus(field)
        return field
      })
      const save = await window.batch((batch) => {
        const save = batch.create({ kind: 'button', text: 'Save' })
        batch.append(window.root, save)
        batch.focus(save)
        return save
      })
      await window.batch((batch) => batch.focus(field))
      const until = performance.now() + 2_000
      while (focused.length < 3 && performance.now() < until) await Bun.sleep(1)
      const names = focused.map((node) =>
        node === field ? 'field' : node === save ? 'save' : 'other'
      )
      expect(names).toEqual(['field', 'save', 'field'])

      await assert.rejects(
        window.batch((batch) => {
          batch.focus(save)
          batch.remove(save)
        }),
        state('invalid_handle')
      )
      await assert.rejects(
        window.batch((batch) => {
          batch.set(save, { kind: 'button', text: 'Save', disabled: true })
          batch.focus(save)
        }),
        state('invalid_state')
      )
      await assert.rejects(
        window.batch((batch) => batch.focus(window.root as never)),
        state('invalid_state')
      )
      expect(window.revision).toBe(3)
    }))

  test('focus stays inside the topmost modal overlay', () =>
    withApp(async (app) => {
      const window = await app.openWindow({ title: 'Modal focus' })
      const outside = await window.batch((batch) => {
        const outside = batch.create({ kind: 'button', text: 'Outside' })
        batch.append(window.root, outside)
        return outside
      })
      const { dialog, inside } = await window.batch((batch) => {
        const dialog = batch.create({ kind: 'overlay', modal: true })
        const inside = batch.create({ kind: 'button', text: 'Inside' })
        batch.append(window.root, dialog)
        batch.append(dialog, inside)
        return { dialog, inside }
      })
      await assert.rejects(
        window.batch((batch) => batch.focus(outside)),
        state('invalid_state')
      )
      await window.batch((batch) => batch.focus(inside))
      // Closing the modal in the same batch releases the scope first.
      await window.batch((batch) => {
        batch.remove(dialog)
        batch.focus(outside)
      })
      expect(window.revision).toBe(4)
    }))

  test('scroll requests validate container axes and offsets before dispatch', () =>
    withApp(async (app) => {
      const window = await app.openWindow({ title: 'Scroll' })
      const { vertical, item, panel } = await window.batch((batch) => {
        const vertical = batch.create({ kind: 'box', style: { overflow: 'scroll_y' } })
        const panel = batch.create({
          kind: 'overlay',
          anchor: 'parent',
          autofocus: true,
          navigation: 'menu',
          style: { overflow: 'scroll' },
        })
        const item = batch.create({ kind: 'text', text: 'row' })
        batch.append(window.root, vertical)
        batch.append(vertical, item)
        batch.append(vertical, panel)
        batch.scrollTo(vertical, { y: 40 })
        batch.scrollIntoView(item)
        return { vertical, item, panel }
      })
      await window.batch((batch) => batch.scrollTo(panel, { x: 0, y: MAX_SCROLL_OFFSET }))
      await assert.rejects(
        window.batch((batch) => batch.scrollTo(vertical, { x: 4 })),
        state('invalid_state')
      )
      await assert.rejects(
        window.batch((batch) => batch.scrollTo(window.root, { y: 4 })),
        state('invalid_state')
      )
      for (const offset of [{}, { y: -1 }, { y: Number.NaN }, { x: MAX_SCROLL_OFFSET + 1 }])
        await assert.rejects(
          window.batch((batch) => batch.scrollTo(vertical, offset)),
          (error: unknown) => error instanceof TypeError || error instanceof RangeError
        )
      await assert.rejects(
        window.batch((batch) => {
          batch.scrollIntoView(item)
          batch.remove(item)
        }),
        state('invalid_handle')
      )
      expect(window.revision).toBe(2)
    }))
})

test('the wire parser accepts request operations and rejects malformed ones', () => {
  const batch = (operation: unknown) => ({
    id: 1,
    type: 'batch',
    window_id: 1,
    base_revision: 0,
    operations: [operation],
  })
  expect(parseCommand(batch({ type: 'scroll_to', node_id: 2, y: 8 }))).toMatchObject({
    operations: [{ type: 'scroll_to', node_id: 2, y: 8 }],
  })
  expect(parseCommand(batch({ type: 'focus', node_id: 2 }))).toMatchObject({
    operations: [{ type: 'focus', node_id: 2 }],
  })
  for (const invalid of [
    { type: 'scroll_to', node_id: 2 },
    { type: 'scroll_to', node_id: 2, y: -1 },
    { type: 'scroll_to', node_id: 2, x: null },
    { type: 'focus', node_id: 2, extra: true },
    { type: 'scroll_into_view' },
  ])
    expect(() => parseCommand(batch(invalid))).toThrow(ProtocolError)
})
