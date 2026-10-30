import {
  BunlyError,
  DOWNLOAD_LIMITS,
  parseDownloadProgress,
  type DownloadOperation,
  type DownloadOutcome,
  type DownloadProgress,
  type NormalizedDownloadRequest,
} from '../../contracts/src/index.ts'
import type { NativeEvent, NativeTransport } from './native-transport.ts'
import type { ListenerResultObserver } from './listener-result.ts'

type Entry = {
  readonly view: number
  id: number | undefined
  progress: DownloadProgress
  readonly listeners: Set<(progress: DownloadProgress) => void>
  readonly completed: Promise<DownloadOutcome>
  resolve: (outcome: DownloadOutcome) => void
  reject: (error: Error) => void
  cancelRequested: boolean
  cancelSent: boolean
  removeAbort: () => void
  settled: boolean
}
const initial: DownloadProgress = Object.freeze({
  status: 'starting',
  bytesReceived: 0,
  totalBytes: null,
  failure: null,
})
const terminal = (status: DownloadProgress['status']) =>
  status === 'completed' || status === 'cancelled' || status === 'failed'

/** Private pipe controller. Cancellation acknowledgment never releases an operation. */
export class CefDownloads {
  readonly #transport: NativeTransport
  readonly #entries = new Map<number, Entry>()
  readonly #listenerFailed: () => void
  readonly #listenerResults: ListenerResultObserver
  constructor(
    transport: NativeTransport,
    listenerFailed: () => void,
    listenerResults: ListenerResultObserver
  ) {
    this.#transport = transport
    this.#listenerFailed = listenerFailed
    this.#listenerResults = listenerResults
  }
  get listenerCount(): number {
    let count = 0
    for (const entry of this.#entries.values()) count += entry.listeners.size
    return count
  }
  async start(
    view: number,
    scope: Readonly<Record<string, unknown>>,
    request: NormalizedDownloadRequest,
    current: () => void,
    signal?: AbortSignal
  ): Promise<DownloadOperation> {
    if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError')
    if (this.#entries.has(view) || this.#entries.size >= DOWNLOAD_LIMITS.operations)
      throw new BunlyError('RESOURCE_IN_USE', 'Native download capacity is still owned')
    let resolve!: Entry['resolve']
    let reject!: Entry['reject']
    const completed = new Promise<DownloadOutcome>((done, failed) => {
      resolve = done
      reject = failed
    })
    void completed.catch(() => {})
    const entry: Entry = {
      view,
      id: undefined,
      progress: initial,
      listeners: new Set(),
      completed,
      resolve,
      reject,
      cancelRequested: false,
      cancelSent: false,
      removeAbort: () => {},
      settled: false,
    }
    const cancel = () => {
      entry.cancelRequested = true
      this.#cancel(entry)
      return completed
    }
    const aborted = () => {
      void cancel().catch(() => {})
    }
    entry.removeAbort = () => signal?.removeEventListener('abort', aborted)
    signal?.addEventListener('abort', aborted, { once: true })
    this.#entries.set(view, entry)
    try {
      current()
      // No transport AbortSignal: the native admission must be acknowledged even
      // when the application cancels before that reply arrives.
      const result = await this.#transport.call('download.start', { id: view, scope, ...request })
      if (
        !result ||
        typeof result !== 'object' ||
        Array.isArray(result) ||
        Object.keys(result).join(',') !== 'id' ||
        !Number.isSafeInteger((result as { id?: unknown }).id) ||
        Number((result as { id: unknown }).id) < 1
      ) {
        const error = new Error('Invalid native download admission')
        this.#transport.fail(error)
        throw error
      }
      entry.id = Number((result as { id: unknown }).id)
      if (entry.cancelRequested) this.#cancel(entry)
      try {
        current()
      } catch (error) {
        void cancel().catch(() => {})
        throw error
      }
    } catch (error) {
      if (entry.id === undefined) this.#remove(entry)
      entry.reject(error instanceof Error ? error : new Error(String(error)))
      throw error
    }
    return Object.freeze({
      completed,
      state: () => entry.progress,
      cancel,
      onProgress: (listener: (progress: DownloadProgress) => void) => {
        if (typeof listener !== 'function')
          throw new BunlyError('INVALID_ARGUMENT', 'Expected a download progress listener')
        if (entry.listeners.size >= DOWNLOAD_LIMITS.listeners)
          throw new BunlyError('RESOURCE_IN_USE', 'Download progress listener capacity exceeded')
        if (!entry.settled) entry.listeners.add(listener)
        this.#notify(listener, entry.progress)
        return () => {
          entry.listeners.delete(listener)
        }
      },
    })
  }
  #cancel(entry: Entry): void {
    if (entry.settled || entry.cancelSent || entry.id === undefined) return
    entry.cancelSent = true
    void this.#transport.call('download.cancel', { id: entry.view, download: entry.id }).then(
      (value) => {
        if (value !== null)
          this.#transport.fail(new Error('Invalid native download cancellation receipt'))
      },
      (error: unknown) => this.#transport.fail(error)
    )
  }
  #notify(listener: (progress: DownloadProgress) => void, progress: DownloadProgress): void {
    try {
      this.#listenerResults.observe(listener(progress))
    } catch {
      this.#listenerFailed()
    }
  }
  event(event: NativeEvent): void {
    if (event.event !== 'download.progress' && event.event !== 'download.finished') return
    const entry = event.target === undefined ? undefined : this.#entries.get(event.target)
    const data = event.data
    if (!entry || !data || data['id'] !== entry.id || Object.keys(data).length !== 2)
      throw new Error('Unknown or mismatched native download operation')
    if (event.event === 'download.progress') {
      const progress = parseDownloadProgress(data['progress'])
      if (
        terminal(entry.progress.status) ||
        progress.bytesReceived < entry.progress.bytesReceived ||
        (progress.status === 'starting' && entry.progress.status !== 'starting') ||
        (entry.progress.status === 'cancelling' &&
          ['starting', 'in-progress'].includes(progress.status))
      )
        throw new Error('Invalid native download state transition')
      entry.progress = progress
      // New subscriptions during delivery belong to the next native update.
      for (const listener of Array.from(entry.listeners))
        if (entry.listeners.has(listener)) this.#notify(listener, progress)
      return
    }
    const value = data['outcome']
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('Invalid native download outcome')
    const outcome = value as Record<string, unknown>
    if (
      Object.keys(outcome).sort().join(',') !== 'bytesReceived,bytesWritten,failure,status' ||
      !terminal(entry.progress.status) ||
      outcome['status'] !== entry.progress.status ||
      outcome['failure'] !== entry.progress.failure ||
      outcome['bytesReceived'] !== entry.progress.bytesReceived ||
      !Number.isSafeInteger(outcome['bytesWritten']) ||
      outcome['bytesWritten'] !== (outcome['status'] === 'completed' ? outcome['bytesReceived'] : 0)
    )
      throw new Error('Native download outcome does not match terminal progress')
    this.#remove(entry)
    const result = Object.freeze({
      status: outcome['status'],
      bytesWritten: outcome['bytesWritten'],
      bytesReceived: outcome['bytesReceived'],
      ...(outcome['failure'] === null ? {} : { failure: outcome['failure'] }),
    }) as DownloadOutcome
    entry.resolve(result)
  }
  #remove(entry: Entry): void {
    entry.settled = true
    entry.removeAbort()
    entry.listeners.clear()
    if (this.#entries.get(entry.view) === entry) this.#entries.delete(entry.view)
  }
  close(error: Error): void {
    for (const entry of this.#entries.values()) {
      this.#remove(entry)
      entry.reject(error)
    }
  }
}
