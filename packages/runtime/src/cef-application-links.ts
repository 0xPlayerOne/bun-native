import {
  APPLICATION_LINK_LIMITS,
  BunlyError,
  normalizeApplicationLinkUrl,
  normalizeExternalHttpsUrl,
  type ApplicationLink,
  type ApplicationLinkBatch,
  type ApplicationLinkReader,
  type OperationOptions,
  type PolicyScope,
  type ViewHandle,
} from '../../contracts/src/index.ts'
import type { NativeTransport } from './native-transport.ts'

interface Authority {
  readonly view: ViewHandle
  readonly scope: object
}
interface Registration {
  readonly handle: ApplicationLinkReader
  readonly scope: PolicyScope
  readonly authority: Authority
  incarnation: number | undefined
  active: boolean
  busy: boolean
  batch: ApplicationLinkBatch | undefined
  removeAbort: () => void
  disposal: Promise<void> | undefined
}
interface Receipt {
  readonly registration: Registration
  readonly id: number
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
function integer(value: unknown, minimum = 0): value is number {
  return Number.isSafeInteger(value) && Number(value) >= minimum
}
function object(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === [...keys].sort().join(',')
  )
}
/** One exact-document reader; unacknowledged entries stay in the native inbox. */
export class CefApplicationLinks {
  readonly #handles = new WeakMap<ApplicationLinkReader, Registration>()
  readonly #batches = new WeakMap<ApplicationLinkBatch, Receipt>()
  readonly #registrations = new Set<Registration>()
  #closed = false
  constructor(
    readonly transport: NativeTransport,
    readonly capture: (scope: PolicyScope) => Authority,
    readonly available: (kind: 'inbound' | 'outbound') => void
  ) {}
  #malformed(): never {
    const error = new Error('Malformed native application link receipt')
    this.transport.fail(error)
    throw error
  }
  #record(handle: ApplicationLinkReader): Registration {
    const record = handle && typeof handle === 'object' ? this.#handles.get(handle) : undefined
    if (!record) throw new BunlyError('INVALID_HANDLE', 'Foreign application link reader')
    return record
  }
  #check(record: Registration): void {
    this.available('inbound')
    if (this.#closed || !record.active)
      throw new BunlyError('DISPOSED', 'Application link reader disposed')
    const current = this.capture(record.scope)
    if (
      current.view !== record.authority.view ||
      JSON.stringify(current.scope) !== JSON.stringify(record.authority.scope)
    )
      throw new BunlyError('PERMISSION_DENIED', 'Application link document authority changed')
  }
  async #call(record: Registration, operation: string, extra: object = {}): Promise<unknown> {
    try {
      return await this.transport.call(operation, {
        registration: record.handle.id,
        scope: record.authority.scope,
        ...(record.incarnation === undefined ? {} : { incarnation: record.incarnation }),
        ...extra,
      })
    } catch (error) {
      nativeError(error)
    }
  }
  async create(scope: PolicyScope, options?: OperationOptions): Promise<ApplicationLinkReader> {
    this.available('inbound')
    options?.signal?.throwIfAborted()
    const authority = this.capture(scope)
    if (this.#closed || this.#registrations.size >= APPLICATION_LINK_LIMITS.readers)
      throw new BunlyError('RESOURCE_IN_USE', 'Application link reader capacity exceeded')
    const handle = Object.freeze({
      id: crypto.randomUUID().replaceAll('-', ''),
    }) as ApplicationLinkReader
    const record: Registration = {
      handle,
      scope,
      authority,
      incarnation: undefined,
      active: true,
      busy: false,
      batch: undefined,
      removeAbort: () => {},
      disposal: undefined,
    }
    this.#handles.set(handle, record)
    this.#registrations.add(record)
    const abort = () => {
      this.#deactivate(record)
      if (record.incarnation !== undefined) this.#cleanup(record)
    }
    options?.signal?.addEventListener('abort', abort, { once: true })
    record.removeAbort = () => options?.signal?.removeEventListener('abort', abort)
    try {
      options?.signal?.throwIfAborted()
      this.#check(record)
      const result = await this.#call(record, 'links.create')
      if (!object(result, ['incarnation']) || !integer(result['incarnation'], 1)) this.#malformed()
      record.incarnation = result['incarnation']
      options?.signal?.throwIfAborted()
      this.#check(record)
      return handle
    } catch (error) {
      this.#deactivate(record)
      if (record.incarnation !== undefined) await this.dispose(handle)
      else if (!this.transport.failure) this.#forget(record)
      throw error
    }
  }
  async read(handle: ApplicationLinkReader): Promise<ApplicationLinkBatch> {
    const record = this.#record(handle)
    this.#check(record)
    if (record.busy) throw new BunlyError('RESOURCE_IN_USE', 'Application link read is in flight')
    record.busy = true
    record.batch = undefined
    try {
      const result = await this.#call(record, 'links.read')
      if (
        !object(result, ['receipt', 'links', 'overflow']) ||
        !integer(result['receipt'], 1) ||
        !integer(result['overflow']) ||
        !Array.isArray(result['links']) ||
        result['links'].length > APPLICATION_LINK_LIMITS.queueEntries
      )
        this.#malformed()
      const links: ApplicationLink[] = []
      let bytes = 0
      let previous = 0
      for (const value of result['links']) {
        if (
          !object(value, ['sequence', 'url', 'source']) ||
          !integer(value['sequence'], 1) ||
          value['sequence'] <= previous ||
          (value['source'] !== 'startup' && value['source'] !== 'macos')
        )
          this.#malformed()
        let url
        try {
          url = normalizeApplicationLinkUrl(value['url'])
        } catch {
          this.#malformed()
        }
        previous = value['sequence']
        bytes += url.length
        if (bytes > APPLICATION_LINK_LIMITS.queueBytes) this.#malformed()
        links.push(Object.freeze({ sequence: previous, url, source: value['source'] }))
      }
      this.#check(record)
      const batch = Object.freeze({
        links: Object.freeze(links),
        overflow: result['overflow'],
      }) as ApplicationLinkBatch
      this.#batches.set(batch, { registration: record, id: result['receipt'] })
      record.batch = batch
      return batch
    } finally {
      record.busy = false
    }
  }
  async acknowledge(handle: ApplicationLinkReader, batch: ApplicationLinkBatch): Promise<void> {
    const record = this.#record(handle)
    this.#check(record)
    const receipt = batch && typeof batch === 'object' ? this.#batches.get(batch) : undefined
    if (!receipt || receipt.registration !== record || record.batch !== batch)
      throw new BunlyError('INVALID_ARGUMENT', 'Application link batch is not the latest read')
    if (record.busy) throw new BunlyError('RESOURCE_IN_USE', 'Application link read is in flight')
    record.busy = true
    try {
      if ((await this.#call(record, 'links.ack', { receipt: receipt.id })) !== null)
        this.#malformed()
      record.batch = undefined
      this.#check(record)
    } finally {
      record.busy = false
    }
  }
  #deactivate(record: Registration): void {
    record.active = false
    record.batch = undefined
    record.removeAbort()
  }
  #forget(record: Registration): void {
    this.#deactivate(record)
    this.#registrations.delete(record)
  }
  #cleanup(record: Registration): void {
    void this.dispose(record.handle).catch((error: unknown) => this.transport.fail(error))
  }
  dispose(handle: ApplicationLinkReader): Promise<void> {
    const record = this.#record(handle)
    this.#deactivate(record)
    if (record.disposal) return record.disposal
    if (!this.#registrations.has(record)) return Promise.resolve()
    const release = this.#closed
      ? this.transport.closed.then(() => {
          if (this.transport.failure) throw this.transport.failure
        })
      : this.#call(record, 'links.dispose').then((result) => {
          if (result !== null) this.#malformed()
        })
    record.disposal = release
      .then(() => this.#forget(record))
      .catch((error: unknown) => {
        record.disposal = undefined
        throw error
      })
    return record.disposal
  }
  matchesScope(handle: ApplicationLinkReader, scope: PolicyScope): boolean {
    const record = this.#record(handle)
    this.#check(record)
    const current = this.capture(scope)
    return (
      current.view === record.authority.view &&
      JSON.stringify(current.scope) === JSON.stringify(record.authority.scope)
    )
  }
  async open(scope: PolicyScope, input: string): Promise<void> {
    this.available('outbound')
    const url = normalizeExternalHttpsUrl(input)
    const authority = this.capture(scope)
    try {
      const result = await this.transport.call('app.open.url', { scope: authority.scope, url })
      if (result !== null) this.#malformed()
      this.capture(scope)
    } catch (error) {
      nativeError(error)
    }
  }
  retireView(view: ViewHandle): void {
    for (const record of this.#registrations)
      if (record.authority.view === view && record.active) {
        this.#deactivate(record)
        if (record.incarnation !== undefined) this.#cleanup(record)
      }
  }
  stop(): void {
    this.#closed = true
    for (const record of this.#registrations) this.#deactivate(record)
  }
  close(): void {
    this.stop()
    if (!this.transport.failure) for (const record of this.#registrations) this.#forget(record)
  }
  diagnostics() {
    return Object.freeze({ readers: this.#registrations.size })
  }
}
