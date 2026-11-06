import { describe, expect, test } from 'bun:test'
import assert from 'node:assert/strict'
import { state, unsupported, withPeer } from './overlays-support.ts'

const popup = {
  kind: 'overlay',
  anchor: 'parent',
  surface: 'window',
  style: { width: 120, height: 80 },
} as const

describe('popup surface content rules (headless subprocess)', () => {
  test('turning a layer into a popup revalidates the content it already owns', () =>
    withPeer(['--overlays', '--popups'], async (app) => {
      const window = await app.openWindow({ title: 'Surface switch' })
      const { layer, group } = await window.batch((batch) => {
        const layer = batch.create({ kind: 'overlay', anchor: 'parent' })
        const group = batch.create({ kind: 'box' })
        batch.append(window.root, layer)
        batch.append(layer, group)
        batch.append(group, batch.create({ kind: 'input', value: 'filter' }))
        return { layer, group }
      })
      await assert.rejects(
        window.batch((batch) => batch.set(layer, popup)),
        state('invalid_state')
      )
      // Removing the editor in the same batch makes the switch valid.
      await window.batch((batch) => {
        batch.remove(group)
        batch.set(layer, popup)
      })
      // Switching back to a layer lifts the restriction.
      await window.batch((batch) => {
        batch.set(layer, { kind: 'overlay', anchor: 'parent' })
        batch.append(layer, batch.create({ kind: 'overlay', anchor: 'parent' }))
      })
      expect(window.revision).toBe(3)
    }))

  test('moving an editor or a layer beneath a popup is rejected', () =>
    withPeer(['--overlays', '--popups'], async (app) => {
      const window = await app.openWindow({ title: 'Move into popup' })
      const { menu, field, layer } = await window.batch((batch) => {
        const menu = batch.create(popup)
        const field = batch.create({ kind: 'input', value: '' })
        const layer = batch.create({ kind: 'overlay', anchor: 'parent' })
        batch.append(window.root, menu)
        batch.append(window.root, field)
        batch.append(window.root, layer)
        batch.append(menu, batch.create({ kind: 'button', text: 'Copy' }))
        return { menu, field, layer }
      })
      for (const node of [field, layer])
        await assert.rejects(
          window.batch((batch) => batch.append(menu, node)),
          state('invalid_state')
        )
      // Moving the popup itself beneath a modal dialog is allowed.
      await window.batch((batch) => {
        const dialog = batch.create({ kind: 'overlay', modal: true })
        batch.append(window.root, dialog)
        batch.append(dialog, menu)
      })
      expect(window.revision).toBe(2)
    }))

  test('a popup surface set on a host without popup_windows_v1 fails locally', () =>
    withPeer(['--overlays'], async (app) => {
      const window = await app.openWindow({ title: 'No popup set' })
      const layer = await window.batch((batch) => {
        const layer = batch.create({ kind: 'overlay', anchor: 'parent' })
        batch.append(window.root, layer)
        return layer
      })
      await assert.rejects(
        window.batch((batch) => batch.set(layer, popup)),
        unsupported('overlay:surface_window')
      )
      // An explicit layer surface normalizes away and stays available.
      await window.batch((batch) =>
        batch.set(layer, {
          kind: 'overlay',
          anchor: 'parent',
          surface: 'layer',
        })
      )
      expect(window.revision).toBe(2)
    }))
})
