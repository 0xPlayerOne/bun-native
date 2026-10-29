import { isAbsolute } from 'node:path'
import { StreamBudget } from '../../contracts/src/stream-budget.ts'
import type { RpcScheduler } from '../../contracts/src/rpc.ts'
import { rpcScheduler } from '../../contracts/src/rpc.ts'
import type { BinaryStreamWriter, StreamOutcome } from '../../contracts/src/streams.ts'
import { FairWorkScheduler } from './fair-scheduler.ts'
import { CallbackStreamSource } from './stream-source.ts'

const terminalBrand: unique symbol = Symbol('bunly.terminal')
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype)
const intrinsicTypedArrayByteLength = Object.getOwnPropertyDescriptor(
  typedArrayPrototype,
  'byteLength'
)!.get!
const intrinsicTypedArrayByteOffset = Object.getOwnPropertyDescriptor(
  typedArrayPrototype,
  'byteOffset'
)!.get!
const intrinsicTypedArrayBuffer = Object.getOwnPropertyDescriptor(
  typedArrayPrototype,
  'buffer'
)!.get!
const intrinsicArrayBufferByteLength = Object.getOwnPropertyDescriptor(
  ArrayBuffer.prototype,
  'byteLength'
)!.get!
const intrinsicAbortSignalAborted = Object.getOwnPropertyDescriptor(
  AbortSignal.prototype,
  'aborted'
)!.get!
const addEventListener = EventTarget.prototype.addEventListener
const removeEventListener = EventTarget.prototype.removeEventListener
const SIGNALS = new Set<NodeJS.Signals>([
  'SIGHUP',
  'SIGINT',
  'SIGQUIT',
  'SIGTERM',
  'SIGKILL',
  'SIGUSR1',
  'SIGUSR2',
  'SIGWINCH',
])

export type TerminalErrorCode =
  | 'INVALID_ARGUMENT'
  | 'INVALID_HANDLE'
  | 'DISPOSED'
  | 'OVERLOADED'
  | 'SPAWN_FAILED'
  | 'IO_FAILED'
  | 'CANCELLED'
  | 'DEADLINE_EXCEEDED'

export class TerminalError extends Error {
  constructor(
    readonly code: TerminalErrorCode,
    message = `Terminal ${code.toLowerCase().replaceAll('_', ' ')}`
  ) {
    super(message)
    this.name = 'TerminalError'
  }
}

/** Opaque in-process identity. The diagnostic ID is never authority. */
export interface TerminalHandle {
  readonly id: string
  readonly kind: 'terminal'
  readonly [terminalBrand]: true
}

export interface TerminalSpawnOptions {
  readonly executable: string
  readonly cwd: string
  readonly argv?: readonly string[]
  /** No variables are inherited. Windows adds only an available SystemRoot. */
  readonly env?: Readonly<Record<string, string>>
  readonly cols?: number
  readonly rows?: number
  readonly name?: string
  readonly maxOutputBytes?: number
  readonly maxQueuedOutputChunks?: number
  readonly signal?: AbortSignal
  readonly spawnTimeoutMs?: number
}

export interface TerminalProcessExit {
  readonly started: boolean
  readonly observed: boolean
  readonly exitCode: number | null
  readonly signalCode: NodeJS.Signals | number | null
  readonly waitError: boolean
  readonly failure:
    | 'SPAWN_FAILED'
    | 'DEADLINE_EXCEEDED'
    | 'TERMINATION_DENIED'
    | 'SUPERVISION_FAILED'
    | 'SCHEDULER_FAILED'
    | null
}

export interface TerminalClosure {
  readonly started: boolean
  readonly observed: boolean
  /** Bun PTY lifecycle status, not the subprocess exit code. Status 1 is not clean EOF. */
  readonly status: number | null
  readonly failure: 'SPAWN_FAILED' | 'DEADLINE_EXCEEDED' | 'SCHEDULER_FAILED' | null
}

export interface TerminalObservation {
  readonly processExited: Promise<TerminalProcessExit>
  readonly terminalClosed: Promise<TerminalClosure>
  readonly outputFinished: Promise<StreamOutcome>
  /** Resolves only after all runtime and callback-source reservations are released. */
  readonly released: Promise<void>
}

/** A launch remains observable even when started rejects before returning a handle. */
export interface TerminalLaunch {
  readonly handle: TerminalHandle
  readonly started: Promise<TerminalHandle>
  readonly observation: TerminalObservation
}

export interface TerminalCloseResult {
  readonly processExited: boolean
  readonly terminalClosed: boolean
  readonly outputDrained: boolean
  readonly released: boolean
}

export interface TerminalDriverSpawnOptions {
  /** Backend lifetime for bounded native admission, never renderer authority. */
  readonly signal?: AbortSignal
  readonly spawnTimeoutMs?: number
  readonly executable: string
  readonly cwd: string
  readonly argv: readonly string[]
  readonly env: Readonly<Record<string, string>>
  readonly cols: number
  readonly rows: number
  readonly name: string
}

export interface TerminalDriverObserver {
  /** Attested failure before any command was created. */
  processNotStarted?(terminalCreated: boolean): void
  /** Unknown command/group ownership: settle failure without releasing reservations. */
  processFailed?(failure: 'TERMINATION_DENIED' | 'SUPERVISION_FAILED'): void
  output(bytes: Uint8Array): void
  terminalClosed(status: number): void
  processExited(exit: Pick<TerminalProcessExit, 'exitCode' | 'signalCode' | 'waitError'>): void
}

export interface TerminalDriverProcess {
  write(bytes: Uint8Array): number | Promise<number>
  resize(cols: number, rows: number): void
  signal(signal: NodeJS.Signals): void
  closeTerminal(): void
}

export interface TerminalDriver {
  spawn(
    options: TerminalDriverSpawnOptions,
    observer: TerminalDriverObserver
  ): TerminalDriverProcess | Promise<TerminalDriverProcess>
}

export interface TerminalServiceLimits {
  readonly maxTerminals: number
  readonly maxTerminalsPerOwner: number
  readonly maxOutputBytes: number
  readonly maxOutputBytesPerOwner: number
  readonly maxOutputBytesPerTerminal: number
  readonly maxInputBytes: number
  readonly operationTimeoutMs: number
  readonly closeTimeoutMs: number
}

const DEFAULT_LIMITS: TerminalServiceLimits = Object.freeze({
  maxTerminals: 64,
  maxTerminalsPerOwner: 16,
  maxOutputBytes: 16 * 1024 * 1024,
  maxOutputBytesPerOwner: 4 * 1024 * 1024,
  maxOutputBytesPerTerminal: 256 * 1024,
  maxInputBytes: 64 * 1024,
  operationTimeoutMs: 5_000,
  closeTimeoutMs: 5_000,
})

interface CapacityOwner {
  count: number
  bytes: number
}

class TerminalCapacity {
  readonly #owners = new Map<object, CapacityOwner>()
  #count = 0
  #bytes = 0
  constructor(readonly limits: TerminalServiceLimits) {}
  reserve(owner: object, bytes: number): () => void {
    const current = this.#owners.get(owner) ?? { count: 0, bytes: 0 }
    if (
      this.#count >= this.limits.maxTerminals ||
      current.count >= this.limits.maxTerminalsPerOwner ||
      this.#bytes + bytes > this.limits.maxOutputBytes ||
      current.bytes + bytes > this.limits.maxOutputBytesPerOwner
    )
      throw new TerminalError('OVERLOADED')
    current.count++
    current.bytes += bytes
    this.#count++
    this.#bytes += bytes
    this.#owners.set(owner, current)
    let released = false
    return () => {
      if (released) return
      released = true
      current.count--
      current.bytes -= bytes
      this.#count--
      this.#bytes -= bytes
      if (!current.count) this.#owners.delete(owner)
    }
  }
  diagnostics(owner?: object) {
    const current = owner ? this.#owners.get(owner) : undefined
    return Object.freeze({
      terminals: owner ? (current?.count ?? 0) : this.#count,
      reservedOutputBytes: owner ? (current?.bytes ?? 0) : this.#bytes,
      owners: this.#owners.size,
    })
  }
}

interface Deferred<T> {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((yes) => {
    resolve = yes
  })
  return { promise, resolve }
}

interface Resource {
  readonly handle: TerminalHandle
  owner: object | undefined
  releaseCapacity: (() => void) | undefined
  readonly processExit: Deferred<TerminalProcessExit>
  readonly terminalClose: Deferred<TerminalClosure>
  outputFinished: Promise<StreamOutcome> | undefined
  readonly released: Deferred<void>
  readonly controller: AbortController
  readonly spawnController: AbortController
  source: CallbackStreamSource | undefined
  driver: Partial<TerminalDriverProcess> | undefined
  state: 'spawning' | 'live' | 'closing' | 'disposed'
  spawnInvoked: boolean
  spawnSettled: boolean
  processObserved: boolean
  processSettled: boolean
  processReleased: boolean
  terminalObserved: boolean
  terminalSettled: boolean
  terminalReleased: boolean
  sourceDrained: boolean
  capacityReleased: boolean
  inputActive: boolean
  driverWrites: number
  requestedSignal: NodeJS.Signals | undefined
  readonly attemptedSignals: Set<NodeJS.Signals>
  terminalCloseRequested: boolean
  driverFailure: boolean
  removeLifetimeAbort: () => void
  lifecycleTimer?: unknown
  lifecycleTimerSet?: boolean
  lifecycleTimerInstalled?: boolean
  closeTask?: Promise<TerminalCloseResult>
  closePending: boolean
  closeSignal?: NodeJS.Signals
}

function dimension(value: unknown, fallback: number): number {
  const result = value ?? fallback
  if (!Number.isSafeInteger(result) || Number(result) < 1 || Number(result) > 1000)
    throw new TerminalError('INVALID_ARGUMENT', 'Terminal dimensions must be integers in [1, 1000]')
  return Number(result)
}

function boundedString(value: unknown, label: string, max = 4096): asserts value is string {
  if (typeof value !== 'string' || !value || value.length > max || value.includes('\0'))
    throw new TerminalError('INVALID_ARGUMENT', `${label} must be a bounded nonempty string`)
}

function validateOptions(
  input: TerminalSpawnOptions,
  limits: TerminalServiceLimits
): TerminalDriverSpawnOptions & {
  maxOutputBytes: number
  maxQueuedOutputChunks: number
  spawnTimeoutMs: number
} {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new TerminalError('INVALID_ARGUMENT')
  const executable = input.executable,
    cwd = input.cwd
  boundedString(executable, 'Executable')
  boundedString(cwd, 'Working directory')
  if (!isAbsolute(executable) || !isAbsolute(cwd))
    throw new TerminalError('INVALID_ARGUMENT', 'Executable and working directory must be absolute')
  const argv = input.argv ?? []
  if (!Array.isArray(argv) || argv.length > 256)
    throw new TerminalError('INVALID_ARGUMENT', 'Argument count exceeds its bound')
  const argumentsSnapshot: string[] = []
  const argumentCount = argv.length
  let argumentBytes = 0
  for (let index = 0; index < argumentCount; index++) {
    const value = argv[index]
    if (value !== '') boundedString(value, 'Argument')
    argumentBytes += Buffer.byteLength(value)
    argumentsSnapshot.push(value)
  }
  if (argumentBytes > 64 * 1024)
    throw new TerminalError('INVALID_ARGUMENT', 'Arguments exceed their byte bound')
  const supplied = input.env ?? {}
  if (!supplied || typeof supplied !== 'object' || Array.isArray(supplied))
    throw new TerminalError('INVALID_ARGUMENT', 'Environment must be an object')
  const entries = Object.entries(supplied)
  if (entries.length > 128)
    throw new TerminalError('INVALID_ARGUMENT', 'Environment count exceeds its bound')
  const env: Record<string, string> = {}
  const environmentKeys = new Set<string>()
  let environmentBytes = 0
  for (const [key, value] of entries) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key))
      throw new TerminalError('INVALID_ARGUMENT', 'Invalid environment key')
    if (typeof value !== 'string' || value.length > 8192 || value.includes('\0'))
      throw new TerminalError('INVALID_ARGUMENT', 'Invalid environment value')
    const identity = process.platform === 'win32' ? key.toUpperCase() : key
    if (environmentKeys.has(identity))
      throw new TerminalError('INVALID_ARGUMENT', 'Duplicate environment key')
    environmentKeys.add(identity)
    environmentBytes += Buffer.byteLength(key) + Buffer.byteLength(value) + 2
    env[key] = value
  }
  if (environmentBytes > 64 * 1024)
    throw new TerminalError('INVALID_ARGUMENT', 'Environment exceeds its byte bound')
  if (!environmentKeys.has('TERM')) env['TERM'] = 'xterm-256color'
  if (process.platform === 'win32' && !environmentKeys.has('SYSTEMROOT')) {
    const root = process.env['SystemRoot']
    if (root) env['SystemRoot'] = root
  }
  const name = input.name ?? 'xterm-256color'
  boundedString(name, 'Terminal name', 64)
  if (!/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/.test(name))
    throw new TerminalError('INVALID_ARGUMENT', 'Invalid terminal name')
  const maxOutputBytes = input.maxOutputBytes ?? limits.maxOutputBytesPerTerminal
  const maxQueuedOutputChunks = input.maxQueuedOutputChunks ?? 32
  const spawnTimeoutMs = input.spawnTimeoutMs ?? limits.operationTimeoutMs
  if (
    !Number.isSafeInteger(maxOutputBytes) ||
    maxOutputBytes < 16 * 1024 ||
    maxOutputBytes > limits.maxOutputBytesPerTerminal ||
    !Number.isSafeInteger(maxQueuedOutputChunks) ||
    maxQueuedOutputChunks < 1 ||
    maxQueuedOutputChunks > 4096 ||
    !Number.isSafeInteger(spawnTimeoutMs) ||
    spawnTimeoutMs < 1 ||
    spawnTimeoutMs > 60_000
  )
    throw new TerminalError('INVALID_ARGUMENT', 'Invalid terminal capacity or deadline')
  return Object.freeze({
    executable,
    cwd,
    argv: Object.freeze(argumentsSnapshot),
    env: Object.freeze(env),
    cols: dimension(input.cols, 80),
    rows: dimension(input.rows, 24),
    name,
    maxOutputBytes,
    maxQueuedOutputChunks,
    spawnTimeoutMs,
  })
}

/** Direct Bun subprocess driver. It does not supervise descendants or accept renderer PIDs. */
export class BunTerminalDriver implements TerminalDriver {
  spawn(
    options: TerminalDriverSpawnOptions,
    observer: TerminalDriverObserver
  ): TerminalDriverProcess {
    const subprocess = Bun.spawn({
      cmd: [options.executable, ...options.argv],
      cwd: options.cwd,
      env: { ...options.env },
      terminal: {
        cols: options.cols,
        rows: options.rows,
        name: options.name,
        data(_terminal, bytes) {
          observer.output(bytes)
        },
        exit(_terminal, status) {
          observer.terminalClosed(status)
        },
      },
      onExit(_process, exitCode, signalCode, error) {
        observer.processExited({ exitCode, signalCode, waitError: error !== undefined })
      },
    })
    const terminal = subprocess.terminal
    if (!terminal) throw new Error('Bun did not create the requested terminal')
    return Object.freeze({
      write: (bytes: Uint8Array) => terminal.write(bytes),
      resize: (cols: number, rows: number) => terminal.resize(cols, rows),
      signal: (signal: NodeJS.Signals) => subprocess.kill(signal),
      closeTerminal: () => terminal.close(),
    })
  }
}

export interface TerminalServiceOptions {
  readonly driver?: TerminalDriver
  readonly limits?: Partial<TerminalServiceLimits>
  readonly scheduler?: RpcScheduler
  readonly fairScheduler?: FairWorkScheduler
}

/** Persistent runtime owner for Bun PTYs; application callbacks never own the subprocess. */
export class TerminalService {
  readonly #driver: TerminalDriver
  readonly #limits: TerminalServiceLimits
  readonly #clock: RpcScheduler
  readonly #capacity: TerminalCapacity
  readonly #sourceBudget: StreamBudget
  readonly #fairScheduler: FairWorkScheduler
  readonly #entries = new WeakMap<TerminalHandle, Resource>()
  readonly #live = new Set<Resource>()
  #sequence = 0
  #disposed = false
  #disposal: Promise<readonly TerminalCloseResult[]> | undefined
  constructor(options: TerminalServiceOptions = {}) {
    for (const key of Object.keys(options.limits ?? {}))
      if (!Object.hasOwn(DEFAULT_LIMITS, key)) throw new TypeError('Unknown terminal service limit')
    const limits = { ...DEFAULT_LIMITS, ...options.limits }
    if (
      !Object.values(limits).every((value) => Number.isSafeInteger(value) && value > 0) ||
      limits.maxTerminals > 4096 ||
      limits.maxTerminalsPerOwner > limits.maxTerminals ||
      limits.maxOutputBytes > 256 * 1024 * 1024 ||
      limits.maxOutputBytesPerTerminal < 16 * 1024 ||
      limits.maxOutputBytesPerTerminal > limits.maxOutputBytesPerOwner ||
      limits.maxOutputBytesPerOwner > limits.maxOutputBytes ||
      limits.maxInputBytes > 1024 * 1024 ||
      limits.operationTimeoutMs > 60_000 ||
      limits.closeTimeoutMs > 60_000
    )
      throw new TypeError('Invalid terminal service limits')
    this.#limits = Object.freeze(limits)
    this.#driver = options.driver ?? new BunTerminalDriver()
    this.#clock = options.scheduler ?? rpcScheduler
    this.#capacity = new TerminalCapacity(this.#limits)
    this.#sourceBudget = new StreamBudget({
      maxBytes: limits.maxOutputBytes,
      maxBytesPerView: limits.maxOutputBytesPerOwner,
      maxBytesPerStream: limits.maxOutputBytesPerTerminal,
      maxStreams: limits.maxTerminals,
      maxStreamsPerView: limits.maxTerminalsPerOwner,
    })
    this.#fairScheduler = options.fairScheduler ?? new FairWorkScheduler()
  }

  async create(
    owner: object,
    writer: BinaryStreamWriter,
    input: TerminalSpawnOptions
  ): Promise<TerminalHandle> {
    return this.launch(owner, writer, input).started
  }

  launch(owner: object, writer: BinaryStreamWriter, input: TerminalSpawnOptions): TerminalLaunch {
    if (this.#disposed) throw new TerminalError('DISPOSED', 'Terminal service disposed')
    if (!owner || typeof owner !== 'object')
      throw new TerminalError('INVALID_ARGUMENT', 'A stable runtime owner object is required')
    const options = validateOptions(input, this.#limits)
    const lifetimeSignal = this.#abortSignal(input.signal)
    if (this.#disposed) throw new TerminalError('DISPOSED', 'Terminal service disposed')
    if (lifetimeSignal && intrinsicAbortSignalAborted.call(lifetimeSignal))
      throw new TerminalError('CANCELLED', 'Terminal spawn cancelled')
    const releaseCapacity = this.#capacity.reserve(owner, options.maxOutputBytes)
    const handle = Object.freeze({
      id: `terminal-${++this.#sequence}`,
      kind: 'terminal' as const,
      [terminalBrand]: true as const,
    })
    const resource: Resource = {
      handle,
      owner,
      releaseCapacity,
      processExit: deferred(),
      terminalClose: deferred(),
      outputFinished: undefined,
      released: deferred(),
      controller: new AbortController(),
      spawnController: new AbortController(),
      source: undefined,
      driver: undefined,
      state: 'spawning',
      spawnInvoked: false,
      spawnSettled: false,
      processObserved: false,
      processSettled: false,
      processReleased: false,
      terminalObserved: false,
      terminalSettled: false,
      terminalReleased: false,
      sourceDrained: false,
      capacityReleased: false,
      inputActive: false,
      driverWrites: 0,
      requestedSignal: undefined,
      attemptedSignals: new Set(),
      terminalCloseRequested: false,
      driverFailure: false,
      removeLifetimeAbort: () => {},
      closePending: false,
    }
    this.#entries.set(handle, resource)
    this.#live.add(resource)
    if (lifetimeSignal) this.#attachLifetimeSignal(resource, lifetimeSignal)
    const started = this.#spawn(resource, writer, options, lifetimeSignal)
    return Object.freeze({ handle, started, observation: this.observe(handle) })
  }

  async #spawn(
    resource: Resource,
    writer: BinaryStreamWriter,
    options: ReturnType<typeof validateOptions>,
    lifetimeSignal: AbortSignal | undefined
  ): Promise<TerminalHandle> {
    const { handle, owner } = resource
    try {
      resource.source = new CallbackStreamSource(writer, {
        budget: this.#sourceBudget,
        owner: owner!,
        maxRetainedBytes: options.maxOutputBytes,
        maxQueuedChunks: options.maxQueuedOutputChunks,
        coalescePending: true,
        scheduler: this.#fairScheduler,
        stopSource: () => this.#stopExact(resource, resource.requestedSignal ?? 'SIGKILL'),
      })
      resource.outputFinished = resource.source.finished
    } catch (error) {
      resource.outputFinished = Promise.resolve({ ok: false, code: 'CONSUMER_FAILED' })
      resource.sourceDrained = true
      this.#notSpawned(resource, 'SPAWN_FAILED')
      throw error
    }
    void resource.source.drained.then(() => {
      resource.sourceDrained = true
      this.#collect(resource)
    })
    if (
      this.#disposed ||
      resource.state !== 'spawning' ||
      (lifetimeSignal && intrinsicAbortSignalAborted.call(lifetimeSignal))
    ) {
      resource.source.cancel()
      this.#notSpawned(resource, 'SPAWN_FAILED')
      throw new TerminalError(
        this.#disposed ? 'DISPOSED' : 'CANCELLED',
        this.#disposed ? 'Terminal service disposed' : 'Terminal spawn cancelled'
      )
    }
    const observer: TerminalDriverObserver = Object.freeze({
      processNotStarted: (terminalCreated: boolean) => {
        resource.processReleased = true
        if (!terminalCreated) resource.terminalReleased = true
        this.#settleProcessFailure(resource, 'SPAWN_FAILED')
        this.#collect(resource)
      },
      output: (bytes: Uint8Array) => {
        resource.source?.push(bytes)
      },
      terminalClosed: (status: number) => this.#terminalClosed(resource, status),
      processFailed: (failure: 'TERMINATION_DENIED' | 'SUPERVISION_FAILED') => {
        resource.driverFailure = true
        this.#settleProcessFailure(resource, failure)
        this.#cancelResource(resource, 'SIGKILL')
      },
      processExited: (exit: Pick<TerminalProcessExit, 'exitCode' | 'signalCode' | 'waitError'>) =>
        this.#processExited(resource, exit),
    })
    let spawned: TerminalDriverProcess | Promise<TerminalDriverProcess>
    resource.spawnInvoked = true
    try {
      spawned = this.#driver.spawn(
        { ...options, signal: resource.spawnController.signal },
        observer
      )
    } catch {
      this.#spawnRejected(resource)
      throw new TerminalError('SPAWN_FAILED')
    }
    const attached = Promise.resolve(spawned).then(
      (driver) => {
        const captured = this.#captureDriver(driver)
        resource.driver = captured.driver
        resource.spawnSettled = true
        if (!captured.valid) {
          this.#spawnRejected(resource)
          throw new TerminalError('SPAWN_FAILED')
        }
        if (resource.state === 'spawning') resource.state = 'live'
        this.#applyStop(resource)
        this.#collect(resource)
        return handle
      },
      () => {
        this.#spawnRejected(resource)
        throw new TerminalError('SPAWN_FAILED')
      }
    )
    return this.#bounded(
      attached,
      options.spawnTimeoutMs,
      [resource.spawnController.signal],
      () => this.#cancelResource(resource, 'SIGKILL'),
      'Terminal spawn',
      'SPAWN_FAILED'
    )
  }

  observe(handle: TerminalHandle): TerminalObservation {
    const resource = this.#resource(handle, true)
    return Object.freeze({
      processExited: resource.processExit.promise,
      terminalClosed: resource.terminalClose.promise,
      outputFinished: resource.outputFinished!,
      released: resource.released.promise,
    })
  }

  async write(
    handle: TerminalHandle,
    input: Uint8Array,
    options: { readonly signal?: AbortSignal; readonly timeoutMs?: number } = {}
  ): Promise<void> {
    const resource = this.#resource(handle)
    const admitted = this.#admitInput(input)
    if (resource.inputActive)
      throw new TerminalError('OVERLOADED', 'Only one terminal input write may be active')
    const timeout = this.#operationTimeout(options.timeoutMs)
    const operationSignal = this.#abortSignal(options.signal)
    if (operationSignal && intrinsicAbortSignalAborted.call(operationSignal))
      throw new TerminalError('CANCELLED', 'Terminal input cancelled')
    if (resource.state !== 'live') throw new TerminalError('DISPOSED', 'Terminal is not live')
    if (resource.inputActive)
      throw new TerminalError('OVERLOADED', 'Only one terminal input write may be active')
    const bytes = new Uint8Array(admitted.length)
    try {
      bytes.set(new Uint8Array(admitted.buffer, admitted.offset, admitted.length))
    } catch {
      throw new TerminalError('INVALID_ARGUMENT', 'Terminal input buffer is detached')
    }
    resource.inputActive = true
    try {
      let written: number | Promise<number>
      try {
        written = resource.driver!.write!(bytes)
      } catch {
        this.#cancelResource(resource, 'SIGKILL')
        throw new TerminalError('IO_FAILED')
      }
      const operation = Promise.resolve(written)
      resource.driverWrites++
      void operation
        .finally(() => {
          resource.driverWrites--
          this.#collect(resource)
        })
        .catch(() => {})
      let count: number
      try {
        count = await this.#bounded(
          operation,
          timeout,
          operationSignal
            ? [operationSignal, resource.controller.signal]
            : [resource.controller.signal],
          () => this.#cancelResource(resource, 'SIGKILL'),
          'Terminal input',
          'IO_FAILED'
        )
      } catch (error) {
        if (error instanceof TerminalError && error.code === 'IO_FAILED')
          this.#cancelResource(resource, 'SIGKILL')
        throw error
      }
      if (!Number.isSafeInteger(count) || count !== admitted.length) {
        this.#cancelResource(resource, 'SIGKILL')
        throw new TerminalError('IO_FAILED', 'Terminal accepted only part of the bounded input')
      }
    } finally {
      resource.inputActive = false
      this.#collect(resource)
    }
  }

  resize(handle: TerminalHandle, cols: number, rows: number): void {
    const resource = this.#resource(handle)
    const width = dimension(cols, 80),
      height = dimension(rows, 24)
    try {
      resource.driver!.resize!(width, height)
    } catch {
      this.#cancelResource(resource, 'SIGKILL')
      throw new TerminalError('IO_FAILED')
    }
  }

  signal(handle: TerminalHandle, signal: NodeJS.Signals): void {
    const resource = this.#resource(handle)
    if (!SIGNALS.has(signal)) throw new TerminalError('INVALID_ARGUMENT', 'Unsupported signal')
    try {
      resource.driver!.signal!(signal)
    } catch {
      throw new TerminalError('IO_FAILED')
    }
  }

  close(
    handle: TerminalHandle,
    timeoutMs = this.#limits.closeTimeoutMs
  ): Promise<TerminalCloseResult> {
    return this.#close(this.#resource(handle, true), 'SIGTERM', timeoutMs)
  }

  cancel(
    handle: TerminalHandle,
    timeoutMs = this.#limits.closeTimeoutMs
  ): Promise<TerminalCloseResult> {
    return this.#close(this.#resource(handle, true), 'SIGKILL', timeoutMs)
  }

  dispose(): Promise<readonly TerminalCloseResult[]> {
    if (this.#disposal) return this.#disposal
    this.#disposed = true
    const observation = deferred<readonly TerminalCloseResult[]>()
    this.#disposal = observation.promise
    void Promise.all(Array.from(this.#live, (resource) => this.#close(resource, 'SIGKILL'))).then(
      observation.resolve
    )
    return this.#disposal
  }

  diagnostics(owner?: object) {
    const capacity = this.#capacity.diagnostics(owner)
    const source = this.#sourceBudget.diagnostics(owner)
    const resources = owner
      ? Array.from(this.#live).filter((resource) => resource.owner === owner)
      : Array.from(this.#live)
    return Object.freeze({
      ...capacity,
      sourceReservedBytes: source.reservedBytes,
      sourceStreams: source.streams,
      spawning: resources.filter((resource) => resource.state === 'spawning').length,
      live: resources.filter((resource) => resource.state === 'live').length,
      closing: resources.filter((resource) => resource.state === 'closing').length,
      pendingDriverWrites: resources.reduce((sum, resource) => sum + resource.driverWrites, 0),
      driverFailures: resources.filter((resource) => resource.driverFailure).length,
      scheduling: this.#fairScheduler.diagnostics(),
      disposed: this.#disposed,
    })
  }

  #resource(handle: TerminalHandle, observations = false): Resource {
    if (!handle || typeof handle !== 'object') throw new TerminalError('INVALID_HANDLE')
    const resource = this.#entries.get(handle)
    if (!resource) throw new TerminalError('INVALID_HANDLE', 'Unknown or foreign terminal handle')
    if (!observations && resource.state !== 'live')
      throw new TerminalError('DISPOSED', 'Terminal is not live')
    return resource
  }

  #operationTimeout(value: number | undefined): number {
    const timeout = value ?? this.#limits.operationTimeoutMs
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 60_000)
      throw new TerminalError('INVALID_ARGUMENT', 'Invalid operation deadline')
    return timeout
  }

  #abortSignal(signal: AbortSignal | undefined): AbortSignal | undefined {
    if (signal === undefined) return undefined
    try {
      intrinsicAbortSignalAborted.call(signal)
      return signal
    } catch {
      throw new TerminalError('INVALID_ARGUMENT', 'Invalid abort signal')
    }
  }

  #admitInput(input: Uint8Array): {
    buffer: ArrayBuffer
    offset: number
    length: number
  } {
    let buffer: unknown, offset: number, length: number, bufferLength: number
    try {
      if (!(input instanceof Uint8Array)) throw new TypeError('Not a byte view')
      buffer = intrinsicTypedArrayBuffer.call(input)
      offset = intrinsicTypedArrayByteOffset.call(input)
      length = intrinsicTypedArrayByteLength.call(input)
      // This intrinsic accepts only a real ArrayBuffer. It rejects SharedArrayBuffer,
      // proxy and prototype-forged values, while zero identifies detachment here.
      bufferLength = intrinsicArrayBufferByteLength.call(buffer)
    } catch {
      throw new TerminalError('INVALID_ARGUMENT', 'Terminal input must be an owned byte view')
    }
    if (
      !length ||
      length > this.#limits.maxInputBytes ||
      !bufferLength ||
      offset < 0 ||
      offset + length > bufferLength
    )
      throw new TerminalError('INVALID_ARGUMENT', 'Terminal input exceeds its bound')
    return { buffer: buffer as ArrayBuffer, offset, length }
  }

  #attachLifetimeSignal(resource: Resource, signal: AbortSignal): void {
    let removed = false
    const abort = () => this.#cancelResource(resource, 'SIGKILL')
    addEventListener.call(signal, 'abort', abort, { once: true })
    resource.removeLifetimeAbort = () => {
      if (removed) return
      removed = true
      removeEventListener.call(signal, 'abort', abort)
    }
    if (intrinsicAbortSignalAborted.call(signal)) abort()
  }

  #captureDriver(value: unknown): {
    driver: Partial<TerminalDriverProcess> | undefined
    valid: boolean
  } {
    // Read each operation once: validation and later ownership actions must use
    // the same receiver/method even if a defective driver mutates its properties.
    if (!value || typeof value !== 'object') return { driver: undefined, valid: false }
    let write: unknown, resize: unknown, signal: unknown, closeTerminal: unknown
    try {
      write = Reflect.get(value, 'write')
      resize = Reflect.get(value, 'resize')
      signal = Reflect.get(value, 'signal')
      closeTerminal = Reflect.get(value, 'closeTerminal')
    } catch {
      return { driver: undefined, valid: false }
    }
    const driver: Partial<TerminalDriverProcess> = {}
    if (typeof write === 'function')
      driver.write = (bytes) => Reflect.apply(write, value, [bytes]) as number | Promise<number>
    if (typeof resize === 'function')
      driver.resize = (cols, rows) => Reflect.apply(resize, value, [cols, rows])
    if (typeof signal === 'function') driver.signal = (kind) => Reflect.apply(signal, value, [kind])
    if (typeof closeTerminal === 'function')
      driver.closeTerminal = () => Reflect.apply(closeTerminal, value, [])
    return {
      driver: Object.freeze(driver),
      valid:
        typeof write === 'function' &&
        typeof resize === 'function' &&
        typeof signal === 'function' &&
        typeof closeTerminal === 'function',
    }
  }

  #terminalClosed(resource: Resource, status: number): void {
    if (resource.terminalReleased) return
    resource.terminalObserved = true
    resource.terminalReleased = true
    if (!resource.terminalSettled) {
      resource.terminalSettled = true
      resource.terminalClose.resolve(
        Object.freeze({
          started: true,
          observed: true,
          status: Number.isInteger(status) ? status : 1,
          failure: null,
        })
      )
    }
    if (resource.state !== 'disposed') resource.state = 'closing'
    void resource.source?.end()
    this.#updateLifecycleDeadline(resource)
    this.#collect(resource)
  }

  #processExited(
    resource: Resource,
    exit: Pick<TerminalProcessExit, 'exitCode' | 'signalCode' | 'waitError'>
  ): void {
    if (resource.processReleased) return
    resource.processObserved = true
    resource.processReleased = true
    if (!resource.processSettled) {
      resource.processSettled = true
      resource.processExit.resolve(
        Object.freeze({
          started: true,
          observed: true,
          exitCode: exit.exitCode,
          signalCode: exit.signalCode,
          waitError: exit.waitError,
          failure: null,
        })
      )
    }
    if (resource.state !== 'disposed') resource.state = 'closing'
    resource.controller.abort(new TerminalError('CANCELLED', 'Terminal process exited'))
    // A requested stop may close ConPTY only after actual child exit. Natural
    // exit must instead retain the PTY through trailing output and its EOF. The
    // separate closure deadline is the only fallback for a missing EOF callback.
    this.#applyStop(resource)
    this.#updateLifecycleDeadline(resource)
    this.#collect(resource)
  }

  #settleProcessFailure(
    resource: Resource,
    failure: NonNullable<TerminalProcessExit['failure']>
  ): void {
    if (resource.processSettled) return
    resource.processSettled = true
    resource.processExit.resolve(
      Object.freeze({
        started: resource.spawnInvoked,
        observed: false,
        exitCode: null,
        signalCode: null,
        waitError: true,
        failure,
      })
    )
  }

  #settleTerminalFailure(
    resource: Resource,
    failure: NonNullable<TerminalClosure['failure']>
  ): void {
    if (resource.terminalSettled) return
    resource.terminalSettled = true
    resource.terminalClose.resolve(
      Object.freeze({
        started: resource.spawnInvoked,
        observed: false,
        status: null,
        failure,
      })
    )
  }

  #notSpawned(resource: Resource, failure: 'SPAWN_FAILED'): void {
    if (resource.state === 'disposed') return
    resource.spawnSettled = true
    resource.state = 'closing'
    resource.source?.cancel()
    this.#settleProcessFailure(resource, failure)
    this.#settleTerminalFailure(resource, failure)
    resource.processReleased = true
    resource.terminalReleased = true
    resource.sourceDrained ||= resource.source === undefined
    this.#collect(resource)
  }

  #spawnRejected(resource: Resource): void {
    if (resource.state === 'disposed') return
    resource.spawnSettled = true
    resource.state = 'closing'
    this.#settleProcessFailure(resource, 'SPAWN_FAILED')
    this.#settleTerminalFailure(resource, 'SPAWN_FAILED')
    this.#stopExact(resource, 'SIGKILL')
    resource.source?.cancel()
    this.#collect(resource)
  }

  #cancelResource(resource: Resource, signal: NodeJS.Signals): void {
    if (resource.state === 'disposed') return
    if (signal === 'SIGKILL' || !resource.requestedSignal) resource.requestedSignal = signal
    resource.state = 'closing'
    resource.spawnController.abort(new TerminalError('CANCELLED'))
    resource.controller.abort(new TerminalError('CANCELLED'))
    this.#applyStop(resource)
    resource.source?.cancel()
  }

  #stopExact(resource: Resource, signal: NodeJS.Signals): void {
    if (signal === 'SIGKILL' || !resource.requestedSignal) resource.requestedSignal = signal
    if (resource.state !== 'disposed') resource.state = 'closing'
    this.#applyStop(resource)
  }

  #applyStop(resource: Resource): void {
    const driver = resource.driver
    if (!driver) return
    if (
      resource.requestedSignal &&
      !resource.processReleased &&
      !resource.attemptedSignals.has(resource.requestedSignal)
    ) {
      const signal = resource.requestedSignal
      resource.attemptedSignals.add(signal)
      try {
        if (!driver.signal) throw new Error('Driver has no signal operation')
        driver.signal(signal)
      } catch {
        resource.driverFailure = true
      }
    }
    if (
      resource.processReleased &&
      resource.requestedSignal !== undefined &&
      !resource.terminalCloseRequested &&
      !resource.terminalReleased
    ) {
      resource.terminalCloseRequested = true
      try {
        if (!driver.closeTerminal) throw new Error('Driver has no terminal close operation')
        driver.closeTerminal()
      } catch {
        resource.driverFailure = true
      }
    }
  }

  #close(
    resource: Resource,
    signal: NodeJS.Signals,
    timeoutMs = this.#limits.closeTimeoutMs
  ): Promise<TerminalCloseResult> {
    const timeout = this.#operationTimeout(timeoutMs)
    if (resource.closeTask) {
      if (resource.closePending && signal === 'SIGKILL' && resource.closeSignal !== 'SIGKILL') {
        resource.closeSignal = 'SIGKILL'
        this.#cancelResource(resource, 'SIGKILL')
      }
      return resource.closeTask
    }
    const observation = deferred<TerminalCloseResult>()
    resource.closeTask = observation.promise
    resource.closePending = true
    resource.closeSignal = signal
    let deadline: number
    let timer: unknown
    let timerSet = false
    const snapshot = () =>
      Object.freeze({
        processExited: resource.processObserved,
        terminalClosed: resource.terminalObserved,
        outputDrained: resource.sourceDrained,
        released: resource.capacityReleased,
      })
    const finish = () => {
      if (!resource.closePending) return
      resource.closePending = false
      if (timerSet) {
        timerSet = false
        try {
          this.#clock.clear(timer)
        } catch {
          // Scheduler cleanup must not prevent reporting the observed state.
        }
      }
      observation.resolve(snapshot())
    }
    const schedulerFailure = () => {
      if (!resource.closePending) return
      this.#cancelResource(resource, 'SIGKILL')
      // A failed clock is not a deadline or proof of process/PTY release.
      finish()
    }
    const expire = () => {
      if (!resource.closePending) return
      try {
        const remaining = deadline - this.#clock.now()
        if (remaining > 0) {
          timer = this.#clock.set(remaining, expire)
          timerSet = true
          return
        }
      } catch {
        schedulerFailure()
        return
      }
      this.#cancelResource(resource, 'SIGKILL')
      this.#expireLifecycle(resource)
      finish()
    }
    if (resource.capacityReleased) {
      finish()
      return resource.closeTask
    }
    try {
      deadline = this.#clock.now() + timeout
      timer = this.#clock.set(timeout, expire)
      timerSet = true
    } catch {
      schedulerFailure()
      return resource.closeTask
    }
    void resource.released.promise.then(() => {
      try {
        if (this.#clock.now() >= deadline) expire()
        else finish()
      } catch {
        schedulerFailure()
      }
    })
    this.#cancelResource(resource, signal)
    return resource.closeTask
  }

  #clearLifecycleTimer(resource: Resource): void {
    if (!resource.lifecycleTimerSet) return
    resource.lifecycleTimerSet = false
    const timer = resource.lifecycleTimer
    const installed = resource.lifecycleTimerInstalled
    resource.lifecycleTimer = undefined
    resource.lifecycleTimerInstalled = false
    if (!installed) return
    try {
      this.#clock.clear(timer)
    } catch {
      // Observed lifecycle and resource cleanup do not depend on timer cancellation.
    }
  }

  #updateLifecycleDeadline(resource: Resource): void {
    if (resource.processReleased && resource.terminalReleased) {
      this.#clearLifecycleTimer(resource)
      return
    }
    if (
      resource.state === 'disposed' ||
      resource.lifecycleTimerSet ||
      resource.closePending ||
      (!resource.processReleased && !resource.terminalReleased)
    )
      return
    // Reserve before calling the scheduler, which may synchronously reenter.
    resource.lifecycleTimerSet = true
    const failed = () => {
      resource.lifecycleTimerSet = false
      resource.lifecycleTimer = undefined
      resource.lifecycleTimerInstalled = false
      // Failure to schedule is not a deadline expiry or a release observation.
      // Keep the PTY and output alive so the natural tail can still arrive.
      if (!resource.processReleased) this.#settleProcessFailure(resource, 'SCHEDULER_FAILED')
      if (!resource.terminalReleased) this.#settleTerminalFailure(resource, 'SCHEDULER_FAILED')
      this.#collect(resource)
    }
    const schedule = (delay: number, callback: () => void) => {
      const timer = this.#clock.set(delay, callback)
      if (!resource.lifecycleTimerSet) {
        try {
          this.#clock.clear(timer)
        } catch {
          // A stale timer checks the reservation before doing anything.
        }
        return
      }
      resource.lifecycleTimer = timer
      resource.lifecycleTimerInstalled = true
    }
    try {
      const deadline = this.#clock.now() + this.#limits.closeTimeoutMs
      if (!resource.lifecycleTimerSet) return
      const expire = () => {
        if (!resource.lifecycleTimerSet) return
        try {
          const remaining = deadline - this.#clock.now()
          if (!resource.lifecycleTimerSet) return
          if (remaining > 0) {
            schedule(remaining, expire)
            return
          }
          resource.lifecycleTimerSet = false
          resource.lifecycleTimer = undefined
          resource.lifecycleTimerInstalled = false
          this.#expireLifecycle(resource)
        } catch {
          failed()
        }
      }
      schedule(this.#limits.closeTimeoutMs, expire)
    } catch {
      failed()
    }
  }

  #expireLifecycle(resource: Resource): void {
    if (resource.state === 'disposed') return
    resource.state = 'closing'
    if (!resource.processReleased) {
      resource.requestedSignal = 'SIGKILL'
      this.#applyStop(resource)
    }
    if (resource.processReleased && !resource.terminalReleased) {
      // Natural exit does not imply that the PTY delivered its final bytes.
      // Only expiry of its separate finite closure wait permits forced close.
      resource.requestedSignal = 'SIGKILL'
      this.#applyStop(resource)
    }
    if (!resource.processReleased) this.#settleProcessFailure(resource, 'DEADLINE_EXCEEDED')
    if (!resource.terminalReleased) {
      this.#settleTerminalFailure(resource, 'DEADLINE_EXCEEDED')
      resource.source?.cancel()
    }
    this.#collect(resource)
  }

  #collect(resource: Resource): void {
    if (
      resource.capacityReleased ||
      !resource.spawnSettled ||
      !resource.processReleased ||
      !resource.terminalReleased ||
      !resource.sourceDrained ||
      resource.inputActive ||
      resource.driverWrites > 0
    )
      return
    resource.capacityReleased = true
    resource.state = 'disposed'
    this.#live.delete(resource)
    this.#clearLifecycleTimer(resource)
    resource.removeLifetimeAbort()
    resource.driver = undefined
    resource.source = undefined
    resource.owner = undefined
    resource.attemptedSignals.clear()
    resource.releaseCapacity?.()
    resource.releaseCapacity = undefined
    resource.released.resolve()
  }

  #bounded<T>(
    operation: Promise<T>,
    timeoutMs: number,
    signals: readonly AbortSignal[],
    stop: () => void,
    label: string,
    failureCode: TerminalErrorCode
  ): Promise<T> {
    if (signals.some((signal) => intrinsicAbortSignalAborted.call(signal))) {
      // The driver may abort synchronously before returning a rejecting promise.
      // Retain a rejection observer even when the caller is already cancelled.
      void operation.catch(() => {})
      stop()
      return Promise.reject(new TerminalError('CANCELLED', `${label} cancelled`))
    }
    const deadline = this.#clock.now() + timeoutMs
    return new Promise<T>((resolve, reject) => {
      let settled = false
      let timer: unknown
      const cleanup = () => {
        if (timer !== undefined) this.#clock.clear(timer)
        for (const signal of signals) removeEventListener.call(signal, 'abort', abort)
      }
      const finish = (callback: () => void) => {
        if (settled) return
        settled = true
        cleanup()
        callback()
      }
      const deadlineFailure = () =>
        finish(() => {
          stop()
          reject(new TerminalError('DEADLINE_EXCEEDED', `${label} deadline exceeded`))
        })
      const abort = () => {
        if (this.#clock.now() >= deadline) {
          deadlineFailure()
          return
        }
        finish(() => {
          stop()
          reject(new TerminalError('CANCELLED', `${label} cancelled`))
        })
      }
      const timeout = () => {
        const remaining = deadline - this.#clock.now()
        if (remaining > 0) {
          timer = this.#clock.set(remaining, timeout)
          return
        }
        deadlineFailure()
      }
      timer = this.#clock.set(timeoutMs, timeout)
      for (const signal of signals) addEventListener.call(signal, 'abort', abort, { once: true })
      if (signals.some((signal) => intrinsicAbortSignalAborted.call(signal))) abort()
      operation.then(
        (value) => {
          if (this.#clock.now() >= deadline) deadlineFailure()
          else finish(() => resolve(value))
        },
        () => {
          if (this.#clock.now() >= deadline) deadlineFailure()
          else finish(() => reject(new TerminalError(failureCode, `${label} failed`)))
        }
      )
    })
  }
}
