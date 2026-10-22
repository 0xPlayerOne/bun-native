import type { RpcScheduler, RpcTransport } from './rpc.ts'
import { decodeStream, StreamError } from './stream-wire.ts'
import type { StreamFrame } from './stream-wire.ts'
interface Write {
  packet: Uint8Array
  readonly bytes: number
  resolve: () => void
  reject: (error: StreamError) => void
  before: () => boolean
  drained: () => void
  released: boolean
}
/** Dedicated bulk lane. Closing settles callers but cannot pretend a hung adapter released bytes. */
export class StreamLink {
  readonly #queue: Write[] = []
  #active: Write | undefined
  #bytes = 0
  #off: (() => void) | undefined
  #timer: unknown
  #reason: StreamError | undefined
  #started = false
  readonly closed: Promise<StreamError>
  readonly #resolve: (reason: StreamError) => void
  constructor(
    readonly transport: RpcTransport,
    readonly maxChunk: number,
    readonly maxBytes: number,
    readonly maxFrames: number,
    readonly sendTimeoutMs: number,
    readonly clock: RpcScheduler,
    readonly receive: (frame: StreamFrame) => void,
    readonly disconnected: (error: StreamError) => void
  ) {
    let resolve!: (error: StreamError) => void
    this.closed = new Promise((r) => {
      resolve = r
    })
    this.#resolve = resolve
  }
  start(): void {
    if (this.#started) throw new TypeError('Stream link already started')
    this.#started = true
    try {
      const off = this.transport.subscribe(
        (packet) => {
          if (this.#reason) return
          try {
            this.receive(decodeStream(packet, this.maxChunk))
          } catch (e) {
            this.close(e instanceof StreamError ? e : new StreamError('PROTOCOL_ERROR'))
          }
        },
        () => this.close()
      )
      if (this.#reason) off()
      else this.#off = off
    } catch {
      this.close()
    }
  }
  /** Owns packet. drained is called only when the adapter settles or unsent data is discarded. */
  send(packet: Uint8Array, before: () => boolean, drained: () => void): Promise<void> {
    if (
      this.#reason ||
      this.#bytes + packet.length > this.maxBytes ||
      this.#queue.length + Number(!!this.#active) >= this.maxFrames
    ) {
      drained()
      return Promise.reject(this.#reason ?? new StreamError('OVERLOADED'))
    }
    return new Promise((resolve, reject) => {
      this.#bytes += packet.length
      this.#queue.push({
        packet,
        bytes: packet.byteLength,
        before,
        drained,
        resolve,
        reject,
        released: false,
      })
      this.#pump()
    })
  }
  #release(item: Write): void {
    if (item.released) return
    item.released = true
    // A transferable adapter may already have detached item.packet.
    this.#bytes -= item.bytes
    item.drained()
  }
  #pump(): void {
    if (this.#reason || this.#active) return
    const item = this.#queue.shift()
    if (!item) return
    this.#active = item
    let allowed = false
    try {
      allowed = item.before()
    } catch {
      /* A revoked/invalid producer cannot send. */
    }
    if (!allowed || this.#reason) {
      this.#finish(item, new StreamError('CANCELLED'))
      return
    }
    this.#timer = this.clock.set(this.sendTimeoutMs, () =>
      this.close(new StreamError('DEADLINE_EXCEEDED'))
    )
    try {
      Promise.resolve(this.transport.send(item.packet)).then(
        () => this.#finish(item),
        () => this.#finish(item, new StreamError('DISCONNECTED'))
      )
    } catch {
      this.#finish(item, new StreamError('DISCONNECTED'))
    }
  }
  #finish(item: Write, error?: StreamError): void {
    if (this.#active === item) {
      this.clock.clear(this.#timer)
      this.#active = undefined
    }
    this.#release(item)
    if (error || this.#reason) item.reject(error ?? this.#reason!)
    else item.resolve()
    if (error?.code === 'DISCONNECTED') this.close(error)
    queueMicrotask(() => this.#pump())
  }
  close(reason = new StreamError('DISCONNECTED')): void {
    if (this.#reason) return
    this.#reason = reason
    this.clock.clear(this.#timer)
    for (const item of this.#queue.splice(0)) {
      this.#release(item)
      item.reject(reason)
    }
    this.#active?.reject(reason) // Active reservation stays until the raw send settles.
    try {
      this.#off?.()
    } catch {
      /* Cleanup cannot prevent settlement. */
    }
    this.#off = undefined
    try {
      this.disconnected(reason)
    } finally {
      this.#resolve(reason)
      try {
        this.transport.close()
      } catch {
        /* Adapter contract still requires releasing its buffers. */
      }
    }
  }
  diagnostics(): Readonly<{ queuedBytes: number; queuedFrames: number; closed: boolean }> {
    return {
      queuedBytes: this.#bytes,
      queuedFrames: this.#queue.length + Number(!!this.#active),
      closed: !!this.#reason,
    }
  }
}
