import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { RpcClient } from '../packages/client/src/rpc.ts'
import { rpcMessagePort } from '../packages/client/src/rpc-port.ts'
import { RpcServer } from '../packages/runtime/src/rpc.ts'
import type { RpcContext, RpcHandlers } from '../packages/runtime/src/rpc.ts'
import { RpcViewAuthority, claimRpcAuthority } from '../packages/runtime/src/rpc-authority.ts'
import type { RpcLease } from '../packages/runtime/src/rpc-authority.ts'
import { MockBackend } from '../packages/runtime/src/mock.ts'
import { defineRpc, procedure, RpcError, rpcLimits } from '../packages/contracts/src/rpc.ts'
import type {
  RpcLimits,
  RpcScheduler,
  RpcTransport,
  RpcEnvelope,
} from '../packages/contracts/src/rpc.ts'
import type { ViewHandle } from '../packages/contracts/src/index.ts'
import { encodeRpc, decodeRpc } from '../packages/contracts/src/rpc-wire.ts'
import { RpcChannel } from '../packages/contracts/src/rpc-channel.ts'
const limits = rpcLimits()
const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})
const flush = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve()
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
function result<T>(promise: Promise<T>) {
  return promise.then(
    (value) => ({ value, code: undefined }),
    (error) => ({
      value: undefined,
      code: (error as RpcError).code,
      message: (error as Error).message,
    })
  )
}
class Clock implements RpcScheduler {
  time = 0
  next = 0
  timers = new Map<number, { at: number; callback: () => void }>()
  now() {
    return this.time
  }
  set(delay: number, callback: () => void) {
    const id = ++this.next
    this.timers.set(id, { at: this.time + delay, callback })
    return id
  }
  clear(id: unknown) {
    this.timers.delete(id as number)
  }
  advance(ms: number, callbacks = true) {
    this.time += ms
    const due = Array.from(this.timers)
    if (callbacks)
      for (const [id, timer] of due)
        if (timer.at <= this.time && this.timers.delete(id)) timer.callback()
  }
}
class Endpoint implements RpcTransport {
  peer!: Endpoint
  message: ((bytes: Uint8Array) => void) | undefined
  end: (() => void) | undefined
  packets: Uint8Array[] = []
  dead = false
  failSend = false
  stalled = false
  subscriptions = 0
  send(packet: Uint8Array): void | Promise<void> {
    if (this.failSend) throw new Error('private transport detail')
    this.packets.push(packet.slice())
    if (this.stalled) return new Promise<void>(() => {})
    if (!this.dead) this.peer.message?.(packet.slice())
  }
  subscribe(message: (packet: Uint8Array) => void, end: () => void) {
    this.subscriptions++
    this.message = message
    this.end = end
    if (this.dead) end()
    return () => {
      this.subscriptions--
      this.message = undefined
      this.end = undefined
    }
  }
  close() {
    if (this.dead) return
    this.dead = true
    this.end?.()
    if (!this.peer.dead) this.peer.close()
  }
}
function pair() {
  const left = new Endpoint(),
    right = new Endpoint()
  left.peer = right
  right.peer = left
  return { left, right }
}
const text = (v: unknown) => {
  if (typeof v !== 'string') throw new Error('private validation error')
  return v
}
const bytes = (v: unknown) => {
  if (!(v instanceof Uint8Array)) throw new Error('bytes required')
  return v
}
const schema = defineRpc({
  echo: procedure(text, text),
  work: procedure(text, text),
  bytes: procedure(bytes, bytes),
})
async function environment() {
  const backend = new MockBackend()
  const session = await backend.createSession({ partition: 'rpc', persistence: 'ephemeral' })
  const window = await backend.createWindow({
    title: 'RPC',
    bounds: { x: 0, y: 0, width: 640, height: 480 },
  })
  const view = await backend.createView({
    window,
    session,
    url: 'app://ui/index.html',
    trust: { kind: 'application', origin: 'app://ui' },
  })
  const authority = new RpcViewAuthority(backend, ['app://ui'])
  const lease = (capabilities = ['echo', 'work', 'bytes']) =>
    authority.issue(
      view,
      { frameId: 'native-main-frame', mainFrame: true, documentId: backend.state(view).documentId },
      capabilities
    )
  cleanups.push(async () => {
    authority.dispose()
    await backend.dispose()
  })
  return { backend, session, window, view, authority, lease }
}
async function setup(
  overrides: Partial<RpcHandlers<typeof schema>> = {},
  options: {
    limits?: Partial<RpcLimits>
    capabilities?: string[]
    scheduler?: Clock
    onDiagnostic?: (event: import('../packages/runtime/src/rpc.ts').RpcDiagnostic) => void
  } = {}
) {
  const env = await environment()
  const { left, right } = pair()
  const clock = options.scheduler ?? new Clock()
  const handlers: RpcHandlers<typeof schema> = {
    echo: { capability: 'echo', handle: (input) => input },
    work: { capability: 'work', handle: (input) => input },
    bytes: { capability: 'bytes', handle: (input) => input },
    ...overrides,
  }
  const config = {
    scheduler: clock,
    ...(options.limits ? { limits: options.limits } : {}),
    ...(options.onDiagnostic ? { onDiagnostic: options.onDiagnostic } : {}),
  }
  const server = new RpcServer(schema, handlers, env.lease(options.capabilities), right, config)
  const client = new RpcClient(schema, left, config)
  cleanups.push(() => {
    client.close()
    server.close()
  })
  return { ...env, client, server, left, right, clock }
}
function raw(metadata: unknown, body = new Uint8Array()) {
  const header = new TextEncoder().encode(
    typeof metadata === 'string' ? metadata : JSON.stringify(metadata)
  )
  const packet = new Uint8Array(12 + header.length + body.length),
    view = new DataView(packet.buffer)
  view.setUint32(0, 0x424c5250)
  view.setUint32(4, header.length)
  view.setUint32(8, body.length)
  packet.set(header, 12)
  packet.set(body, 12 + header.length)
  return packet
}
const request = (id = 1, value: unknown = 'hello'): Extract<RpcEnvelope, { type: 'request' }> => ({
  type: 'request',
  id,
  method: 'echo',
  timeoutMs: 100,
  value,
})

describe('bounded RPC wire', () => {
  test('roundtrips Unicode JSON and each envelope', () => {
    for (const message of [
      request(1, { greeting: 'こんにちは', values: [null, true, 1.25] }),
      { type: 'success', id: 2, value: null },
      { type: 'error', id: 3, code: 'FORBIDDEN', message: 'denied' },
      { type: 'cancel', id: 4 },
    ] satisfies RpcEnvelope[]) {
      expect(decodeRpc(encodeRpc(message, limits), limits)).toEqual(message)
    }
  })
  test('binary is a separate length-delimited body and snapshots a sliced input', () => {
    const input = new Uint8Array([8, 1, 2, 3, 9]).subarray(1, 4)
    const frame = encodeRpc(request(1, input), limits)
    input.fill(0)
    const decoded = decodeRpc(frame, limits)
    expect(decoded.type === 'request' && decoded.value).toEqual(new Uint8Array([1, 2, 3]))
    frame.fill(0)
    expect(decoded.type === 'request' && decoded.value).toEqual(new Uint8Array([1, 2, 3]))
  })
  test('supports an empty binary payload distinctly from JSON null', () => {
    const value = decodeRpc(encodeRpc(request(1, new Uint8Array()), limits), limits)
    expect(value.type === 'request' && value.value instanceof Uint8Array).toBe(true)
  })
  test('rejects truncation, wrong lengths, bad magic, and trailing bytes', () => {
    const frame = encodeRpc(request(), limits)
    for (const length of [0, 4, 11, 12, frame.length - 1])
      expect(() => decodeRpc(frame.slice(0, length), limits)).toThrow(RpcError)
    const bad = frame.slice()
    bad[0] = 0
    expect(() => decodeRpc(bad, limits)).toThrow()
    expect(() => decodeRpc(new Uint8Array([...frame, 0]), limits)).toThrow()
    new DataView(bad.buffer).setUint32(0, 0x424c5250)
    new DataView(bad.buffer).setUint32(8, 0xffffffff)
    expect(() => decodeRpc(bad, limits)).toThrow()
  })
  test('rejects invalid UTF-8 without replacement characters', () => {
    const value = raw({ v: 1, type: 'cancel', id: 1 })
    value[12] = 0xff
    expect(() => decodeRpc(value, limits)).toThrow('UTF-8')
  })
  test('unknown versions fail explicitly', () => {
    try {
      decodeRpc(raw({ v: 2, type: 'cancel', id: 1 }), limits)
      throw new Error('must reject')
    } catch (error) {
      expect((error as RpcError).code).toBe('VERSION_MISMATCH')
    }
  })
  test('strict envelopes cannot carry renderer-provided authority', () => {
    for (const extra of [
      { viewId: 'victim' },
      { origin: 'app://ui' },
      { capabilities: ['admin'] },
      { generation: 1 },
    ]) {
      expect(() =>
        decodeRpc(
          raw({
            v: 1,
            type: 'request',
            id: 1,
            method: 'echo',
            timeoutMs: 10,
            payload: { kind: 'json', value: '' },
            ...extra,
          }),
          limits
        )
      ).toThrow()
    }
  })
  test('validates IDs, names, payload tags, deadlines and error codes', () => {
    const valid = {
      v: 1,
      type: 'request',
      id: 1,
      method: 'echo',
      timeoutMs: 10,
      payload: { kind: 'json', value: 'x' },
    }
    for (const change of [
      { id: 0 },
      { id: 1.5 },
      { id: Number.MAX_SAFE_INTEGER + 1 },
      { method: '__proto__' },
      { method: 'has space' },
      { timeoutMs: 0 },
      { timeoutMs: 60001 },
      { payload: { kind: 'file' } },
      { type: 'notify' },
    ]) {
      expect(() => decodeRpc(raw({ ...valid, ...change }), limits)).toThrow()
    }
    expect(() =>
      decodeRpc(raw({ v: 1, type: 'error', id: 1, code: 'MADE_UP', message: '' }), limits)
    ).toThrow()
    expect(() =>
      decodeRpc(
        raw({ v: 1, type: 'error', id: 1, code: 'INTERNAL', message: 'x'.repeat(257) }),
        limits
      )
    ).toThrow()
  })
  test('rejects ambiguous JSON/binary bodies and shared memory', () => {
    expect(() =>
      decodeRpc(
        raw(
          { v: 1, type: 'success', id: 1, payload: { kind: 'json', value: null } },
          new Uint8Array([1])
        ),
        limits
      )
    ).toThrow()
    expect(() =>
      decodeRpc(
        raw({ v: 1, type: 'success', id: 1, payload: { kind: 'bytes', value: null } }),
        limits
      )
    ).toThrow()
    expect(() => encodeRpc(request(1, new Uint8Array(new SharedArrayBuffer(10))), limits)).toThrow()
  })
  test('rejects lossy values, accessors, cycles, classes and sparse arrays', () => {
    let read = false
    const accessor = {
      get secret() {
        read = true
        return 'secret'
      },
    }
    const cyclic: Record<string, unknown> = {}
    cyclic['self'] = cyclic
    const sparse: unknown[] = []
    sparse.length = 2
    for (const value of [
      undefined,
      NaN,
      Infinity,
      -0,
      1n,
      () => {},
      new Date(),
      new Map(),
      [undefined],
      sparse,
      accessor,
      cyclic,
      { bytes: new Uint8Array([1]) },
    ]) {
      expect(() => encodeRpc({ ...request(), value }, limits)).toThrow()
    }
    expect(read).toBe(false)
  })
  test('bounds JSON complexity, metadata and frame bytes', () => {
    let deep: unknown = null
    for (let i = 0; i < 60; i++) deep = { nested: deep }
    for (const value of [
      deep,
      Array.from({ length: 10_001 }, () => null),
      'x'.repeat(limits.maxMetadataBytes),
      new Uint8Array(limits.maxFrameBytes),
    ]) {
      expect(() => encodeRpc({ ...request(), value }, limits)).toThrow()
    }
  })
  test('rejects prototype-bearing keys and dangerous contract names', () => {
    expect(() =>
      decodeRpc(
        raw(
          '{"v":1,"type":"success","id":1,"payload":{"kind":"json","value":{"__proto__":{"admin":true}}}}'
        ),
        limits
      )
    ).toThrow()
    expect(() => defineRpc({ constructor: procedure(text, text) })).toThrow()
    expect(() => defineRpc({})).toThrow()
  })
  test('validated options cannot remove bounds accidentally', () => {
    for (const options of [
      { maxPending: 0 },
      { maxHandlers: Infinity },
      { maxFrameBytes: 2 ** 30 },
      { maxQueuedBytes: 1 },
      { maxMetadataBytes: 1 },
      { maxTimeoutMs: 1.5 },
    ])
      expect(() => rpcLimits(options)).toThrow()
  })
  test('seeded malformed packet fuzz never dispatches partial envelopes', () => {
    let seed = 341
    for (let i = 0; i < 1000; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      const packet = new Uint8Array(seed % 512)
      for (let j = 0; j < packet.length; j++) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
        packet[j] = seed & 255
      }
      expect(() => decodeRpc(packet, limits)).toThrow()
    }
  })
})

describe('RPC client and server', () => {
  test('typed roundtrip and binary response use the same validated contract', async () => {
    const { client } = await setup()
    expect(await client.call('echo', 'hello')).toBe('hello')
    expect(await client.call('bytes', new Uint8Array([3, 2, 1]))).toEqual(new Uint8Array([3, 2, 1]))
  })
  test('runtime input validation is independent of compile-time inference', async () => {
    const { client } = await setup()
    // @ts-expect-error this procedure accepts a string, not a number
    expect((await result(client.call('echo', 42))).code).toBe('BAD_REQUEST')
    // @ts-expect-error unknown method names must also fail at compile time
    expect((await result(client.call('missing', 'x'))).code).toBe('NOT_FOUND')
    const textValue: string = await client.call('echo', 'typed')
    expect(textValue).toBe('typed')
  })
  test('handler errors and output-validation failures cannot leak private messages', async () => {
    const { client } = await setup({
      work: {
        capability: 'work',
        handle: () => {
          throw new Error('/private/path secret')
        },
      },
      echo: { capability: 'echo', handle: () => 42 as unknown as string },
    })
    for (const method of ['work', 'echo'] as const) {
      const value = await result(client.call(method, 'x'))
      expect(value.code).toBe('INTERNAL')
      expect(JSON.stringify(value)).not.toContain('secret')
    }
  })
  test('server independently validates malicious input before dispatch', async () => {
    let called = false
    const { right, left } = await setup({
      echo: {
        capability: 'echo',
        handle: (s) => {
          called = true
          return s
        },
      },
    })
    right.message?.(encodeRpc(request(1, 42), limits))
    await flush()
    expect(called).toBe(false)
    const response = decodeRpc(right.packets[0]!, limits)
    expect(response.type === 'error' && response.code).toBe('BAD_REQUEST')
    left.close()
  })
  test('permission denial happens before handler execution', async () => {
    let called = false
    const { client } = await setup(
      {
        work: {
          capability: 'work',
          handle: (s) => {
            called = true
            return s
          },
        },
      },
      { capabilities: ['echo'] }
    )
    expect((await result(client.call('work', 'x'))).code).toBe('FORBIDDEN')
    expect(called).toBe(false)
    expect(await client.call('echo', 'still works')).toBe('still works')
  })
  test('concurrent calls are correlated even when results arrive out of order', async () => {
    const first = deferred<string>()
    const { client } = await setup({
      work: { capability: 'work', handle: (s) => (s === 'first' ? first.promise : 'second') },
    })
    const a = client.call('work', 'first'),
      b = client.call('work', 'second')
    expect(await b).toBe('second')
    first.resolve('first')
    expect(await a).toBe('first')
  })
  test('pre-cancelled calls do not write or execute', async () => {
    const { client, left } = await setup()
    const controller = new AbortController()
    controller.abort()
    expect((await result(client.call('echo', 'x', { signal: controller.signal }))).code).toBe(
      'CANCELLED'
    )
    expect(left.packets).toHaveLength(0)
  })
  test('cancellation aborts the handler and suppresses a late success', async () => {
    const done = deferred<string>()
    let signal!: AbortSignal
    const { client, server, right } = await setup({
      work: {
        capability: 'work',
        handle: (_s, ctx) => {
          signal = ctx.signal
          return done.promise
        },
      },
    })
    const controller = new AbortController()
    const pending = result(client.call('work', 'x', { signal: controller.signal }))
    controller.abort()
    await flush()
    expect((await pending).code).toBe('CANCELLED')
    expect(signal.aborted).toBe(true)
    expect(server.diagnostics().cancelledExecuting).toBe(1)
    done.resolve('too late')
    await flush()
    expect(server.diagnostics().executing).toBe(0)
    expect(right.packets.map((p) => decodeRpc(p, limits)).some((p) => p.type === 'success')).toBe(
      false
    )
  })
  test('cancelled handlers retain their quota until execution actually settles', async () => {
    const done = deferred<string>()
    let executions = 0
    const { client, server } = await setup(
      {
        work: {
          capability: 'work',
          handle: () => {
            executions++
            return done.promise
          },
        },
      },
      { limits: { maxHandlers: 1 } }
    )
    const abort = new AbortController(),
      p = result(client.call('work', 'one', { signal: abort.signal }))
    abort.abort()
    await flush()
    await p
    expect((await result(client.call('work', 'two'))).code).toBe('OVERLOADED')
    expect(executions).toBe(1)
    expect(server.diagnostics().executing).toBe(1)
    done.resolve('finished')
    await flush()
    expect(server.diagnostics().executing).toBe(0)
    expect(await client.call('echo', 'usable')).toBe('usable')
  })
  test('request timeout settles locally, cancels remotely and cleans timers', async () => {
    const done = deferred<string>()
    const { client, server, clock } = await setup({
      work: { capability: 'work', handle: () => done.promise },
    })
    const p = result(client.call('work', 'x', { timeoutMs: 25 }))
    clock.advance(25)
    await flush()
    expect((await p).code).toBe('DEADLINE_EXCEEDED')
    expect(client.diagnostics().pending).toBe(0)
    done.resolve('late')
    await flush()
    expect(server.diagnostics().executing).toBe(0)
    expect(clock.timers.size).toBe(0)
  })
  test('a delayed timer callback cannot turn an expired reply into success', async () => {
    const done = deferred<string>()
    const { client, clock } = await setup({
      work: { capability: 'work', handle: () => done.promise },
    })
    const p = result(client.call('work', 'x', { timeoutMs: 20 }))
    clock.advance(30, false)
    done.resolve('late')
    expect((await p).code).toBe('DEADLINE_EXCEEDED')
  })
  test('server enforces its deadline without trusting a cooperative caller', async () => {
    const done = deferred<string>(),
      { right, clock } = await setup({ work: { capability: 'work', handle: () => done.promise } })
    right.message?.(
      encodeRpc({ type: 'request', id: 1, method: 'work', timeoutMs: 10, value: 'x' }, limits)
    )
    clock.advance(10)
    await flush()
    const response = decodeRpc(right.packets[0]!, limits)
    expect(response.type === 'error' && response.code).toBe('DEADLINE_EXCEEDED')
    done.resolve('late')
  })
  test('pending call quota refuses work without allocating another request', async () => {
    const done = deferred<string>()
    const { client } = await setup(
      { work: { capability: 'work', handle: () => done.promise } },
      { limits: { maxPending: 1 } }
    )
    const p = client.call('work', 'x')
    expect((await result(client.call('echo', 'y'))).code).toBe('OVERLOADED')
    done.resolve('done')
    await p
    expect(await client.call('echo', 'y')).toBe('y')
  })
  test('reentrant input parsing cannot exceed the pending quota', async () => {
    const { left } = pair()
    let nested: Promise<unknown> | undefined
    const contract = defineRpc({
      echo: procedure((value: unknown) => {
        if (value === 'outer') nested = client.call('echo', 'inner')
        return text(value)
      }, text),
    })
    const client = new RpcClient(contract, left, { limits: { maxPending: 1 } })
    const outer = result(client.call('echo', 'outer'))
    expect(client.diagnostics().pending).toBe(1)
    expect((await result(nested!)).code).toBe('OVERLOADED')
    expect(decodeRpc(left.packets[0]!, limits)).toMatchObject({ type: 'request', id: 1 })
    client.close()
    await outer
  })
  for (const hook of ['first-now', 'second-now', 'third-now', 'first-set', 'second-set'] as const) {
    test(`client scheduler ${hook} cannot reorder or exceed admission`, async () => {
      const { left } = pair()
      let nested: Promise<unknown> | undefined
      let nowCalls = 0,
        setCalls = 0
      const clock = new Clock()
      const now = clock.now.bind(clock),
        set = clock.set.bind(clock)
      clock.now = () => {
        if (
          ++nowCalls ===
          (hook === 'first-now' ? 1 : hook === 'second-now' ? 2 : hook === 'third-now' ? 3 : -1)
        )
          nested = result(client.call('echo', 'nested'))
        return now()
      }
      clock.set = (delay, callback) => {
        if (++setCalls === (hook === 'first-set' ? 1 : hook === 'second-set' ? 2 : -1))
          nested = result(client.call('echo', 'nested'))
        return set(delay, callback)
      }
      const client = new RpcClient(schema, left, { limits: { maxPending: 2 }, scheduler: clock })
      const outer = result(client.call('echo', 'outer'))
      expect(client.diagnostics().pending).toBe(1)
      expect((await nested!) as { code: string }).toMatchObject({ code: 'OVERLOADED' })
      expect(decodeRpc(left.packets[0]!, limits)).toMatchObject({ type: 'request', id: 1 })
      client.close()
      await outer
      expect(clock.timers.size).toBe(0)
    })
  }
  test('server scheduler cannot reenter before the parsing reservation', async () => {
    const env = await environment()
    const { right } = pair()
    const done = deferred<string>()
    const clock = new Clock()
    const now = clock.now.bind(clock)
    let entered = false
    clock.now = () => {
      if (!entered) {
        entered = true
        right.message?.(
          encodeRpc(
            { type: 'request', id: 2, method: 'echo', timeoutMs: 1000, value: 'inner' },
            limits
          )
        )
      }
      return now()
    }
    const contract = defineRpc({ echo: procedure(text, text) })
    const server = new RpcServer(
      contract,
      { echo: { capability: 'echo', handle: () => done.promise } },
      env.lease(),
      right,
      { scheduler: clock, limits: { maxHandlers: 1 } }
    )
    right.message?.(
      encodeRpc({ type: 'request', id: 1, method: 'echo', timeoutMs: 1000, value: 'outer' }, limits)
    )
    expect(server.diagnostics().executing).toBe(1)
    expect(decodeRpc(right.packets[0]!, limits)).toMatchObject({ id: 2, code: 'OVERLOADED' })
    done.resolve('done')
    await flush()
    server.close()
  })
  for (const hook of ['first-now', 'second-now', 'first-set', 'second-set'] as const) {
    test(`client scheduler ${hook} closure releases admission and timers`, async () => {
      const { left } = pair()
      const clock = new Clock()
      const now = clock.now.bind(clock),
        set = clock.set.bind(clock)
      let nowCalls = 0,
        setCalls = 0
      clock.now = () => {
        if (++nowCalls === (hook === 'first-now' ? 1 : hook === 'second-now' ? 2 : -1))
          client.close()
        return now()
      }
      clock.set = (delay, callback) => {
        if (++setCalls === (hook === 'first-set' ? 1 : hook === 'second-set' ? 2 : -1))
          client.close()
        return set(delay, callback)
      }
      const client = new RpcClient(schema, left, { scheduler: clock })
      expect((await result(client.call('echo', 'outer'))).code).toBe('DISCONNECTED')
      await flush()
      expect(client.diagnostics().pending).toBe(0)
      expect(clock.timers.size).toBe(0)
      expect(left.packets).toHaveLength(0)
    })
  }
  for (const hook of ['first-now', 'second-now', 'third-now', 'fourth-now', 'first-set'] as const) {
    test(`server scheduler ${hook} cancellation releases unstarted work`, async () => {
      const env = await environment()
      const { right } = pair()
      const clock = new Clock()
      const now = clock.now.bind(clock),
        set = clock.set.bind(clock)
      let nowCalls = 0,
        setCalls = 0,
        calls = 0
      const cancel = () => right.message?.(encodeRpc({ type: 'cancel', id: 1 }, limits))
      clock.now = () => {
        if (
          ++nowCalls ===
          (hook === 'first-now'
            ? 1
            : hook === 'second-now'
              ? 2
              : hook === 'third-now'
                ? 3
                : hook === 'fourth-now'
                  ? 4
                  : -1)
        )
          cancel()
        return now()
      }
      clock.set = (delay, callback) => {
        if (++setCalls === 1 && hook === 'first-set') cancel()
        return set(delay, callback)
      }
      const contract = defineRpc({ echo: procedure(text, text) })
      const server = new RpcServer(
        contract,
        {
          echo: {
            capability: 'echo',
            handle: () => {
              calls++
              return 'done'
            },
          },
        },
        env.lease(),
        right,
        { scheduler: clock }
      )
      right.message?.(
        encodeRpc(
          { type: 'request', id: 1, method: 'echo', timeoutMs: 1000, value: 'outer' },
          limits
        )
      )
      await flush()
      expect(calls).toBe(0)
      expect(server.diagnostics().executing).toBe(0)
      expect(env.authority.diagnostics().executing).toBe(0)
      expect(clock.timers.size).toBe(0)
      server.close()
    })
  }
  for (const hook of ['now', 'set'] as const) {
    test(`client scheduler ${hook} failure settles without retaining pending work`, async () => {
      const { left } = pair()
      const clock = new Clock()
      if (hook === 'now')
        clock.now = () => {
          throw new Error('scheduler')
        }
      else
        clock.set = () => {
          throw new Error('scheduler')
        }
      const client = new RpcClient(schema, left, { scheduler: clock })
      expect((await result(client.call('echo', 'outer'))).code).toBe('INTERNAL')
      expect(client.diagnostics().pending).toBe(0)
      expect(left.packets).toHaveLength(0)
      client.close()
    })
    test(`server scheduler ${hook} failure releases admitted work`, async () => {
      const env = await environment()
      const { right } = pair()
      const clock = new Clock()
      if (hook === 'now')
        clock.now = () => {
          throw new Error('scheduler')
        }
      else
        clock.set = () => {
          throw new Error('scheduler')
        }
      const contract = defineRpc({ echo: procedure(text, text) })
      let calls = 0
      const server = new RpcServer(
        contract,
        {
          echo: {
            capability: 'echo',
            handle: () => {
              calls++
              return 'done'
            },
          },
        },
        env.lease(),
        right,
        { scheduler: clock }
      )
      right.message?.(
        encodeRpc(
          { type: 'request', id: 1, method: 'echo', timeoutMs: 1000, value: 'outer' },
          limits
        )
      )
      await flush()
      expect(calls).toBe(0)
      expect(server.diagnostics().executing).toBe(0)
      expect(env.authority.diagnostics().executing).toBe(0)
      expect(server.diagnostics().closed).toBe(true)
    })
  }
  test('server closure during timer installation releases the returned timer and authority', async () => {
    const env = await environment()
    const { right } = pair()
    const clock = new Clock()
    const set = clock.set.bind(clock)
    clock.set = (delay, callback) => {
      server.close()
      return set(delay, callback)
    }
    const contract = defineRpc({ echo: procedure(text, text) })
    let calls = 0
    const server = new RpcServer(
      contract,
      {
        echo: {
          capability: 'echo',
          handle: () => {
            calls++
            return 'done'
          },
        },
      },
      env.lease(),
      right,
      { scheduler: clock }
    )
    right.message?.(
      encodeRpc({ type: 'request', id: 1, method: 'echo', timeoutMs: 1000, value: 'outer' }, limits)
    )
    await flush()
    expect(calls).toBe(0)
    expect(server.diagnostics().executing).toBe(0)
    expect(env.authority.diagnostics().executing).toBe(0)
    expect(clock.timers.size).toBe(0)
  })
  test('channel timer clearing may reentrantly close without double-releasing bytes', async () => {
    const { left } = pair()
    const clock = new Clock()
    const clear = clock.clear.bind(clock)
    const channel = new RpcChannel(
      left,
      limits,
      clock,
      () => {},
      () => {}
    )
    clock.clear = (timer) => {
      channel.close()
      clear(timer)
    }
    channel.start()
    const sending = result(channel.send(Uint8Array.of(1)))
    expect((await sending).code).toBe('DISCONNECTED')
    expect(channel.diagnostics()).toMatchObject({ closed: true, queuedBytes: 0, queuedFrames: 0 })
    expect(clock.timers.size).toBe(0)
  })
  test('input parsing cannot enqueue a request after closing the client', async () => {
    const { left } = pair()
    const contract = defineRpc({
      echo: procedure((value: unknown) => {
        client.close()
        return text(value)
      }, text),
    })
    const client = new RpcClient(contract, left)
    expect((await result(client.call('echo', 'outer'))).code).toBe('DISCONNECTED')
    expect(client.diagnostics().pending).toBe(0)
    expect(left.packets).toHaveLength(0)
  })
  test('serialization reentrancy is refused before it can reorder requests', async () => {
    const { left } = pair()
    let nested: Promise<unknown> | undefined
    const contract = defineRpc({ echo: procedure((value: unknown) => value, text) })
    const client = new RpcClient(contract, left)
    const value = new Proxy(
      { value: 'outer' },
      {
        getPrototypeOf(target) {
          nested ??= client.call('echo', 'inner')
          return Reflect.getPrototypeOf(target)
        },
      }
    )
    const outer = result(client.call('echo', value))
    expect((await result(nested!)).code).toBe('OVERLOADED')
    expect(decodeRpc(left.packets[0]!, limits)).toMatchObject({ type: 'request', id: 1 })
    expect(client.diagnostics().pending).toBe(1)
    client.close()
    await outer
  })
  test('input parsing cannot enqueue a request after cancellation', async () => {
    const { left } = pair()
    const controller = new AbortController()
    const contract = defineRpc({
      echo: procedure((value: unknown) => {
        controller.abort()
        return text(value)
      }, text),
    })
    const client = new RpcClient(contract, left)
    expect((await result(client.call('echo', 'outer', { signal: controller.signal }))).code).toBe(
      'CANCELLED'
    )
    expect(client.diagnostics().pending).toBe(0)
    expect(left.packets).toHaveLength(0)
    client.close()
  })
  test('server rechecks handler capacity after reentrant input parsing', async () => {
    const env = await environment()
    const { right } = pair()
    const done = deferred<string>()
    const contract = defineRpc({
      echo: procedure((value: unknown) => {
        if (value === 'outer')
          right.message?.(
            encodeRpc(
              { type: 'request', id: 2, method: 'echo', timeoutMs: 1000, value: 'inner' },
              limits
            )
          )
        return text(value)
      }, text),
    })
    const server = new RpcServer(
      contract,
      { echo: { capability: 'echo', handle: () => done.promise } },
      env.lease(),
      right,
      { limits: { maxHandlers: 1 } }
    )
    right.message?.(
      encodeRpc({ type: 'request', id: 1, method: 'echo', timeoutMs: 1000, value: 'outer' }, limits)
    )
    expect(server.diagnostics().executing).toBe(1)
    expect(decodeRpc(right.packets[0]!, limits)).toMatchObject({
      type: 'error',
      id: 2,
      code: 'OVERLOADED',
    })
    done.resolve('done')
    await flush()
    server.close()
  })
  test('server input parsing cannot start a handler after connection closure', async () => {
    const env = await environment()
    const { right } = pair()
    let calls = 0
    const contract = defineRpc({
      echo: procedure((value: unknown) => {
        server.close()
        return text(value)
      }, text),
    })
    const server = new RpcServer(
      contract,
      {
        echo: {
          capability: 'echo',
          handle: () => {
            calls++
            return 'done'
          },
        },
      },
      env.lease(),
      right
    )
    right.message?.(
      encodeRpc({ type: 'request', id: 1, method: 'echo', timeoutMs: 1000, value: 'outer' }, limits)
    )
    expect(calls).toBe(0)
    expect(server.diagnostics().executing).toBe(0)
  })
  test('server input parsing observes cancellation delivered reentrantly', async () => {
    const env = await environment()
    const { right } = pair()
    let calls = 0
    const contract = defineRpc({
      echo: procedure((value: unknown) => {
        right.message?.(encodeRpc({ type: 'cancel', id: 1 }, limits))
        return text(value)
      }, text),
    })
    const server = new RpcServer(
      contract,
      {
        echo: {
          capability: 'echo',
          handle: () => {
            calls++
            return 'done'
          },
        },
      },
      env.lease(),
      right
    )
    right.message?.(
      encodeRpc({ type: 'request', id: 1, method: 'echo', timeoutMs: 1000, value: 'outer' }, limits)
    )
    expect(calls).toBe(0)
    expect(decodeRpc(right.packets[0]!, limits)).toMatchObject({
      type: 'error',
      id: 1,
      code: 'CANCELLED',
    })
    server.close()
  })
  test('server idle wait includes admitted input parsing and subsequent handler', async () => {
    const env = await environment()
    const { right } = pair()
    const done = deferred<string>()
    let idle: Promise<void> | undefined
    let settled = false
    const contract = defineRpc({
      echo: procedure((value: unknown) => {
        idle = server.whenIdle().then(() => {
          settled = true
        })
        return text(value)
      }, text),
    })
    const server = new RpcServer(
      contract,
      { echo: { capability: 'echo', handle: () => done.promise } },
      env.lease(),
      right
    )
    right.message?.(
      encodeRpc({ type: 'request', id: 1, method: 'echo', timeoutMs: 1000, value: 'outer' }, limits)
    )
    await flush()
    expect(settled).toBe(false)
    done.resolve('done')
    await idle
    expect(settled).toBe(true)
    server.close()
  })
  test('duplicate and late responses are ignored without unbounded tombstones', async () => {
    const { client, left, right } = await setup()
    expect(await client.call('echo', 'x')).toBe('x')
    left.message?.(right.packets[0]!.slice())
    expect(client.diagnostics().closed).toBe(false)
    expect(await client.call('echo', 'next')).toBe('next')
  })
  test('unsolicited future responses close the channel and settle pending calls', async () => {
    const done = deferred<string>()
    const { client, left } = await setup({
      work: { capability: 'work', handle: () => done.promise },
    })
    const p = result(client.call('work', 'x'))
    left.message?.(encodeRpc({ type: 'success', id: 99, value: 'forged' }, limits))
    expect((await p).code).toBe('PROTOCOL_ERROR')
    done.resolve('late')
  })
  test('replayed requests cannot execute a non-idempotent handler twice', async () => {
    let count = 0
    const { client, right, left } = await setup({
      work: { capability: 'work', handle: () => String(++count) },
    })
    expect(await client.call('work', 'x')).toBe('1')
    right.message?.(left.packets[0]!.slice())
    expect(client.diagnostics().closed).toBe(true)
    expect(count).toBe(1)
  })
  test('synchronous transport failure rejects requests without leaking exceptions', async () => {
    const { client, left } = await setup()
    left.failSend = true
    expect((await result(client.call('echo', 'x'))).code).toBe('DISCONNECTED')
    expect(client.diagnostics().pending).toBe(0)
  })
  test('disconnect settles every pending request and aborts active handlers', async () => {
    const done = deferred<string>()
    const signals: AbortSignal[] = []
    const { client, right } = await setup({
      work: {
        capability: 'work',
        handle: (_s, ctx) => {
          signals.push(ctx.signal)
          return done.promise
        },
      },
    })
    const calls = [result(client.call('work', '1')), result(client.call('work', '2'))]
    await flush()
    right.close()
    expect((await Promise.all(calls)).map((r) => r.code)).toEqual(['DISCONNECTED', 'DISCONNECTED'])
    expect(signals.every((s) => s.aborted)).toBe(true)
    done.resolve('late')
  })
  test('a cancelled queued request is never sent when a previous send stalls', async () => {
    const { client, left, clock } = await setup({}, { limits: { sendTimeoutMs: 50 } })
    left.stalled = true
    const first = result(client.call('echo', 'first'))
    const controller = new AbortController()
    const second = result(client.call('echo', 'second', { signal: controller.signal }))
    controller.abort()
    expect((await second).code).toBe('CANCELLED')
    expect(left.packets).toHaveLength(1)
    clock.advance(50)
    await flush()
    expect((await first).code).toBe('DISCONNECTED')
    expect(client.diagnostics().queuedBytes).toBe(0)
  })
  test('peer output schema mismatches fail closed', async () => {
    const done = deferred<string>()
    const { client, left } = await setup({
      work: { capability: 'work', handle: () => done.promise },
    })
    const p = result(client.call('work', 'x'))
    left.message?.(encodeRpc({ type: 'success', id: 1, value: 42 }, limits))
    expect((await p).code).toBe('PROTOCOL_ERROR')
    done.resolve('late')
  })
  test('request sequence survives a locally rejected payload without reuse', async () => {
    const { client } = await setup()
    await result(client.call('echo', 4 as unknown as string))
    expect(await client.call('echo', 'valid')).toBe('valid')
  })
})

describe('native-known view authority policy', () => {
  test('forged and reused leases cannot bind a server', async () => {
    expect(() => claimRpcAuthority({} as RpcLease)).toThrow('not valid')
    const { lease } = await environment()
    const token = lease()
    claimRpcAuthority(token)
    expect(() => claimRpcAuthority(token)).toThrow('not valid')
    expect(() => claimRpcAuthority({ ...token } as RpcLease)).toThrow('not valid')
  })
  test('copied view IDs and foreign handles are not authority', async () => {
    const first = await environment(),
      second = await environment()
    for (const view of [{ ...first.view } as ViewHandle, second.view]) {
      expect(() =>
        first.authority.issue(
          view,
          {
            frameId: 'main',
            mainFrame: true,
            documentId: first.backend.state(first.view).documentId,
          },
          ['echo']
        )
      ).toThrow()
    }
  })
  test('child frames and stale document identities cannot inherit a grant', async () => {
    const { authority, view, backend } = await environment()
    const documentId = backend.state(view).documentId
    for (const frame of [
      { frameId: 'child', documentId, mainFrame: false },
      { frameId: 'main', documentId: 'old-document', mainFrame: true },
    ])
      expect(() => authority.issue(view, frame, ['echo'])).toThrow()
  })
  test('application origin allowlist is exact, not a string prefix', async () => {
    const { backend, view } = await environment()
    expect(() => new RpcViewAuthority(backend, ['app://ui/path'])).toThrow()
    const other = new RpcViewAuthority(backend, ['app://ui.evil'])
    cleanups.push(() => other.dispose())
    expect(() =>
      other.issue(
        view,
        { frameId: 'main', mainFrame: true, documentId: backend.state(view).documentId },
        ['echo']
      )
    ).toThrow()
  })
  test('remote pages are unprivileged even on an approved origin', async () => {
    const { backend, authority, session, window } = await environment()
    const remote = await backend.createView({
      window,
      session,
      url: 'app://ui/index.html',
      trust: { kind: 'remote' },
    })
    expect(() =>
      authority.issue(
        remote,
        { frameId: 'main', mainFrame: true, documentId: backend.state(remote).documentId },
        ['echo']
      )
    ).toThrow()
  })
  test('same-origin navigation revokes calls as well as cross-origin navigation', async () => {
    for (const url of ['app://ui/next.html', 'https://example.invalid/']) {
      const done = deferred<string>()
      let signal!: AbortSignal
      const { client, server, backend, view, authority } = await setup({
        work: {
          capability: 'work',
          handle: (_s, ctx) => {
            signal = ctx.signal
            return done.promise
          },
        },
      })
      const call = result(client.call('work', 'x'))
      await backend.navigate(view, url)
      expect((await call).code).toBe('DISCONNECTED')
      expect(signal.aborted).toBe(true)
      expect((await server.closed).code).toBe('REVOKED')
      expect(authority.diagnostics().documents).toBe(0)
      done.resolve('late')
    }
  })
  test('returning from a remote origin does not silently restore privileges', async () => {
    const { backend, authority, view } = await environment()
    await backend.navigate(view, 'https://example.invalid/')
    await backend.navigate(view, 'app://ui/index.html')
    expect(() =>
      authority.issue(
        view,
        { frameId: 'main', mainFrame: true, documentId: backend.state(view).documentId },
        ['echo']
      )
    ).toThrow()
  })
  test('close and reload teardown revoke and abort work without destroying unrelated views', async () => {
    const done = deferred<string>()
    const { client, backend, view, authority, window } = await setup({
      work: { capability: 'work', handle: () => done.promise },
    })
    const call = result(client.call('work', 'x'))
    authority.revokeAll()
    expect((await call).code).toBe('DISCONNECTED')
    expect(backend.state(view).url).toBe('app://ui/index.html')
    expect(backend.diagnostics().windows).toBe(1)
    await backend.closeWindow(window)
    expect(authority.diagnostics().documents).toBe(0)
    done.resolve('late')
  })
  test('reissuing on the same view revokes the previous connection', async () => {
    const { authority, lease, client } = await setup()
    const replacement = lease()
    expect(client.diagnostics().closed).toBe(true)
    expect(claimRpcAuthority(replacement).identity.generation).toBe(2)
    authority.dispose()
  })
  test('a host-detected frame replacement can revoke before document commit', async () => {
    const { authority, view, client } = await setup()
    authority.revoke(view)
    expect(client.diagnostics().closed).toBe(true)
  })
  test('handler receives a frozen native-known identity, not page claims', async () => {
    let context!: RpcContext
    const { client, view } = await setup({
      echo: {
        capability: 'echo',
        handle: (input, ctx) => {
          context = ctx
          return input
        },
      },
    })
    await client.call('echo', 'x')
    expect(context.identity.viewId).toBe(view.id)
    expect(context.identity.origin).toBe('app://ui')
    expect(Object.isFrozen(context)).toBe(true)
    expect(Object.isFrozen(context.identity)).toBe(true)
  })
})

describe('bounded writer and actual MessagePort transport', () => {
  test('scheduler clear failure cannot prevent channel settlement', async () => {
    const clock = new Clock()
    const clear = clock.clear.bind(clock)
    clock.clear = (timer) => {
      clear(timer)
      throw new Error('private scheduler failure')
    }
    const { left } = pair()
    const channel = new RpcChannel(
      left,
      limits,
      clock,
      () => {},
      () => {}
    )
    channel.start()
    await channel.send(Uint8Array.of(1))
    channel.close()
    expect(channel.diagnostics()).toMatchObject({ queuedBytes: 0, queuedFrames: 0, closed: true })
    expect(clock.timers.size).toBe(0)
  })
  test('transport subscribe and cleanup failures settle the channel', async () => {
    const clock = new Clock()
    let closed = 0
    const failing: RpcTransport = {
      subscribe: () => {
        throw new Error('private')
      },
      send: () => {},
      close: () => {
        closed++
        throw new Error('private')
      },
    }
    const first = new RpcChannel(
      failing,
      limits,
      clock,
      () => {},
      () => {}
    )
    first.start()
    expect((await first.closed).code).toBe('DISCONNECTED')
    expect(closed).toBe(1)
    const cleanup: RpcTransport = {
      subscribe: () => () => {
        throw new Error('private')
      },
      send: () => {},
      close: () => {
        closed++
      },
    }
    const second = new RpcChannel(
      cleanup,
      limits,
      clock,
      () => {},
      () => {}
    )
    second.start()
    second.close()
    expect((await second.closed).code).toBe('DISCONNECTED')
    expect(closed).toBe(2)
    expect(second.diagnostics()).toMatchObject({ queuedBytes: 0, queuedFrames: 0, closed: true })
    expect(clock.timers.size).toBe(0)
  })
  test('transport send can close synchronously without retaining queued ownership', async () => {
    const clock = new Clock()
    let sends = 0
    const transport: RpcTransport = {
      subscribe: () => () => {},
      send: () => {
        sends++
        channel.close()
      },
      close: () => {},
    }
    const channel = new RpcChannel(
      transport,
      limits,
      clock,
      () => {},
      () => {}
    )
    channel.start()
    expect((await result(channel.send(Uint8Array.of(1)))).code).toBe('DISCONNECTED')
    await flush()
    expect(sends).toBe(1)
    expect(channel.diagnostics()).toMatchObject({ queuedBytes: 0, queuedFrames: 0, closed: true })
    expect(clock.timers.size).toBe(0)
  })
  test('stalled writes keep in-flight bytes counted and close on drain deadline', async () => {
    const clock = new Clock(),
      { left } = pair()
    left.stalled = true
    const channel = new RpcChannel(
      left,
      rpcLimits({ maxQueuedFrames: 1, sendTimeoutMs: 10 }),
      clock,
      () => {},
      () => {}
    )
    channel.start()
    const packet = encodeRpc(request(), limits)
    const first = result(channel.send(packet))
    expect(channel.diagnostics().queuedBytes).toBe(packet.length)
    expect((await result(channel.send(packet))).code).toBe('OVERLOADED')
    clock.advance(10)
    expect((await first).code).toBe('DISCONNECTED')
    expect(channel.diagnostics().queuedBytes).toBe(0)
    expect(left.subscriptions).toBe(0)
  })
  test('already-disconnected subscription settles without leaking listeners', async () => {
    const { left } = pair()
    left.dead = true
    const client = new RpcClient(schema, left)
    expect((await result(client.call('echo', 'x'))).code).toBe('DISCONNECTED')
    expect(left.subscriptions).toBe(0)
  })
  test('real MessageChannel carries typed requests, concurrent traffic and binary buffers', async () => {
    const env = await environment(),
      ports = new MessageChannel()
    const server = new RpcServer(
      schema,
      {
        echo: { capability: 'echo', handle: (s) => s },
        work: { capability: 'work', handle: (s) => s },
        bytes: { capability: 'bytes', handle: (b) => b },
      },
      env.lease(),
      rpcMessagePort(ports.port1)
    )
    const client = new RpcClient(schema, rpcMessagePort(ports.port2))
    cleanups.push(() => {
      client.close()
      server.close()
    })
    expect(
      await Promise.all(Array.from({ length: 20 }, (_, i) => client.call('echo', `item ${i}`)))
    ).toEqual(Array.from({ length: 20 }, (_, i) => `item ${i}`))
    const data = new Uint8Array([1, 2, 3])
    expect(await client.call('bytes', data)).toEqual(data)
    expect(data.length).toBe(3)
    client.close()
    expect((await server.closed).code).toBe('DISCONNECTED')
  })
  test('MessagePort send waits for acknowledgement instead of blindly queueing', async () => {
    const ports = new MessageChannel(),
      transport = rpcMessagePort(ports.port1)
    transport.subscribe(
      () => {},
      () => {}
    )
    cleanups.push(() => {
      transport.close()
      ports.port2.close()
    })
    let settled = false
    const first = transport.send(encodeRpc(request(), limits))!
    void Promise.resolve(first).then(
      () => {
        settled = true
      },
      () => {}
    )
    expect(
      (await result(Promise.resolve(transport.send(encodeRpc(request(2), limits))))).code
    ).toBe('OVERLOADED')
    await flush()
    expect(settled).toBe(false)
    const received = deferred<number>()
    ports.port2.onmessage = (event) => {
      received.resolve((event.data as { id: number }).id)
    }
    ports.port2.postMessage({ kind: 'ack', id: await received.promise })
    await first
    expect(settled).toBe(true)
  })
  test('unacknowledged MessagePort closes through the channel watchdog', async () => {
    const ports = new MessageChannel(),
      clock = new Clock()
    const client = new RpcClient(schema, rpcMessagePort(ports.port1), {
      scheduler: clock,
      limits: { sendTimeoutMs: 20 },
    })
    cleanups.push(() => {
      client.close()
      ports.port2.close()
    })
    const call = result(client.call('echo', 'x'))
    clock.advance(20)
    expect((await call).code).toBe('DISCONNECTED')
  })
})

describe('RPC adversarial lifecycle regressions', () => {
  test('actual view disposal aborts active work and clears authority records', async () => {
    const done = deferred<string>()
    const { client, backend, view, authority } = await setup({
      work: { capability: 'work', handle: () => done.promise },
    })
    const call = result(client.call('work', 'x'))
    await backend.disposeView(view)
    expect((await call).code).toBe('DISCONNECTED')
    expect(authority.diagnostics().documents).toBe(0)
    done.resolve('late')
  })
  test('capability arrays are copied and cannot mutate an existing grant', async () => {
    const env = await environment(),
      capabilities = ['echo']
    const lease = env.lease(capabilities)
    capabilities.push('admin')
    const guard = claimRpcAuthority(lease)
    expect(() => guard.check('echo')).not.toThrow()
    expect(() => guard.check('admin')).toThrow()
  })
  test('only the navigated view loses its independent connection', async () => {
    const a = await setup(),
      b = await setup()
    a.authority.revoke(a.view)
    expect(a.client.diagnostics().closed).toBe(true)
    expect(await b.client.call('echo', 'unaffected')).toBe('unaffected')
  })
  test('revoke-all cannot reissue a grant from an abort callback', async () => {
    const env = await environment(),
      guard = claimRpcAuthority(env.lease())
    let denied = false
    guard.signal.addEventListener('abort', () => {
      try {
        env.lease()
      } catch {
        denied = true
      }
    })
    env.authority.revokeAll()
    expect(denied).toBe(true)
    expect(env.authority.diagnostics().documents).toBe(0)
  })
  test('repeated shutdown is idempotent and releases listeners and timers', async () => {
    const { client, server, left, right, clock } = await setup()
    await client.call('echo', 'x')
    client.close()
    client.close()
    server.close()
    server.close()
    await flush()
    expect(left.subscriptions).toBe(0)
    expect(right.subscriptions).toBe(0)
    expect(clock.timers.size).toBe(0)
    expect(client.diagnostics()).toMatchObject({
      pending: 0,
      queuedBytes: 0,
      queuedFrames: 0,
      closed: true,
    })
  })
  test('denied capability is checked before the input parser', async () => {
    const env = await environment(),
      endpoints = pair()
    let parsed = false
    const contract = defineRpc({
      privileged: procedure((v) => {
        parsed = true
        return text(v)
      }, text),
    })
    const server = new RpcServer(
      contract,
      { privileged: { capability: 'admin', handle: (v) => v } },
      env.lease(['echo']),
      endpoints.right
    )
    cleanups.push(() => server.close())
    endpoints.right.message?.(
      encodeRpc({ type: 'request', id: 1, method: 'privileged', value: 'x', timeoutMs: 10 }, limits)
    )
    await flush()
    expect(parsed).toBe(false)
    const reply = decodeRpc(endpoints.right.packets[0]!, limits)
    expect(reply.type === 'error' && reply.code).toBe('FORBIDDEN')
  })
  test('host revocation during input validation prevents handler entry', async () => {
    const env = await environment(),
      endpoints = pair()
    let called = false
    const contract = defineRpc({
      echo: procedure((v) => {
        env.authority.revoke(env.view)
        return text(v)
      }, text),
    })
    const server = new RpcServer(
      contract,
      {
        echo: {
          capability: 'echo',
          handle: (v) => {
            called = true
            return v
          },
        },
      },
      env.lease(),
      endpoints.right
    )
    cleanups.push(() => server.close())
    endpoints.right.message?.(encodeRpc(request(), limits))
    expect(called).toBe(false)
    expect((await server.closed).code).toBe('REVOKED')
  })
  test('host revocation during output validation prevents result delivery', async () => {
    const env = await environment(),
      endpoints = pair()
    const contract = defineRpc({
      echo: procedure(text, (v) => {
        env.authority.revoke(env.view)
        return text(v)
      }),
    })
    const server = new RpcServer(
      contract,
      { echo: { capability: 'echo', handle: (v) => v } },
      env.lease(),
      endpoints.right
    )
    cleanups.push(() => server.close())
    endpoints.right.message?.(encodeRpc(request(), limits))
    await flush()
    expect(endpoints.right.packets).toHaveLength(0)
    expect((await server.closed).code).toBe('REVOKED')
  })
  test('server rejects unknown procedures with no runtime side effects', async () => {
    const { right } = await setup()
    right.message?.(encodeRpc({ ...request(), method: 'unknown' }, limits))
    await flush()
    const reply = decodeRpc(right.packets[0]!, limits)
    expect(reply.type === 'error' && reply.code).toBe('NOT_FOUND')
  })
  test('packet bytes, not just message count, cap a stalled queue', async () => {
    const endpoints = pair(),
      clock = new Clock()
    endpoints.left.stalled = true
    const small = rpcLimits({ maxFrameBytes: 1024, maxMetadataBytes: 256, maxQueuedBytes: 1024 })
    const channel = new RpcChannel(
      endpoints.left,
      small,
      clock,
      () => {},
      () => {}
    )
    channel.start()
    const packet = encodeRpc({ type: 'success', id: 1, value: new Uint8Array(600) }, small)
    const first = result(channel.send(packet))
    expect((await result(channel.send(packet))).code).toBe('OVERLOADED')
    expect(channel.diagnostics().queuedBytes).toBe(packet.length)
    channel.close()
    await first
  })
  test('queued expiry before send cannot invoke the handler or leak a timer', async () => {
    const gate = deferred<void>(),
      clock = new Clock(),
      endpoints = pair()
    let count = 0
    const original = endpoints.left.send.bind(endpoints.left)
    endpoints.left.send = (packet) => {
      count++
      original(packet)
      return count === 1 ? gate.promise : undefined
    }
    const client = new RpcClient(schema, endpoints.left, { scheduler: clock })
    cleanups.push(() => client.close())
    const a = result(client.call('echo', 'a', { timeoutMs: 100 }))
    const b = result(client.call('echo', 'b', { timeoutMs: 10 }))
    clock.advance(20, false)
    gate.resolve()
    await flush()
    expect((await b).code).toBe('DEADLINE_EXCEEDED')
    expect(count).toBe(1)
    client.close()
    await a
    expect(clock.timers.size).toBe(0)
  })
  test('async send rejection closes all waiters without an unhandled rejection', async () => {
    const { client, left } = await setup()
    left.send = () => Promise.reject(new Error('secret socket state'))
    const replies = await Promise.all([
      result(client.call('echo', 'a')),
      result(client.call('echo', 'b')),
    ])
    expect(replies.every((r) => r.code === 'DISCONNECTED')).toBe(true)
    expect(client.diagnostics().pending).toBe(0)
  })
  test('response queue exhaustion fails closed instead of leaving requests pending', async () => {
    const { client, right } = await setup({}, { limits: { maxQueuedFrames: 1 } })
    right.stalled = true
    const first = result(client.call('echo', 'first'))
    await flush()
    const second = result(client.call('echo', 'second'))
    expect((await Promise.all([first, second])).every((c) => c.code === 'DISCONNECTED')).toBe(true)
    expect(client.diagnostics().pending).toBe(0)
  })
  test('handler timeout remains a failure when a handler ignores abort', async () => {
    const done = deferred<string>()
    const { client, clock, server } = await setup({
      work: { capability: 'work', handle: () => done.promise },
    })
    const call = result(client.call('work', 'x', { timeoutMs: 10 }))
    clock.advance(10)
    expect((await call).code).toBe('DEADLINE_EXCEEDED')
    expect(server.diagnostics().executing).toBe(1)
    done.reject(new Error('late private exception'))
    await flush()
    expect(server.diagnostics().executing).toBe(0)
    expect(await client.call('echo', 'healthy')).toBe('healthy')
  })
  test('a malformed MessagePort control record fails closed', async () => {
    const ports = new MessageChannel(),
      ended = deferred<void>()
    const transport = rpcMessagePort(ports.port1)
    transport.subscribe(
      () => {
        throw new Error('should not deliver')
      },
      () => ended.resolve()
    )
    cleanups.push(() => {
      transport.close()
      ports.port2.close()
    })
    ports.port2.postMessage({ kind: 'ack', id: 77 })
    await ended.promise
    expect((await result(Promise.resolve(transport.send(encodeRpc(request(), limits))))).code).toBe(
      'DISCONNECTED'
    )
  })
  test('raw MessagePort close is detected in the Bun host', async () => {
    const ports = new MessageChannel(),
      client = new RpcClient(schema, rpcMessagePort(ports.port1))
    cleanups.push(() => client.close())
    const call = result(client.call('echo', 'x'))
    ports.port2.close()
    expect((await call).code).toBe('DISCONNECTED')
  })
})

describe('execution budgets survive connection replacement', () => {
  test('reconnecting cannot erase still-running cancelled handlers', async () => {
    const env = await environment()
    env.authority.dispose()
    const authority = new RpcViewAuthority(env.backend, ['app://ui'], {
      maxExecutions: 1,
      maxExecutionsPerView: 1,
    })
    cleanups.push(() => authority.dispose())
    const done = deferred<string>()
    let executions = 0
    const contract = defineRpc({ echo: procedure(text, text) })
    const issue = () =>
      authority.issue(
        env.view,
        { frameId: 'main', documentId: env.backend.state(env.view).documentId, mainFrame: true },
        ['echo']
      )
    const make = () => {
      const endpoints = pair()
      const server = new RpcServer(
        contract,
        {
          echo: {
            capability: 'echo',
            handle: () => {
              executions++
              return done.promise
            },
          },
        },
        issue(),
        endpoints.right
      )
      const client = new RpcClient(contract, endpoints.left)
      cleanups.push(() => {
        client.close()
        server.close()
      })
      return client
    }
    const first = make()
    const old = result(first.call('echo', 'old'))
    const second = make()
    expect((await old).code).toBe('DISCONNECTED')
    expect((await result(second.call('echo', 'new'))).code).toBe('OVERLOADED')
    expect(executions).toBe(1)
    expect(authority.diagnostics().executing).toBe(1)
    done.resolve('finished')
    await flush()
    expect(authority.diagnostics().executing).toBe(0)
    expect(await second.call('echo', 'now allowed')).toBe('finished')
    expect(executions).toBe(2)
  })
  test('shared reservation release is idempotent, even after authority disposal', async () => {
    const env = await environment(),
      guard = claimRpcAuthority(env.lease())
    const release = guard.acquire()
    expect(env.authority.diagnostics().executing).toBe(1)
    env.authority.dispose()
    release()
    release()
    expect(env.authority.diagnostics().executing).toBe(0)
    expect(() => guard.acquire()).toThrow()
  })
})

describe('RPC final boundary review', () => {
  for (const source of ['clock', 'backend'] as const) {
    test(`server stops before output serialization when ${source} reentrantly cancels`, async () => {
      const env = await environment()
      const { right } = pair()
      const clock = new Clock()
      let serialized = 0
      const output = new Proxy(
        { ok: true },
        {
          getPrototypeOf(target) {
            serialized++
            return Reflect.getPrototypeOf(target)
          },
        }
      )
      const contract = defineRpc({
        echo: procedure(text, () => {
          const cancel = () => right.message?.(encodeRpc({ type: 'cancel', id: 1 }, limits))
          if (source === 'clock') {
            const now = clock.now.bind(clock)
            clock.now = () => {
              clock.now = now
              cancel()
              return now()
            }
          } else {
            const original = env.backend.state.bind(env.backend)
            const spy = spyOn(env.backend, 'state').mockImplementation((view) => {
              spy.mockRestore()
              const state = original(view)
              cancel()
              return state
            })
            cleanups.push(() => spy.mockRestore())
          }
          return output
        }),
      })
      const server = new RpcServer(
        contract,
        { echo: { capability: 'echo', handle: () => output } },
        env.lease(),
        right,
        { scheduler: clock }
      )
      right.message?.(
        encodeRpc({ type: 'request', id: 1, method: 'echo', timeoutMs: 1000, value: 'x' }, limits)
      )
      await flush()
      expect(serialized).toBe(0)
      expect(right.packets.map((p) => decodeRpc(p, limits))).toEqual([
        expect.objectContaining({ type: 'error', id: 1, code: 'CANCELLED' }),
      ])
      expect(server.diagnostics().executing).toBe(0)
      expect(env.authority.diagnostics().executing).toBe(0)
      expect(clock.timers.size).toBe(0)
      server.close()
    })
  }
  for (const action of ['cancel', 'close', 'throw'] as const) {
    test(`client output parser ${action} cannot settle success or retain its call`, async () => {
      const { left } = pair()
      const clock = new Clock()
      const controller = new AbortController()
      const contract = defineRpc({
        echo: procedure(text, (value: unknown) => {
          if (action === 'cancel') controller.abort()
          if (action === 'close') client.close()
          if (action === 'throw') throw new Error('private parser failure')
          return text(value)
        }),
      })
      const client = new RpcClient(contract, left, { scheduler: clock })
      const call = result(client.call('echo', 'x', { signal: controller.signal }))
      left.message?.(encodeRpc({ type: 'success', id: 1, value: 'x' }, limits))
      expect((await call).code).toBe(
        action === 'cancel' ? 'CANCELLED' : action === 'close' ? 'DISCONNECTED' : 'PROTOCOL_ERROR'
      )
      await flush()
      expect(client.diagnostics().pending).toBe(0)
      client.close()
      expect(clock.timers.size).toBe(0)
    })
  }
  for (const action of ['nested', 'close', 'revoke', 'throw'] as const) {
    test(`initial backend authority callback ${action} preserves admission`, async () => {
      const env = await environment()
      const { right } = pair()
      const clock = new Clock()
      let parsed = 0,
        handled = 0
      const contract = defineRpc({
        echo: procedure((value: unknown) => {
          parsed++
          return text(value)
        }, text),
      })
      const server = new RpcServer(
        contract,
        {
          echo: {
            capability: 'echo',
            handle: () => {
              handled++
              return 'done'
            },
          },
        },
        env.lease(),
        right,
        { scheduler: clock, limits: { maxHandlers: 1 } }
      )
      const original = env.backend.state.bind(env.backend)
      const spy = spyOn(env.backend, 'state').mockImplementation((view) => {
        spy.mockRestore()
        const state = original(view)
        if (action === 'nested')
          right.message?.(
            encodeRpc(
              { type: 'request', id: 2, method: 'echo', timeoutMs: 1000, value: 'nested' },
              limits
            )
          )
        if (action === 'close') server.close()
        if (action === 'revoke') env.authority.revoke(env.view)
        if (action === 'throw') throw new Error('private backend detail')
        return state
      })
      cleanups.push(() => spy.mockRestore())
      right.message?.(
        encodeRpc({ type: 'request', id: 1, method: 'echo', timeoutMs: 1000, value: 'x' }, limits)
      )
      await flush()
      const packets = right.packets.map((packet) => decodeRpc(packet, limits))
      if (action === 'nested') {
        expect(parsed).toBe(1)
        expect(handled).toBe(1)
        expect(packets).toHaveLength(2)
        expect(packets).toContainEqual(
          expect.objectContaining({ type: 'error', id: 2, code: 'OVERLOADED' })
        )
        expect(packets).toContainEqual(expect.objectContaining({ type: 'success', id: 1 }))
      } else {
        expect(parsed).toBe(0)
        expect(handled).toBe(0)
        expect(packets).toHaveLength(action === 'throw' ? 1 : 0)
        if (action === 'throw')
          expect(packets[0]).toMatchObject({ type: 'error', id: 1, code: 'REVOKED' })
      }
      expect(server.diagnostics().executing).toBe(0)
      expect(env.authority.diagnostics().executing).toBe(0)
      expect(clock.timers.size).toBe(0)
      server.close()
    })
  }
  for (const action of ['cancel', 'close', 'revoke', 'throw'] as const) {
    test(`server output parser ${action} settles at most once and releases work`, async () => {
      const env = await environment()
      const { right } = pair()
      const clock = new Clock()
      const contract = defineRpc({
        echo: procedure(text, (value: unknown) => {
          if (action === 'cancel') right.message?.(encodeRpc({ type: 'cancel', id: 1 }, limits))
          if (action === 'close') server.close()
          if (action === 'revoke') env.authority.revoke(env.view)
          if (action === 'throw') throw new Error('private parser detail')
          return text(value)
        }),
      })
      const server = new RpcServer(
        contract,
        { echo: { capability: 'echo', handle: () => 'done' } },
        env.lease(),
        right,
        { scheduler: clock }
      )
      right.message?.(
        encodeRpc({ type: 'request', id: 1, method: 'echo', timeoutMs: 1000, value: 'x' }, limits)
      )
      await flush()
      const packets = right.packets.map((p) => decodeRpc(p, limits))
      expect(packets).toHaveLength(action === 'cancel' || action === 'throw' ? 1 : 0)
      if (action === 'cancel' || action === 'throw')
        expect(packets[0]).toMatchObject({
          type: 'error',
          id: 1,
          code: action === 'cancel' ? 'CANCELLED' : 'INTERNAL',
        })
      expect(server.diagnostics().executing).toBe(0)
      expect(env.authority.diagnostics().executing).toBe(0)
      expect(clock.timers.size).toBe(0)
      server.close()
    })
  }
  test('server retains cancellation during initial backend authority check', async () => {
    const env = await environment()
    const { right } = pair()
    let parsed = 0,
      handled = 0
    const contract = defineRpc({
      echo: procedure((v: unknown) => {
        parsed++
        return text(v)
      }, text),
    })
    const server = new RpcServer(
      contract,
      {
        echo: {
          capability: 'echo',
          handle: () => {
            handled++
            return 'done'
          },
        },
      },
      env.lease(),
      right
    )
    const original = env.backend.state.bind(env.backend)
    const spy = spyOn(env.backend, 'state').mockImplementation((view) => {
      spy.mockRestore()
      const state = original(view)
      right.message?.(encodeRpc({ type: 'cancel', id: 1 }, limits))
      return state
    })
    cleanups.push(() => spy.mockRestore())
    right.message?.(
      encodeRpc({ type: 'request', id: 1, method: 'echo', timeoutMs: 1000, value: 'x' }, limits)
    )
    await flush()
    expect(parsed).toBe(0)
    expect(handled).toBe(0)
    expect(right.packets.map((p) => decodeRpc(p, limits))).toEqual([
      expect.objectContaining({ type: 'error', code: 'CANCELLED', id: 1 }),
    ])
    expect(server.diagnostics().executing).toBe(0)
    expect(env.authority.diagnostics().executing).toBe(0)
    server.close()
  })
  for (const action of ['cancel', 'close'] as const) {
    test(`client stops before output parsing when response clock reenters with ${action}`, async () => {
      const { left } = pair()
      const clock = new Clock()
      const controller = new AbortController()
      let parsed = 0
      const contract = defineRpc({
        echo: procedure(text, (v: unknown) => {
          parsed++
          return text(v)
        }),
      })
      const client = new RpcClient(contract, left, { scheduler: clock })
      const call = result(client.call('echo', 'x', { signal: controller.signal }))
      const now = clock.now.bind(clock)
      clock.now = () => {
        clock.now = now
        if (action === 'cancel') controller.abort()
        else client.close()
        return now()
      }
      left.message?.(encodeRpc({ type: 'success', id: 1, value: 'x' }, limits))
      expect((await call).code).toBe(action === 'cancel' ? 'CANCELLED' : 'DISCONNECTED')
      expect(parsed).toBe(0)
      expect(client.diagnostics().pending).toBe(0)
      client.close()
      await flush()
      expect(clock.timers.size).toBe(0)
    })
  }
  for (const source of ['clock', 'backend', 'backend-session'] as const) {
    for (const action of ['cancel', 'close', 'revoke'] as const) {
      test(`server stops before output parsing when ${source} reenters with ${action}`, async () => {
        const env = await environment()
        const { right } = pair()
        const clock = new Clock()
        let parsed = 0
        const contract = defineRpc({
          echo: procedure(text, (value: unknown) => {
            parsed++
            return text(value)
          }),
        })
        const trigger = () => {
          if (action === 'cancel') right.message?.(encodeRpc({ type: 'cancel', id: 1 }, limits))
          if (action === 'close') server.close()
          if (action === 'revoke') env.authority.revoke(env.view)
        }
        const server = new RpcServer(
          contract,
          {
            echo: {
              capability: 'echo',
              handle: () => {
                if (source === 'clock') {
                  const now = clock.now.bind(clock)
                  clock.now = () => {
                    clock.now = now
                    trigger()
                    return now()
                  }
                } else if (source === 'backend') {
                  const original = env.backend.state.bind(env.backend)
                  const spy = spyOn(env.backend, 'state').mockImplementation((view) => {
                    spy.mockRestore()
                    const state = original(view)
                    trigger()
                    return state
                  })
                  cleanups.push(() => spy.mockRestore())
                } else {
                  const original = env.backend.session.bind(env.backend)
                  const spy = spyOn(env.backend, 'session').mockImplementation((view) => {
                    spy.mockRestore()
                    const session = original(view)
                    trigger()
                    return session
                  })
                  cleanups.push(() => spy.mockRestore())
                }
                return 'done'
              },
            },
          },
          env.lease(),
          right,
          { scheduler: clock }
        )
        right.message?.(
          encodeRpc({ type: 'request', id: 1, method: 'echo', timeoutMs: 1000, value: 'x' }, limits)
        )
        await flush()
        expect(parsed).toBe(0)
        const packets = right.packets.map((packet) => decodeRpc(packet, limits))
        expect(packets).toHaveLength(action === 'cancel' ? 1 : 0)
        if (action === 'cancel')
          expect(packets[0]).toMatchObject({ type: 'error', code: 'CANCELLED', id: 1 })
        expect(server.diagnostics().executing).toBe(0)
        expect(env.authority.diagnostics().executing).toBe(0)
        expect(clock.timers.size).toBe(0)
        server.close()
      })
    }
  }
  for (const action of [
    'cancel',
    'close',
    'revoke',
    'deadline',
    'scheduler-cancel',
    'none',
  ] as const) {
    test(`server output serialization observes reentrant ${action} before success`, async () => {
      const env = await environment()
      const { right } = pair()
      const clock = new Clock()
      const observations: import('../packages/runtime/src/rpc.ts').RpcDiagnostic[] = []
      let invoked = false
      const output = new Proxy(
        { ok: true },
        {
          getPrototypeOf(target) {
            if (!invoked) {
              invoked = true
              if (action === 'cancel') right.message?.(encodeRpc({ type: 'cancel', id: 1 }, limits))
              if (action === 'close') server.close()
              if (action === 'revoke') env.authority.revoke(env.view)
              if (action === 'deadline') clock.advance(1000, false)
              if (action === 'scheduler-cancel') {
                const now = clock.now.bind(clock)
                clock.now = () => {
                  clock.now = now
                  right.message?.(encodeRpc({ type: 'cancel', id: 1 }, limits))
                  return now()
                }
              }
            }
            return Reflect.getPrototypeOf(target)
          },
        }
      )
      const contract = defineRpc({ echo: procedure(text, (v: unknown) => v) })
      const server = new RpcServer(
        contract,
        { echo: { capability: 'echo', handle: () => output } },
        env.lease(),
        right,
        { scheduler: clock, onDiagnostic: (event) => observations.push(event) }
      )
      right.message?.(
        encodeRpc({ type: 'request', id: 1, method: 'echo', timeoutMs: 1000, value: 'x' }, limits)
      )
      await flush()
      const packets = right.packets.map((packet) => decodeRpc(packet, limits))
      if (action === 'cancel' || action === 'scheduler-cancel' || action === 'deadline') {
        expect(packets).toHaveLength(1)
        expect(packets[0]).toMatchObject({
          type: 'error',
          id: 1,
          code: action === 'deadline' ? 'DEADLINE_EXCEEDED' : 'CANCELLED',
        })
      } else if (action === 'none') {
        expect(packets).toHaveLength(1)
        expect(packets[0]).toMatchObject({ type: 'success', id: 1, value: { ok: true } })
      } else expect(packets).toHaveLength(0)
      expect(observations.find((event) => event.stage === 'settled')?.outcome).toBe(
        action === 'cancel' || action === 'scheduler-cancel'
          ? 'cancelled'
          : action === 'deadline'
            ? 'deadline'
            : action === 'none'
              ? 'success'
              : 'disconnected'
      )
      expect(server.diagnostics().executing).toBe(0)
      expect(env.authority.diagnostics().executing).toBe(0)
      expect(clock.timers.size).toBe(0)
      server.close()
    })
  }
  test('client output parsing cannot return success after the monotonic deadline', async () => {
    const clock = new Clock(),
      endpoints = pair()
    const contract = defineRpc({
      echo: procedure(text, (value) => {
        clock.advance(30, false)
        return text(value)
      }),
    })
    const client = new RpcClient(contract, endpoints.left, { scheduler: clock })
    cleanups.push(() => client.close())
    const pending = result(client.call('echo', 'x', { timeoutMs: 20 }))
    endpoints.left.message?.(encodeRpc({ type: 'success', id: 1, value: 'x' }, limits))
    expect((await pending).code).toBe('DEADLINE_EXCEEDED')
    await flush()
    expect(client.diagnostics().pending).toBe(0)
    expect(clock.timers.size).toBe(0)
  })
  test('single-view revocation cannot issue a new grant from an abort callback', async () => {
    const env = await environment(),
      guard = claimRpcAuthority(env.lease())
    let rejected = false
    guard.signal.addEventListener('abort', () => {
      try {
        env.lease()
      } catch {
        rejected = true
      }
    })
    env.authority.revoke(env.view)
    expect(rejected).toBe(true)
    expect(env.authority.diagnostics().documents).toBe(0)
    expect(() => claimRpcAuthority(env.lease())).not.toThrow()
  })
  test('replacement cannot grant authority after the old abort listener destroys its view', async () => {
    const env = await environment(),
      guard = claimRpcAuthority(env.lease())
    let disposal: Promise<void> | undefined
    guard.signal.addEventListener('abort', () => {
      disposal = env.backend.disposeView(env.view)
    })
    expect(() => env.lease()).toThrow()
    await disposal
    expect(env.authority.diagnostics().documents).toBe(0)
  })
  test('replacement cannot grant authority after the old abort listener disposes the manager', async () => {
    const env = await environment(),
      guard = claimRpcAuthority(env.lease())
    guard.signal.addEventListener('abort', () => env.authority.dispose())
    expect(() => env.lease()).toThrow()
    expect(env.authority.diagnostics().documents).toBe(0)
  })
  test('MessagePort only transfers the selected slice and not unrelated backing bytes', async () => {
    const ports = new MessageChannel(),
      transport = rpcMessagePort(ports.port1)
    cleanups.push(() => {
      transport.close()
      ports.port2.close()
    })
    transport.subscribe(
      () => {},
      () => {}
    )
    const observed = deferred<Uint8Array>()
    ports.port2.addEventListener('message', (event: MessageEvent) => {
      if (event.data.kind === 'packet') {
        observed.resolve(event.data.packet)
        ports.port2.postMessage({ kind: 'ack', id: event.data.id })
      }
    })
    ports.port2.start()
    const source = new Uint8Array([99, 1, 2, 88])
    const sent = transport.send(source.subarray(1, 3))
    const received = await observed.promise
    await sent
    expect(Array.from(received)).toEqual([1, 2])
    expect(received.buffer.byteLength).toBe(2)
    expect(Array.from(source)).toEqual([99, 1, 2, 88])
  })
})

describe('authority teardown reentrancy', () => {
  test('disposing during one view abort also revokes every other view immediately', async () => {
    const env = await environment()
    const other = await env.backend.createView({
      window: env.window,
      session: env.session,
      url: 'app://ui/other.html',
      trust: { kind: 'application', origin: 'app://ui' },
    })
    const first = claimRpcAuthority(env.lease())
    const second = claimRpcAuthority(
      env.authority.issue(
        other,
        { frameId: 'other-main', mainFrame: true, documentId: env.backend.state(other).documentId },
        ['echo']
      )
    )
    first.signal.addEventListener('abort', () => env.authority.dispose())
    env.authority.revoke(env.view)
    expect(first.signal.aborted).toBe(true)
    expect(second.signal.aborted).toBe(true)
    expect(env.authority.diagnostics().documents).toBe(0)
    expect(env.authority.diagnostics().disposed).toBe(true)
  })
})

describe('notification-driven RPC quiescence', () => {
  test('idle timer installation can reenter and shares the reserved waiter', async () => {
    const work = deferred<string>()
    const { client, server, clock } = await setup({
      work: { capability: 'work', handle: () => work.promise },
    })
    const call = client.call('work', 'x')
    await flush()
    const set = clock.set.bind(clock)
    let inner: Promise<void> | undefined
    clock.set = (delay, callback) => {
      inner = server.whenIdle()
      return set(delay, callback)
    }
    const outer = server.whenIdle()
    expect(inner).toBe(outer)
    work.resolve('done')
    await call
    await outer
    expect(clock.timers.size).toBe(0)
  })
  for (const failure of ['now', 'set', 'close'] as const) {
    test(`idle waiter settles when scheduler ${failure} interrupts installation`, async () => {
      const work = deferred<string>()
      const { client, server, clock } = await setup({
        work: { capability: 'work', handle: () => work.promise },
      })
      const call = result(client.call('work', 'x'))
      await flush()
      if (failure === 'now')
        clock.now = () => {
          throw new Error('scheduler')
        }
      if (failure === 'set')
        clock.set = () => {
          throw new Error('scheduler')
        }
      if (failure === 'close') {
        const set = clock.set.bind(clock)
        clock.set = (delay, callback) => {
          server.close()
          return set(delay, callback)
        }
      }
      const idle = result(server.whenIdle())
      expect((await idle).code).toBe(failure === 'close' ? 'DISCONNECTED' : 'INTERNAL')
      work.resolve('done')
      await call
      await flush()
      expect(server.diagnostics().executing).toBe(0)
      expect(clock.timers.size).toBe(0)
    })
  }
  test('reentrant scheduler calls share an idle waiter and release its timer', async () => {
    const work = deferred<string>()
    const { client, server, clock } = await setup({
      work: { capability: 'work', handle: () => work.promise },
    })
    const call = client.call('work', 'x')
    await flush()
    const now = clock.now.bind(clock)
    let inner: Promise<void> | undefined
    let entered = false
    clock.now = () => {
      if (!entered) {
        entered = true
        inner = server.whenIdle()
      }
      return now()
    }
    const outer = server.whenIdle()
    let settled = false
    void inner!.then(() => {
      settled = true
    })
    work.resolve('done')
    await call
    await outer
    await flush()
    expect(settled).toBe(true)
    expect(clock.timers.size).toBe(0)
  })
  test('handler/client completion cannot replace the actual adapter reply receipt', async () => {
    const f = await setup(),
      held = deferred<void>()
    const original = f.right.send.bind(f.right)
    f.right.send = (packet) => {
      original(packet)
      return held.promise
    }
    const value = f.client.call('echo', 'final-reply')
    expect(await value).toBe('final-reply')
    expect(f.server.diagnostics().executing).toBe(0)
    expect(f.server.diagnostics().queuedBytes).toBeGreaterThan(0)
    const first = f.server.whenIdle(),
      second = f.server.whenIdle()
    expect(first).toBe(second)
    let settled = false
    void first.then(() => {
      settled = true
    })
    await flush()
    expect(settled).toBe(false)
    held.resolve()
    await first
    expect(f.server.diagnostics().queuedBytes).toBe(0)
    expect(f.server.diagnostics().queuedFrames).toBe(0)
  })
  test('unsettled handlers retain ownership after a bounded idle waiter times out', async () => {
    const held = deferred<string>()
    const f = await setup(
      { work: { capability: 'work', handle: () => held.promise } },
      { limits: { sendTimeoutMs: 10 } }
    )
    const call = result(f.client.call('work', 'held'))
    await flush() // The request handoff must finish before advancing an independent idle deadline.
    const idle = result(f.server.whenIdle())
    f.clock.advance(10)
    expect((await idle).code).toBe('DEADLINE_EXCEEDED')
    expect(f.server.diagnostics().executing).toBe(1)
    expect(f.server.diagnostics().closed).toBe(false)
    held.resolve('done')
    expect((await call).value).toBe('done')
    await f.server.whenIdle()
    expect(f.clock.timers.size).toBe(0)
  })
  test('revocation cannot report successful idle or leave a waiter timer alive', async () => {
    const held = deferred<string>()
    const f = await setup({ work: { capability: 'work', handle: () => held.promise } })
    const call = result(f.client.call('work', 'held'))
    const idle = result(f.server.whenIdle())
    f.authority.revoke(f.view)
    expect((await idle).code).toBe('REVOKED')
    expect((await call).code).toBeDefined()
    held.resolve('late')
    await flush()
    expect(f.clock.timers.size).toBe(0)
    expect((await result(f.server.whenIdle())).code).toBe('DISCONNECTED')
  })
})

test('a delayed idle timer cannot turn late reply completion into successful quiescence', async () => {
  const f = await setup({}, { limits: { sendTimeoutMs: 10 } }),
    held = deferred<void>()
  const original = f.right.send.bind(f.right)
  f.right.send = (packet) => {
    original(packet)
    return held.promise
  }
  expect(await f.client.call('echo', 'delayed')).toBe('delayed')
  const idle = result(f.server.whenIdle())
  f.clock.advance(11, false)
  held.resolve()
  expect((await idle).code).toBe('DEADLINE_EXCEEDED')
  expect(f.server.diagnostics().queuedBytes).toBe(0)
  expect(f.clock.timers.size).toBe(0)
})

test('RPC diagnostic callbacks observe actual cancellation settlement without request data and cannot disrupt ownership', async () => {
  const done = deferred<string>()
  const events: import('../packages/runtime/src/rpc.ts').RpcDiagnostic[] = []
  const { client, server } = await setup(
    { work: { capability: 'work', handle: () => done.promise } },
    {
      onDiagnostic: async (event) => {
        events.push(event)
        throw new Error('observer failure')
      },
    }
  )
  const controller = new AbortController()
  const pending = result(client.call('work', 'private payload', { signal: controller.signal }))
  await flush()
  controller.abort()
  await flush()
  expect((await pending).code).toBe('CANCELLED')
  expect(server.diagnostics().cancelledExecuting).toBe(1)
  expect(events.map((event) => event.stage)).toEqual(['started'])
  done.resolve('late secret')
  await flush()
  expect(server.diagnostics().executing).toBe(0)
  expect(events.map(({ stage, outcome }) => [stage, outcome])).toEqual([
    ['started', 'pending'],
    ['settled', 'cancelled'],
  ])
  expect(JSON.stringify(events)).not.toContain('private')
  expect(JSON.stringify(events)).not.toContain('secret')
})

test('a throwing settled-diagnostic clock cannot reject detached handler work', async () => {
  const failures: unknown[] = []
  const unhandled = (error: unknown) => {
    failures.push(error)
  }
  process.on('unhandledRejection', unhandled)
  try {
    const clock = new Clock()
    let completionReads = 0
    const env = await environment()
    const { right } = pair()
    const contract = defineRpc({ echo: procedure(text, text) })
    const server = new RpcServer(
      contract,
      {
        echo: {
          capability: 'echo',
          handle: () => {
            const now = clock.now.bind(clock)
            clock.now = () => {
              if (++completionReads === 5) throw new Error('diagnostic clock')
              return now()
            }
            return 'done'
          },
        },
      },
      env.lease(),
      right,
      { scheduler: clock, onDiagnostic: () => {} }
    )
    right.message?.(
      encodeRpc({ type: 'request', id: 1, method: 'echo', timeoutMs: 1000, value: 'x' }, limits)
    )
    await Bun.sleep(10)
    expect(completionReads).toBe(5)
    expect(failures).toHaveLength(0)
    expect(server.diagnostics().executing).toBe(0)
    server.close()
  } finally {
    process.removeListener('unhandledRejection', unhandled)
  }
})

test('a throwing started-diagnostic clock does not suppress the handler', async () => {
  const env = await environment()
  const { right } = pair()
  const clock = new Clock()
  const now = clock.now.bind(clock)
  let reads = 0,
    calls = 0
  clock.now = () => {
    if (++reads === 4) throw new Error('diagnostic clock')
    return now()
  }
  const contract = defineRpc({ echo: procedure(text, text) })
  const server = new RpcServer(
    contract,
    {
      echo: {
        capability: 'echo',
        handle: () => {
          calls++
          return 'done'
        },
      },
    },
    env.lease(),
    right,
    { scheduler: clock, onDiagnostic: () => {} }
  )
  right.message?.(
    encodeRpc({ type: 'request', id: 1, method: 'echo', timeoutMs: 1000, value: 'x' }, limits)
  )
  await flush()
  expect(calls).toBe(1)
  expect(right.packets.map((p) => decodeRpc(p, limits))).toEqual([
    expect.objectContaining({ type: 'success', id: 1 }),
  ])
  expect(server.diagnostics().executing).toBe(0)
  expect(env.authority.diagnostics().executing).toBe(0)
  expect(clock.timers.size).toBe(0)
  server.close()
})

test('a reentrant diagnostic observer can close the server without releasing an unsettled handler', async () => {
  const done = deferred<string>()
  let close: () => void = () => {}
  const { client, server } = await setup(
    { work: { capability: 'work', handle: () => done.promise } },
    {
      onDiagnostic: (event) => {
        if (event.stage === 'started') close()
      },
    }
  )
  close = () => server.close()
  const pending = result(client.call('work', 'x'))
  await flush()
  expect((await pending).code).toBe('DISCONNECTED')
  expect(server.diagnostics().cancelledExecuting).toBe(1)
  done.resolve('late')
  await flush()
  expect(server.diagnostics().executing).toBe(0)
})

test('a diagnostic observer can revoke authority without releasing an unsettled handler', async () => {
  const done = deferred<string>()
  let revoke = () => {}
  const { client, server, authority, view } = await setup(
    { work: { capability: 'work', handle: () => done.promise } },
    {
      onDiagnostic: (event) => {
        if (event.stage === 'started') revoke()
      },
    }
  )
  revoke = () => authority.revoke(view)
  const call = result(client.call('work', 'x'))
  await flush()
  expect((await call).code).toBe('DISCONNECTED')
  expect(server.diagnostics().cancelledExecuting).toBe(1)
  expect(authority.diagnostics().executing).toBe(1)
  done.resolve('late')
  await flush()
  expect(server.diagnostics().executing).toBe(0)
  expect(authority.diagnostics().executing).toBe(0)
})
