import { RpcError } from '../../contracts/src/rpc.ts'
import type { RpcTransport } from '../../contracts/src/rpc.ts'

const MAX_NATIVE_RPC_PACKET = 24 * 1024
const READY_EVENT = 'bunly:rpc-ready'
interface NativeBridge {
  send(packet: ArrayBuffer, acknowledged: (accepted: boolean) => void): void
  subscribe(receive: (packet?: ArrayBuffer) => boolean): void
  close(): void
}

/** Native functions authenticate their invocation context; this JS adapter grants no authority. */
export function cefRpcTransport(): RpcTransport {
  const bridge = (globalThis as typeof globalThis & { __bunlyRpc?: NativeBridge }).__bunlyRpc
  if (
    !bridge ||
    typeof bridge.send !== 'function' ||
    typeof bridge.subscribe !== 'function' ||
    typeof bridge.close !== 'function'
  )
    throw new RpcError('FORBIDDEN', 'Native RPC bridge is unavailable in this document')
  let ended = false
  let notify: (() => void) | undefined
  let subscribed = false
  let pending: { resolve(): void; reject(error: Error): void } | undefined
  function end(tellNative: boolean): void {
    if (ended) return
    ended = true
    const sending = pending
    pending = undefined
    sending?.reject(new RpcError('DISCONNECTED', 'Native RPC bridge closed'))
    const callback = notify
    notify = undefined
    if (tellNative) {
      try {
        bridge!.close()
      } catch {
        /* Context may already be released. */
      }
    }
    callback?.()
  }
  return {
    send(packet) {
      if (ended) return Promise.reject(new RpcError('DISCONNECTED', 'Native RPC bridge closed'))
      if (pending)
        return Promise.reject(new RpcError('OVERLOADED', 'Native RPC send already pending'))
      if (
        !(packet instanceof Uint8Array) ||
        packet.byteLength < 1 ||
        packet.byteLength > MAX_NATIVE_RPC_PACKET
      )
        return Promise.reject(new RpcError('PROTOCOL_ERROR', 'Native RPC packet size denied'))
      const owned = new Uint8Array(packet).buffer
      return new Promise<void>((resolve, reject) => {
        const sending = { resolve, reject }
        pending = sending
        try {
          bridge.send(owned, (accepted) => {
            if (pending !== sending) return
            pending = undefined
            if (accepted === true && !ended) resolve()
            else {
              reject(new RpcError('DISCONNECTED', 'Native RPC packet delivery failed'))
              end(false)
            }
          })
        } catch {
          end(true)
        }
      })
    },
    subscribe(message, closed) {
      if (subscribed) throw new TypeError('Native RPC bridge permits one subscriber')
      subscribed = true
      if (ended) {
        closed()
        return () => {}
      }
      notify = closed
      try {
        bridge.subscribe((buffer) => {
          if (ended) return false
          if (
            !(buffer instanceof ArrayBuffer) ||
            buffer.byteLength < 1 ||
            buffer.byteLength > MAX_NATIVE_RPC_PACKET
          ) {
            end(false)
            return false
          }
          try {
            message(new Uint8Array(buffer.slice(0)))
            return !ended
          } catch {
            end(true)
            return false
          }
        })
      } catch (error) {
        end(true)
        throw error
      }
      return () => {
        notify = undefined
        end(true)
      }
    },
    close() {
      end(true)
    },
  }
}

/** One listener and one deadline; a ready event is only a hint to inspect the bridge. */
export function waitForCefRpcTransport(
  timeoutMs = 5000,
  signal?: AbortSignal
): Promise<RpcTransport> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000)
    return Promise.reject(new TypeError('Invalid native RPC bridge deadline'))
  return new Promise((resolve, reject) => {
    let ended = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const cleanup = () => {
      ended = true
      if (timer !== undefined) clearTimeout(timer)
      globalThis.removeEventListener(READY_EVENT, ready)
      signal?.removeEventListener('abort', abort)
    }
    const abort = () => {
      if (ended) return
      cleanup()
      reject(signal?.reason ?? new RpcError('CANCELLED', 'Native RPC wait cancelled'))
    }
    const ready = () => {
      if (ended) return
      try {
        const transport = cefRpcTransport()
        cleanup()
        resolve(transport)
      } catch (error) {
        if (!(error instanceof RpcError) || error.code !== 'FORBIDDEN') {
          cleanup()
          reject(error)
        }
      }
    }
    globalThis.addEventListener(READY_EVENT, ready)
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) {
      abort()
      return
    }
    timer = setTimeout(() => {
      if (ended) return
      cleanup()
      reject(new RpcError('DEADLINE_EXCEEDED', 'Native RPC bridge readiness deadline'))
    }, timeoutMs)
    ready()
  })
}
