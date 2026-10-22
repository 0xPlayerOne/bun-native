import { RpcError, DEFAULT_RPC_LIMITS } from '../../contracts/src/rpc.ts'
import type { RpcTransport } from '../../contracts/src/rpc.ts'
type Port = Pick<
  MessagePort,
  'postMessage' | 'addEventListener' | 'removeEventListener' | 'start' | 'close'
>
/**
 * A privately provisioned MessagePort, not an origin or identity check. One packet
 * is in flight until receiver acknowledgement, so postMessage isn't mistaken for
 * backpressure. RPC's drain watchdog bounds a peer that never acknowledges.
 */
export function rpcMessagePort(
  port: Port,
  maxFrameBytes = DEFAULT_RPC_LIMITS.maxFrameBytes
): RpcTransport {
  if (
    !Number.isSafeInteger(maxFrameBytes) ||
    maxFrameBytes < 512 ||
    maxFrameBytes > 16 * 1024 * 1024
  )
    throw new TypeError('Invalid MessagePort packet limit')
  let subscribed = false,
    ended = false,
    sent = 0,
    received = 0
  let notify: (() => void) | undefined
  let detach: (() => void) | undefined
  let pending: { id: number; resolve: () => void; reject: (reason: RpcError) => void } | undefined
  function end(tellPeer: boolean): void {
    if (ended) return
    ended = true
    const request = pending
    pending = undefined
    request?.reject(new RpcError('DISCONNECTED', 'RPC MessagePort closed'))
    if (tellPeer) {
      try {
        port.postMessage({ kind: 'close' })
      } catch {
        /* Remote endpoint may be gone. */
      }
    }
    detach?.()
    port.close()
    notify?.()
  }
  return {
    send(packet) {
      if (ended) return Promise.reject(new RpcError('DISCONNECTED', 'RPC MessagePort closed'))
      if (pending)
        return Promise.reject(
          new RpcError('OVERLOADED', 'RPC MessagePort already has an in-flight packet')
        )
      if (
        sent >= Number.MAX_SAFE_INTEGER ||
        !(packet instanceof Uint8Array) ||
        !(packet.buffer instanceof ArrayBuffer) ||
        packet.byteLength > maxFrameBytes
      ) {
        return Promise.reject(new RpcError('PROTOCOL_ERROR', 'Invalid RPC MessagePort packet'))
      }
      const id = ++sent
      return new Promise<void>((resolve, reject) => {
        pending = { id, resolve, reject }
        // Never transfer bytes outside a sliced view (for example a pooled Buffer).
        const owned =
          packet.byteOffset === 0 && packet.byteLength === packet.buffer.byteLength
            ? packet
            : new Uint8Array(packet)
        try {
          port.postMessage({ kind: 'packet', id, packet: owned }, [owned.buffer])
        } catch {
          end(true)
        }
      })
    },
    subscribe(message, closed) {
      if (subscribed) throw new TypeError('RPC MessagePort permits one subscriber')
      subscribed = true
      notify = closed
      if (ended) {
        closed()
        return () => {}
      }
      const onMessage = (event: MessageEvent<unknown>) => {
        if (ended) return
        const value = event.data
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
          end(true)
          return
        }
        const data = value as Record<string, unknown>
        const fields = Object.keys(data)
        if (data['kind'] === 'close' && fields.length === 1) {
          end(false)
          return
        }
        if (
          data['kind'] === 'ack' &&
          fields.length === 2 &&
          Number.isSafeInteger(data['id']) &&
          data['id'] === pending?.id
        ) {
          const request = pending!
          pending = undefined
          request.resolve()
          return
        }
        if (
          data['kind'] !== 'packet' ||
          fields.length !== 3 ||
          !Number.isSafeInteger(data['id']) ||
          data['id'] !== received + 1 ||
          !(data['packet'] instanceof Uint8Array) ||
          !(data['packet'].buffer instanceof ArrayBuffer) ||
          data['packet'].byteOffset !== 0 ||
          data['packet'].byteLength !== data['packet'].buffer.byteLength ||
          data['packet'].byteLength > maxFrameBytes
        ) {
          end(true)
          return
        }
        received++
        try {
          message(data['packet'])
          if (!ended) port.postMessage({ kind: 'ack', id: received })
        } catch {
          end(true)
        }
      }
      const broken = () => end(true)
      port.addEventListener('message', onMessage as EventListener)
      port.addEventListener('messageerror', broken)
      // Node/Bun emit close; browsers rely on our explicit close record or deadlines.
      port.addEventListener('close', broken)
      detach = () => {
        port.removeEventListener('message', onMessage as EventListener)
        port.removeEventListener('messageerror', broken)
        port.removeEventListener('close', broken)
      }
      port.start()
      return () => {
        detach?.()
        notify = undefined
      }
    },
    close() {
      end(true)
    },
  }
}
