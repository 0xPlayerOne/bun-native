import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { cpus, release } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import {
  RPC_TRANSPORT_WORKLOAD,
  type RpcTransportTrial,
} from '../benchmarks/rpc-transport-comparison.ts'
import { distribution, profileOptions } from '../benchmarks/foundation/statistics.ts'
import { RpcClient, RpcLoopbackTransport } from '../packages/client/src/index.ts'
import { defineRpc, procedure } from '../packages/contracts/src/index.ts'
import {
  MockBackend,
  RpcLoopbackServer,
  RpcServer,
  RpcViewAuthority,
  bindRpcAuthority,
} from '../packages/runtime/src/index.ts'

const structured = (value: unknown): Readonly<{ index: number; label: string }> => {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !Number.isSafeInteger((value as Record<string, unknown>)['index']) ||
    typeof (value as Record<string, unknown>)['label'] !== 'string'
  )
    throw new TypeError('Invalid structured fixture')
  const input = value as { index: number; label: string }
  return Object.freeze({ index: input.index, label: input.label })
}
const bytes = (value: unknown): Uint8Array => {
  if (!(value instanceof Uint8Array)) throw new TypeError('Invalid binary fixture')
  return value
}
const none = (value: unknown): null => {
  if (value !== null) throw new TypeError('Expected null')
  return null
}
const schema = defineRpc({
  structured: procedure(structured, structured),
  binary: procedure(bytes, bytes),
  cancel: procedure(none, none),
})

const root = resolve(import.meta.dir, '..')
const options = profileOptions(
  process.argv.slice(2),
  join(root, '.bunly', 'profiles', `rpc-loopback-${randomUUID()}.json`)
)
const output = resolve(options.output)
if (!output.startsWith(join(root, '.bunly') + '/'))
  throw new Error('Transport profiles must remain under private .bunly storage')

async function runTrial(trial: number): Promise<RpcTransportTrial> {
  const backend = new MockBackend()
  const session = await backend.createSession({
    partition: `transport-${trial}-${randomUUID()}`,
    persistence: 'ephemeral',
  })
  const window = await backend.createWindow({
    title: 'Transport profile',
    bounds: { x: 0, y: 0, width: 640, height: 480 },
  })
  const view = await backend.createView({
    window,
    session,
    url: 'app://ui/index.html',
    trust: { kind: 'application', origin: 'app://ui' },
  })
  const authority = new RpcViewAuthority(backend, ['app://ui'])
  let cancellationStarted: (() => void) | undefined
  let rpcServer!: RpcServer<typeof schema>
  let accepted!: () => void
  const connected = new Promise<void>((resolve) => {
    accepted = resolve
  })
  const listener = new RpcLoopbackServer({
    accept(lease, transport) {
      rpcServer = new RpcServer(
        schema,
        {
          structured: { capability: 'structured', handle: (value) => value },
          binary: { capability: 'binary', handle: (value) => value },
          cancel: {
            capability: 'cancel',
            handle: (_value, context) =>
              new Promise<null>((resolve) => {
                cancellationStarted?.()
                context.signal.addEventListener('abort', () => resolve(null), { once: true })
              }),
          },
        },
        lease,
        transport
      )
      accepted()
    },
  })
  const binding = bindRpcAuthority(
    authority.issue(
      view,
      {
        frameId: 'profile-main',
        documentId: backend.state(view).documentId,
        mainFrame: true,
      },
      ['structured', 'binary', 'cancel']
    ),
    session
  )
  const handoff = listener.provision(binding)
  const BunWebSocket = WebSocket as unknown as {
    new (url: string, options: Bun.WebSocketOptions): WebSocket
  }
  const link = new RpcLoopbackTransport({
    ...handoff,
    socket: (endpoint) =>
      new BunWebSocket(endpoint, {
        headers: { Origin: 'app://ui' },
        perMessageDeflate: false,
      }),
  })
  const client = new RpcClient(schema, link)
  try {
    const handoffStart = performance.now()
    const first = await client.call('structured', { index: 0, label: 'fixed-payload' })
    if (first.index !== 0) throw new Error('Structured handoff correctness failure')
    const handoffMs = performance.now() - handoffStart
    await connected

    const structuredStart = performance.now()
    for (
      let offset = 0;
      offset < RPC_TRANSPORT_WORKLOAD.structuredCalls;
      offset += RPC_TRANSPORT_WORKLOAD.structuredConcurrency
    ) {
      const count = Math.min(
        RPC_TRANSPORT_WORKLOAD.structuredConcurrency,
        RPC_TRANSPORT_WORKLOAD.structuredCalls - offset
      )
      const values = await Promise.all(
        Array.from({ length: count }, (_, index) =>
          client.call('structured', { index: offset + index, label: 'fixed-payload' })
        )
      )
      if (values.some((value, index) => value.index !== offset + index))
        throw new Error('Structured workload correctness failure')
    }
    const structuredMs = performance.now() - structuredStart

    const binaryFixture = new Uint8Array(RPC_TRANSPORT_WORKLOAD.binaryBytesPerCall)
    for (let index = 0; index < binaryFixture.length; index++) binaryFixture[index] = index & 0xff
    const binaryStart = performance.now()
    for (let index = 0; index < RPC_TRANSPORT_WORKLOAD.binaryCalls; index++) {
      const result = await client.call('binary', binaryFixture)
      if (result.length !== binaryFixture.length || result[1023] !== binaryFixture[1023])
        throw new Error('Binary workload correctness failure')
    }
    const binaryMs = performance.now() - binaryStart

    const cancellationStart = performance.now()
    for (let index = 0; index < RPC_TRANSPORT_WORKLOAD.cancellationCalls; index++) {
      const started = new Promise<void>((resolve) => {
        cancellationStarted = resolve
      })
      const controller = new AbortController()
      const call = client
        .call('cancel', null, { signal: controller.signal })
        .catch((error) => error)
      await started
      controller.abort()
      const result = await call
      if ((result as { code?: unknown })?.code !== 'CANCELLED')
        throw new Error('Cancellation workload correctness failure')
    }
    const cancellationMs = performance.now() - cancellationStart
    const clientQueue = client.diagnostics()
    const serverQueue = rpcServer.diagnostics()
    return {
      candidate: 'authenticated-loopback',
      trial,
      handoffMs,
      structuredMs,
      binaryMs,
      cancellationMs,
      queuePeaks: {
        clientFrames: clientQueue.peakQueuedFrames,
        clientBytes: clientQueue.peakQueuedBytes,
        serverFrames: serverQueue.peakQueuedFrames,
        serverBytes: serverQueue.peakQueuedBytes,
      },
    }
  } finally {
    client.close()
    rpcServer?.close()
    listener.close()
    authority.dispose()
    await backend.dispose()
  }
}

for (let warmup = 0; warmup < options.warmups; warmup++) await runTrial(-warmup - 1)
const trials: RpcTransportTrial[] = []
for (let trial = 0; trial < options.samples; trial++) trials.push(await runTrial(trial))
const paths = [
  'scripts/profile-rpc-loopback.ts',
  'benchmarks/rpc-transport-comparison.ts',
  'packages/client/src/rpc-loopback.ts',
  'packages/runtime/src/rpc-loopback.ts',
  'packages/contracts/src/rpc-websocket-wire.ts',
]
const sourceHashes = Object.fromEntries(
  await Promise.all(
    paths.map(async (path) => [
      path,
      createHash('sha256')
        .update(await readFile(join(root, path)))
        .digest('hex'),
    ])
  )
)
const metric = (
  name: keyof Pick<RpcTransportTrial, 'handoffMs' | 'structuredMs' | 'binaryMs' | 'cancellationMs'>
) => distribution(trials.map((trial) => trial[name]))
const result = {
  schema: 1,
  classification: 'candidate-only-rpc-transport-profile',
  comparable: false,
  winner: null,
  candidate: 'authenticated-loopback',
  environment: {
    bun: Bun.version,
    platform: process.platform,
    arch: process.arch,
    osRelease: release(),
    cpu: cpus()[0]?.model ?? 'unknown',
  },
  workload: RPC_TRANSPORT_WORKLOAD,
  samples: options.samples,
  warmups: options.warmups,
  rawTrials: trials,
  distributions: {
    handoffMs: metric('handoffMs'),
    structuredMs: metric('structuredMs'),
    binaryMs: metric('binaryMs'),
    cancellationMs: metric('cancellationMs'),
  },
  copyAccounting: {
    scope:
      'minimum explicit JavaScript copies per direction; native/CEF/WebSocket kernel copies unmeasured',
    stages: [
      'RPC encoder allocates the protocol packet',
      'RpcChannel snapshots the queued packet',
      'loopback adapter snapshots and wraps the packet in a binary record',
      'receiving loopback decoder isolates the record payload',
    ],
    zeroCopyClaim: false,
  },
  idleWakeups: {
    status: 'not-collected',
    reason:
      'This candidate profiler has no qualified kernel-counter provider. Windows unavailable is not zero.',
  },
  comparisonBlockers: [
    'Run the same workload through the integrated #19 native-mediated CEF transport in independent trials.',
    'Run actual CEF renderer throttling, navigation-start revocation and disconnect cases.',
    'Collect platform-qualified idle wakeups; do not substitute timers, CPU time or MessageChannel mocks.',
  ],
  sourceHashes,
}
await mkdir(dirname(output), { recursive: true, mode: 0o700 })
await writeFile(output, JSON.stringify(result, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
console.log(JSON.stringify({ comparable: false, winner: null, output }))
