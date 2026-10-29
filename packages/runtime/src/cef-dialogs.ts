import {
  BunlyError,
  validSelectedFilePath,
  type FileDialogResult,
} from '../../contracts/src/index.ts'
import type { NativeEvent, NativeTransport } from './native-transport.ts'

interface PendingDialog {
  readonly view: number
  id: number | undefined
  readonly completed: Promise<FileDialogResult>
  readonly resolve: (value: FileDialogResult) => void
  readonly reject: (error: Error) => void
  readonly current: () => void
  cancelRequested: boolean
  cancelSent: boolean
  settled: boolean
  removeAbort: () => void
}

/** One charged native owner until its real completion event, including after abort. */
export class CefFileDialogs {
  #pending: PendingDialog | undefined
  constructor(readonly transport: NativeTransport) {}
  async show(
    view: number,
    scope: Readonly<Record<string, unknown>>,
    kind: 'open' | 'save',
    dialog: Readonly<{ title: string; suggestedName: string; directory: string }>,
    current: () => void,
    signal?: AbortSignal
  ): Promise<FileDialogResult> {
    if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError')
    if (this.#pending)
      throw new BunlyError('RESOURCE_IN_USE', 'A native file dialog is still owned')
    let resolve!: PendingDialog['resolve']
    let reject!: PendingDialog['reject']
    const completed = new Promise<FileDialogResult>((done, failed) => {
      resolve = done
      reject = failed
    })
    void completed.catch(() => {})
    const entry: PendingDialog = {
      view,
      id: undefined,
      completed,
      resolve,
      reject,
      current,
      cancelRequested: false,
      cancelSent: false,
      settled: false,
      removeAbort: () => {},
    }
    const aborted = () => {
      entry.cancelRequested = true
      this.#cancel(entry)
    }
    entry.removeAbort = () => signal?.removeEventListener('abort', aborted)
    signal?.addEventListener('abort', aborted, { once: true })
    this.#pending = entry
    try {
      current()
      // Admission always settles, even if cancellation arrives before its reply.
      const result = await this.transport.call('dialog.show', { id: view, scope, kind, ...dialog })
      if (
        !result ||
        typeof result !== 'object' ||
        Array.isArray(result) ||
        Object.keys(result).join(',') !== 'id' ||
        !Number.isSafeInteger((result as { id?: unknown }).id) ||
        Number((result as { id: unknown }).id) < 1
      ) {
        this.transport.fail(new Error('Invalid native dialog admission'))
        throw new Error('Invalid native dialog admission')
      }
      entry.id = Number((result as { id: unknown }).id)
      if (entry.cancelRequested) this.#cancel(entry)
    } catch (error) {
      this.#remove(entry)
      entry.reject(error instanceof Error ? error : new Error(String(error)))
      throw error
    }
    return completed
  }
  #cancel(entry: PendingDialog): void {
    if (entry.settled || entry.cancelSent || entry.id === undefined) return
    entry.cancelSent = true
    void this.transport.call('dialog.cancel', { id: entry.view, dialog: entry.id }).then(
      (value) => {
        if (value !== null)
          this.transport.fail(new Error('Invalid native dialog cancellation receipt'))
      },
      (error: unknown) => this.transport.fail(error)
    )
  }
  event(event: NativeEvent): void {
    if (event.event !== 'dialog.finished') return
    const entry = this.#pending
    const data = event.data
    if (
      !entry ||
      event.target !== entry.view ||
      !data ||
      Object.keys(data).sort().join(',') !== 'error,id,path,status' ||
      data['id'] !== entry.id
    )
      throw new Error('Mismatched native dialog completion')
    const status = data['status']
    const path = data['path']
    const error = data['error']
    if (
      !['selected', 'cancelled', 'failed'].includes(String(status)) ||
      (status === 'selected' ? !validSelectedFilePath(path) : path !== null) ||
      (status === 'failed'
        ? !['PERMISSION_DENIED', 'NATIVE_FAILURE', 'INVALID_ARGUMENT'].includes(String(error))
        : error !== null)
    )
      throw new Error('Malformed native file dialog result')
    this.#remove(entry)
    if (status === 'failed') {
      entry.reject(
        error === 'PERMISSION_DENIED' || error === 'INVALID_ARGUMENT'
          ? new BunlyError(error, 'Native file dialog did not produce an authorized selection')
          : new Error('Native file dialog failed')
      )
      return
    }
    if (entry.cancelRequested || status === 'cancelled') {
      entry.resolve(Object.freeze({ status: 'cancelled' }))
      return
    }
    try {
      entry.current()
      entry.resolve(Object.freeze({ status: 'selected', path: path as string }))
    } catch (failure) {
      entry.reject(failure instanceof Error ? failure : new Error(String(failure)))
    }
  }
  #remove(entry: PendingDialog): void {
    entry.settled = true
    entry.removeAbort()
    if (this.#pending === entry) this.#pending = undefined
  }
  close(error: Error): void {
    const entry = this.#pending
    if (!entry) return
    this.#remove(entry)
    entry.reject(error)
  }
}
