import { DEFAULT_RPC_LIMITS, RPC_WEBSOCKET_PATH, RpcError } from '../../contracts/src/index.ts'
import type { RpcTransport } from '../../contracts/src/index.ts'
import {
  decodeRpcWebSocketRecord,
  encodeRpcWebSocketRecord,
} from '../../contracts/src/rpc-websocket-wire.ts'

type Socket = Pick<
  WebSocket,
  | 'binaryType'
  | 'bufferedAmount'
  | 'readyState'
  | 'send'
  | 'close'
  | 'addEventListener'
  | 'removeEventListener'
>

export interface RpcLoopbackClientOptions {
  readonly endpoint: string
  /** One-use secret delivered by the native bridge, never by URL or page storage. */
  readonly credential: Uint8Array
  readonly maxFrameBytes?: number
  readonly connectTimeoutMs?: number
  readonly socket?: (endpoint: string) => Socket
}

interface PendingSend {
  readonly sequence: number
  readonly packet: Uint8Array
  readonly resolve: () => void
  readonly reject: (error: RpcError) => void
  transmitted: boolean
}

/** Browser-side, acknowledged binary WebSocket adapter for the opt-in loopback candidate. */
export class RpcLoopbackTransport implements RpcTransport {
  readonly #socket: Socket
  readonly #maxFrameBytes: number
  readonly #credential: Uint8Array
  readonly #connectTimer: ReturnType<typeof setTimeout>
  #subscribed = false
  #closed = false
  #socketClosed = false
  #ready = false
  #sent = 0
  #received = 0
  #pending: PendingSend | undefined
  #receive: ((packet: Uint8Array) => void) | undefined
  #notifyClosed: (() => void) | undefined
  #listeners = 0

  constructor(options: RpcLoopbackClientOptions) {
    const endpoint = new URL(options.endpoint)
    const maxFrameBytes = options.maxFrameBytes ?? DEFAULT_RPC_LIMITS.maxFrameBytes
    const connectTimeoutMs = options.connectTimeoutMs ?? 5_000
    if (
      endpoint.protocol !== 'ws:' ||
      endpoint.hostname !== '127.0.0.1' ||
      endpoint.pathname !== RPC_WEBSOCKET_PATH ||
      endpoint.search ||
      endpoint.hash ||
      endpoint.username ||
      endpoint.password ||
      !endpoint.port
    )
      throw new TypeError('RPC loopback endpoint must be an exact IPv4 loopback URL')
    if (
      !(options.credential instanceof Uint8Array) ||
      !(options.credential.buffer instanceof ArrayBuffer) ||
      options.credential.byteLength !== 32
    )
      throw new TypeError('Invalid RPC loopback credential')
    if (
      !Number.isSafeInteger(maxFrameBytes) ||
      maxFrameBytes < 512 ||
      maxFrameBytes > 16 * 1024 * 1024
    )
      throw new TypeError('Invalid RPC loopback packet limit')
    if (
      !Number.isSafeInteger(connectTimeoutMs) ||
      connectTimeoutMs < 1 ||
      connectTimeoutMs > 60_000
    )
      throw new TypeError('Invalid RPC loopback connection timeout')
    this.#credential = new Uint8Array(options.credential)
    this.#maxFrameBytes = maxFrameBytes
    this.#socket = (options.socket ?? ((url) => new WebSocket(url)))(endpoint.href)
    this.#socket.binaryType = 'arraybuffer'
    this.#listen('open', this.#open)
    this.#listen('message', this.#message)
    this.#listen('error', this.#broken)
    this.#listen('close', this.#socketEnded)
    this.#connectTimer = setTimeout(
      () => this.#end(false, new RpcError('DISCONNECTED', 'RPC loopback authentication timed out')),
      connectTimeoutMs
    )
  }

  readonly #open = () => {
    if (this.#closed) return
    try {
      const auth = encodeRpcWebSocketRecord({ kind: 'auth', credential: this.#credential })
      this.#socket.send(auth)
      this.#credential.fill(0)
      auth.fill(0)
    } catch {
      this.#end(false, new RpcError('DISCONNECTED', 'RPC loopback authentication failed'))
    }
  }

  readonly #message = (event: Event) => {
    if (this.#closed) return
    const value = (event as MessageEvent<unknown>).data
    if (!(value instanceof ArrayBuffer)) {
      this.#end(true, new RpcError('PROTOCOL_ERROR', 'RPC loopback requires binary records'))
      return
    }
    try {
      const message = decodeRpcWebSocketRecord(new Uint8Array(value), this.#maxFrameBytes)
      if (!this.#ready) {
        if (message.kind !== 'ready')
          throw new RpcError('PROTOCOL_ERROR', 'Expected loopback ready')
        this.#ready = true
        clearTimeout(this.#connectTimer)
        this.#transmit()
        return
      }
      if (message.kind === 'close') {
        this.#end(false, new RpcError('DISCONNECTED', 'RPC loopback peer closed'))
        return
      }
      if (message.kind === 'ack' && message.sequence === this.#pending?.sequence) {
        const pending = this.#pending
        this.#pending = undefined
        pending.resolve()
        return
      }
      if (message.kind !== 'packet' || message.sequence !== this.#received + 1 || !this.#receive)
        throw new RpcError('PROTOCOL_ERROR', 'Invalid RPC loopback sequence')
      this.#received++
      this.#receive(message.packet)
      if (!this.#closed)
        this.#socket.send(encodeRpcWebSocketRecord({ kind: 'ack', sequence: this.#received }))
    } catch (error) {
      this.#end(
        true,
        error instanceof RpcError
          ? error
          : new RpcError('PROTOCOL_ERROR', 'RPC loopback receive failed')
      )
    }
  }

  readonly #broken = () =>
    this.#end(false, new RpcError('DISCONNECTED', 'RPC loopback socket disconnected'))

  #listen(type: string, listener: EventListener): void {
    this.#socket.addEventListener(type, listener)
    this.#listeners++
  }

  readonly #socketEnded = () => {
    this.#socketClosed = true
    this.#end(false, new RpcError('DISCONNECTED', 'RPC loopback socket disconnected'))
    this.#detach(false)
  }

  #detach(preserveClose = false): void {
    for (const [type, listener] of [
      ['open', this.#open],
      ['message', this.#message],
      ['error', this.#broken],
      ['close', this.#socketEnded],
    ] as const) {
      if (!(preserveClose && type === 'close'))
        this.#socket.removeEventListener(type, listener as EventListener)
    }
    this.#listeners = preserveClose ? 1 : 0
  }

  #end(tellPeer: boolean, reason: RpcError): void {
    if (this.#closed) return
    this.#closed = true
    clearTimeout(this.#connectTimer)
    this.#credential.fill(0)
    const pending = this.#pending
    this.#pending = undefined
    pending?.reject(reason)
    if (tellPeer && this.#ready) {
      try {
        this.#socket.send(encodeRpcWebSocketRecord({ kind: 'close' }))
      } catch {
        // The socket may already be gone.
      }
    }
    this.#detach(!this.#socketClosed && this.#socket.readyState !== 3)
    try {
      this.#socket.close(reason.code === 'PROTOCOL_ERROR' ? 1002 : 1000, 'closed')
    } catch {
      // Closing an already failed browser socket is harmless.
    }
    this.#notifyClosed?.()
  }

  #transmit(): void {
    const pending = this.#pending
    if (!this.#ready || !pending || pending.transmitted || this.#closed) return
    pending.transmitted = true
    try {
      this.#socket.send(
        encodeRpcWebSocketRecord({
          kind: 'packet',
          sequence: pending.sequence,
          packet: pending.packet,
        })
      )
    } catch {
      this.#end(false, new RpcError('DISCONNECTED', 'RPC loopback send failed'))
    }
  }

  send(packet: Uint8Array): Promise<void> {
    if (this.#closed) return Promise.reject(new RpcError('DISCONNECTED', 'RPC loopback closed'))
    if (this.#pending)
      return Promise.reject(new RpcError('OVERLOADED', 'RPC loopback packet already in flight'))
    if (
      this.#sent >= 0xffffffff ||
      !(packet instanceof Uint8Array) ||
      !(packet.buffer instanceof ArrayBuffer) ||
      packet.byteLength < 1 ||
      packet.byteLength > this.#maxFrameBytes
    )
      return Promise.reject(new RpcError('PROTOCOL_ERROR', 'Invalid RPC loopback packet'))
    return new Promise((resolve, reject) => {
      this.#pending = {
        sequence: ++this.#sent,
        packet: new Uint8Array(packet),
        resolve,
        reject,
        transmitted: false,
      }
      this.#transmit()
    })
  }

  subscribe(message: (packet: Uint8Array) => void, closed: () => void): () => void {
    if (this.#subscribed) throw new TypeError('RPC loopback permits one subscriber')
    this.#subscribed = true
    this.#receive = message
    this.#notifyClosed = closed
    if (this.#closed) closed()
    return () => {
      this.#receive = undefined
      this.#notifyClosed = undefined
    }
  }

  close(): void {
    this.#end(true, new RpcError('DISCONNECTED', 'RPC loopback closed'))
  }

  diagnostics(): Readonly<{
    state: 'authenticating' | 'ready' | 'closed'
    sockets: number
    listeners: number
    timers: number
    queuedFrames: number
    queuedBytes: number
    bufferedBytes: number
  }> {
    return {
      state: this.#closed ? 'closed' : this.#ready ? 'ready' : 'authenticating',
      sockets: this.#socketClosed || this.#socket.readyState === 3 ? 0 : 1,
      listeners: this.#listeners,
      timers: this.#closed || this.#ready ? 0 : 1,
      queuedFrames: Number(!!this.#pending),
      queuedBytes: this.#pending?.packet.byteLength ?? 0,
      bufferedBytes:
        this.#socketClosed || this.#socket.readyState === 3 ? 0 : this.#socket.bufferedAmount,
    }
  }
}
