import { BinaryStreamReceiver } from '../../packages/contracts/src/streams.ts'
import { StreamBudget } from '../../packages/contracts/src/stream-budget.ts'
import { waitForCefStreamTransport } from '../../packages/client/src/cef-streams.ts'
import { cefRpcClient } from './rpc-client.ts'

const chunks = new Map<string, Uint8Array[]>([
  ['alpha', []],
  ['beta', []],
])
const finished = new Set<string>()
let cancelled = false
let controlWhilePaused: string | undefined
let emitted = false
let rpcAfterLaneClose: string | undefined

async function sha256(parts: readonly Uint8Array[]): Promise<string> {
  const length = parts.reduce((total, part) => total + part.byteLength, 0)
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const part of parts) {
    bytes.set(part, offset)
    offset += part.byteLength
  }
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

async function emit(): Promise<void> {
  if (emitted || finished.size !== 2 || !cancelled || !rpcAfterLaneClose) return
  emitted = true
  const alpha = chunks.get('alpha')!
  const beta = chunks.get('beta')!
  console.log(
    'BUNLY_STREAM_EVIDENCE:' +
      JSON.stringify({
        schema: 1,
        alpha: {
          chunks: alpha.length,
          bytes: alpha.reduce((total, part) => total + part.byteLength, 0),
          sha256: await sha256(alpha),
        },
        beta: {
          chunks: beta.length,
          bytes: beta.reduce((total, part) => total + part.byteLength, 0),
          sha256: await sha256(beta),
        },
        controlWhileConsumerAckWithheld: controlWhilePaused,
        cancellation: 'consumer-aborted',
        rpcAfterLaneClose,
      })
  )
}

const receiver = new BinaryStreamReceiver(
  await waitForCefStreamTransport(),
  { budget: new StreamBudget(), owner: Object.freeze({ nativeDocument: true }) },
  {
    alpha: {
      async consume(chunk) {
        if (chunks.get('alpha')!.length === 0)
          controlWhilePaused = await cefRpcClient.call('echo', 'stream-paused')
        chunks.get('alpha')!.push(chunk.slice())
      },
      finish() {
        finished.add('alpha')
        void emit()
      },
    },
    beta: {
      consume(chunk) {
        chunks.get('beta')!.push(chunk.slice())
      },
      finish() {
        finished.add('beta')
        void emit()
      },
    },
    retire: {
      consume() {
        // Reentrant lane closure during a native delivery must not close RPC.
        receiver.close()
        void (async () => {
          rpcAfterLaneClose = await cefRpcClient.call('echo', 'stream-lane-closed')
          await emit()
        })().catch(() => console.error('BUNLY_STREAM_LANE_CLOSE_FAILED'))
      },
    },
    cancel: {
      consume(_chunk, context) {
        return new Promise<void>((_resolve, reject) => {
          const abort = () => {
            cancelled = true
            reject(context.signal.reason)
            void emit()
          }
          context.signal.addEventListener('abort', abort, { once: true })
          if (context.signal.aborted) abort()
        })
      },
    },
  }
)
void receiver.closed.catch(() => {})
