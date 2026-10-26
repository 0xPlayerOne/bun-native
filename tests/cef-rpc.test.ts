import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { defineRpc, procedure, rpcLimits } from '../packages/contracts/src/rpc.ts'
import { decodeRpc, encodeRpc } from '../packages/contracts/src/rpc-wire.ts'
import { CefBackend } from '../packages/runtime/src/cef.ts'
import { nativePeer, turn, type Command } from './helpers/native-peer.ts'

const text = (value: unknown) => {
  if (typeof value !== 'string') throw new TypeError('Expected string')
  return value
}
const binary = (value: unknown) => {
  if (!(value instanceof Uint8Array)) throw new TypeError('Expected bytes')
  return value
}
const schema = defineRpc({ echo: procedure(text, text), binary: procedure(binary, binary) })
const limits = rpcLimits({ maxFrameBytes: 24 * 1024, maxMetadataBytes: 16 * 1024 })

async function fixture(
  handlers = {
    echo: { capability: 'rpc.echo', handle: async (value: string) => `native:${value}` },
    binary: { capability: 'rpc.binary', handle: async (value: Uint8Array) => value },
  },
  connect = true
) {
  const peer = await nativePeer()
  let next = 0
  peer.handle((command) => {
    if (command.op === 'rpc.deliver') peer.reply(command)
    else {
      peer.reply(command, command.op.endsWith('.create') ? { id: ++next } : null)
      if (command.op === 'quit') peer.send({ v: 1, event: 'shutdown' })
    }
  })
  const backend = new CefBackend(peer.transport)
  backend.serveRpc(schema, handlers, ['app://ui'], ['rpc.echo', 'rpc.binary'])
  const session = await backend.createSession({ partition: 'rpc', persistence: 'ephemeral' })
  const window = await backend.createWindow({
    title: 'rpc',
    bounds: { x: 0, y: 0, width: 640, height: 480 },
  })
  const view = await backend.createView({
    window,
    session,
    url: 'app://ui/index.html',
    trust: { kind: 'application', origin: 'app://ui' },
  })
  if (connect)
    peer.send({
      v: 1,
      event: 'rpc.connected',
      target: 3,
      data: {
        connection: 4,
        context: 1,
        frameId: 'native-main',
        documentId: 'native-3-1',
        generation: 1,
        origin: 'app://ui',
      },
    })
  await turn()
  return { ...peer, backend, view, window }
}

function packetEvent(packet: Uint8Array, sequence: number) {
  return {
    v: 1,
    event: 'rpc.packet',
    target: 3,
    data: {
      connection: 4,
      context: 1,
      generation: 1,
      sequence,
      packet: Buffer.from(packet).toString('hex'),
      copiedBytes: packet.byteLength,
    },
  }
}

function delivered(commands: Command[]): Command {
  const command = [...commands].reverse().find((candidate) => candidate.op === 'rpc.deliver')
  assert.ok(command)
  return command
}

test('native-mediated RPC performs typed JSON and top-level binary roundtrips', async () => {
  const f = await fixture()
  try {
    f.send({
      v: 1,
      event: 'view.loaded',
      target: 3,
      data: { url: 'app://ui/index.html', documentId: 'native-3-1' },
    })
    await turn()
    assert.equal(
      f.commands.some((command) => command.op === 'rpc.disconnect'),
      false,
      'Initial load completion must not revoke an already-subscribed document'
    )
    f.send(
      packetEvent(
        encodeRpc(
          { type: 'request', id: 1, method: 'echo', timeoutMs: 1000, value: 'cef' },
          limits
        ),
        1
      )
    )
    await turn()
    await turn()
    const jsonReply = decodeRpc(
      Uint8Array.fromHex(String(delivered(f.commands).args['packet'])),
      limits
    )
    assert.deepEqual(jsonReply, { type: 'success', id: 1, value: 'native:cef' })
    assert.ok(
      f.commands.some((command) => command.op === 'rpc.ack' && command.args['sequence'] === 1)
    )

    const bytes = new Uint8Array([0, 1, 2, 127, 128, 255])
    f.send(
      packetEvent(
        encodeRpc(
          { type: 'request', id: 2, method: 'binary', timeoutMs: 1000, value: bytes },
          limits
        ),
        2
      )
    )
    await turn()
    await turn()
    const binaryReply = decodeRpc(
      Uint8Array.fromHex(String(delivered(f.commands).args['packet'])),
      limits
    )
    assert.equal(binaryReply.type, 'success')
    assert.deepEqual(binaryReply.value, bytes)
  } finally {
    await f.backend.dispose()
  }
})

test('navigation revokes before a stale in-flight result can enter the renderer queue', async () => {
  let finish!: (value: string) => void
  const pending = new Promise<string>((resolve) => {
    finish = resolve
  })
  const f = await fixture({
    echo: { capability: 'rpc.echo', handle: () => pending },
    binary: { capability: 'rpc.binary', handle: async (value: Uint8Array) => value },
  })
  try {
    f.send(
      packetEvent(
        encodeRpc(
          { type: 'request', id: 1, method: 'echo', timeoutMs: 1000, value: 'late' },
          limits
        ),
        1
      )
    )
    await turn()
    f.send({
      v: 1,
      event: 'view.navigating',
      target: 3,
      data: { url: 'app://ui/next.html', documentId: 'native-3-2' },
    })
    await turn()
    finish('stale')
    await turn()
    await turn()
    assert.equal(f.commands.filter((command) => command.op === 'rpc.deliver').length, 0)
    assert.ok(f.commands.some((command) => command.op === 'rpc.disconnect'))
    assert.equal(f.backend.state(f.view).trust.kind, 'remote')
  } finally {
    await f.backend.dispose()
  }
})

test('closing a view aborts in-flight native RPC and suppresses its stale result', async () => {
  let finish!: (value: string) => void
  const pending = new Promise<string>((resolve) => {
    finish = resolve
  })
  const f = await fixture({
    echo: { capability: 'rpc.echo', handle: () => pending },
    binary: { capability: 'rpc.binary', handle: async (value: Uint8Array) => value },
  })
  try {
    f.send(
      packetEvent(
        encodeRpc(
          { type: 'request', id: 1, method: 'echo', timeoutMs: 1000, value: 'late' },
          limits
        ),
        1
      )
    )
    await turn()
    await f.backend.disposeView(f.view)
    finish('stale')
    await turn()
    await turn()
    assert.equal(f.commands.filter((command) => command.op === 'rpc.deliver').length, 0)
    assert.ok(f.commands.some((command) => command.op === 'rpc.disconnect'))
    assert.equal(f.backend.diagnostics().views, 0)
  } finally {
    await f.backend.dispose()
  }
})

test('forged native document identity fails closed before a server is constructed', async () => {
  const f = await fixture()
  try {
    f.send({
      v: 1,
      event: 'rpc.connected',
      target: 3,
      data: {
        connection: 5,
        context: 2,
        frameId: 'borrowed-child',
        documentId: 'page-supplied',
        generation: 99,
        origin: 'app://ui',
      },
    })
    await assert.rejects(f.backend.closed, /authority|valid/i)
    assert.equal(f.backend.diagnostics().views, 0)
  } finally {
    await f.backend.dispose().catch(() => {})
  }
})

for (const action of ['navigate', 'view-close', 'window-close'] as const) {
  test(`a delayed native handshake cannot restore authority during ${action}`, async () => {
    let invoked = 0
    const f = await fixture(
      {
        echo: {
          capability: 'rpc.echo',
          handle: async (value: string) => {
            invoked++
            return value
          },
        },
        binary: { capability: 'rpc.binary', handle: async (value: Uint8Array) => value },
      },
      false
    )
    let held: Command | undefined
    f.handle((command) => {
      if (['view.navigate', 'view.dispose', 'window.close'].includes(command.op)) held = command
      else {
        f.reply(command)
        if (command.op === 'quit') f.send({ v: 1, event: 'shutdown' })
      }
    })
    const pending =
      action === 'navigate'
        ? f.backend.navigate(f.view, 'app://ui/next.html')
        : action === 'view-close'
          ? f.backend.disposeView(f.view)
          : f.backend.closeWindow(f.window)
    void pending.catch(() => {})
    try {
      await turn()
      assert.ok(held)
      f.send({
        v: 1,
        event: 'rpc.connected',
        target: 3,
        data: {
          connection: 4,
          context: 1,
          frameId: 'native-main',
          documentId: 'native-3-1',
          generation: 1,
          origin: 'app://ui',
        },
      })
      f.send(
        packetEvent(
          encodeRpc(
            { type: 'request', id: 1, method: 'echo', timeoutMs: 1000, value: 'late' },
            limits
          ),
          1
        )
      )
      await turn()
      await turn()
      assert.equal(
        invoked,
        0,
        'A handshake queued before retirement must not create a new live lease'
      )
      assert.equal(
        f.transport.diagnostics().closed,
        false,
        'A legitimate late handshake is not a host failure'
      )
      assert.ok(f.commands.some((command) => command.op === 'rpc.disconnect'))
    } finally {
      if (held) f.reply(held)
      await pending.catch(() => {})
      await f.backend.dispose().catch(() => {})
    }
  })
}

test('a delayed handshake during host shutdown cannot fail or resurrect the service', async () => {
  const f = await fixture(undefined, false)
  let quit: Command | undefined
  f.handle((command) => {
    if (command.op === 'quit') quit = command
    else f.reply(command)
  })
  const closing = f.backend.dispose()
  void closing.catch(() => {})
  try {
    await turn()
    assert.ok(quit)
    f.send({
      v: 1,
      event: 'rpc.connected',
      target: 3,
      data: {
        connection: 4,
        context: 1,
        frameId: 'native-main',
        documentId: 'native-3-1',
        generation: 1,
        origin: 'app://ui',
      },
    })
    await turn()
    assert.equal(f.transport.diagnostics().closed, false)
    assert.equal(f.transport.failure, null)
  } finally {
    if (quit) f.reply(quit)
    f.send({ v: 1, event: 'shutdown' })
    await closing
  }
})

test('native RPC drain waits for delivery acknowledgment and cannot revive a retired view', async () => {
  for (const revoke of [false, true]) {
    const f = await fixture()
    try {
      f.handle((command) => {
        if (command.op !== 'rpc.deliver') f.reply(command)
      })
      f.send(
        packetEvent(
          encodeRpc(
            { type: 'request', id: 1, method: 'echo', timeoutMs: 1000, value: 'held' },
            limits
          ),
          1
        )
      )
      await turn()
      await turn()
      const delivery = delivered(f.commands)
      let settled = false
      const drain = f.backend.drainRpc(f.view)
      void drain.then(
        () => {
          settled = true
        },
        () => {}
      )
      await turn()
      assert.equal(settled, false)
      if (revoke) {
        const rejected = assert.rejects(drain, /revoked|changed|closed|unavailable/i)
        f.send({
          v: 1,
          event: 'view.navigating',
          target: 3,
          data: { url: 'app://ui/next.html', documentId: 'native-3-2' },
        })
        await rejected
        f.reply(delivery)
      } else {
        f.reply(delivery)
        await drain
      }
    } finally {
      await f.stop()
    }
  }
})
test('native RPC drain rejects forged and unbound handles without sending commands', async () => {
  const f = await fixture(undefined, false)
  try {
    const count = f.commands.length
    await assert.rejects(f.backend.drainRpc({ ...f.view }), /handle|foreign|unknown/i)
    await assert.rejects(f.backend.drainRpc(f.view), /unavailable/i)
    assert.equal(f.commands.length, count)
  } finally {
    await f.stop()
  }
})
