import { RpcError } from './rpc.ts'
import type { RpcLimits, RpcScheduler, RpcTransport } from './rpc.ts'
interface Outgoing {
  readonly packet: Uint8Array
  readonly bytes: number
  readonly resolve: () => void
  readonly reject: (error: RpcError) => void
  readonly signal: AbortSignal | undefined
  readonly beforeSend: (() => void) | undefined
  removeAbort: () => void
}
/** Shared bounded writer. A send promise must reflect the adapter's backpressure. */
export class RpcChannel {
  readonly #queue: Outgoing[] = []
  #active: Outgoing | undefined
  #bytes = 0
  #off: (() => void) | undefined
  #timer: unknown
  #started = false
  #reason: RpcError | undefined
  readonly closed: Promise<RpcError>
  readonly #resolveClosed: (error: RpcError) => void
  constructor(
    readonly transport: RpcTransport,
    readonly limits: RpcLimits,
    readonly clock: RpcScheduler,
    readonly receive: (packet: Uint8Array) => void,
    readonly disconnected: (error: RpcError) => void
  ) {
    let resolve!: (error: RpcError) => void
    this.closed = new Promise((done) => {
      resolve = done
    })
    this.#resolveClosed = resolve
  }
  start(): void {
    if (this.#started) throw new TypeError('RPC channel already started')
    this.#started = true
    try {
      const off = this.transport.subscribe(
        (packet) => {
          if (this.#reason) return
          try {
            this.receive(packet)
          } catch (error) {
            this.close(
              error instanceof RpcError
                ? error
                : new RpcError('PROTOCOL_ERROR', 'RPC receive failed')
            )
          }
        },
        () => this.close(new RpcError('DISCONNECTED', 'RPC transport disconnected'))
      )
      if (this.#reason) off()
      else this.#off = off
    } catch {
      this.close(new RpcError('DISCONNECTED', 'RPC transport subscription failed'))
    }
  }
  send(packet: Uint8Array, signal?: AbortSignal, beforeSend?: () => void): Promise<void> {
    if (this.#reason) return Promise.reject(this.#reason)
    if (signal?.aborted) return Promise.reject(new RpcError('CANCELLED', 'RPC send cancelled'))
    if (
      !(packet instanceof Uint8Array) ||
      !(packet.buffer instanceof ArrayBuffer) ||
      packet.byteLength > this.limits.maxFrameBytes
    )
      return Promise.reject(new RpcError('PROTOCOL_ERROR', 'RPC packet too large'))
    if (
      this.#bytes + packet.byteLength > this.limits.maxQueuedBytes ||
      this.#queue.length + Number(!!this.#active) >= this.limits.maxQueuedFrames
    ) {
      return Promise.reject(new RpcError('OVERLOADED', 'RPC send queue is full'))
    }
    return new Promise<void>((resolve, reject) => {
      const item: Outgoing = {
        // Uint8Array construction copies Buffer inputs too; Buffer.slice only aliases.
        packet: new Uint8Array(packet),
        bytes: packet.byteLength,
        resolve,
        reject,
        signal,
        beforeSend,
        removeAbort: () => {},
      }
      const aborted = () => {
        const index = this.#queue.indexOf(item)
        if (index >= 0) {
          this.#queue.splice(index, 1)
          this.#bytes -= item.bytes
          item.removeAbort()
        }
        // An in-flight send still counts against the budget until it drains.
        reject(new RpcError('CANCELLED', 'RPC send cancelled'))
      }
      if (signal) {
        signal.addEventListener('abort', aborted, { once: true })
        item.removeAbort = () => signal.removeEventListener('abort', aborted)
      }
      this.#bytes += item.bytes
      this.#queue.push(item)
      this.#pump()
    })
  }
  #pump(): void {
    if (this.#reason || this.#active) return
    const item = this.#queue.shift()
    if (!item) return
    this.#active = item
    try {
      item.beforeSend?.()
    } catch (error) {
      this.#finish(
        item,
        error instanceof RpcError ? error : new RpcError('CANCELLED', 'RPC send cancelled')
      )
      return
    }
    if (this.#reason || item.signal?.aborted) {
      this.#finish(item, new RpcError('CANCELLED', 'RPC send cancelled'))
      return
    }
    this.#timer = this.clock.set(this.limits.sendTimeoutMs, () =>
      this.close(new RpcError('DISCONNECTED', 'RPC transport did not drain'))
    )
    try {
      Promise.resolve(this.transport.send(item.packet)).then(
        () => this.#finish(item),
        () => this.close(new RpcError('DISCONNECTED', 'RPC transport send failed'))
      )
    } catch {
      this.close(new RpcError('DISCONNECTED', 'RPC transport send failed'))
    }
  }
  #finish(item: Outgoing, error?: RpcError): void {
    if (this.#active !== item) return
    this.clock.clear(this.#timer)
    this.#timer = undefined
    this.#bytes -= item.bytes
    this.#active = undefined
    item.removeAbort()
    if (error) item.reject(error)
    else item.resolve()
    // Do not recursively grow the stack if many beforeSend callbacks expire.
    queueMicrotask(() => this.#pump())
  }
  close(error = new RpcError('DISCONNECTED', 'RPC channel closed')): void {
    if (this.#reason) return
    this.#reason = error
    this.clock.clear(this.#timer)
    const items = [...this.#queue]
    this.#queue.length = 0
    if (this.#active) items.unshift(this.#active)
    this.#active = undefined
    this.#bytes = 0
    for (const item of items) {
      item.removeAbort()
      item.reject(error)
    }
    try {
      this.#off?.()
    } catch {
      /* Adapter cleanup cannot prevent promise settlement. */
    }
    this.#off = undefined
    try {
      this.disconnected(error)
    } finally {
      this.#resolveClosed(error)
      try {
        this.transport.close()
      } catch {
        /* Already closed locally. */
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
