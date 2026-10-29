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

test('a rejected native promise with a throwing constructor getter cannot be observed intrinsically', async () => {
  const module = new URL('../packages/runtime/src/mock.ts', import.meta.url).href
  const script = `
    import { MockBackend } from ${JSON.stringify(module)}
    const failures = []
    process.on('unhandledRejection', error => failures.push(error.message))
    const backend = new MockBackend()
    const promise = Promise.reject(new Error('original rejection'))
    Object.defineProperty(promise, 'constructor', { get() { throw new Error('constructor failure') } })
    backend.onEvent(() => promise)
    await backend.createSession({ persistence: 'ephemeral', partition: 'probe' })
    await Bun.sleep(20)
    console.log(JSON.stringify({ errors: backend.diagnostics().listenerErrors, failures }))
  `
  const child = Bun.spawn([process.execPath, '-e', script], { stdout: 'pipe', stderr: 'pipe' })
  const output = await new Response(child.stdout).text()
  const stderr = await new Response(child.stderr).text()
  expect(await child.exited).toBe(0)
  expect(stderr).toBe('')
  expect(JSON.parse(output)).toEqual({ errors: 1, failures: ['original rejection'] })
})

test('a failing species lookup does not leave a phantom pending observation', () => {
  const counter = { count: 0 }
  const observer = new ListenerResultObserver(counter)
  const promise = new Promise<void>(() => {})
  const poisoned = new Proxy(Promise, {
    get(target, property, receiver) {
      if (property === Symbol.species) throw new Error('species failure')
      return Reflect.get(target, property, receiver)
    },
  })
  // Promise.resolve returns the input only when its constructor is Promise.
  // Poison species on Promise only around this synchronous probe, and restore it.
  const original = Object.getOwnPropertyDescriptor(Promise, Symbol.species)!
  try {
    Object.defineProperty(Promise, Symbol.species, {
      configurable: true,
      get: () => poisoned[Symbol.species],
    })
    expect(() => observer.observe(promise)).toThrow('species failure')
    expect(() => observer.observe(promise)).toThrow('species failure')
    expect(counter.count).toBe(0)
  } finally {
    Object.defineProperty(Promise, Symbol.species, original)
  }
})
