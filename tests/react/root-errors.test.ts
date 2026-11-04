import { expect, spyOn, test } from 'bun:test'
import assert from 'node:assert/strict'
import { createElement, useEffect } from 'react'
import { reconciler } from '../../packages/react/src/reconciler.ts'
import { render } from '@bun-native/react'
import { withApp } from '../renderers/support.ts'
import { createRootErrors, type RootErrorOwner } from '../../packages/react/src/root-errors.ts'

test('retained React error callbacks cannot retain or invoke released owners', () => {
  const calls: unknown[] = []
  const owner: RootErrorOwner = {
    terminate: (error) => calls.push(error),
    report: (error) => calls.push(error),
  }
  const callbacks = createRootErrors(owner)
  const first = new Error('active failure')
  callbacks.uncaught(first)
  callbacks.recoverable(first, {})
  expect(calls).toEqual([first, first])
  callbacks.release()
  expect(owner).toEqual({ terminate: undefined, report: undefined })
  callbacks.uncaught(new Error('late failure'))
  callbacks.recoverable(new Error('late report'), {})
  callbacks.caught()
  callbacks.transition()
  callbacks.release()
  expect(calls).toEqual([first, first])
})

test('recoverable reports freeze a copy and preserve a thrown reporter failure', () => {
  const thrown = new Error('reporter failure')
  const failures: unknown[] = []
  const info = { componentStack: 'owned fixture' }
  let received: unknown
  const callbacks = createRootErrors({
    terminate: (error) => failures.push(error),
    report: (_error, value) => {
      received = value
      expect(Object.isFrozen(value)).toBe(true)
      throw thrown
    },
  })
  callbacks.recoverable(new Error('recoverable'), info)
  expect(received).toEqual(info)
  expect(received).not.toBe(info)
  expect(Object.isFrozen(info)).toBe(false)
  expect(failures).toEqual([thrown])
})

test('actual root disposal revokes the callbacks supplied to the reconciler', () =>
  withApp(async (app) => {
    const window = await app.openWindow({ title: 'React error callback ownership' })
    const original = reconciler.createContainer
    let callbacks: Parameters<typeof original> | undefined
    const capture = spyOn(reconciler, 'createContainer').mockImplementation((...args) => {
      callbacks = args
      return original(...args)
    })
    let reports = 0
    try {
      const root = render(createElement('text', null, 'owned'), window, {
        onRecoverableError: () => {
          reports++
        },
      })
      await root.ready
      if (!callbacks) throw new Error('The real reconciler did not receive root callbacks')
      const uncaught = callbacks[6]
      const recoverable = callbacks[8]
      expect(typeof recoverable).toBe('function')
      await root.dispose()
      await root.closed
      recoverable(new Error('late recoverable error'), {})
      expect(reports).toBe(0)
      uncaught(new Error('late uncaught error'), { componentStack: '' })
      expect(root.diagnostics.nodes).toBe(0)
      expect(app.diagnostics.callbacks).toBe(0)
    } finally {
      capture.mockRestore()
    }
  }))

for (const cleanupFails of [false, true]) {
  test(`framework teardown revokes error owners before native acknowledgement (cleanup failure: ${cleanupFails})`, () =>
    withApp(async (app) => {
      const window = await app.openWindow({ title: 'React disposing callback ownership' })
      const original = reconciler.createContainer
      let callbacks: Parameters<typeof original> | undefined
      const capture = spyOn(reconciler, 'createContainer').mockImplementation((...args) => {
        callbacks = args
        return original(...args)
      })
      const cleanupError = new Error('original framework cleanup failure')
      let reports = 0
      let cleaned = 0
      function Component() {
        useEffect(
          () => () => {
            cleaned++
            if (cleanupFails) throw cleanupError
          },
          []
        )
        return createElement('text', null, 'owned')
      }
      let root: ReturnType<typeof render> | undefined
      let disposal: Promise<void> | undefined
      try {
        root = render(createElement(Component), window, {
          onRecoverableError: () => {
            reports++
          },
        })
        await root.ready
        if (!callbacks) throw new Error('The real reconciler did not receive root callbacks')
        let closed = false
        void root.closed.then(
          () => {
            closed = true
          },
          () => {
            closed = true
          }
        )
        disposal = root.dispose()
        void disposal.catch(() => {})
        // No await: framework cleanup has ended, while the original native
        // removal/closed promise has not acknowledged its completion.
        expect(cleaned).toBe(1)
        expect(closed).toBe(false)
        callbacks[8](new Error('late report after framework teardown'), {})
        expect(reports).toBe(0)
        callbacks[6](new Error('late failure after framework teardown'), { componentStack: '' })
        if (cleanupFails) {
          await assert.rejects(disposal, (actual: unknown) => actual === cleanupError)
          await assert.rejects(root.closed, (actual: unknown) => actual === cleanupError)
        } else {
          await disposal
          await root.closed
        }
        expect(root.diagnostics.nodes).toBe(0)
        expect(app.diagnostics.callbacks).toBe(0)
        expect(reports).toBe(0)
      } finally {
        try {
          // The assertions above own the expected failed-cleanup result.
          await (disposal ?? root?.dispose())?.catch(() => {})
        } finally {
          capture.mockRestore()
        }
      }
    }))
}
