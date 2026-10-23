import type { SessionHandle } from '../../contracts/src/index.ts'
import {
  DEFAULT_RPC_LIMITS,
  RPC_WEBSOCKET_HEADER_BYTES,
  RPC_WEBSOCKET_PATH,
  RpcError,
  originOf,
} from '../../contracts/src/index.ts'
import type { RpcTransport } from '../../contracts/src/index.ts'
import {
  decodeRpcWebSocketRecord,
  encodeRpcWebSocketRecord,
} from '../../contracts/src/rpc-websocket-wire.ts'
import {
  checkRpcAuthorityBinding,
  claimRpcAuthorityBinding,
  completeRpcAuthorityHandoff,
  discardRpcAuthorityHandoff,
} from './rpc-authority.ts'
import type { RpcAuthorityBinding, RpcIdentity, RpcLease } from './rpc-authority.ts'

export interface RpcLoopbackHandoff {
  readonly endpoint: string
  readonly credential: Uint8Array
}

export interface RpcLoopbackConnection {
  readonly identity: RpcIdentity
  /** Opaque in-process identity supplied by the native owner, never by the page. */
  readonly session: SessionHandle
}

export interface RpcLoopbackServerOptions {
  readonly maxFrameBytes?: number
  readonly maxCredentials?: number
  readonly maxUnauthenticatedSockets?: number
  readonly maxSockets?: number
  readonly maxRetainedBytes?: number
  /** Worst-case fragmented inbound message reservation, charged before upgrade. */
  readonly maxReceiveBytes?: number
  readonly closeTimeoutMs?: number
  readonly credentialTtlMs?: number
  readonly authenticationTimeoutMs?: number
  readonly accept: (
    lease: RpcLease,
    transport: RpcTransport,
    connection: RpcLoopbackConnection
  ) => void
}

interface Ticket {
  readonly key: string
  readonly binding: RpcAuthorityBinding
  readonly origin: string
  readonly expiresAt: number
  readonly timer: ReturnType<typeof setTimeout>
  readonly revoked: () => void
  socket?: Bun.ServerWebSocket<SocketData>
}

interface SocketData {
  readonly origin: string
  upgradeReserved: boolean
  authenticated: boolean
  closing: boolean
  closed: boolean
  retainedBytes: number
  drainBytes: number
  receiveReservation: number
  closeTimer: ReturnType<typeof setTimeout> | undefined
  authTimer: ReturnType<typeof setTimeout> | undefined
  ticket: Ticket | undefined
  transport: ServerLoopbackTransport | undefined
}

function credentialKey(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url')
}

class ServerLoopbackTransport implements RpcTransport {
  #subscribed = false
  #closed = false
  #sent = 0
  #received = 0
  #pending:
    | {
        readonly sequence: number
        readonly bytes: number
        readonly release: () => void
        resolve: () => void
        reject: (e: RpcError) => void
      }
    | undefined
  #receive: ((packet: Uint8Array) => void) | undefined
  #notifyClosed: (() => void) | undefined

  constructor(
    readonly socket: Bun.ServerWebSocket<SocketData>,
    readonly maxFrameBytes: number,
    readonly sendRecord: (record: Uint8Array, retainUntilAck: boolean) => (() => void) | undefined,
    readonly closeSocket: (code: number, reason: string) => void
  ) {}

  send(packet: Uint8Array): Promise<void> {
    if (this.#closed) return Promise.reject(new RpcError('DISCONNECTED', 'RPC loopback closed'))
    if (this.#pending)
      return Promise.reject(new RpcError('OVERLOADED', 'RPC loopback packet already in flight'))
    if (
      this.#sent >= 0xffffffff ||
      !(packet instanceof Uint8Array) ||
      !(packet.buffer instanceof ArrayBuffer) ||
      packet.byteLength < 1 ||
      packet.byteLength > this.maxFrameBytes
    )
      return Promise.reject(new RpcError('PROTOCOL_ERROR', 'Invalid RPC loopback packet'))
    const sequence = ++this.#sent
    return new Promise((resolve, reject) => {
      const record = encodeRpcWebSocketRecord({ kind: 'packet', sequence, packet })
      const release = this.sendRecord(record, true)
      if (!release) {
        reject(new RpcError('OVERLOADED', 'RPC loopback retained-byte budget exhausted'))
        this.#end(false, new RpcError('DISCONNECTED', 'RPC loopback send was dropped'))
        return
      }
      this.#pending = { sequence, bytes: packet.byteLength, release, resolve, reject }
    })
  }

  receive(bytes: Uint8Array): void {
    if (this.#closed) return
    try {
      const message = decodeRpcWebSocketRecord(bytes, this.maxFrameBytes)
      if (message.kind === 'close') {
        this.#end(false, new RpcError('DISCONNECTED', 'RPC loopback peer closed'))
        return
      }
      if (message.kind === 'ack' && message.sequence === this.#pending?.sequence) {
        const pending = this.#pending
        this.#pending = undefined
        pending.release()
        pending.resolve()
        return
      }
      if (message.kind !== 'packet' || message.sequence !== this.#received + 1 || !this.#receive)
        throw new RpcError('PROTOCOL_ERROR', 'Invalid RPC loopback sequence')
      this.#received++
      this.#receive(message.packet)
      if (
        !this.#closed &&
        !this.sendRecord(encodeRpcWebSocketRecord({ kind: 'ack', sequence: this.#received }), false)
      )
        this.#end(false, new RpcError('DISCONNECTED', 'RPC loopback acknowledgement was dropped'))
    } catch (error) {
      this.#end(
        true,
        error instanceof RpcError
          ? error
          : new RpcError('PROTOCOL_ERROR', 'RPC loopback receive failed')
      )
    }
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

  socketClosed(): void {
    const reason = new RpcError('DISCONNECTED', 'RPC loopback socket disconnected')
    if (!this.#closed) {
      this.#closed = true
      this.#notifyClosed?.()
    }
    const pending = this.#pending
    this.#pending = undefined
    pending?.release()
    pending?.reject(reason)
    this.#receive = undefined
    this.#notifyClosed = undefined
  }

  #end(tellPeer: boolean, reason: RpcError): void {
    if (this.#closed) return
    this.#closed = true
    const pending = this.#pending
    this.#pending = undefined
    pending?.reject(reason)
    if (tellPeer) {
      try {
        this.sendRecord(encodeRpcWebSocketRecord({ kind: 'close' }), false)
      } catch {
        // Peer may already be gone.
      }
    }
    this.closeSocket(reason.code === 'PROTOCOL_ERROR' ? 1002 : 1000, 'closed')
    this.#notifyClosed?.()
  }

  close(): void {
    this.#end(true, new RpcError('DISCONNECTED', 'RPC loopback closed'))
  }

  diagnostics(): Readonly<{ queuedFrames: number; queuedBytes: number; listeners: number }> {
    return {
      queuedFrames: Number(!!this.#pending),
      queuedBytes: this.#pending?.bytes ?? 0,
      listeners: Number(!!this.#receive) + Number(!!this.#notifyClosed),
    }
  }
}

/**
 * Opt-in Bun loopback candidate. Constructing this class is the only operation
 * that opens a listener; normal application startup does not import or create it.
 */
export class RpcLoopbackServer {
  readonly #options: Required<Omit<RpcLoopbackServerOptions, 'accept'>> &
    Pick<RpcLoopbackServerOptions, 'accept'>
  readonly #server: Bun.Server<SocketData>
  readonly #tickets = new Map<string, Ticket>()
  readonly #active = new Map<string, Ticket>()
  readonly #sockets = new Set<Bun.ServerWebSocket<SocketData>>()
  readonly #transports = new Set<ServerLoopbackTransport>()
  #upgradeReservations = 0
  #retainedBytes = 0
  #receiveReservedBytes = 0
  #closed = false
  #finishClose!: () => void
  #rejectClose!: (error: unknown) => void
  #listenerStopped = false
  readonly closed: Promise<void>

  constructor(options: RpcLoopbackServerOptions) {
    const complete = {
      maxFrameBytes: options.maxFrameBytes ?? DEFAULT_RPC_LIMITS.maxFrameBytes,
      maxCredentials: options.maxCredentials ?? 128,
      maxUnauthenticatedSockets: options.maxUnauthenticatedSockets ?? 16,
      maxSockets: options.maxSockets ?? 128,
      maxRetainedBytes: options.maxRetainedBytes ?? 32 * 1024 * 1024,
      maxReceiveBytes: options.maxReceiveBytes ?? 32 * 1024 * 1024,
      closeTimeoutMs: options.closeTimeoutMs ?? 1000,
      credentialTtlMs: options.credentialTtlMs ?? 5_000,
      authenticationTimeoutMs: options.authenticationTimeoutMs ?? 2_000,
      accept: options.accept,
    }
    if (
      !Number.isSafeInteger(complete.maxFrameBytes) ||
      complete.maxFrameBytes < 512 ||
      complete.maxFrameBytes > 16 * 1024 * 1024 ||
      !Number.isSafeInteger(complete.maxCredentials) ||
      complete.maxCredentials < 1 ||
      complete.maxCredentials > 4096 ||
      !Number.isSafeInteger(complete.maxUnauthenticatedSockets) ||
      complete.maxUnauthenticatedSockets < 1 ||
      complete.maxUnauthenticatedSockets > 1024 ||
      !Number.isSafeInteger(complete.maxSockets) ||
      complete.maxSockets < complete.maxUnauthenticatedSockets ||
      complete.maxSockets > 4096 ||
      !Number.isSafeInteger(complete.maxRetainedBytes) ||
      complete.maxRetainedBytes < complete.maxFrameBytes + RPC_WEBSOCKET_HEADER_BYTES ||
      complete.maxRetainedBytes > 256 * 1024 * 1024 ||
      !Number.isSafeInteger(complete.maxReceiveBytes) ||
      complete.maxReceiveBytes < complete.maxFrameBytes + RPC_WEBSOCKET_HEADER_BYTES ||
      complete.maxReceiveBytes > 256 * 1024 * 1024 ||
      !Number.isSafeInteger(complete.closeTimeoutMs) ||
      complete.closeTimeoutMs < 100 ||
      complete.closeTimeoutMs > 5000 ||
      !Number.isSafeInteger(complete.credentialTtlMs) ||
      complete.credentialTtlMs < 1 ||
      complete.credentialTtlMs > 60_000 ||
      !Number.isSafeInteger(complete.authenticationTimeoutMs) ||
      complete.authenticationTimeoutMs < 1 ||
      complete.authenticationTimeoutMs > 60_000 ||
      typeof complete.accept !== 'function'
    )
      throw new TypeError('Invalid RPC loopback server options')
    this.#options = complete
    this.closed = new Promise<void>((resolve, reject) => {
      this.#finishClose = resolve
      this.#rejectClose = reject
    })
    void this.closed.catch(() => {})
    this.#server = Bun.serve<SocketData>({
      hostname: '127.0.0.1',
      port: 0,
      fetch: (request, server) => this.#upgrade(request, server),
      websocket: {
        maxPayloadLength: complete.maxFrameBytes + RPC_WEBSOCKET_HEADER_BYTES,
        backpressureLimit: Math.min(
          complete.maxFrameBytes + RPC_WEBSOCKET_HEADER_BYTES,
          complete.maxRetainedBytes
        ),
        closeOnBackpressureLimit: true,
        perMessageDeflate: false,
        idleTimeout: 60,
        open: (socket) => this.#open(socket),
        message: (socket, message) => this.#message(socket, message),
        drain: (socket) => this.#drain(socket),
        close: (socket) => this.#socketClosed(socket),
      },
    })
  }

  get endpoint(): string {
    return `ws://127.0.0.1:${this.#server.port}${RPC_WEBSOCKET_PATH}`
  }

  provision(binding: RpcAuthorityBinding): RpcLoopbackHandoff {
    checkRpcAuthorityBinding(binding)
    if (this.#closed || binding.signal.aborted)
      throw new RpcError('REVOKED', 'RPC loopback server is closed or authority was revoked')
    if (originOf(binding.identity.origin) !== binding.identity.origin)
      throw new TypeError('RPC loopback authority origin must be exact')
    if (this.#tickets.size >= this.#options.maxCredentials)
      throw new RpcError('OVERLOADED', 'RPC loopback credential capacity exceeded')
    let credential: Uint8Array
    let key: string
    do {
      credential = crypto.getRandomValues(new Uint8Array(32))
      key = credentialKey(credential)
    } while (this.#tickets.has(key) || this.#active.has(key))
    const expiresAt = performance.now() + this.#options.credentialTtlMs
    const revoked = () => this.#revoke(key)
    const timer = setTimeout(revoked, this.#options.credentialTtlMs)
    const ticket: Ticket = {
      key,
      binding,
      origin: binding.identity.origin,
      expiresAt,
      timer,
      revoked,
    }
    this.#tickets.set(key, ticket)
    binding.signal.addEventListener('abort', revoked, { once: true })
    return Object.freeze({ endpoint: this.endpoint, credential: new Uint8Array(credential) })
  }

  #upgrade(request: Request, server: Bun.Server<SocketData>): Response | undefined {
    let url: URL
    try {
      url = new URL(request.url)
    } catch {
      return new Response('Not found', { status: 404 })
    }
    const origin = request.headers.get('origin')
    const host = request.headers.get('host')
    const unauthenticated = [...this.#sockets].filter((socket) => !socket.data.authenticated).length
    const allowedOrigin =
      origin !== null && [...this.#tickets.values()].some((ticket) => ticket.origin === origin)
    if (
      this.#closed ||
      request.method !== 'GET' ||
      host !== `127.0.0.1:${this.#server.port}` ||
      url.hostname !== '127.0.0.1' ||
      url.port !== String(this.#server.port) ||
      url.pathname !== RPC_WEBSOCKET_PATH ||
      url.search ||
      url.hash ||
      !allowedOrigin ||
      unauthenticated + this.#upgradeReservations >= this.#options.maxUnauthenticatedSockets ||
      this.#sockets.size + this.#upgradeReservations >= this.#options.maxSockets ||
      this.#receiveReservedBytes + this.#options.maxFrameBytes + RPC_WEBSOCKET_HEADER_BYTES >
        this.#options.maxReceiveBytes
    )
      return new Response('Not found', { status: 404 })
    const data: SocketData = {
      origin,
      upgradeReserved: true,
      authenticated: false,
      closing: false,
      closed: false,
      retainedBytes: 0,
      drainBytes: 0,
      receiveReservation: this.#options.maxFrameBytes + RPC_WEBSOCKET_HEADER_BYTES,
      closeTimer: undefined,
      authTimer: undefined,
      ticket: undefined,
      transport: undefined,
    }
    this.#upgradeReservations++
    this.#receiveReservedBytes += data.receiveReservation
    try {
      if (server.upgrade(request, { data })) return undefined
    } catch {
      // An unsuccessful upgrade owns no socket and must release both reservations.
    }
    this.#upgradeReservations--
    this.#receiveReservedBytes -= data.receiveReservation
    data.receiveReservation = 0
    return new Response('Upgrade failed', { status: 400 })
  }

  #open(socket: Bun.ServerWebSocket<SocketData>): void {
    if (socket.data.upgradeReserved) {
      socket.data.upgradeReserved = false
      this.#upgradeReservations--
    }
    this.#sockets.add(socket)
    if (this.#closed) {
      this.#requestClose(socket, 1012, 'closed')
      return
    }
    socket.data.authTimer = setTimeout(
      () => this.#requestClose(socket, 1008, 'authentication timeout'),
      this.#options.authenticationTimeoutMs
    )
  }

  #reserve(socket: Bun.ServerWebSocket<SocketData>, bytes: number): (() => void) | undefined {
    if (
      socket.data.closed ||
      socket.data.closing ||
      bytes < 1 ||
      this.#retainedBytes + bytes > this.#options.maxRetainedBytes
    )
      return undefined
    socket.data.retainedBytes += bytes
    this.#retainedBytes += bytes
    let retained = true
    return () => {
      if (!retained) return
      retained = false
      socket.data.retainedBytes -= bytes
      this.#retainedBytes -= bytes
    }
  }

  #sendRecord(
    socket: Bun.ServerWebSocket<SocketData>,
    record: Uint8Array,
    retainUntilAck: boolean
  ): (() => void) | undefined {
    const release = this.#reserve(socket, record.byteLength)
    if (!release) return undefined
    let status: number
    try {
      status = socket.sendBinary(record, false)
    } catch {
      release()
      return undefined
    }
    if (status === 0) {
      release()
      return undefined
    }
    if (retainUntilAck) return release
    if (status === -1) {
      socket.data.drainBytes += record.byteLength
      return () => {}
    }
    release()
    return () => {}
  }

  #drain(socket: Bun.ServerWebSocket<SocketData>): void {
    const bytes = socket.data.drainBytes
    if (!bytes) return
    socket.data.drainBytes = 0
    socket.data.retainedBytes -= bytes
    this.#retainedBytes -= bytes
  }

  #requestClose(socket: Bun.ServerWebSocket<SocketData>, code: number, reason: string): void {
    if (socket.data.closed || socket.data.closing) return
    socket.data.closing = true
    if (socket.data.authTimer) clearTimeout(socket.data.authTimer)
    socket.data.authTimer = undefined
    socket.data.closeTimer = setTimeout(() => {
      socket.data.closeTimer = undefined
      if (!socket.data.closed) socket.terminate()
    }, this.#options.closeTimeoutMs)
    try {
      socket.close(code, reason)
    } catch {
      socket.terminate()
    }
  }

  #message(socket: Bun.ServerWebSocket<SocketData>, value: string | Buffer<ArrayBuffer>): void {
    if (socket.data.closed || socket.data.closing || this.#closed) return
    if (typeof value === 'string') {
      this.#requestClose(socket, 1002, 'binary protocol required')
      return
    }
    if (!socket.data.authenticated) {
      this.#authenticate(socket, new Uint8Array(value.buffer, value.byteOffset, value.byteLength))
      return
    }
    socket.data.transport?.receive(new Uint8Array(value.buffer, value.byteOffset, value.byteLength))
  }

  #authenticate(socket: Bun.ServerWebSocket<SocketData>, bytes: Uint8Array): void {
    let handoffLease: RpcLease | undefined
    try {
      const message = decodeRpcWebSocketRecord(bytes, this.#options.maxFrameBytes)
      if (message.kind !== 'auth') throw new RpcError('FORBIDDEN', 'Missing loopback credential')
      const key = credentialKey(message.credential)
      message.credential.fill(0)
      const ticket = this.#tickets.get(key)
      if (
        !ticket ||
        ticket.origin !== socket.data.origin ||
        ticket.expiresAt <= performance.now() ||
        ticket.binding.signal.aborted
      )
        throw new RpcError('FORBIDDEN', 'Invalid loopback credential')
      this.#tickets.delete(key)
      this.#active.set(key, ticket)
      clearTimeout(ticket.timer)
      ticket.binding.signal.removeEventListener('abort', ticket.revoked)
      ticket.socket = socket
      socket.data.ticket = ticket
      socket.data.authenticated = true
      if (socket.data.authTimer) clearTimeout(socket.data.authTimer)
      socket.data.authTimer = undefined
      const transport = new ServerLoopbackTransport(
        socket,
        this.#options.maxFrameBytes,
        (record, retainUntilAck) => this.#sendRecord(socket, record, retainUntilAck),
        (code, reason) => this.#requestClose(socket, code, reason)
      )
      socket.data.transport = transport
      this.#transports.add(transport)
      ticket.binding.signal.addEventListener('abort', ticket.revoked, { once: true })
      const claimed = claimRpcAuthorityBinding(ticket.binding)
      handoffLease = claimed.lease
      if (!this.#sendRecord(socket, encodeRpcWebSocketRecord({ kind: 'ready' }), false))
        throw new RpcError('DISCONNECTED', 'RPC loopback ready send was dropped')
      const accepted = (
        this.#options.accept as (
          lease: RpcLease,
          transport: RpcTransport,
          connection: RpcLoopbackConnection
        ) => unknown
      )(
        claimed.lease,
        transport,
        Object.freeze({
          identity: ticket.binding.identity,
          session: claimed.session,
        })
      )
      if (accepted && typeof (accepted as PromiseLike<unknown>).then === 'function') {
        void Promise.resolve(accepted).catch(() => {})
        throw new TypeError('RPC loopback accept callback must complete synchronously')
      }
      completeRpcAuthorityHandoff(claimed.lease)
      handoffLease = undefined
    } catch {
      discardRpcAuthorityHandoff(handoffLease)
      this.#requestClose(socket, 1008, 'authentication failed')
    }
  }

  #revoke(key: string): void {
    const pending = this.#tickets.get(key)
    if (pending) {
      this.#tickets.delete(key)
      clearTimeout(pending.timer)
      pending.binding.signal.removeEventListener('abort', pending.revoked)
    }
    const active = this.#active.get(key)
    if (active?.socket) this.#requestClose(active.socket, 1008, 'revoked')
  }

  #socketClosed(socket: Bun.ServerWebSocket<SocketData>): void {
    if (socket.data.closed) return
    socket.data.closed = true
    if (socket.data.closeTimer) clearTimeout(socket.data.closeTimer)
    socket.data.closeTimer = undefined
    this.#receiveReservedBytes -= socket.data.receiveReservation
    socket.data.receiveReservation = 0
    if (socket.data.upgradeReserved) {
      socket.data.upgradeReserved = false
      this.#upgradeReservations--
    }
    if (socket.data.authTimer) clearTimeout(socket.data.authTimer)
    socket.data.authTimer = undefined
    this.#sockets.delete(socket)
    const transport = socket.data.transport
    if (transport) this.#transports.delete(transport)
    const ticket = socket.data.ticket
    if (ticket) {
      this.#active.delete(ticket.key)
      ticket.binding.signal.removeEventListener('abort', ticket.revoked)
    }
    transport?.socketClosed()
    this.#retainedBytes -= socket.data.retainedBytes
    socket.data.retainedBytes = 0
    socket.data.drainBytes = 0
    this.#settleClose()
  }

  #settleClose(): void {
    if (
      this.#closed &&
      this.#listenerStopped &&
      this.#sockets.size === 0 &&
      this.#upgradeReservations === 0
    )
      this.#finishClose()
  }

  diagnostics(): Readonly<{
    listeners: number
    sockets: number
    upgradeReservations: number
    unauthenticatedSockets: number
    authenticatedSockets: number
    closingSockets: number
    credentials: number
    timers: number
    queuedFrames: number
    queuedBytes: number
    retainedBytes: number
    maxRetainedBytes: number
    receiveReservedBytes: number
    maxReceiveBytes: number
    closed: boolean
  }> {
    const openUnauthenticated = [...this.#sockets].filter(
      (socket) => !socket.data.authenticated
    ).length
    const unauthenticatedSockets = openUnauthenticated + this.#upgradeReservations
    const authenticatedSockets = [...this.#sockets].filter(
      (socket) => socket.data.authenticated
    ).length
    const closingSockets = [...this.#sockets].filter((socket) => socket.data.closing).length
    const authenticationTimers = [...this.#sockets].filter(
      (socket) => socket.data.authTimer !== undefined
    ).length
    let queuedFrames = 0,
      queuedBytes = 0,
      transportListeners = 0
    for (const transport of this.#transports) {
      const current = transport.diagnostics()
      queuedFrames += current.queuedFrames
      queuedBytes += current.queuedBytes
      transportListeners += current.listeners
    }
    return {
      listeners:
        this.#tickets.size + this.#active.size + this.#transports.size + transportListeners,
      sockets: this.#sockets.size + this.#upgradeReservations,
      upgradeReservations: this.#upgradeReservations,
      unauthenticatedSockets,
      authenticatedSockets,
      closingSockets,
      credentials: this.#tickets.size,
      timers:
        this.#tickets.size +
        authenticationTimers +
        [...this.#sockets].filter((socket) => socket.data.closeTimer !== undefined).length,
      queuedFrames,
      queuedBytes,
      retainedBytes: this.#retainedBytes,
      maxRetainedBytes: this.#options.maxRetainedBytes,
      receiveReservedBytes: this.#receiveReservedBytes,
      maxReceiveBytes: this.#options.maxReceiveBytes,
      closed: this.#closed,
    }
  }

  close(): Promise<void> {
    if (this.#closed) return this.closed
    this.#closed = true
    for (const ticket of this.#tickets.values()) this.#revoke(ticket.key)
    for (const ticket of this.#active.values()) this.#revoke(ticket.key)
    for (const socket of this.#sockets) this.#requestClose(socket, 1012, 'server closed')
    void this.#server.stop(true).then(
      () => {
        this.#listenerStopped = true
        this.#settleClose()
      },
      (error: unknown) => this.#rejectClose(error)
    )
    return this.closed
  }
}
