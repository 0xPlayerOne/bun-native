import { Worker } from 'node:worker_threads'
import { spawn } from 'node:child_process'
import { isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ManagedError,
  ManagedGenerationOwner,
  type ManagedGeneration,
  type ManagedResource,
  type ManagedWork,
} from './managed-generations.ts'
import {
  SERVICE_CHANNEL_DEFAULTS,
  decodeServiceMessage,
  encodeServiceMessage,
  serviceErrorDetail,
  serviceInteger,
  serviceJson,
  serviceLabel,
  type ServiceChannelLimits,
} from './service-reload-protocol.ts'
export type {
  ServiceApplication,
  ServiceCallContext,
  ServiceDefinition,
  ServiceGenerationContext,
  ServiceHandler,
} from './service-reload-protocol.ts'

export type ServiceReloadStage =
  | 'prepare'
  | 'validate'
  | 'quiesce'
  | 'commit'
  | 'retire'
  | 'request'
  | 'shutdown'
export type ServiceReloadCode =
  | 'INVALID_ARGUMENT'
  | 'BUSY'
  | 'CAPACITY'
  | 'NOT_ACTIVE'
  | 'QUIESCING'
  | 'CANCELLED'
  | 'RETIRED'
  | 'TIMEOUT'
  | 'PREPARE_FAILED'
  | 'INCOMPATIBLE'
  | 'APPLICATION_FAILED'
  | 'PROTOCOL_ERROR'
  | 'CLEANUP_FAILED'
  | 'RESTART_REQUIRED'
  | 'CLOSED'
export class ServiceReloadError extends Error {
  override readonly name = 'ServiceReloadError'
  /** False means artifact files must be retained until explicit recovery. */
  candidateRetired = true
  /** True means the new generation was published; never automatically replay or roll it back. */
  committed = false
  constructor(
    readonly code: ServiceReloadCode,
    readonly stage: ServiceReloadStage,
    readonly restartRequired = false,
    readonly detail?: string
  ) {
    super(
      `${code} during ${stage}. ${restartRequired ? 'Controlled desktop restart required; resource persistence is not guaranteed.' : 'No mutation was automatically replayed.'}`
    )
  }
}
export interface ServiceResourceAttachment {
  readonly resource: ManagedResource
  readonly schema: string
  /** Stable-owner, read-only native authority validation; never sent to application code. */
  readonly validate?: () => void | Promise<void>
  /** Final synchronous document/policy check after asynchronous readiness and quiescence. */
  readonly current?: () => boolean
}
export type ServiceResourceAttachments = Readonly<Record<string, ServiceResourceAttachment>>
export interface ServiceReloadDiagnostic {
  readonly event: 'stage' | 'failure' | 'forced-termination'
  readonly generation: number
  readonly stage: ServiceReloadStage
  readonly elapsedMs: number
  readonly code?: ServiceReloadCode
  readonly restartRequired?: boolean
  /** Bounded source-mapped local diagnostic; omit from public measurement records. */
  readonly detail?: string
}
export interface ServiceReloadOptions {
  readonly owner: ManagedGenerationOwner
  readonly stateSchema: string
  readonly permissions: readonly string[]
  readonly resources?: ServiceResourceAttachments
  readonly initialState?: string
  readonly mechanism?: 'worker' | 'process'
  /** Bundle this private entry separately when bundling the stable host. */
  readonly runner?: string
  readonly readyTimeoutMs?: number
  readonly quiesceTimeoutMs?: number
  readonly retireTimeoutMs?: number
  readonly exitTimeoutMs?: number
  readonly requestTimeoutMs?: number
  readonly limits?: Partial<ServiceChannelLimits>
  readonly onDiagnostic?: (event: ServiceReloadDiagnostic) => void
}
export interface ServiceReloadInput {
  readonly entry: string
  readonly state?: string
  /** Trusted owner replacement map, prepared with current native authority before this call. */
  readonly resources?: ServiceResourceAttachments
}
export interface ServiceReloadResult {
  readonly generation: number
  readonly mechanism: 'worker' | 'process'
  readonly handlers: readonly string[]
  readonly replaced: boolean
}
interface Deferred<T> {
  promise: Promise<T>
  resolve(value: T): void
  reject(error: unknown): void
}
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  void promise.catch(() => {})
  return { promise, resolve, reject }
}
function milliseconds(value: number | undefined, fallback: number): number {
  const result = value ?? fallback
  if (!serviceInteger(result) || result > 60000)
    throw new ServiceReloadError('INVALID_ARGUMENT', 'prepare')
  return result
}
async function deadline<T>(
  promise: Promise<T>,
  ms: number,
  failure: ServiceReloadError
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(failure), ms)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
interface Isolate {
  send(wire: string): void
  terminate(): void
  readonly exited: Promise<void>
  removeListeners(): void
}
interface Generation {
  readonly number: number
  readonly identity: ManagedGeneration
  readonly resources: ReadonlyMap<string, ServiceResourceAttachment>
  readonly entry: string
  readonly state: string | undefined
  readonly started: number
  readonly ready: Deferred<{ schema: string; state: string; handlers: readonly string[] }>
  readonly retired: Deferred<{ ok: boolean; detail?: string }>
  isolate?: Isolate
  phase: 'preparing' | 'active' | 'retired'
  stage: ServiceReloadStage
  handlers: ReadonlySet<string>
  lastInvocation: number
  hostCalls: number
  outputBytes: number
  stopped?: Promise<void>
  lifetimeWork?: ManagedWork
  failure?: ServiceReloadError
  exited: boolean
}
interface Request {
  readonly id: number
  readonly generation: Generation
  readonly completion: Deferred<string>
  timer?: ReturnType<typeof setTimeout>
  removeAbort?: () => void
  settled: boolean
}

/** One stable supervisor; generation code never receives this object or native resource handles. */
export class ServiceReloadHost {
  readonly #owner: ManagedGenerationOwner
  readonly #schema: string
  readonly #permissions: readonly string[]
  readonly #resources: ReadonlyMap<string, ServiceResourceAttachment>
  readonly #initialState: string
  readonly #mechanism: 'worker' | 'process'
  readonly #runner: string
  readonly #limits: ServiceChannelLimits
  readonly #readyMs: number
  readonly #quiesceMs: number
  readonly #retireMs: number
  readonly #exitMs: number
  readonly #requestMs: number
  readonly #onDiagnostic: ((event: ServiceReloadDiagnostic) => void) | undefined
  readonly #generations = new Set<Generation>()
  readonly #requests = new Map<number, Request>()
  #nextGeneration = 0
  #nextRequest = 0
  #active: Generation | undefined
  #candidate: Generation | undefined
  #reloading = false
  #quiescing = false
  #closed = false
  #closing: Promise<void> | undefined
  #forcedTerminations = 0

  constructor(options: ServiceReloadOptions) {
    if (
      !(options.owner instanceof ManagedGenerationOwner) ||
      !serviceLabel(options.stateSchema) ||
      !Array.isArray(options.permissions) ||
      options.permissions.length > 64 ||
      options.permissions.some((permission) => !serviceLabel(permission))
    )
      throw new ServiceReloadError('INVALID_ARGUMENT', 'prepare')
    this.#owner = options.owner
    this.#schema = options.stateSchema
    this.#permissions = Object.freeze([...options.permissions])
    this.#mechanism = options.mechanism ?? 'worker'
    if (!['worker', 'process'].includes(this.#mechanism))
      throw new ServiceReloadError('INVALID_ARGUMENT', 'prepare')
    this.#runner =
      options.runner ??
      fileURLToPath(
        new URL(
          import.meta.path.endsWith('.ts')
            ? './service-reload-runner.ts'
            : './service-reload-runner.js',
          import.meta.url
        )
      )
    if (!isAbsolute(this.#runner) || this.#runner.length > 4096)
      throw new ServiceReloadError('INVALID_ARGUMENT', 'prepare')
    this.#limits = Object.freeze({ ...SERVICE_CHANNEL_DEFAULTS, ...options.limits })
    const ceilings: ServiceChannelLimits = {
      payloadBytes: 1048576,
      messageBytes: 8388608,
      requests: 4096,
      handlers: 4096,
      cleanup: 4096,
    }
    for (const key of ['payloadBytes', 'messageBytes', 'requests', 'handlers', 'cleanup'] as const)
      if (!serviceInteger(this.#limits[key]) || this.#limits[key] > ceilings[key])
        throw new ServiceReloadError('INVALID_ARGUMENT', 'prepare')
    if (this.#limits.messageBytes < this.#limits.payloadBytes + 16384)
      throw new ServiceReloadError('INVALID_ARGUMENT', 'prepare')
    this.#initialState = options.initialState ?? '{}'
    if (!serviceJson(this.#initialState, this.#limits.payloadBytes))
      throw new ServiceReloadError('INVALID_ARGUMENT', 'prepare')
    this.#resources = this.#attachments(options.resources ?? {})
    this.#readyMs = milliseconds(options.readyTimeoutMs, 5000)
    this.#quiesceMs = milliseconds(options.quiesceTimeoutMs, 2000)
    this.#retireMs = milliseconds(options.retireTimeoutMs, 1000)
    this.#exitMs = milliseconds(options.exitTimeoutMs, 2000)
    this.#requestMs = milliseconds(options.requestTimeoutMs, 10000)
    this.#onDiagnostic = options.onDiagnostic
  }
  #attachments(input: ServiceResourceAttachments): ReadonlyMap<string, ServiceResourceAttachment> {
    if (!input || typeof input !== 'object' || Array.isArray(input))
      throw new ServiceReloadError('INVALID_ARGUMENT', 'prepare')
    const names = Object.keys(input)
    if (names.length > 4096) throw new ServiceReloadError('CAPACITY', 'prepare')
    const result = new Map<string, ServiceResourceAttachment>()
    for (const name of names) {
      const item = input[name]
      if (
        !serviceLabel(name) ||
        !item ||
        !serviceLabel(item.schema) ||
        !item.resource ||
        (item.validate !== undefined && typeof item.validate !== 'function') ||
        (item.current !== undefined && typeof item.current !== 'function')
      )
        throw new ServiceReloadError('INVALID_ARGUMENT', 'prepare')
      result.set(
        name,
        Object.freeze({
          resource: item.resource,
          schema: item.schema,
          ...(item.validate ? { validate: item.validate } : {}),
          ...(item.current ? { current: item.current } : {}),
        })
      )
    }
    return result
  }
  #emit(
    row: Generation,
    event: ServiceReloadDiagnostic['event'],
    failure?: ServiceReloadError
  ): void {
    try {
      this.#onDiagnostic?.(
        Object.freeze({
          event,
          generation: row.number,
          stage: failure?.stage ?? row.stage,
          elapsedMs: performance.now() - row.started,
          ...(failure
            ? {
                code: failure.code,
                restartRequired: failure.restartRequired,
                ...(failure.detail ? { detail: failure.detail } : {}),
              }
            : {}),
        })
      )
    } catch {
      /* Diagnostics cannot change admission or lifecycle. */
    }
  }
  #stage(row: Generation, stage: ServiceReloadStage): void {
    row.stage = stage
    this.#emit(row, 'stage')
  }
  #send(row: Generation, message: Record<string, unknown>): void {
    if (row.exited || !row.isolate) throw new ServiceReloadError('APPLICATION_FAILED', row.stage)
    row.isolate.send(encodeServiceMessage(message, this.#limits.messageBytes))
  }
  #output(row: Generation, bytes: Uint8Array): void {
    // Consume output without forwarding it into the native desktop protocol or retaining app data.
    row.outputBytes += bytes.byteLength
    if (row.outputBytes > 1048576)
      this.#fail(
        row,
        new ServiceReloadError(
          'CAPACITY',
          row.stage,
          false,
          'Generation output exceeded 1 MiB; use an explicitly managed log sink.'
        )
      )
  }
  #launch(row: Generation): Isolate {
    const exited = deferred<void>()
    const env = { ...process.env, BUNLY_NATIVE_STDIO: undefined }
    if (this.#mechanism === 'worker') {
      const worker = new Worker(this.#runner, { stdout: true, stderr: true, env })
      worker.on('message', (raw: unknown) => this.#receive(row, raw))
      worker.on('error', (failure) =>
        this.#fail(
          row,
          new ServiceReloadError(
            'APPLICATION_FAILED',
            row.stage,
            false,
            serviceErrorDetail(failure)
          )
        )
      )
      worker.stdout?.on('data', (bytes: Buffer) => this.#output(row, bytes))
      worker.stderr?.on('data', (bytes: Buffer) => this.#output(row, bytes))
      worker.once('exit', () => {
        row.exited = true
        exited.resolve()
        this.#exited(row)
      })
      return {
        send: (wire) => worker.postMessage(wire),
        terminate: () => {
          void worker.terminate().catch((failure: unknown) => exited.reject(failure))
        },
        exited: exited.promise,
        removeListeners: () => {
          worker.removeAllListeners()
          worker.stdout?.removeAllListeners()
          worker.stderr?.removeAllListeners()
        },
      }
    }
    const child = spawn(process.execPath, [this.#runner], {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env,
      windowsHide: true,
    })
    child.on('message', (raw: unknown) => this.#receive(row, raw))
    child.on('error', (failure) =>
      this.#fail(
        row,
        new ServiceReloadError('APPLICATION_FAILED', row.stage, false, serviceErrorDetail(failure))
      )
    )
    child.stdout?.on('data', (bytes: Buffer) => this.#output(row, bytes))
    child.stderr?.on('data', (bytes: Buffer) => this.#output(row, bytes))
    // 'close' follows process exit and stdio closure, rather than merely a signal request.
    child.once('close', () => {
      row.exited = true
      exited.resolve()
      this.#exited(row)
    })
    return {
      send: (wire) => {
        if (!child.connected) throw new ServiceReloadError('APPLICATION_FAILED', row.stage)
        child.send(wire, (failure) => {
          if (failure && row.phase !== 'retired')
            this.#fail(
              row,
              new ServiceReloadError(
                'APPLICATION_FAILED',
                row.stage,
                false,
                serviceErrorDetail(failure)
              )
            )
        })
      },
      terminate: () => {
        child.kill('SIGKILL')
      },
      exited: exited.promise,
      removeListeners: () => {
        child.removeAllListeners()
        child.stdout?.removeAllListeners()
        child.stderr?.removeAllListeners()
      },
    }
  }
  #exited(row: Generation): void {
    for (const request of this.#requests.values())
      if (request.generation === row) {
        this.#settle(request, new ServiceReloadError('APPLICATION_FAILED', 'request'))
        this.#requests.delete(request.id)
      }
    if (row.phase !== 'retired')
      this.#fail(
        row,
        new ServiceReloadError(
          'APPLICATION_FAILED',
          row.stage,
          false,
          'Application generation exited before retirement.'
        )
      )
  }
  #fail(row: Generation, failure: ServiceReloadError): void {
    if (row.failure || row.phase === 'retired') return
    row.failure = failure
    row.ready.reject(failure)
    this.#emit(row, 'failure', failure)
    if (this.#active === row) {
      this.#active = undefined
      this.#owner.retire(row.identity)
      for (const request of this.#requests.values())
        if (request.generation === row) this.#settle(request, failure)
    }
    void this.#stop(row).catch(() => {})
  }
  #receive(row: Generation, raw: unknown): void {
    try {
      const message = decodeServiceMessage(raw, this.#limits.messageBytes)
      if (row.phase === 'retired' && message['type'] !== 'retired') return
      switch (message['type']) {
        case 'boot':
          if (row.phase !== 'preparing' || row.stage !== 'prepare')
            throw new Error('Unexpected boot')
          this.#send(row, {
            type: 'initialize',
            entry: row.entry,
            state: row.state,
            limits: this.#limits,
          })
          break
        case 'ready': {
          const handlers = message['handlers']
          if (
            row.phase !== 'preparing' ||
            !serviceLabel(message['schema']) ||
            !serviceJson(message['state'], this.#limits.payloadBytes) ||
            !Array.isArray(handlers) ||
            handlers.length === 0 ||
            handlers.length > this.#limits.handlers ||
            handlers.some((name) => !serviceLabel(name)) ||
            new Set(handlers).size !== handlers.length
          )
            throw new Error('Invalid readiness declaration')
          row.ready.resolve({
            schema: message['schema'],
            state: message['state'],
            handlers: Object.freeze([...handlers]) as readonly string[],
          })
          break
        }
        case 'failure':
          if (typeof message['detail'] !== 'string' || message['detail'].length > 8192)
            throw new Error('Invalid failure')
          this.#fail(
            row,
            new ServiceReloadError(
              row.phase === 'preparing' ? 'PREPARE_FAILED' : 'APPLICATION_FAILED',
              row.stage,
              false,
              message['detail']
            )
          )
          break
        case 'retired':
          if (
            typeof message['ok'] !== 'boolean' ||
            (message['detail'] !== undefined &&
              (typeof message['detail'] !== 'string' || message['detail'].length > 8192))
          )
            throw new Error('Invalid retirement receipt')
          row.retired.resolve({
            ok: message['ok'],
            ...(typeof message['detail'] === 'string' ? { detail: message['detail'] } : {}),
          })
          break
        case 'result':
          this.#result(row, message)
          break
        case 'invoke':
          this.#invoke(row, message)
          break
        default:
          throw new Error('Unknown generation message')
      }
    } catch (failure) {
      this.#fail(
        row,
        new ServiceReloadError('PROTOCOL_ERROR', row.stage, false, serviceErrorDetail(failure))
      )
    }
  }
  #result(row: Generation, message: Record<string, unknown>): void {
    const id = message['id']
    if (!serviceInteger(id) || typeof message['ok'] !== 'boolean') throw new Error('Invalid result')
    const request = this.#requests.get(id)
    if (!request || request.generation !== row) return
    if (message['ok']) {
      if (!serviceJson(message['output'], this.#limits.payloadBytes))
        throw new Error('Invalid output')
      if (!request.settled && this.#active === row && !this.#quiescing)
        this.#settle(request, undefined, message['output'])
      else this.#settle(request, new ServiceReloadError('RETIRED', 'request'))
    } else {
      if (typeof message['detail'] !== 'string' || message['detail'].length > 8192)
        throw new Error('Invalid error result')
      this.#settle(
        request,
        new ServiceReloadError('APPLICATION_FAILED', 'request', false, message['detail'])
      )
    }
    this.#requests.delete(id)
  }
  #invoke(row: Generation, message: Record<string, unknown>): void {
    const id = message['id'],
      call = message['request'],
      name = message['resource'],
      operation = message['operation'],
      input = message['input']
    if (
      !serviceInteger(id) ||
      id <= row.lastInvocation ||
      (call !== null && !serviceInteger(call)) ||
      !serviceLabel(name) ||
      !serviceLabel(operation) ||
      !serviceJson(input, this.#limits.payloadBytes)
    )
      throw new Error('Invalid resource invocation')
    row.lastInvocation = id
    const request = call === null ? undefined : this.#requests.get(call)
    const attachment = row.resources.get(name)
    let code: string | undefined
    if (
      row !== this.#active ||
      this.#quiescing ||
      row.phase !== 'active' ||
      (call !== null && (!request || request.generation !== row || request.settled))
    )
      code = 'RETIRED'
    else if (!attachment) code = 'DENIED'
    else if (row.hostCalls >= this.#limits.requests) code = 'CAPACITY'
    if (code) {
      this.#send(row, { type: 'invocation-result', id, ok: false, code })
      return
    }
    row.hostCalls++
    void this.#owner
      .invoke(row.identity, attachment!.resource, operation, input)
      .then(
        (output) => {
          if (row.phase === 'active' && !row.exited)
            this.#send(row, { type: 'invocation-result', id, ok: true, output })
        },
        (failure: unknown) => {
          if (row.phase === 'active' && !row.exited)
            this.#send(row, {
              type: 'invocation-result',
              id,
              ok: false,
              code: failure instanceof ManagedError ? failure.code : 'ADAPTER_FAILED',
            })
        }
      )
      .catch((failure: unknown) =>
        this.#fail(
          row,
          new ServiceReloadError('PROTOCOL_ERROR', row.stage, false, serviceErrorDetail(failure))
        )
      )
      .finally(() => {
        row.hostCalls--
      })
  }
  #settle(request: Request, failure?: ServiceReloadError, output?: string): void {
    if (request.settled) return
    request.settled = true
    if (request.timer) clearTimeout(request.timer)
    request.removeAbort?.()
    if (failure) request.completion.reject(failure)
    else request.completion.resolve(output!)
  }
  #cancel(request: Request, failure: ServiceReloadError): void {
    if (request.settled) return
    this.#settle(request, failure)
    try {
      this.#send(request.generation, { type: 'cancel', id: request.id })
    } catch {
      /* Exit settles remaining reservations. */
    }
    // Keep the slot until the handler actually returns or its generation actually exits.
  }
  async #quiesce(row: Generation): Promise<void> {
    this.#quiescing = true
    for (const request of this.#requests.values())
      this.#cancel(request, new ServiceReloadError('RETIRED', 'request'))
    const controller = new AbortController()
    try {
      await deadline(
        this.#owner.whenIdle(controller.signal),
        this.#quiesceMs,
        new ServiceReloadError(
          'RESTART_REQUIRED',
          'quiesce',
          true,
          'A stable-owner adapter is still unsettled; its reservation remains charged.'
        )
      )
    } finally {
      controller.abort()
    }
    if (row.failure) throw row.failure
  }
  async #validateAttachments(row: Generation): Promise<void> {
    if (![...row.resources.values()].some((attachment) => attachment.validate)) return
    const validating = deferred<void>()
    // Reserve before scheduling any validator: rejected admission must not start host work.
    // A timed-out host validator is still real unsettled work, even if its Worker exited.
    const work = this.#owner.own(row.identity, 'request', () =>
      validating.promise.then(
        () => {},
        () => {}
      )
    )
    void Promise.resolve()
      .then(async () => {
        for (const attachment of row.resources.values()) {
          if (this.#closed || row.phase !== 'preparing')
            throw new ServiceReloadError('CLOSED', 'validate')
          await attachment.validate?.()
        }
      })
      .then(validating.resolve, validating.reject)
    void validating.promise.finally(() => this.#owner.release(row.identity, work)).catch(() => {})
    await deadline(
      validating.promise,
      this.#readyMs,
      new ServiceReloadError(
        'RESTART_REQUIRED',
        'validate',
        true,
        'Native attachment validation is still unsettled.'
      )
    )
  }
  #stop(row: Generation): Promise<void> {
    if (row.stopped) return row.stopped
    row.phase = 'retired'
    if (this.#active === row) this.#active = undefined
    row.stopped = (async () => {
      let receipt: { ok: boolean; detail?: string } | undefined
      if (row.isolate && !row.exited) {
        try {
          this.#send(row, { type: 'retire' })
          receipt = await deadline(
            row.retired.promise,
            this.#retireMs,
            new ServiceReloadError('TIMEOUT', 'retire')
          )
        } catch {
          this.#forcedTerminations++
          this.#emit(row, 'forced-termination')
        }
        row.isolate.terminate()
      }
      if (row.isolate) {
        await deadline(
          row.isolate.exited,
          this.#exitMs,
          new ServiceReloadError(
            'RESTART_REQUIRED',
            'retire',
            true,
            'Generation exit could not be observed.'
          )
        )
        row.isolate.removeListeners()
      }
      if (receipt && !receipt.ok)
        throw new ServiceReloadError('CLEANUP_FAILED', 'retire', true, receipt.detail)
      this.#generations.delete(row)
    })()
    void row.stopped.catch(() => {})
    return row.stopped
  }
  async #releaseGeneration(row: Generation): Promise<void> {
    await this.#stop(row)
    if (!row.lifetimeWork) return
    try {
      await this.#owner.release(row.identity, row.lifetimeWork)
    } catch (failure) {
      // Retirement may already have completed this exact known reservation.
      if (!(failure instanceof ManagedError && failure.code === 'INVALID_IDENTITY')) throw failure
    }
  }

  async reload(input: ServiceReloadInput): Promise<ServiceReloadResult> {
    if (this.#closed) throw new ServiceReloadError('CLOSED', 'prepare')
    if (this.#reloading) throw new ServiceReloadError('BUSY', 'prepare')
    if (this.#owner.diagnostics().failedCleanup)
      throw new ServiceReloadError(
        'RESTART_REQUIRED',
        'prepare',
        true,
        'Earlier cleanup failed and remains charged.'
      )
    if (
      !input ||
      typeof input.entry !== 'string' ||
      !isAbsolute(input.entry) ||
      input.entry.length > 4096 ||
      (input.state !== undefined && !serviceJson(input.state, this.#limits.payloadBytes))
    )
      throw new ServiceReloadError('INVALID_ARGUMENT', 'prepare')
    if (this.#nextGeneration >= Number.MAX_SAFE_INTEGER)
      throw new ServiceReloadError('CAPACITY', 'prepare')
    const resources = input.resources ? this.#attachments(input.resources) : this.#resources
    let identity: ManagedGeneration
    try {
      identity = this.#owner.begin(this.#schema, this.#permissions)
    } catch (failure) {
      throw new ServiceReloadError(
        failure instanceof ManagedError && failure.code === 'CAPACITY'
          ? 'CAPACITY'
          : 'INCOMPATIBLE',
        'prepare',
        false,
        serviceErrorDetail(failure)
      )
    }
    let state: string
    try {
      state = input.state ?? this.#owner.state(identity) ?? this.#initialState
    } catch (failure) {
      this.#owner.retire(identity)
      throw new ServiceReloadError('INCOMPATIBLE', 'prepare', false, serviceErrorDetail(failure))
    }
    this.#reloading = true
    const row: Generation = {
      number: ++this.#nextGeneration,
      identity,
      resources,
      entry: input.entry,
      state,
      started: performance.now(),
      ready: deferred(),
      retired: deferred(),
      phase: 'preparing',
      stage: 'prepare',
      handlers: new Set(),
      lastInvocation: 0,
      hostCalls: 0,
      outputBytes: 0,
      exited: false,
    }
    const previous = this.#active
    let committed = false
    this.#candidate = row
    this.#generations.add(row)
    try {
      for (const attachment of resources.values())
        this.#owner.attach(identity, attachment.resource, attachment.schema)
      row.lifetimeWork = this.#owner.own(identity, 'state', () => this.#stop(row))
      row.isolate = this.#launch(row)
      this.#stage(row, 'prepare')
      const prepared = await deadline(
        row.ready.promise,
        this.#readyMs,
        new ServiceReloadError('TIMEOUT', 'prepare')
      )
      this.#stage(row, 'validate')
      if (prepared.schema !== this.#schema) throw new ServiceReloadError('INCOMPATIBLE', 'validate')
      await this.#validateAttachments(row)
      if (this.#closed || row.failure || row.phase === 'retired')
        throw row.failure ?? new ServiceReloadError('CLOSED', 'prepare')
      row.handlers = new Set(prepared.handlers)
      this.#stage(row, 'quiesce')
      await this.#quiesce(row)
      if (this.#closed || row.failure || row.exited)
        throw row.failure ?? new ServiceReloadError('CLOSED', 'quiesce')
      this.#stage(row, 'commit')
      if (this.#closed) throw new ServiceReloadError('CLOSED', 'commit')
      for (const attachment of resources.values())
        if (attachment.current) {
          const current: unknown = attachment.current()
          if (current !== true) {
            // A mistakenly asynchronous gate is denied, and its rejection is observed.
            if (current && (typeof current === 'object' || typeof current === 'function'))
              void Promise.resolve(current).catch(() => {})
            throw new ServiceReloadError(
              'INCOMPATIBLE',
              'commit',
              false,
              'Attachment authority changed during preparation.'
            )
          }
        }
      if (this.#closed || row.failure || row.exited)
        throw row.failure ?? new ServiceReloadError('CLOSED', 'commit')
      // No asynchronous boundary or application callback between owner publication and routing.
      this.#owner.commit(identity, prepared.state)
      committed = true
      if (this.#closed || this.#owner.scope(identity).signal.aborted)
        throw new ServiceReloadError(
          'RESTART_REQUIRED',
          'commit',
          true,
          'The committed generation was synchronously revoked.'
        )
      row.phase = 'active'
      this.#active = row
      this.#candidate = undefined
      this.#send(row, { type: 'activate' })
      this.#quiescing = false
      this.#stage(row, 'retire')
      if (previous) await this.#releaseGeneration(previous)
      if (row.failure || this.#closed)
        throw row.failure ?? new ServiceReloadError('CLOSED', 'retire')
      row.stage = 'request'
      return Object.freeze({
        generation: row.number,
        mechanism: this.#mechanism,
        handlers: prepared.handlers,
        replaced: previous !== undefined,
      })
    } catch (failure) {
      let problem =
        failure instanceof ServiceReloadError
          ? failure
          : new ServiceReloadError(
              failure instanceof ManagedError && failure.code === 'BUSY'
                ? 'RESTART_REQUIRED'
                : 'INCOMPATIBLE',
              row.stage,
              failure instanceof ManagedError && failure.code === 'BUSY',
              serviceErrorDetail(failure)
            )
      problem.committed = committed
      if (!committed) {
        this.#owner.retire(identity)
        try {
          await this.#releaseGeneration(row)
        } catch (cleanup) {
          problem = new ServiceReloadError(
            'CLEANUP_FAILED',
            'retire',
            true,
            serviceErrorDetail(cleanup)
          )
          problem.candidateRetired = row.exited
        }
      } else {
        problem.candidateRetired = false
        if (!problem.restartRequired) {
          const restart = new ServiceReloadError(
            'RESTART_REQUIRED',
            problem.stage,
            true,
            problem.detail
          )
          restart.committed = true
          restart.candidateRetired = false
          problem = restart
        }
      }
      if (committed && this.#active !== row) {
        this.#owner.retire(identity)
        try {
          await this.#releaseGeneration(row)
        } catch {
          /* Existing restart requirement retains uncertain cleanup. */
        }
      }
      this.#emit(row, 'failure', problem)
      throw problem
    } finally {
      if (this.#candidate === row) this.#candidate = undefined
      this.#reloading = false
      this.#quiescing = false
    }
  }
  request(
    handler: string,
    input: string,
    options: { readonly signal?: AbortSignal; readonly timeoutMs?: number } = {}
  ): Promise<string> {
    try {
      const row = this.#active
      if (this.#closed) throw new ServiceReloadError('CLOSED', 'request')
      if (this.#quiescing) throw new ServiceReloadError('QUIESCING', 'request')
      if (!row || row.phase !== 'active') throw new ServiceReloadError('NOT_ACTIVE', 'request')
      if (
        !serviceLabel(handler) ||
        !row.handlers.has(handler) ||
        !serviceJson(input, this.#limits.payloadBytes)
      )
        throw new ServiceReloadError('INVALID_ARGUMENT', 'request')
      if (options.signal?.aborted) throw new ServiceReloadError('CANCELLED', 'request')
      if (
        this.#requests.size >= this.#limits.requests ||
        this.#nextRequest >= Number.MAX_SAFE_INTEGER
      )
        throw new ServiceReloadError('CAPACITY', 'request')
      const timeoutMs = milliseconds(options.timeoutMs, this.#requestMs)
      const request: Request = {
        id: ++this.#nextRequest,
        generation: row,
        completion: deferred(),
        settled: false,
      }
      this.#requests.set(request.id, request)
      request.timer = setTimeout(
        () => this.#cancel(request, new ServiceReloadError('TIMEOUT', 'request')),
        timeoutMs
      )
      if (options.signal) {
        const signal = options.signal,
          abort = () => this.#cancel(request, new ServiceReloadError('CANCELLED', 'request'))
        signal.addEventListener('abort', abort, { once: true })
        request.removeAbort = () => signal.removeEventListener('abort', abort)
      }
      try {
        this.#send(row, { type: 'call', id: request.id, handler, input })
      } catch (failure) {
        this.#settle(
          request,
          new ServiceReloadError(
            'APPLICATION_FAILED',
            'request',
            false,
            serviceErrorDetail(failure)
          )
        )
        this.#requests.delete(request.id)
      }
      return request.completion.promise
    } catch (failure) {
      return Promise.reject(failure)
    }
  }
  /** Events share acknowledged request limits; overflow and transition rejection are explicit. */
  dispatchEvent(
    handler: string,
    input: string,
    options: { readonly signal?: AbortSignal; readonly timeoutMs?: number } = {}
  ): Promise<string> {
    return this.request(handler, input, options)
  }
  close(): Promise<void> {
    return (this.#closing ??= (async () => {
      this.#closed = true
      this.#quiescing = true
      this.#active = undefined
      for (const request of this.#requests.values())
        this.#cancel(request, new ServiceReloadError('CLOSED', 'shutdown'))
      const generations = [...this.#generations]
      for (const row of generations) {
        this.#stage(row, 'shutdown')
        row.ready.reject(new ServiceReloadError('CLOSED', 'shutdown'))
        this.#owner.retire(row.identity)
      }
      const stopped = await Promise.allSettled(
        generations.map((row) => this.#releaseGeneration(row))
      )
      if (
        stopped.some((result) => result.status === 'rejected') ||
        this.#owner.diagnostics().inFlight ||
        this.#owner.diagnostics().failedCleanup ||
        this.#owner.diagnostics().generations
      )
        throw new ServiceReloadError(
          'RESTART_REQUIRED',
          'shutdown',
          true,
          'Generation or stable-owner cleanup remains unresolved; reservations are retained.'
        )
    })())
  }
  diagnostics() {
    return Object.freeze({
      closed: this.#closed,
      reloading: this.#reloading,
      quiescing: this.#quiescing,
      active: this.#active?.number ?? null,
      candidate: this.#candidate?.number ?? null,
      generations: this.#generations.size,
      requests: this.#requests.size,
      unsettledCallers: [...this.#requests.values()].filter((request) => !request.settled).length,
      hostCalls: [...this.#generations].reduce((sum, row) => sum + row.hostCalls, 0),
      forcedTerminations: this.#forcedTerminations,
      mechanism: this.#mechanism,
      owner: this.#owner.diagnostics(),
    })
  }
}
