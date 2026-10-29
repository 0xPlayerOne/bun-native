import { expect, test } from 'bun:test'
import type { RpcScheduler } from '../packages/contracts/src/rpc.ts'
import type { BinaryStreamWriter, StreamOutcome } from '../packages/contracts/src/streams.ts'
import {
  TerminalService,
  type TerminalDriver,
  type TerminalDriverObserver,
  type TerminalDriverProcess,
  type TerminalDriverSpawnOptions,
  type TerminalHandle,
} from '../packages/runtime/src/terminal.ts'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

const flush = async () => {
  for (let index = 0; index < 12; index++) await Promise.resolve()
}

class Clock implements RpcScheduler {
  time = 0
  next = 0
  timers = new Map<number, { at: number; callback: () => void }>()
  now() {
    return this.time
  }
  set(delayMs: number, callback: () => void) {
    const id = ++this.next
    this.timers.set(id, { at: this.time + delayMs, callback })
    return id
  }
  clear(timer: unknown) {
    this.timers.delete(timer as number)
  }
  advance(ms: number) {
    this.time += ms
    this.runDue()
  }
  elapse(ms: number) {
    this.time += ms
  }
  runDue() {
    for (const [id, timer] of Array.from(this.timers))
      if (timer.at <= this.time && this.timers.delete(id)) timer.callback()
  }
}

class Writer implements BinaryStreamWriter {
  readonly outcome = deferred<StreamOutcome>()
  readonly finished = this.outcome.promise
  readonly writes: Uint8Array[] = []
  hold: ReturnType<typeof deferred<void>> | undefined
  ended = 0
  cancelled = 0
  async write(bytes: Uint8Array) {
    this.writes.push(bytes.slice())
    await this.hold?.promise
  }
  async end() {
    this.ended++
    this.outcome.resolve({ ok: true })
  }
  cancel() {
    this.cancelled++
    this.outcome.resolve({ ok: false, code: 'CANCELLED' })
  }
}

class FakeProcess implements TerminalDriverProcess {
  readonly signals: NodeJS.Signals[] = []
  readonly sizes: Array<[number, number]> = []
  readonly inputs: Uint8Array[] = []
  closes = 0
  autoStop = true
  throwStop = false
  emitTerminalClose = true
  writeImpl: ((bytes: Uint8Array) => number | Promise<number>) | undefined
  writeResult: number | Promise<number> | undefined
  constructor(readonly observer: TerminalDriverObserver) {}
  write(bytes: Uint8Array): number | Promise<number> {
    if (this.writeImpl) return this.writeImpl(bytes)
    this.inputs.push(bytes.slice())
    return this.writeResult ?? bytes.byteLength
  }
  resize(cols: number, rows: number) {
    this.sizes.push([cols, rows])
  }
  signal(signal: NodeJS.Signals) {
    this.signals.push(signal)
    if (this.throwStop) throw new Error('private signal failure')
    if (this.autoStop)
      this.observer.processExited({ exitCode: null, signalCode: signal, waitError: false })
  }
  closeTerminal() {
    this.closes++
    if (this.throwStop) throw new Error('private close failure')
    if (this.autoStop && this.emitTerminalClose) this.observer.terminalClosed(0)
  }
}

class FakeDriver implements TerminalDriver {
  readonly processes: FakeProcess[] = []
  readonly options: TerminalDriverSpawnOptions[] = []
  beforeReturn: ((observer: TerminalDriverObserver, process: FakeProcess) => void) | undefined
  pending: ReturnType<typeof deferred<TerminalDriverProcess>> | undefined
  spawn(options: TerminalDriverSpawnOptions, observer: TerminalDriverObserver) {
    this.options.push(options)
    const process = new FakeProcess(observer)
    this.processes.push(process)
    this.beforeReturn?.(observer, process)
    return this.pending?.promise ?? process
  }
}

for (const failure of ['now', 'set'] as const)
  test(`terminal close does not strand ownership if scheduler ${failure} throws`, async () => {
    const clock = new Clock()
    const driver = new FakeDriver()
    const service = new TerminalService({ driver, scheduler: clock })
    const handle = await service.create({}, new Writer(), valid())
    const observation = service.observe(handle)
    let processSettled = false,
      terminalSettled = false
    void observation.processExited.then(() => {
      processSettled = true
    })
    void observation.terminalClosed.then(() => {
      terminalSettled = true
    })
    const process = driver.processes[0]!
    process.autoStop = false
    const set = clock.set.bind(clock)
    const now = clock.now.bind(clock)
    if (failure === 'set')
      clock.set = () => {
        throw new Error('scheduler failed')
      }
    else
      clock.now = () => {
        throw new Error('scheduler failed')
      }
    const result = await service.close(handle)
    expect(process.signals).toEqual(['SIGKILL'])
    expect(result).toMatchObject({ processExited: false, terminalClosed: false, released: false })
    expect(service.diagnostics().terminals).toBe(1)
    await flush()
    expect(processSettled).toBe(false)
    expect(terminalSettled).toBe(false)
    clock.set = set
    clock.now = now
    process.observer.processExited({ exitCode: null, signalCode: 'SIGKILL', waitError: false })
    process.observer.terminalClosed(0)
    await observation.released
    expect(service.diagnostics().terminals).toBe(0)
    expect(clock.timers.size).toBe(0)
  })

const valid = (change: Record<string, unknown> = {}) => ({
  executable: process.execPath,
  cwd: import.meta.dir,
  ...change,
})

test('disposal attempts every terminal if scheduler setup fails', async () => {
  const clock = new Clock()
  const driver = new FakeDriver()
  const service = new TerminalService({ driver, scheduler: clock })
  const handles = [
    await service.create({}, new Writer(), valid()),
    await service.create({}, new Writer(), valid()),
  ]
  const observations = handles.map((handle) => service.observe(handle))
  for (const process of driver.processes) process.autoStop = false
  const set = clock.set.bind(clock)
  clock.set = () => {
    throw new Error('scheduler failed')
  }
  const outcomes = await service.dispose()
  expect(outcomes).toHaveLength(2)
  expect(outcomes.every((outcome) => !outcome.released && !outcome.processExited)).toBe(true)
  expect(driver.processes.map((process) => process.signals)).toEqual([['SIGKILL'], ['SIGKILL']])
  expect(service.diagnostics().terminals).toBe(2)
  clock.set = set
  for (const process of driver.processes) {
    process.observer.processExited({ exitCode: null, signalCode: 'SIGKILL', waitError: false })
    process.observer.terminalClosed(0)
  }
  await Promise.all(observations.map((observation) => observation.released))
  expect(service.diagnostics().terminals).toBe(0)
  expect(clock.timers.size).toBe(0)
})

test('admission establishes opaque ownership before touching the writer or driver', async () => {
  const driver = new FakeDriver()
  const owner = {}
  const service = new TerminalService({
    driver,
    limits: { maxTerminals: 1, maxTerminalsPerOwner: 1 },
  })
  const result = deferred<StreamOutcome>()
  let countAtWriterAccess = 0
  const writer = {
    write: async () => {},
    end: async () => result.resolve({ ok: true }),
    cancel: () => result.resolve({ ok: false, code: 'CANCELLED' }),
    get finished() {
      countAtWriterAccess = service.diagnostics(owner).terminals
      return result.promise
    },
  }
  const handle = await service.create(owner, writer, valid())
  expect(countAtWriterAccess).toBe(1)
  expect(Object.isFrozen(handle)).toBe(true)
  // Windows needs its explicitly documented SystemRoot fallback. No other
  // ambient variable is admitted; equality remains exact on every platform.
  expect(driver.options[0]?.env).toEqual({
    TERM: 'xterm-256color',
    ...(process.platform === 'win32' && process.env['SystemRoot']
      ? { SystemRoot: process.env['SystemRoot'] }
      : {}),
  })
  expect(driver.options[0]?.executable).toBe(process.execPath)
  await expect(service.create(owner, new Writer(), valid())).rejects.toMatchObject({
    code: 'OVERLOADED',
  })
  expect(() => service.signal({ ...handle } as TerminalHandle, 'SIGTERM')).toThrow(
    expect.objectContaining({ code: 'INVALID_HANDLE' })
  )
  await service.cancel(handle)
  await service.observe(handle).released
  expect(service.diagnostics()).toMatchObject({ terminals: 0, sourceStreams: 0 })
})

test('global and per-owner terminal count and output reservations are shared', async () => {
  const driver = new FakeDriver()
  const service = new TerminalService({
    driver,
    limits: {
      maxTerminals: 2,
      maxTerminalsPerOwner: 1,
      maxOutputBytes: 32 * 1024,
      maxOutputBytesPerOwner: 16 * 1024,
      maxOutputBytesPerTerminal: 16 * 1024,
    },
  })
  const firstOwner = {},
    secondOwner = {}
  const first = await service.create(firstOwner, new Writer(), valid({ maxOutputBytes: 16 * 1024 }))
  await expect(
    service.create(firstOwner, new Writer(), valid({ maxOutputBytes: 16 * 1024 }))
  ).rejects.toMatchObject({ code: 'OVERLOADED' })
  const second = await service.create(
    secondOwner,
    new Writer(),
    valid({ maxOutputBytes: 16 * 1024 })
  )
  await expect(
    service.create({}, new Writer(), valid({ maxOutputBytes: 16 * 1024 }))
  ).rejects.toMatchObject({ code: 'OVERLOADED' })
  expect(service.diagnostics()).toMatchObject({ terminals: 2, reservedOutputBytes: 32 * 1024 })
  expect(service.diagnostics(firstOwner)).toMatchObject({
    terminals: 1,
    reservedOutputBytes: 16 * 1024,
  })
  await Promise.all([service.cancel(first), service.cancel(second)])
  expect(service.diagnostics()).toMatchObject({ terminals: 0, sourceStreams: 0 })
})

test('early binary output, nonzero exit, PTY status and acknowledged drain stay independent', async () => {
  const driver = new FakeDriver()
  const writer = new Writer()
  writer.hold = deferred<void>()
  const first = new Uint8Array([0xf0, 0x9f])
  const second = new Uint8Array([0x90, 0x99, 0xff])
  driver.beforeReturn = (observer) => {
    observer.output(first)
    observer.output(second)
    observer.processExited({ exitCode: 7, signalCode: null, waitError: false })
    observer.terminalClosed(1)
  }
  const service = new TerminalService({ driver })
  const handle = await service.create({}, writer, valid())
  const observed = service.observe(handle)
  expect(await observed.processExited).toEqual({
    started: true,
    observed: true,
    exitCode: 7,
    signalCode: null,
    waitError: false,
    failure: null,
  })
  expect(await observed.terminalClosed).toEqual({
    started: true,
    observed: true,
    status: 1,
    failure: null,
  })
  await flush()
  // Callback boundaries are not terminal record boundaries. Both early fragments
  // may occupy one unsent block, but no byte is acknowledged before settlement.
  expect(writer.writes).toEqual([new Uint8Array([...first, ...second])])
  expect(service.diagnostics().reservedOutputBytes).toBeGreaterThan(0)
  writer.hold.resolve()
  expect(await observed.outputFinished).toEqual({ ok: true })
  await observed.released
  expect(writer.writes).toEqual([new Uint8Array([...first, ...second])])
  expect(service.diagnostics()).toMatchObject({ terminals: 0, sourceStreams: 0 })
})

test('output overload and peer disconnect stop only the exact owned producer', async () => {
  const driver = new FakeDriver()
  const service = new TerminalService({ driver })
  const firstWriter = new Writer()
  const first = await service.create({}, firstWriter, valid({ maxQueuedOutputChunks: 1 }))
  const firstProcess = driver.processes[0]!
  // Fill the single admitted chunk; one further byte requires a second slot.
  firstProcess.observer.output(new Uint8Array(16 * 1024))
  firstProcess.observer.output(new Uint8Array([2]))
  expect(await service.observe(first).outputFinished).toEqual({ ok: false, code: 'OVERLOADED' })
  expect(firstProcess.signals).toEqual(['SIGKILL'])
  await service.observe(first).released

  const secondWriter = new Writer()
  const second = await service.create({}, secondWriter, valid())
  const secondProcess = driver.processes[1]!
  secondWriter.cancel()
  expect(await service.observe(second).outputFinished).toEqual({ ok: false, code: 'CANCELLED' })
  await service.observe(second).released
  expect(secondProcess.signals).toEqual(['SIGKILL'])
  expect(firstProcess.signals).toHaveLength(1)
})

test('partial input and cancellation during an active write are explicit fail-stop outcomes', async () => {
  const driver = new FakeDriver()
  const service = new TerminalService({ driver })
  const partial = await service.create({}, new Writer(), valid())
  driver.processes[0]!.writeResult = 2
  await expect(service.write(partial, new Uint8Array([1, 2, 3]))).rejects.toMatchObject({
    code: 'IO_FAILED',
  })
  await service.observe(partial).released

  const active = await service.create({}, new Writer(), valid())
  const held = deferred<number>()
  driver.processes[1]!.writeResult = held.promise
  const controller = new AbortController()
  const writing = service.write(active, new Uint8Array([4]), { signal: controller.signal })
  controller.abort()
  await expect(writing).rejects.toMatchObject({ code: 'CANCELLED' })
  held.resolve(1)
  await service.observe(active).released
  expect(driver.processes[1]!.signals).toEqual(['SIGKILL'])
})

test('input admission uses intrinsic byte slots, an exact owned ArrayBuffer and exact offset', async () => {
  const driver = new FakeDriver()
  const service = new TerminalService({ driver, limits: { maxInputBytes: 4 } })
  const handle = await service.create({}, new Writer(), valid())

  const oversized = new Uint8Array(8)
  Object.defineProperties(oversized, {
    byteLength: { value: 1 },
    buffer: { value: new ArrayBuffer(1) },
    slice: { value: () => new Uint8Array([99]) },
  })
  await expect(service.write(handle, oversized)).rejects.toMatchObject({
    code: 'INVALID_ARGUMENT',
  })

  const buffer = new ArrayBuffer(6)
  new Uint8Array(buffer).set([10, 11, 12, 13, 14, 15])
  const offset = new Uint8Array(buffer, 2, 3)
  Object.defineProperties(offset, {
    byteLength: { value: 1 },
    buffer: { value: new ArrayBuffer(1) },
    slice: { value: () => new Uint8Array([99]) },
  })
  await service.write(handle, offset)
  expect(driver.processes[0]!.inputs).toEqual([new Uint8Array([12, 13, 14])])

  const detachedBuffer = new ArrayBuffer(2)
  const detached = new Uint8Array(detachedBuffer)
  structuredClone(detachedBuffer, { transfer: [detachedBuffer] })
  const prototypeOnly = Object.create(Uint8Array.prototype) as Uint8Array
  const proxied = new Proxy(new Uint8Array([1]), {})
  for (const invalid of [detached, prototypeOnly, proxied])
    await expect(service.write(handle, invalid)).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    })

  const shared = new SharedArrayBuffer(2)
  const sharedPrototype = Object.getPrototypeOf(shared)
  Object.setPrototypeOf(shared, ArrayBuffer.prototype)
  try {
    await expect(service.write(handle, new Uint8Array(shared))).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    })
  } finally {
    Object.setPrototypeOf(shared, sharedPrototype)
  }

  await service.cancel(handle)
})

test('detaching driver bytes cannot change admitted input accounting', async () => {
  const driver = new FakeDriver()
  const service = new TerminalService({ driver })
  const handle = await service.create({}, new Writer(), valid())
  driver.processes[0]!.writeImpl = (bytes) => {
    structuredClone(bytes.buffer, { transfer: [bytes.buffer] })
    return 0
  }
  await expect(service.write(handle, new Uint8Array([1, 2, 3]))).rejects.toMatchObject({
    code: 'IO_FAILED',
  })
  expect(driver.processes[0]!.signals).toEqual(['SIGKILL'])
  await service.observe(handle).released
})

test('delayed timer execution cannot admit completion or abort after the absolute deadline', async () => {
  const completionClock = new Clock()
  const completionDriver = new FakeDriver()
  const completionService = new TerminalService({
    driver: completionDriver,
    scheduler: completionClock,
  })
  const completionHandle = await completionService.create({}, new Writer(), valid())
  const completion = deferred<number>()
  completionDriver.processes[0]!.writeResult = completion.promise
  const writing = completionService.write(completionHandle, new Uint8Array([1]), {
    timeoutMs: 5,
  })
  completionClock.elapse(5)
  completion.resolve(1)
  await expect(writing).rejects.toMatchObject({ code: 'DEADLINE_EXCEEDED' })
  await completionService.observe(completionHandle).released

  const abortClock = new Clock()
  const abortDriver = new FakeDriver()
  const abortService = new TerminalService({ driver: abortDriver, scheduler: abortClock })
  const controller = new AbortController()
  const abortHandle = await abortService.create({}, new Writer(), valid())
  const held = deferred<number>()
  abortDriver.processes[0]!.writeResult = held.promise
  const aborting = abortService.write(abortHandle, new Uint8Array([1]), {
    signal: controller.signal,
    timeoutMs: 5,
  })
  abortClock.elapse(5)
  controller.abort()
  await expect(aborting).rejects.toMatchObject({ code: 'DEADLINE_EXCEEDED' })
  held.resolve(1)
  await abortService.observe(abortHandle).released
})

test('async input rejection fails stop the exact terminal', async () => {
  const driver = new FakeDriver()
  const service = new TerminalService({ driver })
  const first = await service.create({}, new Writer(), valid())
  const second = await service.create({}, new Writer(), valid())
  driver.processes[0]!.writeResult = Promise.reject(new Error('private write failure'))
  await expect(service.write(first, new Uint8Array([1]))).rejects.toMatchObject({
    code: 'IO_FAILED',
  })
  await service.observe(first).released
  expect(driver.processes[0]!.signals).toEqual(['SIGKILL'])
  expect(driver.processes[1]!.signals).toEqual([])
  await service.cancel(second)
})

test('input option validation cannot reenter and write a retired terminal', async () => {
  const driver = new FakeDriver()
  const service = new TerminalService({ driver })
  const handle = await service.create({}, new Writer(), valid())
  const options = Object.defineProperty({}, 'timeoutMs', {
    get() {
      void service.cancel(handle)
      return 5
    },
  })
  await expect(
    service.write(handle, new Uint8Array([1]), options as { readonly timeoutMs: number })
  ).rejects.toMatchObject({ code: 'DISPOSED' })
  expect(driver.processes[0]!.inputs).toEqual([])
  await service.observe(handle).released
})

test('spawn cancellation attaches late only to stop the owned process and release capacity', async () => {
  const clock = new Clock()
  const driver = new FakeDriver()
  driver.pending = deferred<TerminalDriverProcess>()
  const service = new TerminalService({ driver, scheduler: clock })
  const controller = new AbortController()
  const creating = service.create({}, new Writer(), valid({ signal: controller.signal }))
  await flush()
  controller.abort()
  await expect(creating).rejects.toMatchObject({ code: 'CANCELLED' })
  expect(service.diagnostics()).toMatchObject({ terminals: 1, closing: 1 })
  driver.pending.resolve(driver.processes[0]!)
  await flush()
  expect(driver.processes[0]!.signals).toEqual(['SIGKILL'])
  expect(service.diagnostics()).toMatchObject({ terminals: 0, sourceStreams: 0 })
})

test('create signal remains a lifetime revocation and setup reentrancy cannot spawn live work', async () => {
  const lifetimeDriver = new FakeDriver()
  const lifetimeService = new TerminalService({ driver: lifetimeDriver })
  const lifetime = new AbortController()
  const handle = await lifetimeService.create({}, new Writer(), valid({ signal: lifetime.signal }))
  lifetime.abort()
  await lifetimeService.observe(handle).released
  expect(lifetimeDriver.processes[0]!.signals).toEqual(['SIGKILL'])

  const validationDriver = new FakeDriver()
  const validationService = new TerminalService({ driver: validationDriver })
  const reentrantOptions = valid()
  Object.defineProperty(reentrantOptions, 'executable', {
    get() {
      void validationService.dispose()
      return process.execPath
    },
  })
  await expect(validationService.create({}, new Writer(), reentrantOptions)).rejects.toMatchObject({
    code: 'DISPOSED',
  })
  expect(validationDriver.processes).toHaveLength(0)

  const setupDriver = new FakeDriver()
  const setupService = new TerminalService({ driver: setupDriver })
  const setupAbort = new AbortController()
  const setupOutcome = deferred<StreamOutcome>()
  const reentrantWriter = {
    write: async () => {},
    end: async () => setupOutcome.resolve({ ok: true }),
    cancel: () => setupOutcome.resolve({ ok: false, code: 'CANCELLED' }),
    get finished() {
      setupAbort.abort()
      return setupOutcome.promise
    },
  }
  await expect(
    setupService.create({}, reentrantWriter, valid({ signal: setupAbort.signal }))
  ).rejects.toMatchObject({ code: 'CANCELLED' })
  expect(setupDriver.processes).toHaveLength(0)
  expect(setupService.diagnostics()).toMatchObject({ terminals: 0, sourceStreams: 0 })
})

test('lifetime revocation while attaching a driver retains then stops exact ownership', async () => {
  const driver = new FakeDriver()
  driver.pending = deferred<TerminalDriverProcess>()
  const service = new TerminalService({ driver })
  const controller = new AbortController()
  const creating = service.create({}, new Writer(), valid({ signal: controller.signal }))
  await flush()
  controller.abort()
  await expect(creating).rejects.toMatchObject({ code: 'CANCELLED' })
  expect(service.diagnostics()).toMatchObject({ terminals: 1, closing: 1 })
  driver.pending.resolve(driver.processes[0]!)
  await flush()
  expect(driver.processes[0]!.signals).toEqual(['SIGKILL'])
  expect(service.diagnostics()).toMatchObject({ terminals: 0, sourceStreams: 0 })
})

test('spawn and input deadlines settle callers but retain uncooperative driver ownership', async () => {
  const spawnClock = new Clock()
  const spawnDriver = new FakeDriver()
  spawnDriver.pending = deferred<TerminalDriverProcess>()
  const spawnService = new TerminalService({ driver: spawnDriver, scheduler: spawnClock })
  const creating = spawnService.create({}, new Writer(), valid({ spawnTimeoutMs: 5 }))
  await flush()
  spawnClock.advance(5)
  await expect(creating).rejects.toMatchObject({ code: 'DEADLINE_EXCEEDED' })
  expect(spawnService.diagnostics()).toMatchObject({ terminals: 1, closing: 1 })
  spawnDriver.pending.resolve(spawnDriver.processes[0]!)
  await flush()
  expect(spawnService.diagnostics()).toMatchObject({ terminals: 0, sourceStreams: 0 })

  const inputClock = new Clock()
  const inputDriver = new FakeDriver()
  const inputService = new TerminalService({ driver: inputDriver, scheduler: inputClock })
  const inputHandle = await inputService.create({}, new Writer(), valid())
  const held = deferred<number>()
  inputDriver.processes[0]!.writeResult = held.promise
  const writing = inputService.write(inputHandle, new Uint8Array([1]), { timeoutMs: 5 })
  inputClock.advance(5)
  await expect(writing).rejects.toMatchObject({ code: 'DEADLINE_EXCEEDED' })
  expect(inputService.diagnostics()).toMatchObject({ terminals: 1, sourceStreams: 0 })
  held.resolve(1)
  await inputService.observe(inputHandle).released
  expect(inputService.diagnostics()).toMatchObject({ terminals: 0, sourceStreams: 0 })
})

test('uncooperative consumers retain ownership after the finite close deadline', async () => {
  const clock = new Clock()
  const driver = new FakeDriver()
  const writer = new Writer()
  writer.hold = deferred<void>()
  const service = new TerminalService({ driver, scheduler: clock })
  const handle = await service.create({}, writer, valid())
  driver.processes[0]!.observer.output(new Uint8Array([1]))
  await flush()
  const closing = service.cancel(handle, 10)
  clock.advance(10)
  expect(await closing).toEqual({
    processExited: true,
    terminalClosed: true,
    outputDrained: false,
    released: false,
  })
  expect(service.diagnostics()).toMatchObject({ terminals: 1, sourceStreams: 1, closing: 1 })
  writer.hold.resolve()
  await service.observe(handle).released
  expect(service.diagnostics()).toMatchObject({ terminals: 0, sourceStreams: 0 })
})

test('close and cancel coalesce, cancel escalates, and dispose returns one observation', async () => {
  const clock = new Clock()
  const driver = new FakeDriver()
  driver.beforeReturn = (_observer, process) => {
    process.autoStop = false
  }
  const service = new TerminalService({ driver, scheduler: clock })
  const handle = await service.create({}, new Writer(), valid())
  const graceful = service.close(handle, 5)
  const repeated = service.close(handle, 5)
  const escalated = service.cancel(handle, 5)
  expect(repeated).toBe(graceful)
  expect(escalated).toBe(graceful)
  expect(clock.timers.size).toBe(1)
  expect(driver.processes[0]!.signals).toEqual(['SIGTERM', 'SIGKILL'])
  expect(driver.processes[0]!.closes).toBe(0)
  clock.advance(5)
  expect((await graceful).released).toBe(false)
  expect(service.cancel(handle)).toBe(graceful)
  expect(clock.timers.size).toBe(0)

  const disposalClock = new Clock()
  const disposalDriver = new FakeDriver()
  disposalDriver.beforeReturn = (_observer, process) => {
    process.autoStop = false
  }
  const disposalService = new TerminalService({ driver: disposalDriver, scheduler: disposalClock })
  await disposalService.create({}, new Writer(), valid())
  const first = disposalService.dispose()
  const second = disposalService.dispose()
  expect(second).toBe(first)
  expect(disposalClock.timers.size).toBe(1)
  disposalClock.advance(5_000)
  expect(await first).toEqual(await second)
  expect((await first)[0]?.released).toBe(false)
})

test('partial process and PTY lifecycle states have finite failed observations without release', async () => {
  const processClock = new Clock()
  const processDriver = new FakeDriver()
  processDriver.beforeReturn = (_observer, process) => {
    process.autoStop = false
    process.emitTerminalClose = false
  }
  const processService = new TerminalService({
    driver: processDriver,
    scheduler: processClock,
    limits: { closeTimeoutMs: 5 },
  })
  const processHandle = await processService.create({}, new Writer(), valid())
  const processObservation = processService.observe(processHandle)
  processDriver.processes[0]!.observer.processExited({
    exitCode: 0,
    signalCode: null,
    waitError: false,
  })
  expect(processDriver.processes[0]!.closes).toBe(0)
  processClock.advance(5)
  expect(processDriver.processes[0]!.closes).toBe(1)
  expect(await processObservation.terminalClosed).toMatchObject({
    observed: false,
    failure: 'DEADLINE_EXCEEDED',
  })
  expect(await processObservation.outputFinished).toEqual({ ok: false, code: 'CANCELLED' })
  expect(processService.diagnostics()).toMatchObject({ terminals: 1, closing: 1 })

  const terminalClock = new Clock()
  const terminalDriver = new FakeDriver()
  terminalDriver.beforeReturn = (_observer, process) => {
    process.autoStop = false
  }
  const terminalService = new TerminalService({
    driver: terminalDriver,
    scheduler: terminalClock,
    limits: { closeTimeoutMs: 5 },
  })
  const terminalHandle = await terminalService.create({}, new Writer(), valid())
  const terminalObservation = terminalService.observe(terminalHandle)
  terminalDriver.processes[0]!.observer.terminalClosed(0)
  terminalClock.advance(5)
  expect(terminalDriver.processes[0]!.signals).toEqual(['SIGKILL'])
  expect(await terminalObservation.processExited).toMatchObject({
    observed: false,
    failure: 'DEADLINE_EXCEEDED',
  })
  expect(terminalService.diagnostics()).toMatchObject({ terminals: 1, closing: 1 })
})

test('terminal close waits for actual process exit and is skipped when termination fails', async () => {
  const clock = new Clock()
  const driver = new FakeDriver()
  driver.beforeReturn = (_observer, process) => {
    process.autoStop = false
  }
  const service = new TerminalService({ driver, scheduler: clock })
  const handle = await service.create({}, new Writer(), valid())
  const closing = service.close(handle, 10)
  expect(driver.processes[0]!.signals).toEqual(['SIGTERM'])
  expect(driver.processes[0]!.closes).toBe(0)
  driver.processes[0]!.observer.processExited({
    exitCode: null,
    signalCode: 'SIGTERM',
    waitError: false,
  })
  expect(driver.processes[0]!.closes).toBe(1)
  driver.processes[0]!.observer.terminalClosed(0)
  expect((await closing).released).toBe(true)

  const failedClock = new Clock()
  const failedDriver = new FakeDriver()
  failedDriver.beforeReturn = (_observer, process) => {
    process.autoStop = false
    process.throwStop = true
  }
  const failedService = new TerminalService({ driver: failedDriver, scheduler: failedClock })
  const failedHandle = await failedService.create({}, new Writer(), valid())
  const failedClose = failedService.close(failedHandle, 5)
  expect(failedDriver.processes[0]!.closes).toBe(0)
  failedClock.advance(5)
  expect((await failedClose).released).toBe(false)
  expect(failedDriver.processes[0]!.closes).toBe(0)
  expect(failedService.diagnostics()).toMatchObject({ terminals: 1, driverFailures: 1 })
})

test('early lifecycle callbacks cannot release before async driver attachment', async () => {
  const driver = new FakeDriver()
  driver.pending = deferred<TerminalDriverProcess>()
  driver.beforeReturn = (observer) => {
    observer.processExited({ exitCode: 0, signalCode: null, waitError: false })
    observer.terminalClosed(0)
  }
  const service = new TerminalService({ driver })
  const creating = service.create({}, new Writer(), valid())
  await flush()
  expect(service.diagnostics()).toMatchObject({ terminals: 1, closing: 1 })
  driver.pending.resolve(driver.processes[0]!)
  const handle = await creating
  await service.observe(handle).released
  expect(service.diagnostics()).toMatchObject({ terminals: 0, live: 0 })
})

test('spawn rejection and invalid driver retain reservations when closure is unknown', async () => {
  const rejectedDriver = new FakeDriver()
  rejectedDriver.pending = deferred<TerminalDriverProcess>()
  const rejectedService = new TerminalService({ driver: rejectedDriver })
  const rejected = rejectedService.create({}, new Writer(), valid())
  rejectedDriver.pending.reject(new Error('spawn rejected after possible ownership'))
  await expect(rejected).rejects.toMatchObject({ code: 'SPAWN_FAILED' })
  expect(rejectedService.diagnostics()).toMatchObject({ terminals: 1, closing: 1 })

  let signals = 0
  let closes = 0
  const invalidDriver: TerminalDriver = {
    spawn: () =>
      ({
        write: 1,
        resize() {},
        signal() {
          signals++
        },
        closeTerminal() {
          closes++
        },
      }) as unknown as TerminalDriverProcess,
  }
  const invalidService = new TerminalService({ driver: invalidDriver })
  await expect(invalidService.create({}, new Writer(), valid())).rejects.toMatchObject({
    code: 'SPAWN_FAILED',
  })
  expect(signals).toBe(1)
  expect(closes).toBe(0)
  expect(invalidService.diagnostics()).toMatchObject({ terminals: 1, closing: 1 })
})

test('validation, rapid resize, signals, stale handles and throwing stops fail closed', async () => {
  const driver = new FakeDriver()
  const service = new TerminalService({ driver })
  for (const options of [
    valid({ executable: 'relative' }),
    valid({ cwd: 'relative' }),
    valid({ argv: ['a'.repeat(65 * 1024)] }),
    valid({ env: { 'bad-key': 'x' } }),
    valid({ env: { SAFE: 'x\0y' } }),
    valid({ cols: 0 }),
    valid({ rows: 1001 }),
  ])
    await expect(service.create({}, new Writer(), options)).rejects.toMatchObject({
      code: 'INVALID_ARGUMENT',
    })
  expect(driver.processes).toHaveLength(0)

  const handle = await service.create({}, new Writer(), valid({ env: { SAFE: 'yes' } }))
  service.resize(handle, 80, 24)
  service.resize(handle, 140, 50)
  service.signal(handle, 'SIGWINCH')
  expect(driver.processes[0]!.sizes).toEqual([
    [80, 24],
    [140, 50],
  ])
  expect(driver.processes[0]!.signals).toEqual(['SIGWINCH'])
  driver.processes[0]!.autoStop = false
  driver.processes[0]!.throwStop = true
  const clock = new Clock()
  const failedDriver = new FakeDriver()
  failedDriver.beforeReturn = (_observer, process) => {
    process.autoStop = false
    process.throwStop = true
  }
  const failedService = new TerminalService({ driver: failedDriver, scheduler: clock })
  const failed = await failedService.create({}, new Writer(), valid())
  const closing = failedService.cancel(failed, 5)
  clock.advance(5)
  expect((await closing).released).toBe(false)
  expect(failedService.diagnostics()).toMatchObject({ driverFailures: 1, terminals: 1 })

  driver.processes[0]!.throwStop = false
  driver.processes[0]!.autoStop = true
  await service.cancel(handle)
  expect(() => service.resize(handle, 90, 30)).toThrow(
    expect.objectContaining({ code: 'DISPOSED' })
  )
})

test('natural process exit retains PTY output until actual closure rather than discarding the tail', async () => {
  const clock = new Clock()
  const driver = new FakeDriver()
  const service = new TerminalService({ driver, scheduler: clock, limits: { closeTimeoutMs: 10 } })
  const writer = new Writer()
  const handle = await service.create({}, writer, valid())
  const observation = service.observe(handle)
  const process = driver.processes[0]!
  process.observer.output(new Uint8Array([1, 2]))
  process.observer.processExited({ exitCode: 7, signalCode: null, waitError: false })
  expect(process.closes).toBe(0)
  process.observer.output(new Uint8Array([3, 4, 255]))
  await flush()
  expect(writer.ended).toBe(0)
  expect(service.diagnostics().terminals).toBe(1)
  process.observer.terminalClosed(0)
  expect(await observation.outputFinished).toEqual({ ok: true })
  await observation.released
  expect(writer.writes.flatMap((value) => [...value])).toEqual([1, 2, 3, 4, 255])
  expect((await observation.processExited).exitCode).toBe(7)
  expect(process.signals).toEqual([])
  expect(process.closes).toBe(0)
  expect(clock.timers.size).toBe(0)
  await service.dispose()
})

test('untyped non-byte typed arrays cannot become terminal input', async () => {
  const driver = new FakeDriver()
  const service = new TerminalService({ driver })
  const handle = await service.create({}, new Writer(), valid())
  try {
    for (const value of [new Uint16Array([1]), new Float32Array([1]), new Int8Array([1])])
      await expect(service.write(handle, value as unknown as Uint8Array)).rejects.toMatchObject({
        code: 'INVALID_ARGUMENT',
      })
    expect(driver.processes[0]!.inputs).toEqual([])
  } finally {
    await service.dispose()
  }
})

test('spawn validation snapshots executable and argument entries without invoking replacement iterators', async () => {
  const driver = new FakeDriver()
  const service = new TerminalService({ driver })
  let reads = 0
  let iterated = false
  const argv = ['safe']
  argv[Symbol.iterator] = () => {
    iterated = true
    return ['unsafe\0replacement'][Symbol.iterator]()
  }
  const options = {
    ...valid(),
    argv,
    get executable() {
      return ++reads === 1 ? process.execPath : 'relative-invalid'
    },
  }
  try {
    await service.create({}, new Writer(), options)
    expect(reads).toBe(1)
    expect(iterated).toBe(false)
    expect(driver.options[0]!.executable).toBe(process.execPath)
    expect(driver.options[0]!.argv).toEqual(['safe'])
  } finally {
    await service.dispose()
  }
})

test('a driver aborting synchronously cannot leave its later write rejection unobserved', async () => {
  const driver = new FakeDriver()
  const service = new TerminalService({ driver })
  const writer = new Writer()
  const handle = await service.create({}, writer, valid())
  const abort = new AbortController()
  const pending = deferred<number>()
  driver.processes[0]!.writeImpl = () => {
    abort.abort()
    return pending.promise
  }
  await expect(
    service.write(handle, new Uint8Array([1]), { signal: abort.signal })
  ).rejects.toMatchObject({ code: 'CANCELLED' })
  pending.reject(new Error('private driver failure'))
  await flush()
  await service.observe(handle).released
  expect(service.diagnostics().terminals).toBe(0)
  await service.dispose()
})

test('native supervision denial is not process exit and cannot release capacity', async () => {
  for (const failure of ['TERMINATION_DENIED', 'SUPERVISION_FAILED'] as const) {
    const clock = new Clock()
    const driver = new FakeDriver()
    driver.beforeReturn = (_observer, process) => {
      process.autoStop = false
    }
    const service = new TerminalService({
      driver,
      scheduler: clock,
      limits: { maxTerminals: 1, maxTerminalsPerOwner: 1 },
    })
    const handle = await service.create({}, new Writer(), valid())
    const process = driver.processes[0]!
    process.observer.processFailed!(failure)
    process.observer.terminalClosed(0)
    expect(await service.observe(handle).processExited).toMatchObject({
      observed: false,
      waitError: true,
      failure,
    })
    expect(service.diagnostics()).toMatchObject({ terminals: 1, driverFailures: 1 })
    await expect(service.create({}, new Writer(), valid())).rejects.toMatchObject({
      code: 'OVERLOADED',
    })
    const disposal = service.dispose()
    clock.advance(5000)
    expect((await disposal)[0]).toMatchObject({ processExited: false, released: false })
  }
})

test('empty arguments are preserved while an empty executable is rejected', async () => {
  const driver = new FakeDriver()
  const service = new TerminalService({ driver })
  await expect(service.create({}, new Writer(), valid({ executable: '' }))).rejects.toMatchObject({
    code: 'INVALID_ARGUMENT',
  })
  const handle = await service.create({}, new Writer(), valid({ argv: ['', 'x', ''] }))
  expect(driver.options[0]!.argv).toEqual(['', 'x', ''])
  await service.cancel(handle)
})

test('attested failure before a PTY exists releases reservations without invented closure', async () => {
  const service = new TerminalService({
    driver: {
      spawn(_options, observer) {
        observer.processNotStarted?.(false)
        throw new Error('No process or PTY created')
      },
    },
  })
  for (let index = 0; index < 66; index++) {
    await expect(service.create({}, new Writer(), valid())).rejects.toMatchObject({
      code: 'SPAWN_FAILED',
    })
    await flush()
    expect(service.diagnostics().terminals).toBe(0)
  }
})
