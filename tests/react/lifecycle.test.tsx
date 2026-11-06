/** @jsxImportSource @bun-native/react */
import { expect, test } from 'bun:test'
import assert from 'node:assert/strict'
import { render, type NativeRef, type ReactRenderRoot } from '@bun-native/react'
import { Activity, useEffect, useLayoutEffect, useState } from 'react'
import { scheduledWindow, withApp } from '../renderers/support.ts'

test('immediate React disposal rejects readiness and runs effect and callback-ref cleanup once', () =>
  withApp(async (app) => {
    const window = await app.openWindow({ title: 'React cancelled mount' })
    let effects = 0
    let cleanups = 0
    let attached = 0
    let detached = 0
    const reference = (value: NativeRef | null) => {
      if (!value) throw new Error('React 19 callback-ref cleanup should own detachment')
      attached++
      return () => {
        detached++
      }
    }
    function App() {
      useEffect(() => {
        effects++
        return () => {
          cleanups++
        }
      }, [])
      return <text ref={reference}>Cancelled</text>
    }
    const root = render(<App />, window)
    await root.dispose()
    await assert.rejects(root.ready, /before initial native acknowledgement/)
    await root.closed
    await root.dispose()
    expect({ effects, cleanups, attached, detached }).toEqual({
      effects: 1,
      cleanups: 1,
      attached: 1,
      detached: 1,
    })
    expect(root.diagnostics.nodes).toBe(0)
    expect(app.diagnostics.nodes).toBe(1)
  }))

test('React layout effects may request terminal disposal without reentering a Fiber commit', () =>
  withApp(async (app) => {
    const window = await app.openWindow({ title: 'React commit disposal' })
    let request!: (value: boolean) => void
    let root!: ReactRenderRoot
    let disposal: Promise<void> | undefined
    let cleaned = 0
    function App() {
      const [stop, setStop] = useState(false)
      request = setStop
      useLayoutEffect(() => {
        if (stop) disposal = root.dispose()
      }, [stop])
      useEffect(
        () => () => {
          cleaned++
        },
        []
      )
      return <button onClick={() => {}}>Live</button>
    }
    root = render(<App />, window)
    await root.ready
    request(true)
    await assert.rejects(root.flush(), /React root is closed/)
    await disposal
    await root.closed
    expect(cleaned).toBe(1)
    expect(app.diagnostics.callbacks).toBe(0)
    expect(app.diagnostics.nodes).toBe(1)
  }))

test('React flush bounds the outstanding commit-barrier queue without terminating accepted work', () =>
  withApp(async (app) => {
    const window = await app.openWindow({ title: 'React bounded barriers' })
    const root = render(<text>Barrier</text>, window)
    await root.ready
    const results = await Promise.allSettled(Array.from({ length: 129 }, () => root.flush()))
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(128)
    const failures = results.filter((result) => result.status === 'rejected')
    expect(failures).toHaveLength(1)
    if (failures[0]?.status === 'rejected')
      expect(failures[0].reason).toMatchObject({ code: 'limit_exceeded' })
    await root.render(<text>Still usable</text>)
    expect(root.diagnostics.mutations.set).toBe(1)
    await root.dispose()
  }))

test('unsupported hidden Activity fails explicitly and disposes its native subtree', () =>
  withApp(async (app) => {
    const window = await app.openWindow({ title: 'React unsupported hidden subtree' })
    const root = render(
      <Activity mode="visible">
        <text>Visible</text>
      </Activity>,
      window
    )
    await root.ready
    await assert.rejects(
      root.render(
        <Activity mode="hidden">
          <text>Hidden</text>
        </Activity>
      ),
      /react-hidden-subtrees/
    )
    await assert.rejects(root.closed, /react-hidden-subtrees/)
    expect(root.diagnostics.nodes).toBe(0)
    expect(app.diagnostics.nodes).toBe(1)
  }))

test('React disposal racing the initial acknowledgement never reports a closed root as ready', () =>
  withApp(async (app) => {
    const native = await app.openWindow({ title: 'React acknowledgement race' })
    const { window, control } = scheduledWindow(native)
    const outcomes = new Set<string>()
    for (let depth = 0; depth < 16; depth += 1) {
      let disposing: Promise<void> | undefined
      const root = render(<text>Raced</text>, window)
      control.afterAck = { depth, run: () => (disposing = root.dispose()) }
      await root.ready.then(
        () => outcomes.add('ready'),
        (error: unknown) => {
          assert.ok(error instanceof Error)
          outcomes.add(error.message)
        }
      )
      await root.closed
      await disposing
      expect(root.diagnostics.nodes).toBe(0)
      expect(app.diagnostics.nodes).toBe(1)
    }
    // Disposal after the native acknowledgement but before React observes it.
    expect(outcomes).toContain('React root closed before initial native acknowledgement')
    for (const outcome of outcomes)
      expect(['ready', 'React root closed before initial native acknowledgement']).toContain(
        outcome
      )
  }))
