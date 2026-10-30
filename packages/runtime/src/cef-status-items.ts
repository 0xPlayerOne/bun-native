import {
  BunlyError,
  normalizeStatusItem,
  STATUS_ITEM_LIMITS,
  type OperationOptions,
  type PolicyScope,
  type StatusItemDefinition,
  type StatusItemEvent,
  type StatusItemHandle,
  type ViewHandle,
} from '../../contracts/src/index.ts'
import type { NativeEvent, NativeTransport } from './native-transport.ts'
import type { ListenerResultObserver } from './listener-result.ts'

interface Authority {
  readonly view: ViewHandle
  readonly id: number
  readonly scope: object
}
interface Subscription {
  readonly listener: (event: StatusItemEvent) => void
  readonly stop: () => void
  active: boolean
}
interface Registration {
  readonly handle: StatusItemHandle
  readonly scope: PolicyScope
  readonly authority: Authority
  readonly listeners: Set<Subscription>
  removeAbort: () => void
  active: boolean
  created: boolean
  sequence: number
  disposal: Promise<void> | undefined
}
function nativeError(error: unknown): never {
  if (error instanceof Error)
    for (const code of [
      'INVALID_ARGUMENT',
      'INVALID_HANDLE',
      'DISPOSED',
      'PERMISSION_DENIED',
      'RESOURCE_IN_USE',
      'UNSUPPORTED_CAPABILITY',
    ] as const)
      if (error.message.startsWith(code + ':')) throw new BunlyError(code, error.message)
  throw error
}

/** A reservation remains charged until native removal or clean native shutdown. */
export class CefStatusItems {
  readonly #handles = new WeakMap<StatusItemHandle, Registration>()
  readonly #registrations = new Map<string, Registration>()
  #closed = false
  constructor(
    readonly transport: NativeTransport,
    readonly capture: (scope: PolicyScope) => Authority,
    readonly available: () => void,
    readonly listenerError: () => void,
    readonly listenerResults: ListenerResultObserver
  ) {}
  #record(handle: StatusItemHandle): Registration {
    const record = handle && typeof handle === 'object' ? this.#handles.get(handle) : undefined
    if (!record) throw new BunlyError('INVALID_HANDLE', 'Foreign status item handle')
    return record
  }
  #check(record: Registration): void {
    this.available()
    if (this.#closed || !record.active) throw new BunlyError('DISPOSED', 'Status item disposed')
    const current = this.capture(record.scope)
    if (current.id !== record.authority.id || current.view !== record.authority.view)
      throw new BunlyError('PERMISSION_DENIED', 'Status item document authority changed')
  }
  async #call(record: Registration, operation: string, extra: object = {}): Promise<void> {
    try {
      const result = await this.transport.call(operation, {
        registration: record.handle.id,
        scope: record.authority.scope,
        ...extra,
      })
      if (result !== null) {
        const error = new Error('Malformed native status item receipt')
        this.transport.fail(error)
        throw error
      }
    } catch (error) {
      nativeError(error)
    }
  }
  async create(
    scope: PolicyScope,
    input: StatusItemDefinition,
    options?: OperationOptions
  ): Promise<StatusItemHandle> {
    this.available()
    const signal = options?.signal
    signal?.throwIfAborted()
    const definition = normalizeStatusItem(input)
    const authority = this.capture(scope)
    if (
      this.#closed ||
      this.#registrations.size >= STATUS_ITEM_LIMITS.items ||
      [...this.#registrations.values()].some((record) => record.authority.view === authority.view)
    )
      throw new BunlyError('RESOURCE_IN_USE', 'Status item capacity exceeded')
    const handle = Object.freeze({
      id: crypto.randomUUID().replaceAll('-', ''),
    }) as StatusItemHandle
    const record: Registration = {
      handle,
      scope,
      authority,
      listeners: new Set(),
      removeAbort: () => {},
      active: true,
      created: false,
      sequence: 0,
      disposal: undefined,
    }
    this.#handles.set(handle, record)
    this.#registrations.set(handle.id, record)
    const abort = () => {
      this.#deactivate(record)
      if (record.created) this.#cleanup(record)
    }
    signal?.addEventListener('abort', abort, { once: true })
    record.removeAbort = () => signal?.removeEventListener('abort', abort)
    try {
      signal?.throwIfAborted()
      this.#check(record)
      await this.#call(record, 'status.create', { definition })
      record.created = true
      signal?.throwIfAborted()
      this.#check(record)
      return handle
    } catch (error) {
      this.#deactivate(record)
      if (record.created) await this.dispose(handle)
      else if (!this.transport.failure) this.#forget(record)
      throw error
    }
  }
  async update(handle: StatusItemHandle, input: StatusItemDefinition): Promise<void> {
    const record = this.#record(handle)
    this.#check(record)
    const definition = normalizeStatusItem(input)
    this.#check(record)
    await this.#call(record, 'status.update', { definition })
    this.#check(record)
  }
  onEvent(
    handle: StatusItemHandle,
    listener: (event: StatusItemEvent) => void,
    options?: OperationOptions
  ): () => void {
    const record = this.#record(handle)
    this.#check(record)
    options?.signal?.throwIfAborted()
    if (typeof listener !== 'function') throw new BunlyError('INVALID_ARGUMENT', 'Invalid listener')
    if (this.listenerCount >= STATUS_ITEM_LIMITS.listeners)
      throw new BunlyError('RESOURCE_IN_USE', 'Status item listener capacity exceeded')
    const subscription: Subscription = {
      listener,
      active: true,
      stop: () => {
        subscription.active = false
        record.listeners.delete(subscription)
        options?.signal?.removeEventListener('abort', subscription.stop)
      },
    }
    record.listeners.add(subscription)
    options?.signal?.addEventListener('abort', subscription.stop, { once: true })
    return subscription.stop
  }
  #deactivate(record: Registration): void {
    record.active = false
    record.removeAbort()
    for (const subscription of record.listeners) subscription.stop()
  }
  #forget(record: Registration): void {
    this.#deactivate(record)
    this.#registrations.delete(record.handle.id)
  }
  #cleanup(record: Registration): void {
    void this.dispose(record.handle).catch((error: unknown) => this.transport.fail(error))
  }
  dispose(handle: StatusItemHandle): Promise<void> {
    const record = this.#record(handle)
    this.#deactivate(record)
    if (record.disposal) return record.disposal
    if (!this.#registrations.has(handle.id)) return Promise.resolve()
    const release = this.#closed
      ? this.transport.closed.then(() => {
          if (this.transport.failure) throw this.transport.failure
        })
      : this.#call(record, 'status.dispose')
    record.disposal = release
      .then(() => this.#forget(record))
      .catch((error: unknown) => {
        record.disposal = undefined
        throw error
      })
    return record.disposal
  }
  matchesScope(handle: StatusItemHandle, scope: PolicyScope): boolean {
    const record = this.#record(handle)
    this.#check(record)
    const current = this.capture(scope)
    return (
      current.view === record.authority.view &&
      JSON.stringify(current.scope) === JSON.stringify(record.authority.scope)
    )
  }
  retireView(view: ViewHandle): void {
    for (const record of this.#registrations.values())
      if (record.authority.view === view && record.active) {
        this.#deactivate(record)
        if (record.created) this.#cleanup(record)
      }
  }
  stop(): void {
    this.#closed = true
    for (const record of this.#registrations.values()) this.#deactivate(record)
  }
  close(): void {
    this.stop()
    if (!this.transport.failure)
      for (const record of this.#registrations.values()) this.#forget(record)
  }
  get listenerCount(): number {
    let count = 0
    for (const record of this.#registrations.values()) count += record.listeners.size
    return count
  }
  diagnostics() {
    return Object.freeze({ items: this.#registrations.size, listeners: this.listenerCount })
  }
  event(frame: NativeEvent): void {
    if (frame.event !== 'status.item') return
    const data = frame.data
    const token = data?.['registration']
    if (
      !data ||
      Object.keys(data).length !== 3 ||
      typeof token !== 'string' ||
      /^[a-f0-9]{32}$/.exec(token)?.[0] !== token ||
      !Number.isSafeInteger(frame.target) ||
      Number(frame.target) < 1 ||
      !Number.isSafeInteger(data['sequence']) ||
      Number(data['sequence']) < 1 ||
      (data['type'] !== 'click' && data['type'] !== 'revoked')
    )
      throw new Error('Malformed native status item event')
    const record = this.#registrations.get(token)
    if (!record || !record.active) return
    if (frame.target !== record.authority.id || Number(data['sequence']) <= record.sequence)
      throw new Error('Invalid native status item event identity or order')
    record.sequence = Number(data['sequence'])
    const event: StatusItemEvent = Object.freeze({ type: data['type'], sequence: record.sequence })
    for (const subscription of Array.from(record.listeners)) {
      if (!subscription.active || !record.active) continue
      try {
        if (event.type === 'click') this.#check(record)
      } catch {
        this.#deactivate(record)
        this.#cleanup(record)
        break
      }
      try {
        this.listenerResults.observe(subscription.listener(event))
      } catch {
        this.listenerError()
      }
    }
    if (event.type === 'revoked') {
      this.#deactivate(record)
      if (record.created) this.#cleanup(record)
    }
  }
  /** Contributor-only AppKit performClick; acceptance still requires its real action callback. */
  async qualify(handle: StatusItemHandle): Promise<void> {
    const record = this.#record(handle)
    this.#check(record)
    await this.#call(record, 'status.qualification.click')
    this.#check(record)
  }
}
