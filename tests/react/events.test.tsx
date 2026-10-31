/** @jsxImportSource @bun-native/react */
import { expect, test } from 'bun:test'
import { render } from '@bun-native/react'
import { useState, type Dispatch, type SetStateAction } from 'react'
import { withApp } from '../renderers/support.ts'

test('React handler rerenders preserve the native subscription and queued click sequence', () =>
  withApp(async (app) => {
    const window = await app.openWindow({ title: 'React stable event binding' })
    const marker = await window.batch((batch) => {
      const node = batch.create({ kind: 'text', text: 'Marker' })
      batch.append(window.root, node)
      return node
    })
    let release!: () => void
    let began!: () => void
    let update!: Dispatch<SetStateAction<number>>
    let activeSignal!: AbortSignal
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const started = new Promise<void>((resolve) => {
      began = resolve
    })
    const received: { sequence: number; revision: number }[] = []
    function App() {
      const [revision, setRevision] = useState(0)
      update = setRevision
      return (
        <button
          onClick={async (event) => {
            received.push({ sequence: event.sequence, revision })
            if (received.length === 1) {
              activeSignal = event.signal
              began()
              await gate
            }
          }}
        >
          Revision: {revision}
        </button>
      )
    }
    const root = render(<App />, window)
    const click = () =>
      window.batch((batch) => batch.set(marker, { kind: 'text', text: 'emit click' }))
    try {
      await root.ready
      await click()
      await started
      await click()
      expect(app.diagnostics.queuedCallbacks).toBe(1)
      update(1)
      await root.flush()
      expect(activeSignal.aborted).toBe(false)
      expect(app.diagnostics.queuedCallbacks).toBe(1)
      release()
      for (let attempt = 0; attempt < 100 && received.length < 2; attempt++) await Bun.sleep(1)
      expect(received).toEqual([
        { sequence: 1, revision: 0 },
        { sequence: 2, revision: 1 },
      ])
      expect(app.diagnostics.callbacks).toBe(1)
    } finally {
      release()
      await root.dispose()
    }
    expect(activeSignal.aborted).toBe(true)
    expect(app.diagnostics.callbacks).toBe(0)
  }))

test('a throwing React native callback terminates the owning application and cleans the root', () =>
  withApp(async (app) => {
    const window = await app.openWindow({ title: 'React callback failure' })
    const marker = await window.batch((batch) => {
      const node = batch.create({ kind: 'text', text: 'Marker' })
      batch.append(window.root, node)
      return node
    })
    const error = new Error('React native callback failed')
    const root = render(
      <button
        onClick={() => {
          throw error
        }}
      >
        Fail
      </button>,
      window
    )
    await root.ready
    await window.batch((batch) => batch.set(marker, { kind: 'text', text: 'emit click' }))
    await expect(app.closed).rejects.toBe(error)
    await root.closed
    expect(root.diagnostics.nodes).toBe(0)
    expect(root.diagnostics.listeners).toBe(0)
    expect(app.diagnostics.nodes).toBe(0)
    expect(app.diagnostics.callbacks).toBe(0)
  }))
