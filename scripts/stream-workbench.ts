/** Headless correctness fixture: real MessageChannels, mock view, no CEF/PTY or performance claim. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { MockBackend, RpcServer, RpcViewAuthority } from '../packages/runtime/src/index.ts'
import {
  RpcClient,
  rpcMessagePort,
  BinaryStreamReceiver,
  BinaryStreamSender,
  StreamBudget,
} from '../packages/client/src/index.ts'
import { defineRpc, procedure } from '../packages/contracts/src/index.ts'
const backend = new MockBackend()
const session = await backend.createSession({ partition: 'streams', persistence: 'ephemeral' })
const window = await backend.createWindow({
  title: 'Stream workbench',
  bounds: { x: 0, y: 0, width: 800, height: 600 },
})
const view = await backend.createView({
  window,
  session,
  url: 'app://ui/index.html',
  trust: { kind: 'application', origin: 'app://ui' },
})
const authority = new RpcViewAuthority(backend, ['app://ui'])
const schema = defineRpc({
  echo: procedure(
    (v: unknown) => {
      if (typeof v !== 'string') throw new Error('string required')
      return v
    },
    (v: unknown) => {
      if (typeof v !== 'string') throw new Error('string required')
      return v
    }
  ),
})
const control = new MessageChannel(),
  bulk = new MessageChannel()
const server = new RpcServer(
  schema,
  { echo: { capability: 'echo', handle: (v) => v } },
  authority.issue(
    view,
    { mainFrame: true, frameId: 'mock-main', documentId: backend.state(view).documentId },
    ['echo']
  ),
  rpcMessagePort(control.port1)
)
const client = new RpcClient(schema, rpcMessagePort(control.port2))
const lifetime = new AbortController()
const deadline = setTimeout(() => lifetime.abort(), 10_000)
let release!: () => void, started!: () => void
const held = new Promise<void>((r) => {
    release = r
  }),
  entered = new Promise<void>((r) => {
    started = r
  })
let received = 0
const actual = createHash('sha256'),
  expected = createHash('sha256')
const receiverBudget = new StreamBudget(),
  senderBudget = new StreamBudget()
const receiver = new BinaryStreamReceiver(
  rpcMessagePort(bulk.port1),
  { budget: receiverBudget, owner: view, signal: lifetime.signal },
  {
    fixture: {
      async consume(bytes, context) {
        if (!received) {
          started()
          await held
        }
        if (context.signal.aborted) throw new Error('Cancelled fixture')
        actual.update(bytes)
        received += bytes.length
      },
    },
  }
)
const sender = new BinaryStreamSender(rpcMessagePort(bulk.port2), {
  budget: senderBudget,
  owner: view,
  signal: lifetime.signal,
})
try {
  const stream = await sender.open('fixture')
  const block = new Uint8Array(16 * 1024).map((_, i) => i % 251)
  let complete = false
  const first = stream.write(block).then(() => {
    complete = true
  })
  await Promise.race([
    entered,
    first.then(() => {
      throw new Error('Write completed before consumption')
    }),
  ])
  assert.equal(
    await client.call('echo', 'control remains usable', { timeoutMs: 1000 }),
    'control remains usable'
  )
  assert.equal(complete, false)
  assert.equal(received, 0)
  const reservedWhilePaused = receiverBudget.diagnostics().reservedBytes
  release()
  await first
  expected.update(block)
  for (let i = 1; i < 64; i++) {
    expected.update(block)
    await stream.write(block)
  }
  await stream.end()
  assert.deepEqual(await stream.finished, { ok: true })
  const sha256 = actual.digest('hex')
  assert.equal(sha256, expected.digest('hex'))
  assert.equal(received, 1024 * 1024)
  console.log(
    JSON.stringify({
      event: 'bunly.stream.workbench',
      passed: true,
      receivedBytes: received,
      sha256,
      controlDuringPausedConsumer: true,
      reservedWhilePaused,
      scope: 'Headless MessageChannel fixture; not native/PTY/rendering throughput',
    })
  )
} finally {
  clearTimeout(deadline)
  release()
  sender.close()
  receiver.close()
  client.close()
  server.close()
  authority.dispose()
  await backend.dispose()
}
