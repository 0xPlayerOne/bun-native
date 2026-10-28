import type { Readable, Writable } from 'node:stream'
import capacity from './native-capacity.json'
const DESKTOP_CAPABILITIES = Object.freeze([
  'window.state',
  'window.geometry',
  'clipboard.text',
  'app.lifecycle',
] as const)
export type NativeDesktopCapability = (typeof DESKTOP_CAPABILITIES)[number]
function desktopCapabilities(value: unknown): readonly NativeDesktopCapability[] {
  // ABI 1 predates portable desktop capabilities. Absence preserves that legacy
  // peer without claiming that newer native operations are available.
  if (value === undefined) return Object.freeze([])
  const metadata = object(value)
  const capabilities = metadata['capabilities']
  if (
    Object.keys(metadata).length !== 2 ||
    metadata['version'] !== 1 ||
    !Array.isArray(capabilities) ||
    capabilities.length > 16 ||
    new Set(capabilities).size !== capabilities.length ||
    capabilities.some(
      (capability) =>
        typeof capability !== 'string' ||
        !DESKTOP_CAPABILITIES.includes(capability as NativeDesktopCapability)
    )
  )
    throw new Error('Invalid native desktop capabilities')
  Object.freeze(metadata)
  return Object.freeze(capabilities) as readonly NativeDesktopCapability[]
}
export interface NativeEvent {
  readonly v: 1
  readonly event: string
  readonly target?: number
  readonly data?: Record<string, unknown> | null
  readonly abi?: number
  readonly cef?: string
}
type Abandoned = { timer: ReturnType<typeof setTimeout>; ordinary: boolean }
type Pending = {
  readonly ordinary: boolean
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
/** A pending call was cancelled by the host's explicit normal-shutdown receipt. */
export class NativeShutdownError extends Error {
  constructor() {
    super('Native host shut down')
    this.name = 'NativeShutdownError'
  }
}
/** Private inherited pipes, not renderer IPC. Application code never writes protocol frames itself. */
export class NativeTransport {
  readonly #input: Readable
  readonly #output: Writable
  readonly #pending = new Map<number, Pending>()
  readonly #listeners = new Set<(event: NativeEvent) => void>()
  readonly #abandoned = new Map<number, Abandoned>()
  #next = 0
  #closed = false
  #queuedBytes = 0
  #ordinaryQueuedBytes = 0
  #ordinaryRequests = 0
  #controlAdmissionsUnderPressure = 0
  #ready = false
  #desktopCapabilities: readonly NativeDesktopCapability[] = Object.freeze([])
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
  /** Validated current-host features. Empty before readiness and for legacy ABI 1 hosts. */
  get desktopCapabilities(): readonly NativeDesktopCapability[] {
    return this.#desktopCapabilities
  }
  onEvent(listener: (event: NativeEvent) => void): () => void {
    if (this.#closed) throw new Error('Native transport closed')
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }
  call(
    operation: string,
    args: Record<string, unknown> = {},
    signal?: AbortSignal,
    timeoutMs = this.#requestTimeoutMs
  ): Promise<unknown> {
    try {
      if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError')
      if (this.#closed || !this.#ready) throw new Error('Native transport is not ready')
      if (this.#pending.size + this.#abandoned.size >= capacity.requests)
        throw new Error('Native request capacity exceeded')
      if (
        typeof operation !== 'string' ||
        !Number.isFinite(timeoutMs) ||
        timeoutMs <= 0 ||
        timeoutMs > 30000 ||
        !/^[a-z][a-z.]{0,63}$/.test(operation)
      )
        throw new Error('Invalid native request')
      // Snapshot arguments before allocating an identity: toJSON can reenter this transport.
      const serialized = JSON.stringify(args)
      if (typeof serialized !== 'string' || !serialized.startsWith('{'))
        throw new Error('Invalid native request arguments')
      if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError')
      if (this.#closed || !this.#ready) throw new Error('Native transport is not ready')
      if (this.#pending.size + this.#abandoned.size >= capacity.requests)
        throw new Error('Native request capacity exceeded')
      if (this.#next >= Number.MAX_SAFE_INTEGER)
        throw new Error('Native request identity exhausted')
      const id = this.#next + 1
      // The operation grammar above contains no JSON metacharacters.
      const json = `{"v":1,"id":${id},"op":"${operation}","args":${serialized}}\n`
      const length = Buffer.byteLength(json)
      // Only bounded lifecycle/ack operations may consume the reserved headroom.
      // This scheduling class grants no native authority and is never page-supplied.
      const ordinary = !(
        length <= capacity.controlFrameBytes && capacity.controlOperations.includes(operation)
      )
      if (ordinary && this.#ordinaryRequests >= capacity.ordinaryRequests)
        throw new Error('Native ordinary request capacity exceeded')
      if (
        length > capacity.frameBytes ||
        this.#queuedBytes + length > capacity.queuedBytes ||
        (ordinary && this.#ordinaryQueuedBytes + length > capacity.ordinaryQueuedBytes)
      )
        throw new Error('Native output capacity exceeded')
      const bytes = Buffer.from(json)
      this.#next = id
      return new Promise((resolve, reject) => {
        const abort = () => {
          const pending = this.#pending.get(id)
          if (!pending) return
          this.#pending.delete(id)
          pending.removeAbort()
          // Cancellation does not acknowledge native side effects. Keep the original deadline.
          this.#abandoned.set(id, { timer: pending.timer, ordinary: pending.ordinary })
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
          ordinary,
          resolve,
          reject,
          timer,
          removeAbort: () => signal?.removeEventListener('abort', abort),
        })
        signal?.addEventListener('abort', abort, { once: true })
        if (!ordinary && this.#ordinaryRequests >= capacity.ordinaryRequests)
          this.#controlAdmissionsUnderPressure = Math.min(
            Number.MAX_SAFE_INTEGER,
            this.#controlAdmissionsUnderPressure + 1
          )
        if (ordinary) this.#ordinaryRequests++
        this.#queuedBytes += length
        if (ordinary) this.#ordinaryQueuedBytes += length
        let released = false
        const releaseWrite = () => {
          if (released) return
          released = true
          this.#queuedBytes -= length
          if (ordinary) this.#ordinaryQueuedBytes -= length
        }
        try {
          this.#output.write(bytes, (error) => {
            releaseWrite()
            if (error) this.fail(error)
          })
        } catch (error) {
          releaseWrite()
          this.fail(error)
        }
      })
    } catch (error) {
      return Promise.reject(error)
    }
  }
  diagnostics() {
    return {
      requests: this.#pending.size,
      abandoned: this.#abandoned.size,
      queuedBytes: this.#queuedBytes,
      ordinaryRequests: this.#ordinaryRequests,
      ordinaryQueuedBytes: this.#ordinaryQueuedBytes,
      controlAdmissionsUnderPressure: this.#controlAdmissionsUnderPressure,
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
    const error = failure ?? new NativeShutdownError()
    this.#rejectReady(error)
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer)
      pending.removeAbort()
      pending.reject(error)
    }
    this.#pending.clear()
    for (const abandoned of this.#abandoned.values()) clearTimeout(abandoned.timer)
    this.#abandoned.clear()
    this.#listeners.clear()
    this.#ordinaryRequests = 0
    // Raw writes retain their byte reservations until the adapter callback settles.
    // Destroying a pipe is not proof that an uncooperative adapter released bytes.
    // Release the read loop and inherited protocol pipes on failure as well as
    // shutdown. The native owner observes EOF and performs its bounded teardown.
    this.#input.destroy()
    this.#output.destroy()
    this.#resolveClosed()
  }
  async #read(): Promise<void> {
    const decoder = new TextDecoder('utf-8', { fatal: true })
    // Scan delimiters in bytes once. Repeated UTF-8 decoding, string concatenation
    // and byteLength/indexOf on the accumulated prefix are quadratic on short reads.
    // Allocate only for a split frame; retain at most one 64 KiB scratch buffer.
    let partial: Buffer | undefined
    let used = 0
    let processed = 0
    const append = (bytes: Buffer) => {
      const needed = used + bytes.length
      if (!partial || partial.length < needed) {
        const next = Buffer.allocUnsafe(
          Math.min(65536, Math.max(1024, needed, (partial?.length ?? 0) * 2))
        )
        if (partial) partial.copy(next, 0, 0, used)
        partial = next
      }
      bytes.copy(partial, used)
      used = needed
    }
    const consume = async (text: string) => {
      let start = 0
      for (;;) {
        const end = text.indexOf('\n', start)
        if (end < 0) break
        const completed = this.#receive(object(JSON.parse(text.slice(start, end))))
        start = end + 1
        // Publish resolved creation ownership before consuming the next lifecycle event.
        if (completed) await Promise.resolve()
        if (this.#closed) return
        if (++processed % 32 === 0) await new Promise<void>((resolve) => setImmediate(resolve))
      }
    }
    try {
      for await (const chunk of this.#input) {
        if (this.#closed) return
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
        let offset = 0
        while (offset < bytes.length) {
          if (!used) {
            // Batched short events keep one decoder invocation per bounded block.
            // An LF-terminated <=16 KiB prefix cannot contain an oversized frame.
            const batch = bytes.subarray(offset, offset + 16384)
            const last = batch.lastIndexOf(10)
            if (last >= 0) {
              await consume(decoder.decode(batch.subarray(0, last + 1), { stream: true }))
              if (this.#closed) return
              offset += last + 1
              continue
            }
          }
          // Restrict the search itself: malformed huge input is rejected without
          // scanning beyond the maximum remaining frame capacity.
          const window = bytes.subarray(offset, offset + 65536 - used)
          const newline = window.indexOf(10)
          const end = newline < 0 ? -1 : offset + newline
          const length = newline < 0 ? window.length : newline
          if (used + length > 65535)
            throw new Error(
              end < 0
                ? 'Unterminated native frame exceeds limit'
                : 'Native input frame exceeds limit'
            )
          if (end < 0) {
            append(bytes.subarray(offset))
            break
          }
          // Include LF so fatal UTF-8 rejects an unfinished codepoint at the boundary.
          let frame = bytes.subarray(offset, end + 1)
          if (used) {
            append(frame)
            frame = partial!.subarray(0, used)
            used = 0
          }
          offset = end + 1
          // Preserve decoder stream/BOM semantics; each byte is decoded only once.
          await consume(decoder.decode(frame, { stream: true }))
          if (this.#closed) return
        }
      }
      if (used) decoder.decode(partial!.subarray(0, used), { stream: true })
      decoder.decode()
      if (!this.#closed)
        this.fail(new Error(used ? 'Truncated native frame at EOF' : 'Native host disconnected'))
    } catch (error) {
      this.fail(error)
    }
  }
  #receive(frame: Record<string, unknown>): boolean {
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
      if (frame['data'] !== undefined && frame['data'] !== null)
        Object.freeze(object(frame['data']))
      const event = Object.freeze(frame) as unknown as NativeEvent
      if (event.event === 'ready') {
        if (this.#ready || event.abi !== 1) throw new Error('Native readiness/ABI mismatch')
        const capabilities = desktopCapabilities(event.data?.['desktopCapabilities'])
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
        this.#desktopCapabilities = capabilities
        this.#ready = true
        this.#resolveReady(event)
      } else if (!this.#ready) throw new Error('Native event before readiness')
      if (
        event.event === 'shutdown' &&
        event.data !== undefined &&
        event.data !== null &&
        (Object.keys(event.data).length !== 1 || typeof event.data['failed'] !== 'boolean')
      )
        throw new Error('Malformed native shutdown result')
      for (const listener of Array.from(this.#listeners)) {
        if (!this.#listeners.has(listener)) continue
        try {
          listener(event)
        } catch {
          /* Diagnostics listeners cannot disrupt protocol progress. */
        }
      }
      if (event.event === 'shutdown')
        this.#finish(
          event.data?.['failed'] === true ? new Error('Native host reported failed shutdown') : null
        )
      return event.event === 'ready'
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
    const abandoned = this.#abandoned.get(Number(id))
    if (abandoned !== undefined) {
      clearTimeout(abandoned.timer)
      this.#abandoned.delete(Number(id))
      if (abandoned.ordinary) this.#ordinaryRequests--
      return false
    }
    const pending = this.#pending.get(Number(id))
    if (!pending) throw new Error('Unexpected or duplicate native response')
    this.#pending.delete(Number(id))
    if (pending.ordinary) this.#ordinaryRequests--
    clearTimeout(pending.timer)
    pending.removeAbort()
    if (frame['ok']) pending.resolve(frame['value'])
    else pending.reject(new Error(String(frame['error'])))
    return true
  }
}
