import { describe, expect, test } from 'bun:test'
import { onDismiss, type DismissEvent, type KeyEvent } from '@bun-native/core'
import { trigger, waitFor, withPeer } from './overlays-support.ts'

describe('onDismiss routing (headless subprocess)', () => {
  test('Escape closes the innermost overlay on the focus route, one layer per press', () =>
    withPeer(['--overlays'], async (app) => {
      const window = await app.openWindow({ title: 'Three layers' })
      const layers = await window.batch((batch) => {
        const probe = batch.create({ kind: 'text', text: 'probe' })
        batch.append(window.root, probe)
        batch.append(window.root, batch.create({ kind: 'button', text: 'Page' }))
        const outer = batch.create({ kind: 'overlay', modal: true })
        const middle = batch.create({ kind: 'overlay', modal: true })
        const inner = batch.create({ kind: 'overlay', anchor: 'parent' })
        batch.append(window.root, outer)
        batch.append(outer, batch.create({ kind: 'button', text: 'Outer' }))
        batch.append(outer, middle)
        batch.append(middle, batch.create({ kind: 'button', text: 'Middle' }))
        batch.append(middle, inner)
        batch.append(inner, batch.create({ kind: 'button', text: 'Inner' }))
        return { probe, outer, middle, inner }
      })
      const dismissed: string[] = []
      const record = (name: string) => (event: DismissEvent) => {
        dismissed.push(name + ':' + event.reason)
      }
      // Registration order does not decide which layer handles Escape.
      onDismiss(window, layers.outer, record('outer'))
      onDismiss(window, layers.inner, record('inner'))
      onDismiss(window, layers.middle, record('middle'))
      await trigger(window, layers.probe, [
        { type: 'key_down', target: 'Inner', key: 'escape' },
        { type: 'key_down', target: 'Middle', key: 'escape' },
        { type: 'key_down', target: 'Outer', key: 'escape' },
        // Outside every overlay's route: nobody dismisses.
        { type: 'key_down', target: 'Page', key: 'escape' },
        // The control-less fallback target is the overlay node itself.
        { type: 'key_down', target: 'overlay#1', key: 'escape' },
      ])
      await waitFor(() => dismissed.length === 4, 'four dismissals')
      expect(dismissed).toEqual(['inner:escape', 'middle:escape', 'outer:escape', 'middle:escape'])
      await window.close()
    }))

  test('modified Escape and other keys never dismiss and keep bubbling', () =>
    withPeer(['--overlays'], async (app) => {
      const window = await app.openWindow({ title: 'Modifiers' })
      const { probe, dialog } = await window.batch((batch) => {
        const probe = batch.create({ kind: 'text', text: 'probe' })
        const dialog = batch.create({ kind: 'overlay', modal: true })
        batch.append(window.root, probe)
        batch.append(window.root, dialog)
        batch.append(dialog, batch.create({ kind: 'button', text: 'Ok' }))
        return { probe, dialog }
      })
      const dismissed: DismissEvent['reason'][] = []
      onDismiss(window, dialog, (event) => {
        dismissed.push(event.reason)
      })
      const bubbled: string[] = []
      const captured: string[] = []
      const label = (event: KeyEvent<'key_down'>) =>
        event.key +
        Object.entries(event.modifiers)
          .filter(([, on]) => on)
          .map(([name]) => '+' + name)
          .join('')
      window.on(window.root, 'key_down', (event) => {
        bubbled.push(label(event))
      })
      // Capture listeners stay available and observe the dismissed Escape too.
      window.on(
        window.root,
        'key_down',
        (event) => {
          captured.push(label(event))
        },
        { capture: true }
      )
      const modifiers = ['control', 'alt', 'shift', 'platform', 'function'] as const
      await trigger(window, probe, [
        ...modifiers.map((name) => ({
          type: 'key_down',
          target: 'Ok',
          key: 'escape',
          modifiers: { [name]: true },
        })),
        { type: 'key_down', target: 'Ok', key: 'enter' },
        { type: 'key_down', target: 'Ok', key: 'escape' },
      ])
      await waitFor(() => captured.length === 7 && dismissed.length === 1, 'seven key events')
      const modified = modifiers.map((name) => 'escape+' + name)
      expect(captured).toEqual([...modified, 'enter', 'escape'])
      // The handled Escape stops propagation; everything else reaches the root.
      expect(bubbled).toEqual([...modified, 'enter'])
      expect(dismissed).toEqual(['escape'])
      await window.close()
    }))

  test('a press on a parent-anchored overlay itself is a backdrop dismissal', () =>
    withPeer(['--overlays'], async (app) => {
      const window = await app.openWindow({ title: 'Popover backdrop' })
      const { probe, popover } = await window.batch((batch) => {
        const probe = batch.create({ kind: 'text', text: 'probe' })
        const trigger = batch.create({ kind: 'box' })
        const popover = batch.create({ kind: 'overlay', anchor: 'parent' })
        batch.append(window.root, probe)
        batch.append(window.root, trigger)
        batch.append(trigger, popover)
        batch.append(popover, batch.create({ kind: 'button', text: 'Item' }))
        return { probe, popover }
      })
      const dismissed: DismissEvent['reason'][] = []
      const stop = onDismiss(window, popover, (event) => {
        dismissed.push(event.reason)
      })
      await trigger(window, probe, [
        { type: 'pointer_down', target: 'Item' },
        { type: 'pointer_down', target: 'overlay#0' },
      ])
      await waitFor(() => dismissed.length === 1, 'one dismissal')
      expect(dismissed).toEqual(['backdrop'])
      // Revoking twice is harmless and leaves no registration behind.
      stop()
      stop()
      expect(app.diagnostics.callbacks).toBe(0)
      await window.close()
    }))
})
