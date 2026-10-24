import type { CefBackend } from '../../packages/runtime/src/cef.ts'
import { cefRpcSchema } from './rpc-contract.ts'

/** Shared bounded service for the RPC-dependent packaged asset fixture. */
export function serveRpcFixture(backend: CefBackend) {
  const waits = new Map<string, { started: boolean; aborted: boolean; viewId: string }>()
  const stopRpc = backend.serveRpc(
    cefRpcSchema,
    {
      echo: { capability: 'rpc.echo', handle: (value) => `bun:${value}` },
      binary: { capability: 'rpc.binary', handle: (value) => value },
      wait: {
        capability: 'rpc.wait',
        handle: (value, context) => {
          if (waits.size >= 16 && !waits.has(value)) throw new Error('Fixture wait capacity')
          const state = { started: true, aborted: false, viewId: context.identity.viewId }
          waits.set(value, state)
          return new Promise<string>((resolve, reject) => {
            const timer = setTimeout(() => {
              context.signal.removeEventListener('abort', abort)
              resolve(value)
            }, 5000)
            const abort = () => {
              state.aborted = true
              clearTimeout(timer)
              if (value === 'cancel') reject(context.signal.reason)
              else queueMicrotask(() => resolve('stale-result-after-revocation'))
            }
            context.signal.addEventListener('abort', abort, { once: true })
            if (context.signal.aborted) abort()
          })
        },
      },
      waitStarted: {
        capability: 'rpc.wait',
        handle: (value) => (waits.get(value)?.started ? 'started' : 'missing'),
      },
      waitAborted: {
        capability: 'rpc.wait',
        handle: (value) => (waits.get(value)?.aborted ? 'aborted' : 'missing'),
      },
    },
    ['app://ui'],
    ['rpc.echo', 'rpc.binary', 'rpc.wait'],
    { limits: { maxFrameBytes: 24 * 1024, maxMetadataBytes: 16 * 1024 } }
  )
  return Object.freeze({ waits, stopRpc })
}
