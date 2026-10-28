import { AsyncLocalStorage } from 'node:async_hooks'

/** Trusted-code ownership only: not a loader, renderer authenticator, or sandbox. */
declare const brand: unique symbol
export interface ManagedIdentity<K extends 'generation' | 'resource' | 'work'> {
  readonly [brand]: K
}
export type ManagedGeneration = ManagedIdentity<'generation'>
export type ManagedResource = ManagedIdentity<'resource'>
export type ManagedWork = ManagedIdentity<'work'>
export type ManagedResourceKind =
  | 'window'
  | 'view'
  | 'session'
  | 'terminal'
  | 'process'
  | 'clipboard'
  | 'commands'
  | 'dialog'
export type ManagedCleanupKind = 'handler' | 'listener' | 'timer' | 'request' | 'state'
export type ManagedErrorCode =
  | 'INVALID_ARGUMENT'
  | 'INVALID_IDENTITY'
  | 'RETIRED'
  | 'NOT_ACTIVE'
  | 'CAPACITY'
  | 'INCOMPATIBLE'
  | 'DENIED'
  | 'DISPOSED'
  | 'BUSY'
  | 'ADAPTER_FAILED'
  | 'CLEANUP_FAILED'
export class ManagedError extends Error {
  constructor(readonly code: ManagedErrorCode) {
    super(code)
    this.name = 'ManagedError'
  }
}
export interface ManagedCallContext {
  readonly generation: ManagedGeneration
  readonly signal: AbortSignal
  /** Recheck after an asynchronous boundary before a managed side effect. */
  readonly isCurrent: () => boolean
}
export interface ManagedResourceDefinition {
  readonly kind: ManagedResourceKind
  readonly schema: string
  readonly permission: string
  /** Existing owner resources that must outlive this resource. Registration forms a DAG. */
  readonly dependsOn?: readonly ManagedResource[]
  /** Revalidate current native/document authority, not just the generation's permission label. */
  readonly authorize: (operation: string, context: ManagedCallContext) => boolean
  /** Stable owner adapter. Raw native handles never cross this bounded JSON boundary. */
  readonly invoke: (
    operation: string,
    input: string,
    context: ManagedCallContext
  ) => string | Promise<string>
  /** Resolve only after actual release; rejection leaves the resource charged. Must be retry-safe. */
  readonly dispose: () => void | Promise<void>
}
export interface ManagedLimits {
  readonly resources: number
  readonly generations: number
  readonly work: number
  /** Maximum UTF-8 bytes for each state/input/output snapshot. */
  readonly stateBytes: number
}
export interface ManagedGenerationScope {
  readonly generation: ManagedGeneration
  readonly signal: AbortSignal
  state(): string | undefined
  invoke(resource: ManagedResource, operation: string, input: string): Promise<string>
  own(kind: ManagedCleanupKind, cleanup: () => void | Promise<void>): ManagedWork
  release(work: ManagedWork): Promise<void>
  callback(work: ManagedWork, callback: () => undefined): () => boolean
}
interface Deferred<T> {
  promise: Promise<T>
  resolve(value: T): void
  reject(reason: ManagedError): void
}
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (reason: ManagedError) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  // Framework cancellation can precede the consumer attaching its observer.
  void promise.catch(() => {})
  return { promise, resolve, reject }
}
interface Resource extends ManagedResourceDefinition {
  readonly dependencies: readonly ManagedResource[]
  closing: boolean
  busy: number
  cleanup: 'idle' | 'pending' | 'failed'
  completion?: Deferred<void>
}
interface Generation {
  phase: 'preparing' | 'active' | 'retired'
  invalidated: boolean
  schema: string
  permissions: Set<string>
  attachments: Map<ManagedResource, object>
  controller: AbortController
}
interface Work {
  generation: ManagedGeneration
  kind: ManagedCleanupKind
  cleanup?: () => void | Promise<void>
  state: 'owned' | 'pending' | 'failed'
  completion?: Deferred<void>
  resource?: ManagedResource
  cancel?: () => void
}
const defaults: ManagedLimits = { resources: 64, generations: 4, work: 256, stateBytes: 65536 }
const identity = <K extends 'generation' | 'resource' | 'work'>(): ManagedIdentity<K> =>
  Object.freeze({}) as ManagedIdentity<K>
function fail(code: ManagedErrorCode): never {
  throw new ManagedError(code)
}
function label(value: string): void {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(value)) fail('INVALID_ARGUMENT')
}

/** One stable Bun owner; the candidate may attach/read snapshots but cannot invoke resources.
 * Calls admitted before retirement settle to RETIRED for their caller, while the underlying
 * operation remains charged until actual settlement. Unknown cleanup never becomes success.
 */
export class ManagedGenerationOwner {
  readonly #asOwner = AsyncLocalStorage.snapshot()
  readonly #limits: ManagedLimits
  readonly #resources = new Map<ManagedResource, Resource>()
  readonly #generations = new Map<ManagedGeneration, Generation>()
  readonly #knownGenerations = new WeakSet<ManagedGeneration>()
  readonly #knownResources = new WeakSet<ManagedResource>()
  readonly #work = new Map<ManagedWork, Work>()
  readonly #idleWaiters = new Map<Deferred<void>, () => void>()
  #candidate: ManagedGeneration | undefined
  #active: ManagedGeneration | undefined
  #state: string | undefined
  #stateSchema: string | undefined
  #closed = false

  constructor(limits: Partial<ManagedLimits> = {}) {
    // The stable owner's context must not itself be a disposable application graph.
    if (typeof Bun.ModuleGraph === 'function' && Bun.ModuleGraph.current !== undefined)
      fail('INVALID_ARGUMENT')
    this.#limits = Object.freeze({
      resources: limits.resources ?? defaults.resources,
      generations: limits.generations ?? defaults.generations,
      work: limits.work ?? defaults.work,
      stateBytes: limits.stateBytes ?? defaults.stateBytes,
    })
    const ceilings: ManagedLimits = {
      resources: 4096,
      generations: 64,
      work: 65536,
      stateBytes: 1048576,
    }
    for (const key of ['resources', 'generations', 'work', 'stateBytes'] as const) {
      const value = this.#limits[key]
      if (!Number.isSafeInteger(value) || value < 1 || value > ceilings[key])
        fail('INVALID_ARGUMENT')
    }
  }
  #open(): void {
    if (this.#closed) fail('DISPOSED')
  }
  #generation(id: ManagedGeneration): Generation {
    const entry = this.#generations.get(id)
    if (!entry) fail(this.#knownGenerations.has(id) ? 'RETIRED' : 'INVALID_IDENTITY')
    if (entry.phase === 'retired') fail('RETIRED')
    this.#open()
    return entry
  }
  #json(value: string): string {
    // Check code units before encoding, so malformed huge inputs do not trigger a huge allocation.
    if (
      typeof value !== 'string' ||
      value.length > this.#limits.stateBytes ||
      Buffer.byteLength(value, 'utf8') > this.#limits.stateBytes
    )
      fail('INVALID_ARGUMENT')
    try {
      JSON.parse(value)
    } catch {
      fail('INVALID_ARGUMENT')
    }
    return value
  }
  /** Stable-host authority. Never expose this object itself to replaceable code. */
  register(definition: ManagedResourceDefinition): ManagedResource {
    return this.#asOwner(() => {
      const { kind, schema, permission, authorize, invoke, dispose, dependsOn } = definition
      label(schema)
      label(permission)
      if (
        !['window', 'view', 'session', 'terminal', 'process', 'clipboard', 'commands', 'dialog'].includes(
          kind
        ) ||
        typeof authorize !== 'function' ||
        typeof invoke !== 'function' ||
        typeof dispose !== 'function'
      )
        fail('INVALID_ARGUMENT')
      const dependencies: ManagedResource[] = []
      if (dependsOn !== undefined) {
        if (!Array.isArray(dependsOn) || dependsOn.length > this.#limits.resources)
          fail('INVALID_ARGUMENT')
        const count = dependsOn.length
        for (let i = 0; i < count; i++) {
          const dependency = dependsOn[i]!
          if (dependencies.includes(dependency)) fail('INVALID_ARGUMENT')
          dependencies.push(dependency)
        }
      }
      this.#open()
      for (const dependency of dependencies) {
        const entry = this.#resources.get(dependency)
        if (!entry || entry.closing) fail('INVALID_IDENTITY')
      }
      if (this.#resources.size >= this.#limits.resources) fail('CAPACITY')
      const id = identity<'resource'>()
      this.#knownResources.add(id)
      this.#resources.set(id, {
        dependencies: Object.freeze(dependencies),
        kind,
        schema,
        permission,
        authorize,
        invoke,
        dispose,
        closing: false,
        busy: 0,
        cleanup: 'idle',
      })
      return id
    })
  }
  begin(schema: string, permissions: readonly string[]): ManagedGeneration {
    return this.#asOwner(() => {
      label(schema)
      if (!Array.isArray(permissions) || permissions.length > 64) fail('INVALID_ARGUMENT')
      const count = permissions.length
      const granted = new Set<string>()
      // Ignore custom iterators, and bound reads even for accessor-backed input arrays.
      for (let i = 0; i < count; i++) {
        const permission = permissions[i]!
        label(permission)
        granted.add(permission)
      }
      this.#open()
      if (this.#candidate || this.#generations.size >= this.#limits.generations) fail('CAPACITY')
      const id = identity<'generation'>()
      this.#knownGenerations.add(id)
      this.#generations.set(id, {
        phase: 'preparing',
        invalidated: false,
        schema,
        permissions: granted,
        attachments: new Map(),
        controller: new AbortController(),
      })
      this.#candidate = id
      return id
    })
  }
  attach(generation: ManagedGeneration, resource: ManagedResource, schema: string): void {
    this.#asOwner(() => {
      label(schema)
      const g = this.#generation(generation)
      const r = this.#resources.get(resource)
      if (!r || r.closing) fail('INVALID_IDENTITY')
      if (r.schema !== schema) fail('INCOMPATIBLE')
      if (!g.permissions.has(r.permission)) fail('DENIED')
      // Reattaching an already attached handle is idempotent. Detach creates a new epoch.
      if (!g.attachments.has(resource)) g.attachments.set(resource, Object.freeze({}))
    })
  }
  detach(generation: ManagedGeneration, resource: ManagedResource): void {
    this.#asOwner(() => {
      this.#generation(generation).attachments.delete(resource)
      // Abort listeners may synchronously reattach and admit new work. Snapshot
      // the detached epoch's jobs before callbacks so a fresh attachment is not
      // cancelled by the old detach, and this traversal cannot grow reentrantly.
      const detached = [...this.#work.values()].filter(
        (work) => work.generation === generation && work.resource === resource
      )
      for (const work of detached) work.cancel?.()
    })
  }
  /** No user callbacks run between validation and publication. No implicit state migration. */
  commit(generation: ManagedGeneration, state: string): void {
    this.#asOwner(() => {
      const snapshot = this.#json(state)
      const g = this.#generation(generation)
      if (this.#candidate !== generation || g.phase !== 'preparing') fail('NOT_ACTIVE')
      if (g.invalidated) fail('INCOMPATIBLE')
      if (this.#stateSchema !== undefined && this.#stateSchema !== g.schema) fail('INCOMPATIBLE')
      // A cancelled caller does not prove its adapter stopped. Refuse overlapping cutover.
      for (const work of this.#work.values()) if (work.resource !== undefined) fail('BUSY')
      for (const resource of g.attachments.keys()) {
        const r = this.#resources.get(resource)
        if (!r || r.closing || !g.permissions.has(r.permission)) fail('INCOMPATIBLE')
      }
      const previous = this.#active
      g.phase = 'active'
      this.#active = generation
      this.#candidate = undefined
      this.#state = snapshot
      this.#stateSchema = g.schema
      // Publish replacement first. Reentrant abort callbacks may dispose it, never resurrect it.
      if (previous) this.#retire(previous)
    })
  }
  state(generation: ManagedGeneration): string | undefined {
    return this.#asOwner(() => {
      const g = this.#generation(generation)
      if (this.#stateSchema !== undefined && this.#stateSchema !== g.schema) fail('INCOMPATIBLE')
      return this.#state
    })
  }
  scope(generation: ManagedGeneration): ManagedGenerationScope {
    const g = this.#generation(generation)
    return Object.freeze({
      generation,
      signal: g.controller.signal,
      state: () => this.state(generation),
      invoke: (resource: ManagedResource, operation: string, input: string) =>
        this.invoke(generation, resource, operation, input),
      own: (kind: ManagedCleanupKind, cleanup: () => void | Promise<void>) =>
        this.own(generation, kind, cleanup),
      release: (work: ManagedWork) => this.release(generation, work),
      callback: (work: ManagedWork, callback: () => undefined) =>
        this.callback(generation, work, callback),
    })
  }
  /** Reserve BEFORE installing external work. Cleanup must be idempotent for explicit retry. */
  own(
    generation: ManagedGeneration,
    kind: ManagedCleanupKind,
    cleanup: () => void | Promise<void>
  ): ManagedWork {
    return this.#asOwner(() => {
      this.#generation(generation)
      if (
        !['handler', 'listener', 'timer', 'request', 'state'].includes(kind) ||
        typeof cleanup !== 'function'
      )
        fail('INVALID_ARGUMENT')
      return this.#reserve({ generation, kind, cleanup, state: 'owned' })
    })
  }
  #reserve(work: Work): ManagedWork {
    if (this.#work.size + this.#idleWaiters.size >= this.#limits.work) fail('CAPACITY')
    const id = identity<'work'>()
    this.#work.set(id, work)
    return id
  }
  /** Synchronous callback boundary. Async continuations must use checked scope APIs again. */
  callback(
    generation: ManagedGeneration,
    work: ManagedWork,
    callback: () => undefined
  ): () => boolean {
    this.#generation(generation)
    const entry = this.#work.get(work)
    if (
      !entry ||
      entry.generation !== generation ||
      entry.state !== 'owned' ||
      typeof callback !== 'function'
    )
      fail('INVALID_IDENTITY')
    return () => {
      if (
        this.#closed ||
        this.#active !== generation ||
        this.#work.get(work) !== entry ||
        entry.state !== 'owned'
      )
        return false
      callback()
      return true
    }
  }
  invoke(
    generation: ManagedGeneration,
    resource: ManagedResource,
    operation: string,
    input: string
  ): Promise<string> {
    return this.#asOwner(() => {
      try {
        return this.#invoke(generation, resource, operation, input)
      } catch (error) {
        return Promise.reject(error)
      }
    })
  }
  #invoke(
    generation: ManagedGeneration,
    resource: ManagedResource,
    operation: string,
    input: string
  ): Promise<string> {
    label(operation)
    const payload = this.#json(input)
    const g = this.#generation(generation)
    const r = this.#resources.get(resource)
    const attachment = g.attachments.get(resource)
    if (this.#active !== generation) fail('NOT_ACTIVE')
    if (!r || r.closing || !attachment || !g.permissions.has(r.permission)) fail('DENIED')
    const result = deferred<string>()
    const controller = new AbortController()
    let cancelled = false
    const current = () =>
      !this.#closed &&
      !cancelled &&
      this.#active === generation &&
      g.phase === 'active' &&
      !r.closing &&
      g.attachments.get(resource) === attachment
    const context: ManagedCallContext = Object.freeze({
      generation,
      signal: controller.signal,
      isCurrent: current,
    })
    const job = this.#reserve({
      generation,
      kind: 'request',
      state: 'pending',
      resource,
      cancel: () => {
        if (cancelled) return
        cancelled = true
        result.reject(new ManagedError('RETIRED'))
        controller.abort()
      },
    })
    r.busy++
    const finished = () => {
      r.busy--
      this.#work.delete(job)
      this.#collect(generation)
      this.#close(resource, r)
      this.#notifyIdle()
    }
    void Promise.resolve()
      .then(() => {
        if (!current()) fail('RETIRED')
        const authorization: unknown = r.authorize(operation, context)
        if (authorization !== true) {
          // Reject mistaken asynchronous authorization immediately, but retain
          // admission until its work settles. A promise is never a permission.
          if (
            authorization &&
            (typeof authorization === 'object' || typeof authorization === 'function')
          ) {
            result.reject(new ManagedError('DENIED'))
            return Promise.resolve(authorization).then(
              () => fail('DENIED'),
              () => fail('DENIED')
            )
          }
          fail('DENIED')
        }
        if (!current()) fail('RETIRED')
        return r.invoke(operation, payload, context)
      })
      .then((output) => {
        if (!current()) fail('RETIRED')
        return this.#json(output)
      })
      .then(
        (output) => {
          finished()
          result.resolve(output)
        },
        (error: unknown) => {
          finished()
          result.reject(error instanceof ManagedError ? error : new ManagedError('ADAPTER_FAILED'))
        }
      )
    return result.promise
  }
  /** Wait for actual adapter settlement, including work whose framework caller was cancelled.
   * This observes adapter calls only, not arbitrary resource disposal. Waiters share the
   * bounded work budget and can be aborted without releasing any adapter reservation.
   */
  whenIdle(signal?: AbortSignal): Promise<void> {
    try {
      return this.#asOwner(() => {
        this.#open()
        if (signal !== undefined && !(signal instanceof AbortSignal)) fail('INVALID_ARGUMENT')
        if (signal?.aborted) fail('RETIRED')
        if (![...this.#work.values()].some((work) => work.resource !== undefined))
          return Promise.resolve()
        if (this.#work.size + this.#idleWaiters.size >= this.#limits.work) fail('CAPACITY')
        const completion = deferred<void>()
        const abort = () => {
          const remove = this.#idleWaiters.get(completion)
          if (!remove) return
          remove()
          this.#idleWaiters.delete(completion)
          completion.reject(new ManagedError('RETIRED'))
        }
        this.#idleWaiters.set(completion, () => signal?.removeEventListener('abort', abort))
        try {
          signal?.addEventListener('abort', abort, { once: true })
        } catch (error) {
          this.#idleWaiters.delete(completion)
          throw error
        }
        if (signal?.aborted) abort()
        return completion.promise
      })
    } catch (error) {
      return Promise.reject(error)
    }
  }
  #notifyIdle(): void {
    for (const work of this.#work.values()) if (work.resource !== undefined) return
    for (const [completion, remove] of this.#idleWaiters) {
      remove()
      this.#idleWaiters.delete(completion)
      completion.resolve()
    }
  }
  release(generation: ManagedGeneration, work: ManagedWork): Promise<void> {
    return this.#asOwner(() => {
      const entry = this.#work.get(work)
      if (!entry || entry.generation !== generation || !entry.cleanup) fail('INVALID_IDENTITY')
      return this.#release(work, entry)
    })
  }
  #release(id: ManagedWork, entry: Work): Promise<void> {
    if (entry.completion) return entry.completion.promise
    entry.state = 'pending'
    const completion = (entry.completion = deferred<void>())
    void Promise.resolve()
      .then(() => entry.cleanup!())
      .then(
        () => {
          this.#work.delete(id)
          delete entry.cleanup
          this.#collect(entry.generation)
          completion.resolve()
        },
        () => {
          entry.state = 'failed'
          completion.reject(new ManagedError('CLEANUP_FAILED'))
        }
      )
    return completion.promise
  }
  retire(generation: ManagedGeneration): void {
    this.#asOwner(() => this.#retire(generation))
  }
  #retire(generation: ManagedGeneration): void {
    if (!this.#knownGenerations.has(generation)) fail('INVALID_IDENTITY')
    const g = this.#generations.get(generation)
    if (!g || g.phase === 'retired') return
    g.phase = 'retired'
    g.attachments.clear()
    g.permissions.clear()
    if (this.#candidate === generation) this.#candidate = undefined
    if (this.#active === generation) this.#active = undefined
    const owned = [...this.#work.entries()].filter(([, w]) => w.generation === generation)
    for (const [id, work] of owned) {
      work.cancel?.()
      if (work.state === 'owned') void this.#release(id, work)
    }
    g.controller.abort()
    this.#collect(generation)
  }
  #collect(generation: ManagedGeneration): void {
    if (this.#generations.get(generation)?.phase !== 'retired') return
    for (const work of this.#work.values()) if (work.generation === generation) return
    this.#generations.delete(generation)
  }
  disposeResource(resource: ManagedResource): Promise<void> {
    return this.#asOwner(() => {
      const r = this.#resources.get(resource)
      if (!r) {
        if (this.#knownResources.has(resource)) return Promise.resolve()
        fail('INVALID_IDENTITY')
      }
      if (!r.completion) r.completion = deferred<void>()
      r.closing = true
      for (const g of this.#generations.values()) {
        if (g.attachments.delete(resource) && g.phase === 'preparing') g.invalidated = true
      }
      // Remove attachments immediately; a staged loss permanently invalidates that candidate.
      for (const work of this.#work.values()) if (work.resource === resource) work.cancel?.()
      this.#close(resource, r)
      return r.completion.promise
    })
  }
  #close(id: ManagedResource, r: Resource): void {
    if (!r.closing || r.busy || r.cleanup !== 'idle' || this.#resources.get(id) !== r) return
    for (const dependent of this.#resources.values())
      if (dependent.dependencies.includes(id)) return
    r.cleanup = 'pending'
    void Promise.resolve()
      .then(r.dispose)
      .then(
        () => {
          this.#resources.delete(id)
          for (const dependency of r.dependencies) {
            const parent = this.#resources.get(dependency)
            if (parent) this.#close(dependency, parent)
          }
          r.completion!.resolve()
        },
        () => {
          r.cleanup = 'failed'
          r.completion!.reject(new ManagedError('CLEANUP_FAILED'))
        }
      )
  }
  /** Explicit host retry only; failed cleanup never frees admission or starts an automatic retry. */
  retryFailed(): void {
    this.#asOwner(() => {
      for (const [id, work] of this.#work)
        if (work.state === 'failed') {
          delete work.completion
          void this.#release(id, work)
        }
      for (const [id, r] of this.#resources)
        if (r.cleanup === 'failed') {
          r.cleanup = 'idle'
          r.completion = deferred<void>()
          this.#close(id, r)
        }
    })
  }
  /** Starts release; diagnostics retain unfinished/failed ownership. No timeout invents completion. */
  dispose(): void {
    this.#asOwner(() => {
      this.#closed = true
      this.#state = undefined
      for (const [completion, remove] of this.#idleWaiters) {
        remove()
        this.#idleWaiters.delete(completion)
        completion.reject(new ManagedError('DISPOSED'))
      }
      for (const id of this.#generations.keys()) this.#retire(id)
      for (const id of this.#resources.keys()) void this.disposeResource(id)
    })
  }
  diagnostics() {
    const work = [...this.#work.values()]
    const resources = [...this.#resources.values()]
    return Object.freeze({
      closed: this.#closed,
      resources: resources.length,
      attachments: [...this.#generations.values()].reduce(
        (count, g) => count + g.attachments.size,
        0
      ),
      generations: this.#generations.size,
      work: work.length + this.#idleWaiters.size,
      active: this.#active ? 1 : 0,
      candidate: this.#candidate ? 1 : 0,
      inFlight: work.filter((w) => w.resource !== undefined).length,
      failedCleanup:
        work.filter((w) => w.state === 'failed').length +
        resources.filter((r) => r.cleanup === 'failed').length,
    })
  }
}
