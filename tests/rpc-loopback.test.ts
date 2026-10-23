import { afterEach, describe, expect, test } from 'bun:test'
import { RpcClient, RpcLoopbackTransport } from '../packages/client/src/index.ts'
import { defineRpc, procedure } from '../packages/contracts/src/index.ts'
import type { RpcTransport } from '../packages/contracts/src/index.ts'
import {
  RPC_WEBSOCKET_HEADER_BYTES,
  encodeRpcWebSocketRecord,
} from '../packages/contracts/src/rpc-websocket-wire.ts'
import { rpcLimits } from '../packages/contracts/src/rpc.ts'
import { encodeRpc } from '../packages/contracts/src/rpc-wire.ts'
import {
  MockBackend,
  RpcLoopbackServer,
  RpcServer,
  RpcViewAuthority,
  bindRpcAuthority,
} from '../packages/runtime/src/index.ts'
import type {
  RpcAuthorityBinding,
  RpcHandlers,
  RpcLoopbackConnection,
  RpcLoopbackHandoff,
  RpcLoopbackServerOptions,
} from '../packages/runtime/src/index.ts'

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

const text = (value: unknown): string => {
  if (typeof value !== 'string') throw new TypeError('Expected string')
  return value
}
const bytes = (value: unknown): Uint8Array => {
  if (!(value instanceof Uint8Array)) throw new TypeError('Expected bytes')
  return value
}
const schema = defineRpc({
  echo: procedure(text, text),
  work: procedure(text, text),
  bytes: procedure(bytes, bytes),
})
const defaultHandlers: RpcHandlers<typeof schema> = {
  echo: { capability: 'echo', handle: (value) => value },
  work: { capability: 'work', handle: (value) => value },
  bytes: { capability: 'bytes', handle: (value) => value },
}

async function environment(partition = crypto.randomUUID()) {
  const backend = new MockBackend()
  const session = await backend.createSession({ partition, persistence: 'ephemeral' })
  const window = await backend.createWindow({
    title: 'Loopback',
    bounds: { x: 0, y: 0, width: 640, height: 480 },
  })
  const view = await backend.createView({
    window,
    session,
    url: 'app://ui/index.html',
    trust: { kind: 'application', origin: 'app://ui' },
  })
  const authority = new RpcViewAuthority(backend, ['app://ui'])
  cleanups.push(async () => {
    authority.dispose()
    await backend.dispose()
  })
  const binding = () =>
    bindRpcAuthority(
      authority.issue(
        view,
        {
          frameId: 'native-main',
          documentId: backend.state(view).documentId,
          mainFrame: true,
        },
        ['echo', 'work', 'bytes']
      ),
      session
    )
  return { backend, session, window, view, authority, binding }
}

function socket(endpoint: string, origin = 'app://ui', headers: Record<string, string> = {}) {
  const BunWebSocket = WebSocket as unknown as {
    new (url: string, options: Bun.WebSocketOptions): WebSocket
  }
  return new BunWebSocket(endpoint, {
    headers: { Origin: origin, ...headers },
    perMessageDeflate: false,
  })
}

function closed(websocket: WebSocket): Promise<CloseEvent> {
  return new Promise((resolve) => websocket.addEventListener('close', resolve, { once: true }))
}

function opened(websocket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    websocket.addEventListener('open', () => resolve(), { once: true })
    websocket.addEventListener('error', () => reject(new Error('WebSocket failed')), { once: true })
  })
}

async function rawWebSocket(endpoint: string, origin = 'app://ui') {
  const url = new URL(endpoint)
  let upgraded!: () => void
  let failed!: (error: Error) => void
  const ready = new Promise<void>((resolve, reject) => {
    upgraded = resolve
    failed = reject
  })
  let headers = new Uint8Array()
  const connection = await Bun.connect({
    hostname: url.hostname,
    port: Number(url.port),
    socket: {
      data(_socket, chunk) {
        if (!headers.length || !new TextDecoder().decode(headers).includes('\r\n\r\n')) {
          const joined = new Uint8Array(headers.length + chunk.length)
          joined.set(headers)
          joined.set(chunk, headers.length)
          headers = joined
          const response = new TextDecoder().decode(headers)
          if (response.includes('\r\n\r\n')) {
            if (response.startsWith('HTTP/1.1 101')) upgraded()
            else failed(new Error('Raw WebSocket upgrade rejected'))
          }
        }
      },
      error(_socket, error) {
        failed(error)
      },
    },
  })
  const key = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64')
  connection.write(
    `GET ${url.pathname} HTTP/1.1\r\nHost: ${url.host}\r\nOrigin: ${origin}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`
  )
  await ready
  return {
    send(payload: Uint8Array, opcode: 0 | 2, fin: boolean) {
      if (payload.length > 65_535) throw new TypeError('Raw test frame is too large')
      const mask = crypto.getRandomValues(new Uint8Array(4))
      const extended = payload.length > 125
      const maskOffset = extended ? 4 : 2
      const payloadOffset = maskOffset + 4
      const frame = new Uint8Array(payloadOffset + payload.length)
      frame[0] = (fin ? 0x80 : 0) | opcode
      frame[1] = 0x80 | (extended ? 126 : payload.length)
      if (extended) new DataView(frame.buffer).setUint16(2, payload.length)
      frame.set(mask, maskOffset)
      for (let i = 0; i < payload.length; i++) frame[payloadOffset + i] = payload[i]! ^ mask[i % 4]!
      connection.write(frame)
    },
    close() {
      connection.end()
    },
  }
}

async function rejectedRawUpgrade(endpoint: string, headers: readonly string[]): Promise<number> {
  const url = new URL(endpoint)
  let resolveStatus!: (status: number) => void
  let rejectStatus!: (error: Error) => void
  const status = new Promise<number>((resolve, reject) => {
    resolveStatus = resolve
    rejectStatus = reject
  })
  let settled = false
  const connection = await Bun.connect({
    hostname: url.hostname,
    port: Number(url.port),
    socket: {
      data(socket, chunk) {
        if (settled) return
        const match = /^HTTP\/1\.1 (\d{3})/.exec(new TextDecoder().decode(chunk))
        if (!match) return
        settled = true
        resolveStatus(Number(match[1]))
        socket.end()
      },
      error(_socket, error) {
        if (!settled) rejectStatus(error)
      },
    },
  })
  const key = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64')
  connection.write(
    `GET ${url.pathname} HTTP/1.1\r\n${headers.join('\r\n')}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`
  )
  return status
}

async function fixture(
  handlers: RpcHandlers<typeof schema> = defaultHandlers,
  options: Omit<RpcLoopbackServerOptions, 'accept'> = {}
) {
  const env = await environment()
  const rpcServers: RpcServer<typeof schema>[] = []
  const connections: RpcLoopbackConnection[] = []
  const server = new RpcLoopbackServer({
    ...options,
    accept(lease, transport, connection) {
      connections.push(connection)
      rpcServers.push(new RpcServer(schema, handlers, lease, transport))
    },
  })
  cleanups.push(() => {
    for (const rpc of rpcServers) rpc.close()
    server.close()
  })
  const handoff = server.provision(env.binding())
  return { ...env, server, handoff, rpcServers, connections }
}

function transport(handoff: RpcLoopbackHandoff, origin = 'app://ui') {
  return new RpcLoopbackTransport({
    ...handoff,
    socket: (endpoint) => socket(endpoint, origin),
  })
}

describe('authenticated Bun loopback RPC candidate', () => {
  test('carries structured and binary RPC over a real Bun WebSocket with acknowledgements', async () => {
    const env = await fixture()
    const link = transport(env.handoff)
    const client = new RpcClient(schema, link)
    cleanups.push(() => client.close())
    expect(await client.call('echo', 'hello')).toBe('hello')
    expect(await client.call('bytes', new Uint8Array([1, 2, 3]))).toEqual(new Uint8Array([1, 2, 3]))
    await Bun.sleep(0) // Yield once for the explicit reply acknowledgement.
    expect(env.rpcServers).toHaveLength(1)
    expect(env.connections[0]!.identity.viewId).toBe(env.view.id)
    expect(env.connections[0]!.session).toBe(env.session)
    expect(Object.isFrozen(env.connections[0])).toBe(true)
    // The RPC result settles before its transport ACK crosses back to the server.
    expect(env.rpcServers[0]!.diagnostics().queuedFrames).toBeLessThanOrEqual(1)
    expect(link.diagnostics().queuedFrames).toBe(0)
    expect(env.server.diagnostics()).toMatchObject({
      sockets: 1,
      authenticatedSockets: 1,
      unauthenticatedSockets: 0,
      credentials: 0,
      timers: 0,
    })
  })

  test('rejects missing, forged, malformed and reused first-message credentials', async () => {
    const env = await fixture()
    const attempts = [
      encodeRpcWebSocketRecord({ kind: 'ready' }),
      encodeRpcWebSocketRecord({
        kind: 'auth',
        credential: crypto.getRandomValues(new Uint8Array(32)),
      }),
      new Uint8Array(RPC_WEBSOCKET_HEADER_BYTES),
    ]
    for (const message of attempts) {
      const ws = socket(env.handoff.endpoint)
      await opened(ws)
      const done = closed(ws)
      ws.send(message)
      expect((await done).code).toBe(1008)
    }
    const credential = new Uint8Array(env.handoff.credential)
    const first = transport(env.handoff)
    const client = new RpcClient(schema, first)
    cleanups.push(() => client.close())
    expect(await client.call('echo', 'claimed')).toBe('claimed')
    const replacement = env.server.provision(env.binding())
    const replay = socket(replacement.endpoint)
    await opened(replay)
    const done = closed(replay)
    replay.send(encodeRpcWebSocketRecord({ kind: 'auth', credential }))
    expect((await done).code).toBe(1008)
    expect(env.server.diagnostics().credentials).toBe(1)
  })

  test('rejects wrong Origin and Host before upgrade', async () => {
    const env = await fixture()
    for (const ws of [
      socket(env.handoff.endpoint, 'app://other'),
      socket(env.handoff.endpoint, 'app://ui', { Host: 'localhost:1' }),
    ]) {
      expect((await closed(ws)).code).not.toBe(1000)
    }
    expect(env.server.diagnostics()).toMatchObject({ sockets: 0, credentials: 1 })
  })

  test('rejects duplicate Origin and Host headers rather than choosing one value', async () => {
    const env = await fixture()
    const endpoint = new URL(env.handoff.endpoint)
    expect(
      await rejectedRawUpgrade(env.handoff.endpoint, [
        `Host: ${endpoint.host}`,
        'Origin: app://ui',
        'Origin: app://other',
      ])
    ).not.toBe(101)
    expect(
      await rejectedRawUpgrade(env.handoff.endpoint, [
        `Host: ${endpoint.host}`,
        'Host: localhost:1',
        'Origin: app://ui',
      ])
    ).not.toBe(101)
    expect(env.server.diagnostics()).toMatchObject({ sockets: 0, credentials: 1 })
  })

  test('expires unused credentials and authentication sockets without polling', async () => {
    const env = await fixture(defaultHandlers, {
      credentialTtlMs: 15,
      authenticationTimeoutMs: 15,
    })
    await Bun.sleep(25)
    expect(env.server.diagnostics()).toMatchObject({ credentials: 0, timers: 0 })

    const fresh = env.server.provision(env.binding())
    const ws = socket(fresh.endpoint)
    await opened(ws)
    expect((await closed(ws)).code).toBe(1008)
    expect(env.server.diagnostics()).toMatchObject({ sockets: 0, timers: 0 })
  })

  test('bounds unauthenticated sockets before first-message authentication', async () => {
    const env = await fixture(defaultHandlers, {
      maxUnauthenticatedSockets: 2,
      authenticationTimeoutMs: 1_000,
    })
    const first = socket(env.handoff.endpoint)
    const second = socket(env.handoff.endpoint)
    await Promise.all([opened(first), opened(second)])
    cleanups.push(() => {
      first.close()
      second.close()
    })
    const rejected = socket(env.handoff.endpoint)
    expect((await closed(rejected)).code).not.toBe(1000)
    expect(env.server.diagnostics()).toMatchObject({
      sockets: 2,
      upgradeReservations: 0,
      unauthenticatedSockets: 2,
      timers: 3,
    })
  })

  test('a credential is scoped to its listener and cannot claim another view listener', async () => {
    const first = await fixture()
    const second = await fixture()
    const ws = socket(second.handoff.endpoint)
    await opened(ws)
    const done = closed(ws)
    ws.send(
      encodeRpcWebSocketRecord({
        kind: 'auth',
        credential: first.handoff.credential,
      })
    )
    expect((await done).code).toBe(1008)
    expect(first.server.diagnostics().credentials).toBe(1)
    expect(second.server.diagnostics().credentials).toBe(1)
  })

  test('string-shaped page identity cannot provision a connection credential', async () => {
    const env = await fixture()
    const fake = Object.freeze({
      identity: {
        viewId: env.view.id,
        frameId: 'native-main',
        documentId: env.backend.state(env.view).documentId,
        origin: 'app://ui',
        generation: 1,
      },
      signal: new AbortController().signal,
    }) as unknown as RpcAuthorityBinding
    expect(() => env.server.provision(fake)).toThrow()
    expect(env.server.diagnostics().credentials).toBe(1)
  })

  test('binds the exact backend-owned session rather than a shaped or foreign handle', async () => {
    const env = await environment()
    const otherSession = await env.backend.createSession({
      partition: crypto.randomUUID(),
      persistence: 'ephemeral',
    })
    const foreignBackend = new MockBackend()
    const foreignSession = await foreignBackend.createSession({
      partition: crypto.randomUUID(),
      persistence: 'ephemeral',
    })
    cleanups.push(() => foreignBackend.dispose())
    const issue = () =>
      env.authority.issue(
        env.view,
        {
          frameId: 'native-main',
          documentId: env.backend.state(env.view).documentId,
          mainFrame: true,
        },
        ['echo']
      )
    expect(() => bindRpcAuthority(issue(), otherSession)).toThrow()
    expect(() => bindRpcAuthority(issue(), { ...env.session } as typeof env.session)).toThrow()
    expect(() => bindRpcAuthority(issue(), foreignSession)).toThrow()
    expect(bindRpcAuthority(issue(), env.session).identity.viewId).toBe(env.view.id)
  })

  test('closes a connecting client without leaving a queued send or client resources', async () => {
    const env = await fixture()
    let physicalClose!: () => void
    const physicallyClosed = new Promise<void>((resolve) => {
      physicalClose = resolve
    })
    const link = new RpcLoopbackTransport({
      ...env.handoff,
      socket(endpoint) {
        const websocket = socket(endpoint)
        websocket.addEventListener('close', physicalClose, { once: true })
        return websocket
      },
    })
    const pending = link.send(new Uint8Array([1])).catch((error) => error)
    link.close()
    expect((await pending).code).toBe('DISCONNECTED')
    await physicallyClosed
    expect(link.diagnostics()).toEqual({
      state: 'closed',
      sockets: 0,
      listeners: 0,
      timers: 0,
      queuedFrames: 0,
      queuedBytes: 0,
      bufferedBytes: 0,
    })
    expect(env.server.diagnostics()).toMatchObject({ sockets: 0, retainedBytes: 0 })
  })

  test('contains a throwing accept callback and releases the claimed connection on close', async () => {
    const env = await environment()
    const lease = env.authority.issue(
      env.view,
      {
        frameId: 'native-main',
        documentId: env.backend.state(env.view).documentId,
        mainFrame: true,
      },
      ['echo']
    )
    const binding = bindRpcAuthority(lease, env.session)
    const server = new RpcLoopbackServer({
      accept() {
        throw new Error('application callback failed')
      },
    })
    cleanups.push(() => server.close())
    const handoff = server.provision(binding)
    const ws = socket(handoff.endpoint)
    await opened(ws)
    const done = closed(ws)
    ws.send(encodeRpcWebSocketRecord({ kind: 'auth', credential: handoff.credential }))
    expect((await done).code).toBe(1008)
    expect(server.diagnostics()).toMatchObject({
      sockets: 0,
      authenticatedSockets: 0,
      closingSockets: 0,
      credentials: 0,
      timers: 0,
      retainedBytes: 0,
    })
    expect(() => bindRpcAuthority(lease, env.session)).toThrow()
  })

  test('rejects oversized, text and malformed authenticated records', async () => {
    for (const payload of [
      'text is never protocol data',
      new Uint8Array(525),
      new Uint8Array(RPC_WEBSOCKET_HEADER_BYTES),
    ]) {
      const env = await fixture(defaultHandlers, { maxFrameBytes: 512 })
      const ws = socket(env.handoff.endpoint)
      await opened(ws)
      ws.send(encodeRpcWebSocketRecord({ kind: 'auth', credential: env.handoff.credential }))
      await new Promise<void>((resolve) =>
        ws.addEventListener('message', () => resolve(), { once: true })
      )
      const done = closed(ws)
      ws.send(payload)
      // Bun aborts maxPayloadLength violations without a close frame (1006).
      expect([1002, 1006, 1008, 1009]).toContain((await done).code)
    }
  })

  test('accepts a bounded credential split across WebSocket fragments', async () => {
    const env = await environment()
    let accepted!: () => void
    const connected = new Promise<void>((resolve) => {
      accepted = resolve
    })
    const rpcServers: RpcServer<typeof schema>[] = []
    const server = new RpcLoopbackServer({
      accept(lease, candidate) {
        rpcServers.push(new RpcServer(schema, defaultHandlers, lease, candidate))
        accepted()
      },
    })
    cleanups.push(() => {
      for (const rpc of rpcServers) rpc.close()
      server.close()
    })
    const handoff = server.provision(env.binding())
    const raw = await rawWebSocket(handoff.endpoint)
    cleanups.push(() => raw.close())
    const auth = encodeRpcWebSocketRecord({ kind: 'auth', credential: handoff.credential })
    raw.send(auth.subarray(0, 9), 2, false)
    raw.send(auth.subarray(9), 0, true)
    await connected
    expect(server.diagnostics()).toMatchObject({
      authenticatedSockets: 1,
      unauthenticatedSockets: 0,
      credentials: 0,
      timers: 0,
    })
  })

  test('a paused real Bun consumer leaves at most one acknowledged adapter packet in flight', async () => {
    let began!: () => void
    const started = new Promise<void>((resolve) => {
      began = resolve
    })
    const env = await fixture({
      ...defaultHandlers,
      work: {
        capability: 'work',
        handle(value) {
          began()
          return value
        },
      },
    })
    let websocket!: WebSocket & { pause(): boolean; resume(): boolean }
    const link = new RpcLoopbackTransport({
      ...env.handoff,
      socket(endpoint) {
        websocket = socket(endpoint) as typeof websocket
        return websocket
      },
    })
    const client = new RpcClient(schema, link)
    cleanups.push(() => client.close())
    expect(await client.call('echo', 'ready')).toBe('ready')
    expect(websocket.pause()).toBe(true)
    const call = client.call('work', 'paused')
    await started
    await Bun.sleep(0)
    expect(env.server.diagnostics().queuedFrames).toBeLessThanOrEqual(1)
    expect(env.server.diagnostics().queuedBytes).toBeLessThanOrEqual(1024 * 1024)
    expect(websocket.resume()).toBe(true)
    expect(await call).toBe('paused')
  })

  test('enforces one retained-byte budget across authenticated and closing sockets', async () => {
    const env = await environment()
    const firstBinding = env.binding()
    const secondView = await env.backend.createView({
      window: env.window,
      session: env.session,
      url: 'app://ui/second.html',
      trust: { kind: 'application', origin: 'app://ui' },
    })
    const secondBinding = bindRpcAuthority(
      env.authority.issue(
        secondView,
        {
          frameId: 'native-second',
          documentId: env.backend.state(secondView).documentId,
          mainFrame: true,
        },
        ['echo']
      ),
      env.session
    )
    const candidates: RpcTransport[] = []
    const rpcServers: RpcServer<typeof schema>[] = []
    let acceptBoth!: () => void
    const accepted = new Promise<void>((resolve) => {
      acceptBoth = resolve
    })
    const server = new RpcLoopbackServer({
      maxFrameBytes: 512,
      maxRetainedBytes: 512 + RPC_WEBSOCKET_HEADER_BYTES,
      accept(lease, candidate) {
        rpcServers.push(new RpcServer(schema, defaultHandlers, lease, candidate))
        candidates.push(candidate)
        if (candidates.length === 2) acceptBoth()
      },
    })
    cleanups.push(() => {
      for (const rpc of rpcServers) rpc.close()
      server.close()
    })
    const firstHandoff = server.provision(firstBinding)
    const secondHandoff = server.provision(secondBinding)
    const first = socket(firstHandoff.endpoint)
    const second = socket(secondHandoff.endpoint)
    cleanups.push(() => {
      first.close()
      second.close()
    })
    await Promise.all([opened(first), opened(second)])
    const firstReady = new Promise<void>((resolve) =>
      first.addEventListener('message', () => resolve(), { once: true })
    )
    const secondReady = new Promise<void>((resolve) =>
      second.addEventListener('message', () => resolve(), { once: true })
    )
    first.send(encodeRpcWebSocketRecord({ kind: 'auth', credential: firstHandoff.credential }))
    second.send(encodeRpcWebSocketRecord({ kind: 'auth', credential: secondHandoff.credential }))
    await Promise.all([accepted, firstReady, secondReady])

    const firstSend = Promise.resolve(candidates[0]!.send(new Uint8Array(512))).catch(
      (error: unknown) => error as { code?: unknown }
    )
    expect(server.diagnostics().retainedBytes).toBe(512 + RPC_WEBSOCKET_HEADER_BYTES)
    const secondClosed = closed(second)
    expect(
      (
        await Promise.resolve(candidates[1]!.send(new Uint8Array(512))).catch(
          (error: unknown) => error as { code?: unknown }
        )
      )?.code
    ).toBe('OVERLOADED')
    await secondClosed
    expect(server.diagnostics()).toMatchObject({
      sockets: 1,
      authenticatedSockets: 1,
      retainedBytes: 512 + RPC_WEBSOCKET_HEADER_BYTES,
    })

    const firstClosed = closed(first)
    candidates[0]!.close()
    const duringClose = server.diagnostics()
    if (duringClose.sockets === 1)
      expect(duringClose).toMatchObject({
        closingSockets: 1,
        retainedBytes: 512 + RPC_WEBSOCKET_HEADER_BYTES,
      })
    else expect(duringClose).toMatchObject({ sockets: 0, closingSockets: 0, retainedBytes: 0 })
    await firstClosed
    expect((await firstSend)?.code).toBe('DISCONNECTED')
    expect(server.diagnostics()).toMatchObject({
      sockets: 0,
      closingSockets: 0,
      retainedBytes: 0,
    })
  })

  test('an acknowledgement-ignoring request burst closes without unbounded queues', async () => {
    const env = await environment()
    let accepted!: (rpc: RpcServer<typeof schema>) => void
    const connected = new Promise<RpcServer<typeof schema>>((resolve) => {
      accepted = resolve
    })
    let rpc: RpcServer<typeof schema> | undefined
    const server = new RpcLoopbackServer({
      accept(lease, candidate) {
        rpc = new RpcServer(schema, defaultHandlers, lease, candidate, {
          limits: { maxQueuedFrames: 8 },
        })
        accepted(rpc)
      },
    })
    cleanups.push(() => {
      rpc?.close()
      server.close()
    })
    const handoff = server.provision(env.binding())
    const raw = await rawWebSocket(handoff.endpoint)
    cleanups.push(() => raw.close())
    raw.send(encodeRpcWebSocketRecord({ kind: 'auth', credential: handoff.credential }), 2, true)
    const active = await connected
    const limits = rpcLimits()
    for (let id = 1; id <= 32; id++) {
      const packet = encodeRpc(
        { type: 'request', id, method: 'echo', timeoutMs: 1_000, value: `burst-${id}` },
        limits
      )
      raw.send(encodeRpcWebSocketRecord({ kind: 'packet', sequence: id, packet }), 2, true)
    }
    await active.closed
    expect(active.diagnostics().queuedFrames).toBe(0)
    expect(server.diagnostics().queuedFrames).toBe(0)
    expect(env.authority.diagnostics().executing).toBeLessThanOrEqual(64)
  })

  test('cancellation and disconnect retain execution charges until ignored work settles', async () => {
    let finish!: (value: string) => void
    let began!: () => void
    let observedAbort!: () => void
    const started = new Promise<void>((resolve) => {
      began = resolve
    })
    const aborted = new Promise<void>((resolve) => {
      observedAbort = resolve
    })
    const work = new Promise<string>((resolve) => {
      finish = resolve
    })
    const env = await fixture({
      ...defaultHandlers,
      work: {
        capability: 'work',
        handle: (_value, context) => {
          began()
          context.signal.addEventListener('abort', observedAbort, { once: true })
          return work
        },
      },
    })
    const link = transport(env.handoff)
    const client = new RpcClient(schema, link)
    cleanups.push(() => client.close())
    const controller = new AbortController()
    const call = client.call('work', 'held', { signal: controller.signal }).catch((error) => error)
    await started
    controller.abort()
    expect((await call).code).toBe('CANCELLED')
    await aborted
    expect(env.authority.diagnostics().executing).toBe(1)
    expect(env.rpcServers[0]!.diagnostics().cancelledExecuting).toBe(1)
    client.close()
    expect(env.authority.diagnostics().executing).toBe(1)
    finish('late')
    await work
    await Bun.sleep(0)
    expect(env.authority.diagnostics().executing).toBe(0)
  })

  test('document revocation closes pending credentials and live sockets before late results', async () => {
    let finish!: (value: string) => void
    let began!: () => void
    const started = new Promise<void>((resolve) => {
      began = resolve
    })
    const work = new Promise<string>((resolve) => {
      finish = resolve
    })
    const env = await fixture({
      ...defaultHandlers,
      work: {
        capability: 'work',
        handle: () => {
          began()
          return work
        },
      },
    })
    const client = new RpcClient(schema, transport(env.handoff))
    cleanups.push(() => client.close())
    const call = client.call('work', 'held').catch((error) => error)
    await started
    env.authority.revoke(env.view)
    expect((await call).code).toBe('DISCONNECTED')
    expect(env.server.diagnostics()).toMatchObject({ sockets: 0, credentials: 0 })
    expect(env.authority.diagnostics().executing).toBe(1)
    finish('late')
    await work
    await Bun.sleep(0)
    expect(env.authority.diagnostics().executing).toBe(0)
  })

  test('reserves fragmented receive capacity before accepting each socket', async () => {
    const env = await environment()
    const capacity = 512 + RPC_WEBSOCKET_HEADER_BYTES
    const server = new RpcLoopbackServer({
      maxFrameBytes: 512,
      maxReceiveBytes: capacity,
      maxUnauthenticatedSockets: 4,
      maxSockets: 4,
      authenticationTimeoutMs: 5000,
      accept: () => {
        throw new Error('Unauthenticated test must not accept RPC')
      },
    })
    cleanups.push(() => server.close())
    const handoff = server.provision(env.binding())
    const first = socket(handoff.endpoint)
    cleanups.push(() => first.close())
    await opened(first)
    expect(server.diagnostics().receiveReservedBytes).toBe(capacity)
    const second = socket(handoff.endpoint)
    await closed(second)
    expect(server.diagnostics()).toMatchObject({ sockets: 1, receiveReservedBytes: capacity })
    const ended = closed(first)
    first.close()
    await ended
    // Peer close is not server-side release; await the actual server callback.
    await server.close()
    expect(server.diagnostics().receiveReservedBytes).toBe(0)
  })

  test('server close releases sockets, credentials, timers, listeners and queues', async () => {
    const env = await fixture()
    const client = new RpcClient(schema, transport(env.handoff))
    cleanups.push(() => client.close())
    expect(await client.call('echo', 'open')).toBe('open')
    env.server.close()
    await client.closed
    expect(env.server.diagnostics()).toEqual({
      listeners: 0,
      sockets: 0,
      upgradeReservations: 0,
      unauthenticatedSockets: 0,
      authenticatedSockets: 0,
      closingSockets: 0,
      credentials: 0,
      timers: 0,
      queuedFrames: 0,
      queuedBytes: 0,
      retainedBytes: 0,
      maxRetainedBytes: 32 * 1024 * 1024,
      receiveReservedBytes: 0,
      maxReceiveBytes: 32 * 1024 * 1024,
      closed: true,
    })
  })
})
