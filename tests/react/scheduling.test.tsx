/** @jsxImportSource @bun-native/react */
import { expect, spyOn, test } from 'bun:test'
import assert from 'node:assert/strict'
import { render, type NativeRef } from '@bun-native/react'
import { createRef, useEffect, useState, type Dispatch, type SetStateAction } from 'react'
import { withApp } from '../renderers/support.ts'

test('a recoverable concurrent render retry keeps the React root usable', () =>
  withApp(async (app) => {
    const window = await app.openWindow({ title: 'React concurrent recovery' })
    let update!: Dispatch<SetStateAction<number>>
    let failures = 0
    const observed: unknown[] = []
    const original = new Error('Transient concurrent render failure')
    function App() {
      const [value, setValue] = useState(0)
      update = setValue
      if (value === 1 && failures++ === 0) throw original
      return <text>Value: {value}</text>
    }
    const root = render(<App />, window, {
      onRecoverableError(error, info) {
        observed.push(error)
        expect(Object.isFrozen(info)).toBe(true)
      },
    })
    try {
      await root.ready
      update(1)
      await root.flush()
      expect(root.diagnostics.nodes).toBe(2)
      expect(failures).toBeGreaterThan(1)
      expect(observed).toHaveLength(1)
      expect(observed[0]).toMatchObject({ cause: original })
      update(2)
      await root.flush()
      expect(root.diagnostics.mutations.set).toBe(2)
    } finally {
      await root.dispose().catch(() => {})
    }
  }))

test('a throwing recoverable-error reporter fails only its root and releases refs and effects', () =>
  withApp(async (app) => {
    const window = await app.openWindow({ title: 'React reporter failure' })
    let update!: Dispatch<SetStateAction<number>>
    let attempts = 0
    let cleanups = 0
    const reference = createRef<NativeRef>()
    const error = new Error('Recovery reporter failed')
    function App() {
      const [value, setValue] = useState(0)
      update = setValue
      useEffect(
        () => () => {
          cleanups++
        },
        []
      )
      if (value === 1 && attempts++ === 0) throw new Error('Recovered rendering error')
      return (
        <button ref={reference} onClick={() => {}}>
          Value: {value}
        </button>
      )
    }
    const sibling = render(<text>Unaffected sibling</text>, window)
    const root = render(<App />, window, {
      onRecoverableError() {
        throw error
      },
    })
    await Promise.all([root.ready, sibling.ready])
    update(1)
    await assert.rejects(root.flush(), (actual: unknown) => actual === error)
    await assert.rejects(root.closed, (actual: unknown) => actual === error)
    expect(root.diagnostics.nodes).toBe(0)
    expect(reference.current).toBeNull()
    expect(cleanups).toBe(1)
    expect(app.diagnostics.callbacks).toBe(0)
    expect(app.diagnostics.windows).toBe(1)
    await sibling.render(<text>Sibling remains usable</text>)
    await sibling.dispose()
  }))

test('default recoverable-error reporting logs the error without invalidating the native root', () =>
  withApp(async (app) => {
    const window = await app.openWindow({ title: 'React default recovery report' })
    const log = spyOn(console, 'error').mockImplementation(() => {})
    let update!: Dispatch<SetStateAction<number>>
    let attempts = 0
    function App() {
      const [value, setValue] = useState(0)
      update = setValue
      if (value === 1 && attempts++ === 0) throw new Error('Transient rendering error')
      return <text>Value: {value}</text>
    }
    const root = render(<App />, window)
    try {
      await root.ready
      update(1)
      await root.flush()
      expect(log).toHaveBeenCalledTimes(1)
      expect(root.diagnostics.nodes).toBe(2)
    } finally {
      await root.dispose()
      log.mockRestore()
    }
  }))

test('invalid JavaScript error reporters fail before mounting native resources', () =>
  withApp(async (app) => {
    const window = await app.openWindow({ title: 'React invalid reporter' })
    for (const options of [null, [], false, { onError() {} }, { onRecoverableError: true }])
      expect(() => render(<text>Invalid</text>, window, options as never)).toThrow()
    expect(app.diagnostics.nodes).toBe(1)
  }))

test.each(['effect', 'ref'] as const)(
  'an uncaught React %s cleanup error rejects disposal after releasing native ownership',
  (source) =>
    withApp(async (app) => {
      const window = await app.openWindow({ title: 'React unmount error' })
      const error = new Error(source + ' cleanup failed')
      const reference = createRef<NativeRef>()
      function App() {
        useEffect(
          () => () => {
            if (source === 'effect') throw error
          },
          []
        )
        return (
          <box ref={reference}>
            <button
              ref={() => () => {
                if (source === 'ref') throw error
              }}
              onClick={() => {}}
            >
              Owned
            </button>
          </box>
        )
      }
      const root = render(<App />, window)
      await root.ready
      await assert.rejects(root.dispose(), (actual: unknown) => actual === error)
      await assert.rejects(root.closed, (actual: unknown) => actual === error)
      expect(reference.current).toBeNull()
      expect(root.diagnostics.nodes).toBe(0)
      expect(app.diagnostics.callbacks).toBe(0)
      expect(app.diagnostics.nodes).toBe(1)
    })
)
