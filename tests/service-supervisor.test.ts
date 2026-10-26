import { expect, test } from 'bun:test'
import { getEventListeners } from 'node:events'
import type { RpcScheduler } from '../packages/contracts/src/rpc.ts'
import type { BinaryStreamWriter, StreamOutcome } from '../packages/contracts/src/streams.ts'
import {
  ServiceSupervisor,
  type ServiceSupervisorOptions,
} from '../packages/runtime/src/service-supervisor.ts'
import {
  TerminalService,
  type TerminalDriverObserver,
  type TerminalDriverProcess,
} from '../packages/runtime/src/terminal.ts'

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason?: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
const flush = async () => {
  for (let i = 0; i < 80; i++) await Promise.resolve()
}
class Clock implements RpcScheduler {
  time = 0
  next = 0
  timers = new Map<number, { at: number; callback: () => void }>()
  now() {
    return this.time
  }
  set(ms: number, callback: () => void) {
    const id = ++this.next
    this.timers.set(id, { at: this.time + ms, callback })
    return id
  }
  clear(id: unknown) {
    this.timers.delete(id as number)
  }
  advance(ms: number) {
    this.time += ms
    for (const [id, t] of Array.from(this.timers))
      if (t.at <= this.time && this.timers.delete(id)) t.callback()
  }
}
class Writer implements BinaryStreamWriter {
  result = deferred<StreamOutcome>()
  finished = this.result.promise
  hold: Promise<void> | undefined
  chunks: Uint8Array[] = []
  async write(bytes: Uint8Array) {
    this.chunks.push(bytes.slice())
    await this.hold
  }
  async end() {
    this.result.resolve({ ok: true })
  }
  cancel() {
    this.result.resolve({ ok: false, code: 'CANCELLED' })
  }
}
class Child implements TerminalDriverProcess {
  inputs: Uint8Array[] = []
  signals: NodeJS.Signals[] = []
  sizes: number[] = []
  writeResult: Promise<number> | undefined
  cooperative = true
  denied = false
  constructor(readonly observer: TerminalDriverObserver) {}
  write(bytes: Uint8Array) {
    this.inputs.push(bytes.slice())
    return this.writeResult ?? bytes.length
  }
  resize(cols: number) {
    this.sizes.push(cols)
  }
  signal(signal: NodeJS.Signals) {
    this.signals.push(signal)
    if (this.denied) throw new Error('denied private detail')
    if (this.cooperative)
      this.observer.processExited({ exitCode: null, signalCode: signal, waitError: false })
  }
  closeTerminal() {
    if (this.cooperative) this.observer.terminalClosed(0)
  }
  exit(code = 7, signal: NodeJS.Signals | null = null) {
    this.observer.processExited({ exitCode: code, signalCode: signal, waitError: false })
    this.observer.terminalClosed(0)
  }
}
const restart = {
  mode: 'on-failure' as const,
  maxAttempts: 4,
  initialBackoffMs: 5,
  maxBackoffMs: 9,
  totalBudgetMs: 100,
}
function fixture(overrides: Partial<ServiceSupervisorOptions> = {}) {
  const clock = new Clock(),
    children: Child[] = [],
    writers: Writer[] = []
  let pending: Promise<TerminalDriverProcess> | undefined
  let early = false
  const service = new TerminalService({
    scheduler: clock,
    limits: { closeTimeoutMs: 10, operationTimeoutMs: 10 },
    driver: {
      spawn(_options, observer) {
        const child = new Child(observer)
        children.push(child)
        if (early) child.exit()
        return pending ?? child
      },
    },
  })
  let disposed = 0
  const supervisor = new ServiceSupervisor({
    service,
    owner: {},
    launch: { executable: process.execPath, cwd: import.meta.dir, spawnTimeoutMs: 10 },
    scheduler: clock,
    startupTimeoutMs: 20,
    restart,
    createOutput() {
      const writer = new Writer()
      writers.push(writer)
      return {
        writer,
        dispose() {
          disposed++
        },
      }
    },
    ...overrides,
  })
  return {
    clock,
    children,
    writers,
    service,
    supervisor,
    get disposed() {
      return disposed
    },
    setPending(value: typeof pending) {
      pending = value
    },
    setEarly() {
      early = true
    },
  }
}
function baseline(f: ReturnType<typeof fixture>) {
  expect(f.service.diagnostics()).toMatchObject({
    terminals: 0,
    sourceStreams: 0,
    pendingDriverWrites: 0,
  })
  expect(f.supervisor.diagnostics()).toMatchObject({
    timer: 0,
    activeGenerations: 0,
    observerCalls: 0,
    queuedSnapshots: 0,
  })
  expect(f.clock.timers.size).toBe(0)
}
test('finite lifetime crash loop caps exponential backoff and never replays input', async () => {
  const f = fixture()
  f.supervisor.start()
  await flush()
  const old = f.supervisor.snapshot.generation!
  await f.supervisor.write(old, new Uint8Array([42]))
  for (let i = 0; i < 4; i++) {
    expect(f.children.length).toBe(i + 1)
    expect(f.supervisor.snapshot.readiness).toBe('driver-attached')
    f.children[i]!.exit()
    await flush()
    if (i < 3) {
      expect(f.supervisor.snapshot).toMatchObject({
        state: 'backoff',
        nextAttemptAt: f.clock.time + (i ? 9 : 5),
        cleanupPending: false,
      })
      expect(f.supervisor.diagnostics().timer).toBe(1)
      f.clock.advance(i ? 9 : 5)
      await flush()
      expect(f.supervisor.snapshot.generation).not.toBe(old)
      expect(() => f.supervisor.resize(old, 80, 24)).toThrow()
      expect(() => f.supervisor.signal(old, 'SIGTERM')).toThrow()
      expect(() => f.supervisor.close(old)).toThrow()
      expect(() => f.supervisor.write(old, new Uint8Array([1]))).toThrow()
      expect(() => f.supervisor.resize({ ...f.supervisor.snapshot.generation! }, 80, 24)).toThrow()
    }
  }
  expect((await f.supervisor.settled).failure).toBe('ATTEMPTS_EXHAUSTED')
  expect(f.children.map((c) => c.inputs.length)).toEqual([1, 0, 0, 0])
  expect(f.disposed).toBe(4)
  baseline(f)
})
test('never is default; zero is success, nonzero and signal preserve exact exit', async () => {
  for (const [code, signal] of [
    [0, null],
    [7, null],
    [null, 'SIGTERM'],
  ] as const) {
    const f = fixture({ restart: { mode: 'never' } })
    f.supervisor.start()
    await flush()
    f.children[0]!.observer.processExited({ exitCode: code, signalCode: signal, waitError: false })
    f.children[0]!.observer.terminalClosed(0)
    await f.supervisor.settled
    expect(f.supervisor.snapshot.exit).toMatchObject({ exitCode: code, signalCode: signal })
    expect(f.supervisor.snapshot.state).toBe(code === 0 ? 'stopped' : 'failed')
    expect(f.children.length).toBe(1)
    baseline(f)
  }
  const f = fixture()
  const noPolicy = new ServiceSupervisor({
    service: f.service,
    owner: {},
    launch: { executable: process.execPath, cwd: import.meta.dir },
    createOutput: () => ({ writer: new Writer(), dispose() {} }),
  })
  noPolicy.start()
  await flush()
  f.children[0]!.exit()
  await noPolicy.settled
  expect(f.children.length).toBe(1)
})
test('total monotonic restart deadline rejects late timer delivery and impossible backoff', async () => {
  for (const budget of [4, 15]) {
    const f = fixture({ restart: { ...restart, totalBudgetMs: budget } })
    f.supervisor.start()
    await flush()
    f.children[0]!.exit()
    await flush()
    f.clock.advance(100)
    await flush()
    expect((await f.supervisor.settled).failure).toBe('RESTART_DEADLINE')
    expect(f.children.length).toBe(1)
    baseline(f)
  }
})
test('readiness handshake success and false/throw failure are explicit', async () => {
  for (const result of ['success', 'false', 'throw'] as const) {
    const ready = deferred<boolean>()
    const f = fixture({ readiness: () => ready.promise })
    f.supervisor.start()
    await flush()
    expect(f.supervisor.snapshot).toMatchObject({ state: 'starting', readiness: 'pending' })
    if (result === 'throw') ready.reject(new Error('private'))
    else ready.resolve(result === 'success')
    await flush()
    expect(f.supervisor.snapshot.readiness).toBe(result === 'success' ? 'handshake' : 'rejected')
    if (result !== 'success')
      expect(f.supervisor.snapshot).toMatchObject({ state: 'backoff', failure: 'READINESS_FAILED' })
    f.supervisor.stop()
    await f.supervisor.settled
    baseline(f)
  }
})
test('timeout and late readiness rejection retain callback ownership until actual settlement', async () => {
  const ready = deferred<boolean>(),
    f = fixture({ readiness: () => ready.promise })
  f.supervisor.start()
  await flush()
  f.clock.advance(20)
  await flush()
  expect(f.supervisor.snapshot).toMatchObject({
    state: 'failed',
    readiness: 'timed-out',
    cleanupPending: true,
  })
  expect(f.service.diagnostics().terminals).toBe(0)
  f.clock.advance(100)
  await flush()
  expect(f.children.length).toBe(1)
  ready.reject(new Error('late'))
  await flush()
  expect((await f.supervisor.settled).failure).toBe('RESTART_DEADLINE')
  baseline(f)
})
test('abort during readiness and backoff fences even a cancelled timer callback', async () => {
  for (const phase of ['ready', 'backoff'] as const) {
    const controller = new AbortController(),
      ready = deferred<boolean>()
    const f = fixture({
      signal: controller.signal,
      ...(phase === 'ready' ? { readiness: () => ready.promise } : {}),
    })
    f.supervisor.start()
    await flush()
    if (phase === 'backoff') {
      f.children[0]!.exit()
      await flush()
    }
    const callbacks = [...f.clock.timers.values()].map((t) => t.callback)
    controller.abort()
    ready.resolve(true)
    await flush()
    f.clock.time = 500
    callbacks.forEach((callback) => callback())
    await flush()
    expect((await f.supervisor.settled).state).toBe('stopped')
    expect(f.children.length).toBe(1)
    baseline(f)
  }
})
test('spawn cancellation retains launch identity until late driver attaches and releases', async () => {
  const pending = deferred<TerminalDriverProcess>(),
    f = fixture()
  f.setPending(pending.promise)
  f.supervisor.start()
  await flush()
  f.supervisor.stop()
  await flush()
  expect(f.supervisor.snapshot.cleanupPending).toBe(true)
  expect(f.service.diagnostics().terminals).toBe(1)
  f.clock.advance(10)
  await flush()
  pending.resolve(f.children[0]!)
  await flush()
  await f.supervisor.settled
  expect(f.children.length).toBe(1)
  expect(f.children[0]!.signals).toContain('SIGKILL')
  baseline(f)
})
test('uncooperative factory and consumer disposal cannot overlap another generation', async () => {
  const factory = deferred<{ writer: Writer; dispose(): void }>(),
    f = fixture({ createOutput: () => factory.promise })
  f.supervisor.start()
  await flush()
  f.clock.advance(20)
  await flush()
  expect(f.supervisor.snapshot.cleanupPending).toBe(true)
  expect(f.children.length).toBe(0)
  let disposed = false
  factory.resolve({
    writer: new Writer(),
    dispose() {
      disposed = true
    },
  })
  await flush()
  expect(disposed).toBe(true)
  expect(f.supervisor.snapshot.state).toBe('backoff')
  f.supervisor.dispose()
  await f.supervisor.settled
  baseline(f)
  const release = deferred<void>(),
    g = fixture({ createOutput: () => ({ writer: new Writer(), dispose: () => release.promise }) })
  g.supervisor.start()
  await flush()
  g.children[0]!.exit()
  await flush()
  g.clock.advance(40)
  expect(g.children.length).toBe(1)
  expect(g.supervisor.snapshot.cleanupPending).toBe(true)
  release.resolve()
  await flush()
  g.supervisor.dispose()
  await g.supervisor.settled
  baseline(g)
})
test('uncooperative output and denied cleanup hold leases and never restart', async () => {
  const f = fixture()
  f.supervisor.start()
  await flush()
  const hold = deferred<void>()
  f.writers[0]!.hold = hold.promise
  f.children[0]!.observer.output(new Uint8Array([1, 2]))
  await flush()
  f.children[0]!.exit()
  await flush()
  expect(f.supervisor.snapshot.cleanupPending).toBe(true)
  expect(f.service.diagnostics().terminals).toBe(1)
  hold.resolve()
  await flush()
  expect(f.supervisor.snapshot.state).toBe('backoff')
  f.supervisor.dispose()
  await f.supervisor.settled
  baseline(f)
  const g = fixture()
  g.supervisor.start()
  await flush()
  g.children[0]!.denied = true
  g.supervisor.stop()
  g.clock.advance(10)
  await flush()
  expect(g.supervisor.snapshot).toMatchObject({
    cleanupPending: true,
    failure: 'CLEANUP_UNOBSERVED',
  })
  expect(g.service.diagnostics().terminals).toBe(1)
  expect(g.children.length).toBe(1)
  g.children[0]!.exit()
  await g.supervisor.settled
  baseline(g)
})
test('overflow and disconnected consumers fail closed without replacement', async () => {
  for (const overflow of [true, false]) {
    const f = fixture()
    f.supervisor.start()
    await flush()
    if (overflow) f.children[0]!.observer.output(new Uint8Array(300_000))
    else f.writers[0]!.cancel()
    await f.supervisor.settled
    expect(f.supervisor.snapshot.failure).toBe('OUTPUT_FAILED')
    expect(f.children.length).toBe(1)
    baseline(f)
  }
})
test('rapid early exits, throwing/reentrant observers and bounded asynchronous delivery', async () => {
  const f = fixture({
    onChange() {
      throw new Error('observer')
    },
  })
  f.setEarly()
  f.supervisor.start()
  await flush()
  expect(f.supervisor.snapshot.state).toBe('backoff')
  expect(f.supervisor.diagnostics().observerFailures).toBeGreaterThan(0)
  f.supervisor.dispose()
  await f.supervisor.settled
  baseline(f)
  let supervisor!: ServiceSupervisor
  const g = fixture({
    onChange(snapshot) {
      if (snapshot.state === 'starting') supervisor.stop()
    },
  })
  supervisor = g.supervisor
  supervisor.start()
  await supervisor.settled
  expect(g.children.length).toBe(0)
  baseline(g)
  const observer = deferred<void>(),
    h = fixture({ onChange: () => observer.promise })
  h.supervisor.start()
  await flush()
  h.children[0]!.exit()
  await flush()
  expect(h.supervisor.diagnostics()).toMatchObject({
    observerCalls: 1,
    queuedSnapshots: 1,
    activeGenerations: 1,
  })
  h.clock.advance(20)
  expect(h.children.length).toBe(1)
  h.supervisor.dispose()
  observer.reject()
  await h.supervisor.settled
  baseline(h)
})
test('configuration callback validation precedes output acquisition', () => {
  const f = fixture()
  let acquired = 0
  for (const field of ['createOutput', 'readiness', 'onChange']) {
    expect(
      () =>
        new ServiceSupervisor({
          service: f.service,
          owner: {},
          launch: { executable: process.execPath, cwd: import.meta.dir },
          createOutput() {
            acquired++
            return { writer: new Writer(), dispose() {} }
          },
          [field]: 1,
        } as unknown as ServiceSupervisorOptions)
    ).toThrow()
  }
  expect(acquired).toBe(0)
  baseline(f)
})

test('late successful readiness is timeout even before delayed timer dispatch', async () => {
  const ready = deferred<boolean>(),
    f = fixture({ readiness: () => ready.promise })
  f.supervisor.start()
  await flush()
  f.clock.time = 20
  ready.resolve(true)
  await flush()
  expect(f.supervisor.snapshot.readiness).toBe('timed-out')
  expect(f.supervisor.snapshot.state).toBe('backoff')
  f.supervisor.dispose()
  await f.supervisor.settled
  baseline(f)
})

test('explicit stop gracefully escalates once at the existing deadline and keeps unknown ownership', async () => {
  const f = fixture()
  f.supervisor.start()
  await flush()
  f.children[0]!.cooperative = false
  f.supervisor.close(f.supervisor.snapshot.generation!)
  await flush()
  expect(f.children[0]!.signals).toEqual(['SIGTERM'])
  f.clock.advance(10)
  await flush()
  expect(f.children[0]!.signals).toEqual(['SIGTERM', 'SIGKILL'])
  expect(f.supervisor.snapshot).toMatchObject({
    state: 'stopping',
    cleanupPending: true,
    failure: 'CLEANUP_UNOBSERVED',
  })
  f.clock.advance(100)
  expect(f.children.length).toBe(1)
  f.children[0]!.exit()
  await f.supervisor.settled
  baseline(f)
})

test('output disposal rejection retains unknown cleanup and cannot release supervisor ownership', async () => {
  const f = fixture({
    createOutput: () => ({
      writer: new Writer(),
      dispose() {
        return Promise.reject(new Error('private'))
      },
    }),
  })
  f.supervisor.start()
  await flush()
  f.children[0]!.exit()
  await flush()
  expect(f.supervisor.snapshot).toMatchObject({
    failure: 'OUTPUT_DISPOSE_FAILED',
    cleanupPending: true,
  })
  expect(f.supervisor.diagnostics()).toMatchObject({ activeGenerations: 1, timer: 0 })
  f.clock.advance(500)
  await flush()
  expect(f.children.length).toBe(1)
  f.supervisor.dispose()
  // No actual OS or test worker remains; the deliberately defective consumer lease stays unknown.
  expect(f.service.diagnostics().terminals).toBe(0)
})

test('factory throw, asynchronous rejection and invalid acquired disposal are contained', async () => {
  for (const createOutput of [
    () => {
      throw new Error('private')
    },
    () => Promise.reject(new Error('private')),
  ]) {
    const f = fixture({ createOutput })
    f.supervisor.start()
    await f.supervisor.settled
    expect(f.supervisor.snapshot.failure).toBe('OUTPUT_FACTORY_FAILED')
    expect(f.children.length).toBe(0)
    baseline(f)
  }
  const f = fixture({ createOutput: () => ({ writer: new Writer() }) as never })
  f.supervisor.start()
  await flush()
  expect(f.supervisor.snapshot).toMatchObject({
    failure: 'OUTPUT_FACTORY_FAILED',
    cleanupPending: true,
  })
  expect(f.children.length).toBe(0)
  f.supervisor.dispose()
})

test('tracked rejected spawn remains observable and cannot authorize a replacement', async () => {
  const pending = deferred<TerminalDriverProcess>(),
    f = fixture()
  f.setPending(pending.promise)
  f.supervisor.start()
  await flush()
  pending.reject()
  await flush()
  expect(f.supervisor.snapshot).toMatchObject({ cleanupPending: true })
  expect(f.supervisor.snapshot.exit?.observed).toBe(false)
  expect(f.service.diagnostics().terminals).toBe(1)
  f.children[0]!.exit()
  await f.supervisor.settled
  expect(f.children.length).toBe(1)
  baseline(f)
})

test('dispose during output creation prevents late launch and removes the owner abort listener', async () => {
  const controller = new AbortController(),
    output = deferred<{ writer: Writer; dispose(): void }>()
  const f = fixture({ signal: controller.signal, createOutput: () => output.promise })
  expect(getEventListeners(controller.signal, 'abort')).toHaveLength(1)
  f.supervisor.start()
  await flush()
  f.supervisor.dispose()
  const writer = new Writer()
  let disposed = false
  output.resolve({
    writer,
    dispose() {
      disposed = true
    },
  })
  await f.supervisor.settled
  expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0)
  controller.abort()
  await flush()
  expect(disposed).toBe(true)
  expect(f.children.length).toBe(0)
  expect(await writer.finished).toEqual({ ok: false, code: 'CANCELLED' })
  baseline(f)
})

test('writer methods and output getters are captured once and a disposed writer cannot be reused', async () => {
  const writer = new Writer()
  let reads = 0
  const f = fixture({
    createOutput: () => ({
      get writer() {
        reads++
        return writer
      },
      dispose() {},
    }),
  })
  f.supervisor.start()
  await flush()
  writer.write = async () => {
    throw new Error('replacement must not execute')
  }
  f.children[0]!.observer.output(new Uint8Array([99]))
  f.children[0]!.exit()
  await flush()
  expect(reads).toBe(1)
  expect(writer.chunks).toEqual([new Uint8Array([99])])
  f.clock.advance(5)
  await f.supervisor.settled
  expect(f.children.length).toBe(1)
  expect(f.supervisor.snapshot.failure).toBe('OUTPUT_FACTORY_FAILED')
  baseline(f)
})

test('on-failure rejects unbounded or inverted policies before acquisition', () => {
  for (const policy of [
    { ...restart, maxAttempts: Infinity },
    { ...restart, maxAttempts: 0 },
    { ...restart, initialBackoffMs: 0 },
    { ...restart, maxBackoffMs: 1 },
    { ...restart, totalBudgetMs: Infinity },
    { ...restart, totalBudgetMs: 0 },
  ])
    expect(() => fixture({ restart: policy })).toThrow('Invalid finite restart policy')
})

test('settled shared terminal service admission failure disposes output without spawning', async () => {
  const f = fixture()
  await f.service.dispose()
  f.supervisor.start()
  await f.supervisor.settled
  expect(f.supervisor.snapshot.failure).toBe('SPAWN_FAILED')
  expect(f.children.length).toBe(0)
  expect(f.disposed).toBe(1)
  baseline(f)
})

test('late driver input settlement holds replacement admission without replaying uncertain input', async () => {
  const f = fixture(),
    pending = deferred<number>()
  f.supervisor.start()
  await flush()
  f.children[0]!.writeResult = pending.promise
  const written = f.supervisor
    .write(f.supervisor.snapshot.generation!, new Uint8Array([8]))
    .catch(() => {})
  f.children[0]!.exit()
  await written
  await flush()
  expect(f.service.diagnostics()).toMatchObject({ terminals: 1, pendingDriverWrites: 1 })
  expect(f.supervisor.snapshot.cleanupPending).toBe(true)
  pending.reject(new Error('late input failure'))
  await flush()
  expect(f.supervisor.snapshot.state).toBe('backoff')
  f.clock.advance(5)
  await flush()
  expect(f.children[1]!.inputs).toEqual([])
  f.supervisor.stop()
  await f.supervisor.settled
  baseline(f)
})
