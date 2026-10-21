import type { Readable, Writable } from 'node:stream'
export interface NativeEvent {
  readonly v: 1
  readonly event: string
  readonly target?: number
  readonly data?: Record<string, unknown> | null
  readonly abi?: number
  readonly cef?: string
}
type Pending = {
  resolve(value: unknown): void
  reject(error: Error): void
  timer: ReturnType<typeof setTimeout>
  removeAbort(): void
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Native frame is not an object')
  return value as Record<string, unknown>
}
/** Private inherited pipes, not renderer IPC. Application code never writes protocol frames itself. */
export class NativeTransport {
  readonly #input: Readable
  readonly #output: Writable
  readonly #pending = new Map<number, Pending>()
  readonly #listeners = new Set<(event: NativeEvent) => void>()
  readonly #abandoned = new Set<number>()
  #next = 0
  #closed = false
  #queuedBytes = 0
  #ready = false
  #requestTimeoutMs = 10000
  #failure: Error | null = null
  #resolveReady!: (event: NativeEvent) => void
  #rejectReady!: (error: Error) => void
  #resolveClosed!: () => void
  readonly ready: Promise<NativeEvent>
  readonly closed: Promise<void>
  readonly #outputError = (error: Error) => this.fail(error)
  constructor(input: Readable, output: Writable) {
    this.#input = input
    this.#output = output
    this.ready = new Promise((resolve, reject) => {
      this.#resolveReady = resolve
      this.#rejectReady = reject
    })
    this.closed = new Promise((resolve) => {
      this.#resolveClosed = resolve
    })
    void this.ready.catch(() => {})
    output.on('error', this.#outputError)
    output.once('close', () => {
      output.off('error', this.#outputError)
      if (!this.#closed) this.fail(new Error('Native output closed'))
    })
    void this.#read()
  }
  get failure(): Error | null {
    return this.#failure
  }
  onEvent(listener: (event: NativeEvent) => void): () => void {
    if (this.#closed) throw new Error('Native transport closed')
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }
  async call(
    operation: string,
    args: Record<string, unknown> = {},
    signal?: AbortSignal,
    timeoutMs = this.#requestTimeoutMs
  ): Promise<unknown> {
    if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError')
    if (this.#closed || !this.#ready) throw new Error('Native transport is not ready')
    if (this.#pending.size >= 128 || this.#abandoned.size >= 128)
      throw new Error('Native request capacity exceeded')
    if (
      !Number.isFinite(timeoutMs) ||
      timeoutMs <= 0 ||
      timeoutMs > 30000 ||
      !/^[a-z][a-z.]{0,63}$/.test(operation)
    )
      throw new Error('Invalid native request')
    if (this.#next >= Number.MAX_SAFE_INTEGER) throw new Error('Native request identity exhausted')
    const id = this.#next + 1
    const bytes = Buffer.from(JSON.stringify({ v: 1, id, op: operation, args }) + '\n')
    if (bytes.length > 65536 || this.#queuedBytes + bytes.length > 1024 * 1024)
      throw new Error('Native output capacity exceeded')
    this.#next = id
    return new Promise((resolve, reject) => {
      const abort = () => {
        const pending = this.#pending.get(id)
        if (!pending) return
        this.#pending.delete(id)
        clearTimeout(pending.timer)
        pending.removeAbort()
        this.#abandoned.add(id)
        reject(
          signal?.reason instanceof Error
            ? signal.reason
            : new DOMException('Aborted', 'AbortError')
        )
      }
      // A deadline does not prove the native operation never ran. Retire the
      // connection rather than lose ownership of an unacknowledged created view.
      const timer = setTimeout(
        () => this.fail(new Error(`Native request deadline: ${operation}`)),
        timeoutMs
      )
      this.#pending.set(id, {
        resolve,
        reject,
        timer,
        removeAbort: () => signal?.removeEventListener('abort', abort),
      })
      signal?.addEventListener('abort', abort, { once: true })
      this.#queuedBytes += bytes.length
      try {
        this.#output.write(bytes, (error) => {
          this.#queuedBytes = Math.max(0, this.#queuedBytes - bytes.length)
          if (error) this.fail(error)
        })
      } catch (error) {
        this.fail(error)
      }
    })
  }
  diagnostics() {
    return {
      requests: this.#pending.size,
      abandoned: this.#abandoned.size,
      queuedBytes: this.#queuedBytes,
      listeners: this.#listeners.size,
      closed: this.#closed,
    }
  }
  fail(reason: unknown): void {
    this.#finish(reason instanceof Error ? reason : new Error(String(reason)))
  }
  #finish(failure: Error | null): void {
    if (this.#closed) return
    this.#closed = true
    this.#failure = failure
    const error = failure ?? new Error('Native host shut down')
    this.#rejectReady(error)
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer)
      pending.removeAbort()
      pending.reject(error)
    }
    this.#pending.clear()
    this.#abandoned.clear()
    this.#listeners.clear()
    this.#queuedBytes = 0
    // Release the read loop and inherited protocol pipes on failure as well as
    // shutdown. The native owner observes EOF and performs its bounded teardown.
    this.#input.destroy()
    this.#output.destroy()
    this.#resolveClosed()
  }
  async #read(): Promise<void> {
    const decoder = new TextDecoder('utf-8', { fatal: true })
    let buffered = ''
    let processed = 0
    try {
      for await (const chunk of this.#input) {
        if (this.#closed) return
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
        for (let offset = 0; offset < bytes.length; offset += 16384) {
          buffered += decoder.decode(bytes.subarray(offset, offset + 16384), { stream: true })
          for (;;) {
            const end = buffered.indexOf('\n')
            if (end < 0) break
            const line = buffered.slice(0, end)
            buffered = buffered.slice(end + 1)
            if (Buffer.byteLength(line) > 65535) throw new Error('Native input frame exceeds limit')
            this.#receive(object(JSON.parse(line)))
            if (this.#closed) return
            if (++processed % 32 === 0) await new Promise<void>((resolve) => setImmediate(resolve))
          }
          if (Buffer.byteLength(buffered) > 65535)
            throw new Error('Unterminated native frame exceeds limit')
        }
      }
      buffered += decoder.decode()
      if (!this.#closed)
        this.fail(
          new Error(buffered.length ? 'Truncated native frame at EOF' : 'Native host disconnected')
        )
    } catch (error) {
      this.fail(error)
    }
  }
  #receive(frame: Record<string, unknown>): void {
    if (frame['v'] !== 1) throw new Error('Native protocol version mismatch')
    if (typeof frame['event'] === 'string') {
      if (
        !/^[a-z][a-z.-]{0,63}$/.test(frame['event']) ||
        frame['id'] !== undefined ||
        frame['ok'] !== undefined ||
        (frame['target'] !== undefined &&
          (!Number.isSafeInteger(frame['target']) || Number(frame['target']) <= 0))
      )
        throw new Error('Invalid native event')
      if (frame['data'] !== undefined && frame['data'] !== null) object(frame['data'])
      const event = frame as unknown as NativeEvent
      if (event.event === 'ready') {
        if (this.#ready || event.abi !== 1) throw new Error('Native readiness/ABI mismatch')
        if (
          event.data?.['deadlineProfile'] !== undefined ||
          event.data?.['requestTimeoutMs'] !== undefined
        ) {
          const profile = event.data['deadlineProfile']
          const expected =
            profile === 'standard' ? 10000 : profile === 'emulated-functional' ? 30000 : null
          if (expected === null || event.data['requestTimeoutMs'] !== expected)
            throw new Error('Invalid native deadline profile')
          this.#requestTimeoutMs = expected
        }
        this.#ready = true
        this.#resolveReady(event)
      } else if (!this.#ready) throw new Error('Native event before readiness')
      for (const listener of this.#listeners) {
        try {
          listener(event)
        } catch {
          /* Diagnostics listeners cannot disrupt protocol progress. */
        }
      }
      if (event.event === 'shutdown') this.#finish(null)
      return
    }
    const id = frame['id']
    if (
      !this.#ready ||
      !Number.isSafeInteger(id) ||
      Number(id) <= 0 ||
      Number(id) > this.#next ||
      typeof frame['ok'] !== 'boolean'
    )
      throw new Error('Invalid native response')
    if (!frame['ok'] && (typeof frame['error'] !== 'string' || !frame['error'].length))
      throw new Error('Invalid native error response')
    if (this.#abandoned.delete(Number(id))) return
    const pending = this.#pending.get(Number(id))
    if (!pending) throw new Error('Unexpected or duplicate native response')
    this.#pending.delete(Number(id))
    clearTimeout(pending.timer)
    pending.removeAbort()
    if (frame['ok']) pending.resolve(frame['value'])
    else pending.reject(new Error(String(frame['error'])))
  }
}
