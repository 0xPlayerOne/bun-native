/** @jsxImportSource @bun-native/react */
import { expect, test } from 'bun:test'
import { render, type ReactRenderRoot } from '@bun-native/react'
import { App, createCounterStats } from '../../examples/react-counter/app.tsx'
import { withApp } from '../renderers/support.ts'
import { until } from '../react/support.ts'
import { mirrorWindow, withEvidence } from './support.ts'

/** The committed tree below the render container and the example's own column box. */
function counter(clicks: number, input: string, rows: string[]) {
  return [
    'box',
    '  box',
    '    text:Bun Native React',
    `    text:Clicks: ${clicks}`,
    '    button:Increment',
    '    text:Native editable input',
    '    input:|Type here…',
    `    text:Input: ${input}`,
    '    box',
    ...rows.map((name) => `      text:${name}`),
  ]
}

test('react-counter example mounts, reorders keyed rows on click, accepts input and unmounts on close', () =>
  withEvidence((evidence) =>
    withApp(async (app) => {
      const actual = await app.openWindow({ title: 'React counter example' })
      const marker = await actual.batch((batch) => {
        const node = batch.create({ kind: 'text', text: 'Marker' })
        batch.append(actual.root, node)
        return node
      })
      const dispatch = (type: 'click' | 'input', target: string) =>
        actual.batch((batch) =>
          batch.set(marker, { kind: 'text', text: `event:${JSON.stringify({ type, target })}` })
        )
      const settled = () =>
        app.diagnostics.activeCallbacks === 0 && app.diagnostics.queuedCallbacks === 0
      const { window, tree } = mirrorWindow(actual)
      const stats = createCounterStats()
      const view: ReactRenderRoot = render(<App stats={stats} view={() => view} />, window)
      try {
        await view.ready
        await view.flush()
        expect(tree()).toEqual(counter(0, '', ['Alpha', 'Beta', 'Gamma']))
        expect(stats).toEqual({ rowsCreated: 3, rowsDisposed: 0, effects: 1, ownerDisposed: false })

        // The example's handler verifies its own keyed-update mutation budget
        // and records `react-keyed-update` only when that check passes.
        await dispatch('click', 'Increment')
        await until(() => evidence().some((entry) => entry.type === 'react-keyed-update'))
        await until(settled)
        await view.flush()
        expect(tree()).toEqual(counter(1, '', ['Gamma', 'Alpha']))
        expect(stats).toMatchObject({ rowsCreated: 3, rowsDisposed: 1, effects: 2 })

        await dispatch('click', 'Increment')
        await until(() => stats.effects === 3 && settled())
        await view.flush()
        expect(tree()).toEqual(counter(2, '', ['Alpha', 'Beta', 'Gamma']))
        expect(stats).toMatchObject({ rowsCreated: 4, rowsDisposed: 1 })

        await dispatch('input', 'Type here…')
        await until(() => tree().includes('    text:Input: native edit') && settled())
        await view.flush()
        expect(tree()).toEqual(counter(2, 'native edit', ['Alpha', 'Beta', 'Gamma']))
        expect(evidence().map((entry) => entry.type)).toEqual([
          'react-effect',
          'react-effect',
          'click',
          'react-keyed-update',
          'react-effect',
          'click',
          'react-keyed-update',
          'input',
        ])

        await actual.close()
        await view.closed
        expect(view.diagnostics.nodes).toBe(0)
        expect(view.diagnostics.listeners).toBe(0)
        expect(stats).toMatchObject({ rowsCreated: 4, rowsDisposed: 4, ownerDisposed: true })
        expect(app.diagnostics.callbacks).toBe(0)
      } finally {
        await view.dispose()
      }
    }, 'events-peer.ts')
  ))
