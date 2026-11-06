import { describe, expect, test } from 'bun:test'
import assert from 'node:assert/strict'
import { state, unsupported, withPeer } from './overlays-support.ts'

describe('active modal scope for focus requests (headless subprocess)', () => {
  test('among sibling modals the later one in tree order is active', () =>
    withPeer(['--overlays', '--keyboard'], async (app) => {
      const window = await app.openWindow({ title: 'Sibling modals' })
      const { first, second, firstButton, secondButton } = await window.batch((batch) => {
        const first = batch.create({ kind: 'overlay', modal: true })
        const second = batch.create({ kind: 'overlay', modal: true })
        const firstButton = batch.create({ kind: 'button', text: 'First' })
        const secondButton = batch.create({ kind: 'button', text: 'Second' })
        batch.append(window.root, first)
        batch.append(window.root, second)
        batch.append(first, firstButton)
        batch.append(second, secondButton)
        return { first, second, firstButton, secondButton }
      })
      await assert.rejects(
        window.batch((batch) => batch.focus(firstButton)),
        state('invalid_state')
      )
      await window.batch((batch) => batch.focus(secondButton))
      // Reordering in the same batch changes which modal paints on top.
      await window.batch((batch) => {
        batch.insert(window.root, second, 0)
        batch.focus(firstButton)
      })
      await assert.rejects(
        window.batch((batch) => batch.focus(secondButton)),
        state('invalid_state')
      )
      // A later non-modal sibling layer paints above but does not take the scope.
      await assert.rejects(
        window.batch((batch) => {
          batch.set(first, { kind: 'overlay' })
          batch.focus(firstButton)
        }),
        state('invalid_state')
      )
      await window.batch((batch) => {
        batch.set(first, { kind: 'overlay' })
        batch.focus(secondButton)
      })
      expect(window.revision).toBe(4)
    }))

  test('a nested modal outranks its parent; deeper non-modal layers stay inside it', () =>
    withPeer(['--overlays', '--keyboard'], async (app) => {
      const window = await app.openWindow({ title: 'Nested modals' })
      const nodes = await window.batch((batch) => {
        const dialog = batch.create({ kind: 'overlay', modal: true })
        const confirm = batch.create({ kind: 'overlay', modal: true })
        const menu = batch.create({ kind: 'overlay', anchor: 'parent' })
        const outerButton = batch.create({ kind: 'button', text: 'Outer' })
        const confirmField = batch.create({ kind: 'input', value: '' })
        const menuItem = batch.create({ kind: 'button', text: 'Item' })
        const disabled = batch.create({
          kind: 'button',
          text: 'Off',
          disabled: true,
        })
        batch.append(window.root, dialog)
        batch.append(dialog, outerButton)
        batch.append(dialog, confirm)
        batch.append(confirm, confirmField)
        batch.append(confirm, disabled)
        batch.append(confirm, menu)
        batch.append(menu, menuItem)
        return {
          dialog,
          confirm,
          outerButton,
          confirmField,
          menuItem,
          disabled,
        }
      })
      await assert.rejects(
        window.batch((batch) => batch.focus(nodes.outerButton)),
        state('invalid_state')
      )
      await window.batch((batch) => batch.focus(nodes.confirmField))
      await window.batch((batch) => batch.focus(nodes.menuItem))
      await assert.rejects(
        window.batch((batch) => batch.focus(nodes.disabled)),
        state('invalid_state')
      )
      // Closing the inner modal hands the scope back to its parent.
      await window.batch((batch) => {
        batch.remove(nodes.confirm)
        batch.focus(nodes.outerButton)
      })
      expect(window.revision).toBe(4)
    }))

  test('a modal created in the same batch already scopes that batch', () =>
    withPeer(['--overlays', '--keyboard'], async (app) => {
      const window = await app.openWindow({ title: 'Same batch modal' })
      const outside = await window.batch((batch) => {
        const outside = batch.create({ kind: 'button', text: 'Outside' })
        batch.append(window.root, outside)
        return outside
      })
      await assert.rejects(
        window.batch((batch) => {
          batch.focus(outside)
          batch.append(window.root, batch.create({ kind: 'overlay', modal: true }))
        }),
        state('invalid_state')
      )
      expect(window.revision).toBe(1)
    }))

  test('scrollTo on a split pane container is rejected; its pane child may scroll', () =>
    withPeer(['--overlays', '--keyboard', '--splits'], async (app) => {
      const window = await app.openWindow({ title: 'Split scroll' })
      const { split, pane } = await window.batch((batch) => {
        const split = batch.create({ kind: 'split', ratio: 0.25 })
        const pane = batch.create({
          kind: 'box',
          style: { overflow: 'scroll_y' },
        })
        batch.append(window.root, split)
        batch.append(split, pane)
        batch.append(split, batch.create({ kind: 'box' }))
        return { split, pane }
      })
      await assert.rejects(
        window.batch((batch) => batch.scrollTo(split, { y: 4 })),
        state('invalid_state')
      )
      await window.batch((batch) => batch.scrollTo(pane, { y: 4 }))
      expect(window.revision).toBe(2)
    }))

  test('scroll anchors need scroll_anchor_v1 even with the explicit start value', () =>
    withPeer([], async (app) => {
      const window = await app.openWindow({ title: 'No anchor' })
      await assert.rejects(
        window.batch((batch) =>
          batch.create({
            kind: 'box',
            style: { overflow: 'scroll', scroll_anchor: 'start' },
          })
        ),
        unsupported('style:scroll_anchor')
      )
      expect(window.revision).toBe(0)
    }))
})
