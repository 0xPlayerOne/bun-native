import { expect, test } from 'bun:test'
import { mountCounter } from '../../examples/native-window/content.ts'
import { withApp } from '../renderers/support.ts'
import { until } from '../react/support.ts'
import { mirrorWindow, withEvidence } from './support.ts'

const INITIAL = [
  'text:Bun Native',
  'text:Clicks: 0',
  'button:Increment',
  'text:Native editable input',
  'input:|Type here…',
]

test('native-window example mounts, counts clicks, accepts input and closes cleanly', () =>
  withEvidence((evidence) =>
    withApp(async (app) => {
      const actual = await app.openWindow({ title: 'Native window example' })
      const { window, tree, size } = mirrorWindow(actual)
      const { label, input } = await mountCounter(window)
      expect(tree()).toEqual(INITIAL)
      expect(app.diagnostics.callbacks).toBe(2)

      // Synthetic peer events are requested by a marker outside the example tree.
      const marker = await actual.batch((batch) => {
        const node = batch.create({ kind: 'text', text: 'Marker' })
        batch.append(actual.root, node)
        return node
      })
      const dispatch = (type: 'click' | 'input', target: string) =>
        actual.batch((batch) =>
          batch.set(marker, { kind: 'text', text: `event:${JSON.stringify({ type, target })}` })
        )

      await dispatch('click', 'Increment')
      await until(() => tree()[1] === 'text:Clicks: 1')
      await dispatch('click', 'Increment')
      await until(() => tree()[1] === 'text:Clicks: 2')
      expect(tree()).toEqual(INITIAL.with(1, 'text:Clicks: 2'))

      const revision = actual.input(input).revision
      await dispatch('input', 'Type here…')
      await until(() => actual.input(input).revision > revision)
      expect(actual.input(input).value).toBe('native edit')
      await until(() => app.diagnostics.activeCallbacks === 0)
      expect(size()).toBe(5)
      expect(evidence()).toMatchObject([
        {
          type: 'click',
          sequence: 1,
          activation: 1,
          target: 'increment',
          stage: 'bun-application',
        },
        {
          type: 'click',
          sequence: 2,
          activation: 2,
          target: 'increment',
          stage: 'bun-application',
        },
        {
          type: 'input',
          sequence: 3,
          value: 'native edit',
          input_revision: 1,
          stage: 'bun-application',
        },
      ])

      await window.close()
      await window.closed
      expect(app.diagnostics.windows).toBe(0)
      expect(app.diagnostics.nodes).toBe(0)
      expect(app.diagnostics.callbacks).toBe(0)
      await expect(
        window.batch((batch) => batch.set(label, { kind: 'text', text: 'late' }))
      ).rejects.toThrow()
    }, 'events-peer.ts')
  ))
