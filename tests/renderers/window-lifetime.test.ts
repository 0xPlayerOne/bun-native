import assert from 'node:assert/strict'
import { test } from 'bun:test'
import type { NativeWindow } from '@bun-native/core'
import { watchWindow } from '../../packages/renderer/src/window-lifetime.ts'
import { withApp } from './support.ts'

type Watch = typeof watchWindow

/** Exercise the real completion promise; no GC or WeakRef outcome is involved. */
async function assertObserverLifetime(watch: Watch) {
  await withApp(async (app) => {
    const actual = await app.openWindow({ title: 'Window completion ownership' })
    let subscriptions = 0
    const completion = new Proxy(actual.closed, {
      get(target, property, receiver) {
        if (property === 'then')
          return (...args: Parameters<Promise<void>['then']>) => {
            subscriptions++
            return target.then(...args)
          }
        return Reflect.get(target, property, receiver)
      },
    })
    const window: NativeWindow = {
      root: actual.root,
      closed: completion,
      get revision() {
        return actual.revision
      },
      batch: actual.batch.bind(actual),
      close: actual.close.bind(actual),
      input: actual.input.bind(actual),
      onClick: actual.onClick.bind(actual),
      onInput: actual.onInput.bind(actual),
    }
    const notified: number[] = []
    for (let index = 0; index < 25; index++) {
      const release = watch(window, () => notified.push(index))
      release()
      release()
    }
    const releaseActive = watch(window, () => notified.push(25))
    const releaseRemoved = watch(window, () => notified.push(26))
    releaseRemoved()
    assert.equal(subscriptions, 1, 'one completion subscription must serve all roots')
    assert.deepEqual([...notified], [], 'an open window cannot complete an observer')
    await actual.close()
    await actual.closed
    assert.deepEqual([...notified], [25], 'released observers must remain inert at window close')
    releaseActive()
    releaseRemoved()
    assert.throws(() => watch(window, () => notified.push(27)), /already closed/)
    assert.deepEqual(notified, [25])
  })
}

test('window lifetime bounds completion subscriptions and revokes released observers', () =>
  assertObserverLifetime(watchWindow))

test('the lifetime oracle rejects a separate retained completion callback per root', async () => {
  const perRootObserver: Watch = (window, listener) => {
    void window.closed.then(listener)
    return () => {}
  }
  await assert.rejects(
    assertObserverLifetime(perRootObserver),
    /one completion subscription must serve all roots/
  )
})

test('the lifetime oracle rejects a shared observer that forgets to unsubscribe roots', async () => {
  const callbacks = new Set<() => void>()
  let observing = false
  const missingUnsubscribe: Watch = (window, listener) => {
    callbacks.add(listener)
    if (!observing) {
      observing = true
      void window.closed.then(() => {
        for (const notify of callbacks) notify()
        callbacks.clear()
      })
    }
    return () => {}
  }
  await assert.rejects(
    assertObserverLifetime(missingUnsubscribe),
    /released observers must remain inert at window close/
  )
})
