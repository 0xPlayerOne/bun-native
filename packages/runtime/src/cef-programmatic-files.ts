import { BunlyError } from '../../contracts/src/core.ts'
import {
  PROGRAMMATIC_FILE_LIMITS as LIMITS,
  parseFileInteractionResult,
  type FileInteractionOperation,
  type FileInteractionResult,
} from '../../contracts/src/programmatic-files.ts'
import {
  inspectProgrammaticFile,
  fileInteractionReservation,
  type FileInteractionMetadata,
} from './cef-programmatic-file-data.ts'
import { viewControlBudget } from './cef-view-control-budget.ts'
import type { NativeEvent, NativeTransport } from './native-transport.ts'

type Entry = {
  readonly view: number
  readonly scope: Readonly<Record<string, unknown>>
  readonly current: () => void
  readonly lease: Readonly<{ release(): void }>
  readonly ready: ReturnType<typeof Promise.withResolvers<void>>
  readonly completed: ReturnType<typeof Promise.withResolvers<FileInteractionResult>>
  readonly early: NativeEvent[]
  id?: number
  nativeReady: boolean
  preparing: boolean
  pendingCalls: number
  cancelled: boolean
  cancelSent: boolean
  commitSent: boolean
  settled: boolean
  terminal?: { result?: FileInteractionResult; error?: Error }
  removeAbort: () => void
}
const aborted = () => new DOMException('File interaction cancelled', 'AbortError')
const errorFrom = (error: unknown) =>
  error instanceof Error ? error : new Error('File interaction failed')
function object(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Malformed native file receipt')
  const data = value as Record<string, unknown>
  if (Object.keys(data).length !== fields.length || fields.some((field) => !(field in data)))
    throw new Error('Malformed native file receipt fields')
  return data
}
function preparationFailure(result?: FileInteractionResult): Error {
  if (result?.status === 'cancelled') return aborted()
  return new BunlyError(
    result?.failure === 'unsupported-capability' ? 'UNSUPPORTED_CAPABILITY' : 'PERMISSION_DENIED',
    `File preparation failed: ${result?.failure ?? 'native-closed'}`
  )
}

/** The native terminal receipt and all pending local calls must settle before
 * capacity is reusable. Cancellation acknowledgement is not a terminal receipt.
 */
export class CefProgrammaticFiles {
  readonly #transport: NativeTransport
  readonly #entries = new Map<number, Entry>()
  constructor(transport: NativeTransport) {
    this.#transport = transport
  }

  prepare(
    view: number,
    scope: Readonly<Record<string, unknown>>,
    request: unknown,
    current: () => void,
    signal?: AbortSignal
  ): Promise<FileInteractionOperation> {
    if (signal?.aborted) throw aborted()
    current()
    // This method is synchronous through reservation and copying. The async
    // continuation receives only owned bytes, never a borrowed caller buffer.
    const inspected = inspectProgrammaticFile(request)
    const lease = viewControlBudget(this.#transport).reserve(
      view,
      fileInteractionReservation(inspected.bytes)
    )
    let owned: ReturnType<typeof inspected.copy>
    try {
      owned = inspected.copy()
    } catch (error) {
      lease.release()
      throw error
    }
    const ready = Promise.withResolvers<void>()
    const completed = Promise.withResolvers<FileInteractionResult>()
    void ready.promise.catch(() => {})
    void completed.promise.catch(() => {})
    const entry: Entry = {
      view,
      scope,
      current,
      lease,
      ready,
      completed,
      early: [],
      nativeReady: false,
      preparing: true,
      pendingCalls: 0,
      cancelled: false,
      cancelSent: false,
      commitSent: false,
      settled: false,
      removeAbort() {},
    }
    this.#entries.set(view, entry)
    const abort = () => {
      entry.cancelled = true
      this.#cancel(entry)
    }
    signal?.addEventListener('abort', abort, { once: true })
    entry.removeAbort = () => signal?.removeEventListener('abort', abort)
    if (signal?.aborted) abort()
    return this.#prepare(entry, owned.metadata, owned.data)
  }

  async #call(
    entry: Entry,
    operation: string,
    args: Record<string, unknown>,
    parse: (value: unknown) => unknown = (value) => value
  ): Promise<unknown> {
    entry.pendingCalls++
    try {
      return parse(await this.#transport.call(operation, args))
    } finally {
      entry.pendingCalls--
      this.#finalize(entry)
    }
  }

  #ack(entry: Entry, operation: string, args: Record<string, unknown>): Promise<unknown> {
    return this.#call(entry, operation, args, (value) => {
      if (value !== null) {
        const error = new Error('Malformed native file acknowledgement')
        entry.terminal = { error }
        entry.ready.reject(error)
        this.#transport.fail(error)
        throw error
      }
      return value
    })
  }

  async #prepare(
    entry: Entry,
    metadata: FileInteractionMetadata,
    data: Uint8Array | undefined
  ): Promise<FileInteractionOperation> {
    let failed: Error | undefined
    try {
      if (entry.cancelled) throw aborted()
      entry.current()
      const admission = await this.#call(entry, 'file.interaction.prepare', {
        id: entry.view,
        scope: entry.scope,
        metadata,
      })
      try {
        const admitted = object(admission, ['id'])
        if (!Number.isSafeInteger(admitted['id']) || Number(admitted['id']) < 1)
          throw new Error('Malformed native file admission')
        entry.id = Number(admitted['id'])
      } catch (error) {
        const invalid = errorFrom(error)
        entry.terminal = { error: invalid }
        this.#transport.fail(invalid)
        throw invalid
      }
      for (const early of entry.early.splice(0)) this.#event(entry, early)
      if (entry.cancelled) this.#cancel(entry)
      await entry.ready.promise
      for (let offset = 0; offset < metadata.bytes; offset += LIMITS.chunkBytes) {
        if (entry.cancelled || entry.terminal) throw aborted()
        entry.current()
        const size = Math.min(LIMITS.chunkBytes, metadata.bytes - offset)
        const hex = Buffer.from(data!.buffer, data!.byteOffset + offset, size).toString('hex')
        const result = await this.#call(entry, 'file.interaction.write', {
          id: entry.view,
          operation: entry.id,
          scope: entry.scope,
          offset,
          hex,
        })
        if (result !== null) {
          const error = new Error('Malformed native file chunk acknowledgement')
          this.#transport.fail(error)
          throw error
        }
      }
      entry.current()
      if (entry.cancelled || entry.terminal) throw aborted()
    } catch (error) {
      failed = errorFrom(error)
      if (entry.id === undefined) {
        entry.terminal ??= { error: failed }
        entry.ready.reject(failed)
      } else if (!entry.terminal) {
        entry.cancelled = true
        this.#cancel(entry)
      }
    } finally {
      data = undefined
      entry.preparing = false
      this.#finalize(entry)
    }
    if (failed || entry.terminal || entry.cancelled) {
      const result = await entry.completed.promise
      throw failed ?? preparationFailure(result)
    }
    return Object.freeze({
      completed: entry.completed.promise,
      commit: () => this.#commit(entry),
      cancel: () => {
        entry.cancelled = true
        this.#cancel(entry)
        return entry.completed.promise
      },
    })
  }

  #commit(entry: Entry): Promise<FileInteractionResult> {
    if (entry.settled || entry.terminal || entry.commitSent || entry.cancelled)
      return entry.completed.promise
    try {
      entry.current()
    } catch {
      entry.cancelled = true
      this.#cancel(entry)
      return entry.completed.promise
    }
    entry.commitSent = true
    void this.#ack(entry, 'file.interaction.commit', {
      id: entry.view,
      operation: entry.id,
      scope: entry.scope,
    }).catch((error: unknown) => {
      if (!entry.terminal) {
        entry.cancelled = true
        this.#cancel(entry)
      }
      if (this.#transport.failure) this.close(errorFrom(error))
    })
    return entry.completed.promise
  }

  #cancel(entry: Entry): void {
    if (entry.id === undefined || entry.cancelSent || entry.settled || entry.terminal) return
    entry.cancelSent = true
    void this.#ack(entry, 'file.interaction.cancel', { id: entry.view, operation: entry.id }).catch(
      (error: unknown) => this.#transport.fail(errorFrom(error))
    )
  }

  event(event: NativeEvent): void {
    if (!event.event.startsWith('file.interaction.')) return
    const entry = event.target === undefined ? undefined : this.#entries.get(event.target)
    if (!entry || entry.settled) throw new Error('Unowned native file-interaction event')
    if (entry.id === undefined) {
      if (entry.early.length >= 2) throw new Error('Too many early native file receipts')
      entry.early.push(event)
    } else this.#event(entry, event)
  }

  #event(entry: Entry, event: NativeEvent): void {
    const fields = event.event === 'file.interaction.ready' ? ['id'] : ['id', 'result']
    const data = object(event.data, fields)
    if (data['id'] !== entry.id || entry.terminal)
      throw new Error('Mismatched or duplicate native file receipt')
    if (event.event === 'file.interaction.ready') {
      if (entry.nativeReady) throw new Error('Duplicate native file readiness')
      entry.nativeReady = true
      entry.ready.resolve()
    } else if (event.event === 'file.interaction.finished') {
      const result = parseFileInteractionResult(data['result'])
      if (result.status === 'completed' && (!entry.nativeReady || !entry.commitSent))
        throw new Error('Native file completed before an authorized commit')
      if (result.mayHaveExposedFile && !entry.commitSent)
        throw new Error('Native file exposed before commit')
      entry.terminal = { result }
      entry.ready.reject(preparationFailure(result))
      this.#finalize(entry)
    } else throw new Error('Unknown native file-interaction event')
  }

  #finalize(entry: Entry): void {
    if (entry.settled || !entry.terminal || entry.preparing || entry.pendingCalls !== 0) return
    entry.settled = true
    entry.removeAbort()
    if (this.#entries.get(entry.view) === entry) this.#entries.delete(entry.view)
    entry.lease.release()
    if (entry.terminal.error) entry.completed.reject(entry.terminal.error)
    else entry.completed.resolve(entry.terminal.result!)
  }

  close(error: Error): void {
    for (const entry of this.#entries.values()) {
      entry.terminal = { error }
      entry.ready.reject(error)
      this.#finalize(entry)
    }
  }

  diagnostics(): Readonly<{ operations: number }> {
    return Object.freeze({ operations: this.#entries.size })
  }
}
