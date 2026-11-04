import { expect, spyOn, test } from 'bun:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { render } from '@bun-native/react'
import { reconciler } from '../../packages/react/src/reconciler.ts'
import * as barriers from '../../packages/react/src/commit-barrier.ts'
import { withApp } from '../renderers/support.ts'

for (const terminal of ['complete', 'reject'] as const) {
  test(`a retained commit callback revokes all bindings before ${terminal}`, () => {
    const calls: unknown[] = []
    const failure = new Error('original failure')
    const bindings: barriers.CommitBarrierBindings = {
      release: () => {
        expect(bindings).toEqual({ release: undefined, resolve: undefined, reject: undefined })
        calls.push('release')
        callback.complete()
        callback.reject(new Error('reentrant failure'))
      },
      resolve: () => calls.push('resolved'),
      reject: (cause) => calls.push(cause),
    }
    const callback = barriers.createCommitBarrier(bindings)
    if (terminal === 'complete') callback.complete()
    else callback.reject(failure)
    callback.complete()
    callback.reject(new Error('late failure'))
    expect(calls).toEqual(['release', terminal === 'complete' ? 'resolved' : failure])
  })
}

test('a synchronously rejected reconciler submission releases its reserved barrier capacity', () =>
  withApp(async (app) => {
    const window = await app.openWindow({ title: 'React barrier submission ownership' })
    const root = render(createElement('text', { text: 'Owned' }), window)
    await root.ready
    const failure = new Error('controlled submission failure')
    const update = spyOn(reconciler, 'updateContainer').mockImplementation(() => {
      throw failure
    })
    try {
      for (let index = 0; index < 129; index++)
        await assert.rejects(root.flush(), (cause) => cause === failure)
    } finally {
      update.mockRestore()
    }
    // All failed reservations were released; a genuine native flush still works.
    await root.flush()
    await root.dispose()
    expect(root.diagnostics.nodes).toBe(0)
  }))

test('actual commits revoke root bindings even while their reconciler callbacks stay retained', () =>
  withApp(async (app) => {
    const window = await app.openWindow({ title: 'React completed barrier ownership' })
    const root = render(createElement('text', { text: 'Owned' }), window)
    await root.ready
    const originalFactory = barriers.createCommitBarrier
    const bindings: barriers.CommitBarrierBindings[] = []
    const callbacks: Array<() => void> = []
    const originalUpdate = reconciler.updateContainer
    const factory = spyOn(barriers, 'createCommitBarrier').mockImplementation((owner) => {
      bindings.push(owner)
      return originalFactory(owner)
    })
    const update = spyOn(reconciler, 'updateContainer').mockImplementation((...args) => {
      const callback = args[3]
      if (typeof callback === 'function') callbacks.push(callback)
      return originalUpdate(...args)
    })
    try {
      await root.flush()
      expect(bindings).toHaveLength(1)
      expect(callbacks).toHaveLength(1)
      expect(bindings[0]).toEqual({ release: undefined, resolve: undefined, reject: undefined })
      await root.dispose()
      for (const callback of callbacks) callback()
      expect(root.diagnostics.nodes).toBe(0)
      expect(app.diagnostics.callbacks).toBe(0)
    } finally {
      update.mockRestore()
      factory.mockRestore()
    }
  }))

test('terminal root disposal rejects and revokes pending callbacks before late completion', () =>
  withApp(async (app) => {
    const window = await app.openWindow({ title: 'React cancelled barrier ownership' })
    const root = render(createElement('text', { text: 'Owned' }), window)
    await root.ready
    const originalFactory = barriers.createCommitBarrier
    const bindings: barriers.CommitBarrierBindings[] = []
    const callbacks: Array<() => void> = []
    const factory = spyOn(barriers, 'createCommitBarrier').mockImplementation((owner) => {
      bindings.push(owner)
      return originalFactory(owner)
    })
    const originalUpdate = reconciler.updateContainer
    const update = spyOn(reconciler, 'updateContainer').mockImplementation((...args) => {
      const callback = args[3]
      if (typeof callback === 'function') callbacks.push(callback)
      // Hold only completion notification. The update, synchronous unmount and
      // native core still execute through their actual implementations.
      return originalUpdate(args[0], args[1], args[2], null)
    })
    try {
      const pending = root.flush().then(
        () => ({ status: 'fulfilled' as const }),
        (cause: unknown) => ({ status: 'rejected' as const, cause })
      )
      expect(bindings).toHaveLength(1)
      expect(typeof bindings[0]?.release).toBe('function')
      await root.dispose()
      const outcome = await pending
      expect(outcome.status).toBe('rejected')
      if (outcome.status === 'rejected')
        expect(outcome.cause).toMatchObject({ code: 'invalid_state' })
      expect(bindings[0]).toEqual({ release: undefined, resolve: undefined, reject: undefined })
      for (const callback of callbacks) callback()
      expect(root.diagnostics.nodes).toBe(0)
      expect(app.diagnostics.callbacks).toBe(0)
    } finally {
      update.mockRestore()
      factory.mockRestore()
    }
  }))
