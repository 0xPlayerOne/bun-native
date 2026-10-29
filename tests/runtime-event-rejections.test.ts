import { expect, test } from 'bun:test'
import { MockBackend } from '../packages/runtime/src/mock.ts'
import { ListenerResultObserver } from '../packages/runtime/src/listener-result.ts'

const flush = async () => {
  for (let n = 0; n < 8; n++) await Promise.resolve()
}

test('runtime events remain synchronous and count each rejection from a shared promise', async () => {
  const backend = new MockBackend()
  let reject!: (reason: unknown) => void
  const pending = new Promise<void>((_resolve, fail) => {
    reject = fail
  })
  let deliveries = 0
  const unsubscribe = backend.onEvent(() => {
    deliveries++
    return pending
  })
  const first = backend.createSession({ persistence: 'ephemeral', partition: 'one' })
  const second = backend.createSession({ persistence: 'ephemeral', partition: 'two' })
  expect(deliveries).toBe(2)
  await first
  await second
  unsubscribe()
  reject(new Error('listener failure'))
  await flush()
  expect(backend.diagnostics().listenerErrors).toBe(2)
  await backend.dispose()
})

test('distinct thenable invocations remain independently assimilated', async () => {
  const counter = { count: 0 }
  const observer = new ListenerResultObserver(counter)
  let calls = 0
  const thenable = {
    // Intentionally exercise a stateful PromiseLike returned by a listener.
    // oxlint-disable-next-line unicorn/no-thenable
    then(_resolve: (value: unknown) => void, reject: (error: unknown) => void) {
      calls++
      reject(new Error('failure'))
    },
  }
  observer.observe(thenable)
  observer.observe(thenable)
  await flush()
  expect(calls).toBe(2)
  expect(counter.count).toBe(2)
})

test('a native promise with an overridden then still has its rejection observed', async () => {
  const counter = { count: 0 }
  const observer = new ListenerResultObserver(counter)
  let reject!: (error: unknown) => void
  const promise = new Promise<void>((_resolve, fail) => {
    reject = fail
  })
  // Exercise an application-mutated native promise.
  // oxlint-disable-next-line unicorn/no-thenable
  promise.then = (() => {
    throw new Error('overridden then')
  }) as typeof promise.then
  observer.observe(promise)
  reject(new Error('listener failure'))
  await flush()
  expect(counter.count).toBe(1)
})
