import { rpcScheduler } from './rpc.ts'
import type { RpcScheduler, RpcTransport } from './rpc.ts'
import { StreamBudget } from './stream-budget.ts'
import { StreamLink } from './stream-link.ts'
import {
  STREAM_CHUNK_BYTES,
  STREAM_ERRORS,
  STREAM_HEADER_BYTES,
  StreamError,
  encodeStream,
  streamFrame,
  validateChunkSize,
} from './stream-wire.ts'
import type { StreamFrame, StreamErrorCode } from './stream-wire.ts'
export interface BinaryStreamOptions {
  readonly budget: StreamBudget
  /** Host-attested local object, shared across reconnects; never a page-supplied view ID. */
  readonly owner: object
  readonly signal?: AbortSignal
  readonly maxChunkBytes?: number
  readonly timeoutMs?: number
  readonly sendTimeoutMs?: number
  readonly maxQueuedBytes?: number
  readonly maxQueuedFrames?: number
  readonly scheduler?: RpcScheduler
}
export type StreamOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: StreamErrorCode }
export interface BinaryStreamWriter {
  /** One outstanding write. Resolves only after the actual consumer acknowledges it. */
  write(chunk: Uint8Array): Promise<void>
  end(): Promise<void>
  cancel(): void
  readonly finished: Promise<StreamOutcome>
}
export interface StreamConsumerContext {
  readonly signal: AbortSignal
  readonly streamId: number
}
export interface BinaryStreamSink {
  /** Resolve only when consumed, e.g. xterm.write(data, callback), not on postMessage. */
  consume(chunk: Uint8Array, context: StreamConsumerContext): void | Promise<void>
  finish?(context: StreamConsumerContext): void | Promise<void>
}
interface Pending {
  readonly kind: 'opened' | 'ack' | 'closed'
  readonly sequence: number
  readonly bytes: number
  readonly resolve: () => void
  readonly reject: (error: StreamError) => void
  readonly deadline: number
  timer: unknown
  handedOff: boolean
  acknowledged: boolean
}
interface State {
  id: number
  sequence: number
  active: boolean
  sends: number
  started: boolean
  consuming: number
  busy: boolean
  release: () => void
  pending?: Pending
  controller: AbortController
  removeAbort: () => void
  outcome: (outcome: StreamOutcome) => void
  finished: Promise<StreamOutcome>
}
function state(id: number, release: () => void): State {
  let outcome!: (value: StreamOutcome) => void
  const finished = new Promise<StreamOutcome>((r) => {
    outcome = r
  })
  return {
    id,
    release,
    sequence: 0,
    active: true,
    sends: 0,
    started: false,
    consuming: 0,
    busy: false,
    controller: new AbortController(),
    removeAbort: () => {},
    outcome,
    finished,
  }
}
function failure(code: StreamErrorCode): StreamError {
  return new StreamError(code)
}
function collect(s: State): void {
  if (!s.active && !s.consuming && !s.sends) s.release()
}
class Endpoint {
  readonly states = new Map<number, State>()
  readonly link: StreamLink
  readonly chunk: number
  readonly timeout: number
  readonly clock: RpcScheduler
  reason: StreamError | undefined
  private removeAbort: () => void = () => {}
  constructor(
    readonly options: BinaryStreamOptions,
    transport: RpcTransport,
    receive: (frame: StreamFrame) => void
  ) {
    this.options = Object.freeze({ ...options })
    if (
      !(options.budget instanceof StreamBudget) ||
      !options.owner ||
      typeof options.owner !== 'object'
    )
      throw new TypeError('Supply a host-owned stream budget and view object')
    this.chunk = options.maxChunkBytes ?? STREAM_CHUNK_BYTES
    validateChunkSize(this.chunk)
    this.timeout = options.timeoutMs ?? 30_000
    this.clock = options.scheduler ?? rpcScheduler
    const sendTimeout = options.sendTimeoutMs ?? 5_000,
      maxFrames = options.maxQueuedFrames ?? 128
    const maxBytes =
      options.maxQueuedBytes ?? Math.max(2 * 1024 * 1024, this.chunk + STREAM_HEADER_BYTES)
    if (
      ![this.timeout, sendTimeout, maxFrames, maxBytes].every(
        (n) => Number.isSafeInteger(n) && n >= 1
      ) ||
      this.timeout > 600_000 ||
      sendTimeout > 60_000 ||
      maxFrames > 4096 ||
      maxBytes < this.chunk + STREAM_HEADER_BYTES ||
      maxBytes > 64 * 1024 * 1024
    )
      throw new TypeError('Invalid binary stream limits')
    this.link = new StreamLink(
      transport,
      this.chunk,
      maxBytes,
      maxFrames,
      sendTimeout,
      this.clock,
      receive,
      (error) => this.disconnected(error)
    )
  }
  start(): void {
    if (this.options.signal) {
      const abort = () => this.link.close(failure('CANCELLED'))
      this.options.signal.addEventListener('abort', abort, { once: true })
      this.removeAbort = () => this.options.signal!.removeEventListener('abort', abort)
      if (this.options.signal.aborted) {
        abort()
        return
      }
    }
    this.link.start()
  }
  disconnected(error: StreamError): void {
    this.reason = error
    this.removeAbort()
    for (const s of Array.from(this.states.values())) this.retire(s, error.code)
  }
  reserve(id: number): State {
    if (this.reason) throw this.reason
    // Three complete packet capacities cover snapshots, framing and in-flight handoff.
    const s = state(
      id,
      this.options.budget.reserve(this.options.owner, 3 * (this.chunk + STREAM_HEADER_BYTES))
    )
    this.states.set(id, s)
    return s
  }
  send(frame: StreamFrame, s?: State, before?: () => void): Promise<void> {
    let packet: Uint8Array
    try {
      packet = encodeStream(frame, this.chunk)
    } catch (error) {
      return Promise.reject(error)
    }
    if (s) s.sends++
    return this.link.send(
      packet,
      () => {
        if (s && !s.active) return false
        if (s) s.started = true
        before?.()
        return true
      },
      () => {
        if (s) {
          s.sends--
          collect(s)
        }
      }
    )
  }
  tell(frame: StreamFrame): void {
    void this.send(frame).catch(() => this.link.close())
  }
  retire(s: State, code?: StreamErrorCode): void {
    if (!s.active) return
    s.active = false
    this.states.delete(s.id)
    s.removeAbort()
    const pending = s.pending
    delete s.pending
    if (pending) {
      this.clock.clear(pending.timer)
      pending.reject(failure(code ?? 'DISCONNECTED'))
    }
    s.outcome(code ? { ok: false, code } : { ok: true })
    s.controller.abort(failure(code ?? 'CANCELLED'))
    collect(s)
  }
  close(): void {
    this.link.close()
  }
  diagnostics() {
    return { streams: this.states.size, ...this.link.diagnostics() }
  }
}
/** One direction per dedicated authenticated transport. No producer queue or silent dropping. */
export class BinaryStreamSender {
  readonly #endpoint: Endpoint
  #sequence = 0
  constructor(transport: RpcTransport, options: BinaryStreamOptions) {
    this.#endpoint = new Endpoint(options, transport, (frame) => this.#receive(frame))
    this.#endpoint.start()
  }
  open(
    name: string,
    options: { readonly signal?: AbortSignal; readonly mode?: 'lossless' } = {}
  ): Promise<BinaryStreamWriter> {
    if (typeof name !== 'string' || name.length > 128)
      return Promise.reject(failure('PROTOCOL_ERROR'))
    if (options.mode !== undefined && options.mode !== 'lossless')
      return Promise.reject(failure('PROTOCOL_ERROR'))
    if (options.signal?.aborted) return Promise.reject(failure('CANCELLED'))
    if (this.#sequence >= 0xffffffff) return Promise.reject(failure('OVERLOADED'))
    let s: State, frame: StreamFrame
    try {
      frame = streamFrame('open', ++this.#sequence, 0, 0, new TextEncoder().encode(name))
      encodeStream(frame, this.#endpoint.chunk)
      s = this.#endpoint.reserve(frame.id)
    } catch (error) {
      return Promise.reject(error)
    }
    const cancel = () => this.#cancel(s)
    if (options.signal) {
      const signal = options.signal
      signal.addEventListener('abort', cancel, { once: true })
      s.removeAbort = () => signal.removeEventListener('abort', cancel)
    }
    const writer: BinaryStreamWriter = Object.freeze({
      write: (chunk: Uint8Array) => this.#write(s, chunk),
      end: () => this.#end(s),
      cancel,
      finished: s.finished,
    })
    return this.#wait(s, frame, 'opened').then(() => writer)
  }
  #write(s: State, chunk: Uint8Array): Promise<void> {
    if (!s.active) return Promise.reject(failure('DISCONNECTED'))
    if (s.pending) return Promise.reject(failure('OVERLOADED'))
    if (
      !(chunk instanceof Uint8Array) ||
      !(chunk.buffer instanceof ArrayBuffer) ||
      !chunk.length ||
      chunk.length > this.#endpoint.chunk
    )
      return Promise.reject(failure('PROTOCOL_ERROR'))
    if (s.sequence >= 0xffffffff) {
      this.#cancel(s)
      return Promise.reject(failure('OVERLOADED'))
    }
    return this.#wait(s, streamFrame('data', s.id, ++s.sequence, 0, chunk), 'ack')
  }
  #end(s: State): Promise<void> {
    if (!s.active) return Promise.reject(failure('DISCONNECTED'))
    if (s.pending) return Promise.reject(failure('OVERLOADED'))
    return this.#wait(s, streamFrame('close', s.id, s.sequence), 'closed').then(() =>
      this.#endpoint.retire(s)
    )
  }
  #wait(s: State, frame: StreamFrame, kind: Pending['kind']): Promise<void> {
    if (!s.active) return Promise.reject(failure('DISCONNECTED'))
    if (s.pending) return Promise.reject(failure('OVERLOADED'))
    const endpoint = this.#endpoint
    return new Promise((resolve, reject) => {
      const pending: Pending = {
        kind,
        sequence: frame.sequence,
        bytes: frame.body.length,
        resolve,
        reject,
        deadline: endpoint.clock.now() + endpoint.timeout,
        timer: undefined,
        handedOff: false,
        acknowledged: false,
      }
      s.pending = pending
      pending.timer = endpoint.clock.set(endpoint.timeout, () =>
        this.#cancel(s, 'DEADLINE_EXCEEDED')
      )
      void endpoint.send(frame, s).then(
        () => {
          pending.handedOff = true
          this.#complete(s, pending)
        },
        (error) => {
          if (s.active) this.#cancel(s, error instanceof StreamError ? error.code : 'DISCONNECTED')
        }
      )
    })
  }
  #complete(s: State, pending: Pending): void {
    if (!s.active || s.pending !== pending || !pending.handedOff || !pending.acknowledged) return
    if (this.#endpoint.clock.now() >= pending.deadline) {
      this.#cancel(s, 'DEADLINE_EXCEEDED')
      return
    }
    delete s.pending
    this.#endpoint.clock.clear(pending.timer)
    pending.resolve()
  }
  #cancel(s: State, code: StreamErrorCode = 'CANCELLED'): void {
    if (!s.active) return
    const started = s.started
    this.#endpoint.retire(s, code)
    if (started) this.#endpoint.tell(streamFrame('cancel', s.id))
  }
  #receive(frame: StreamFrame): void {
    if (!['opened', 'ack', 'closed', 'error'].includes(frame.kind) || frame.id > this.#sequence)
      throw failure('PROTOCOL_ERROR')
    const s = this.#endpoint.states.get(frame.id)
    if (!s) return // Cancellation/late-response race; IDs are never reused.
    if (frame.kind === 'error') {
      this.#endpoint.retire(s, STREAM_ERRORS[frame.argument - 1]!)
      return
    }
    const pending = s.pending
    if (
      frame.kind === 'ack' &&
      (pending?.kind !== 'ack' ? frame.sequence <= s.sequence : frame.sequence < pending.sequence)
    )
      return
    if (
      !pending ||
      !s.started ||
      frame.kind !== pending.kind ||
      frame.sequence !== pending.sequence ||
      (frame.kind === 'ack' && frame.argument !== pending.bytes)
    )
      throw failure('PROTOCOL_ERROR')
    pending.acknowledged = true
    this.#complete(s, pending)
  }
  close(): void {
    this.#endpoint.close()
  }
  get closed(): Promise<StreamError> {
    return this.#endpoint.link.closed
  }
  diagnostics() {
    return this.#endpoint.diagnostics()
  }
}
interface Receiving {
  readonly state: State
  readonly sink: BinaryStreamSink
  credit: boolean
}
/** Sink names are a host-provisioned allowlist, not a capability or native identity proof. */
export class BinaryStreamReceiver {
  readonly #endpoint: Endpoint
  readonly #sinks = new Map<string, BinaryStreamSink>()
  readonly #receiving = new Map<number, Receiving>()
  #sequence = 0
  constructor(
    transport: RpcTransport,
    options: BinaryStreamOptions,
    sinks: Readonly<Record<string, BinaryStreamSink>>
  ) {
    if (!Object.keys(sinks).length || Object.keys(sinks).length > 256)
      throw new TypeError('Supply 1–256 authorized stream sinks')
    for (const [name, sink] of Object.entries(sinks)) {
      encodeStream(streamFrame('open', 1, 0, 0, new TextEncoder().encode(name)))
      if (
        !sink ||
        typeof sink.consume !== 'function' ||
        (sink.finish !== undefined && typeof sink.finish !== 'function')
      )
        throw new TypeError('Invalid stream sink')
      this.#sinks.set(
        name,
        Object.freeze({ consume: sink.consume, ...(sink.finish ? { finish: sink.finish } : {}) })
      )
    }
    this.#endpoint = new Endpoint(options, transport, (frame) => this.#receive(frame))
    void this.#endpoint.link.closed.then(() => this.#receiving.clear())
    this.#endpoint.start()
  }
  #receive(frame: StreamFrame): void {
    if (frame.kind === 'open') {
      if (frame.id <= this.#sequence) throw failure('PROTOCOL_ERROR')
      this.#sequence = frame.id
      const sink = this.#sinks.get(new TextDecoder().decode(frame.body))
      if (!sink) {
        this.#error(frame.id, 'FORBIDDEN')
        return
      }
      let s: State
      try {
        s = this.#endpoint.reserve(frame.id)
      } catch {
        this.#error(frame.id, 'OVERLOADED')
        return
      }
      const entry: Receiving = { state: s, sink, credit: false }
      this.#receiving.set(frame.id, entry)
      void this.#endpoint
        .send(streamFrame('opened', frame.id), s, () => {
          entry.credit = true
        })
        .catch(() => this.#endpoint.close())
      return
    }
    if (!['data', 'close', 'cancel'].includes(frame.kind) || frame.id > this.#sequence)
      throw failure('PROTOCOL_ERROR')
    const entry = this.#receiving.get(frame.id)
    if (frame.kind === 'cancel') {
      if (entry) this.#retire(entry.state, 'CANCELLED')
      return
    }
    // A failure/cancellation may cross an already-sent DATA frame. No handler is invoked.
    if (!entry || !entry.state.active) return
    const s = entry.state
    if (!entry.credit || s.busy || frame.sequence !== s.sequence + (frame.kind === 'data' ? 1 : 0))
      throw failure('PROTOCOL_ERROR')
    entry.credit = false
    if (frame.kind === 'data') s.sequence = frame.sequence
    // Own just the declared chunk, never its larger backing allocation.
    const chunk = frame.kind === 'data' ? frame.body.slice() : undefined
    this.#consume(entry, chunk)
  }
  #consume(entry: Receiving, chunk: Uint8Array | undefined): void {
    const { state: s, sink } = entry
    const endpoint = this.#endpoint
    s.consuming++
    s.busy = true
    const deadline = endpoint.clock.now() + endpoint.timeout
    const timer = endpoint.clock.set(endpoint.timeout, () => {
      if (s.active) {
        this.#error(s.id, 'DEADLINE_EXCEEDED')
        this.#retire(s, 'DEADLINE_EXCEEDED')
      }
    })
    const removeTimer = () => endpoint.clock.clear(timer)
    s.controller.signal.addEventListener('abort', removeTimer, { once: true })
    const context: StreamConsumerContext = Object.freeze({
      signal: s.controller.signal,
      streamId: s.id,
    })
    void (async () => {
      try {
        if (chunk) await sink.consume(chunk, context)
        else await sink.finish?.(context)
        if (!s.active || endpoint.reason) return
        if (endpoint.clock.now() >= deadline) {
          this.#error(s.id, 'DEADLINE_EXCEEDED')
          this.#retire(s, 'DEADLINE_EXCEEDED')
          return
        }
        // Credit is replenished after consumption, not on packet delivery. Clear busy
        // immediately before send to permit a synchronous adapter's next DATA callback.
        endpoint.clock.clear(timer)
        s.busy = false
        if (chunk)
          await endpoint.send(streamFrame('ack', s.id, s.sequence, chunk.length), s, () => {
            entry.credit = true
          })
        else {
          await endpoint.send(streamFrame('closed', s.id, s.sequence), s)
          this.#retire(s)
        }
      } catch {
        if (s.active) {
          this.#error(s.id, 'CONSUMER_FAILED')
          this.#retire(s, 'CONSUMER_FAILED')
        }
      } finally {
        endpoint.clock.clear(timer)
        s.controller.signal.removeEventListener('abort', removeTimer)
        s.consuming--
        collect(s)
      }
    })()
  }
  #error(id: number, code: StreamErrorCode): void {
    this.#endpoint.tell(streamFrame('error', id, 0, STREAM_ERRORS.indexOf(code) + 1))
  }
  #retire(s: State, code?: StreamErrorCode): void {
    this.#receiving.delete(s.id)
    this.#endpoint.retire(s, code)
  }
  close(): void {
    this.#endpoint.close()
  }
  get closed(): Promise<StreamError> {
    return this.#endpoint.link.closed
  }
  diagnostics() {
    return this.#endpoint.diagnostics()
  }
}
