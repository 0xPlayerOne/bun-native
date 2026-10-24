import { RpcError, type RpcTransport } from '../../contracts/src/rpc.ts'
import {
  decodeNativeLoopbackHandoff,
  encodeNativeLoopbackConfirmation,
} from '../../contracts/src/rpc-native-handoff.ts'
import { NATIVE_RPC_MESSAGE_BYTES } from '../../contracts/src/rpc-fragments.ts'
import { waitForCefRpcTransport } from './cef-rpc.ts'
import { RpcLoopbackTransport } from './rpc-loopback.ts'

/** The native bridge remains alive to prove socket ownership and receive
 * revocation. Neither the endpoint nor credential is read from URLs/storage.
 */
export async function waitForCefLoopbackTransport(
  timeoutMs = 5000,
  signal?: AbortSignal
): Promise<RpcTransport> {
  const started = performance.now()
  const native = await waitForCefRpcTransport(timeoutMs, signal)
  return new Promise((resolve, reject) => {
    let ended = false,
      off: () => void = () => {},
      link: RpcLoopbackTransport | undefined,
      notify: (() => void) | undefined
    let handedOff = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const fail = (reason: unknown) => {
      if (ended) return
      ended = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      off()
      native.close()
      link?.close()
      if (!handedOff) reject(reason)
      const closed = notify
      notify = undefined
      closed?.()
    }
    const abort = () =>
      fail(signal?.reason ?? new RpcError('CANCELLED', 'Native loopback wait aborted'))
    const remaining = Math.max(1, timeoutMs - (performance.now() - started))
    timer = setTimeout(
      () => fail(new RpcError('DEADLINE_EXCEEDED', 'Native loopback handoff deadline')),
      remaining
    )
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) {
      abort()
      return
    }
    try {
      const remove = native.subscribe(
        (packet) => {
          if (ended) return
          try {
            if (link) throw new RpcError('PROTOCOL_ERROR', 'Duplicate native loopback handoff')
            const offer = decodeNativeLoopbackHandoff(packet)
            try {
              link = new RpcLoopbackTransport({
                ...offer,
                maxFrameBytes: NATIVE_RPC_MESSAGE_BYTES,
                connectTimeoutMs: Math.ceil(remaining),
                confirmNative: async (challenge) => {
                  if (ended) throw new RpcError('REVOKED', 'Native owner retired')
                  await native.send(encodeNativeLoopbackConfirmation(challenge))
                },
              })
            } finally {
              offer.credential.fill(0)
            }
            clearTimeout(timer)
            timer = undefined
            signal?.removeEventListener('abort', abort)
            handedOff = true
            resolve({
              send: (value) =>
                ended
                  ? Promise.reject(new RpcError('DISCONNECTED', 'Native loopback closed'))
                  : link!.send(value),
              subscribe(message, closed) {
                if (ended) {
                  closed()
                  return () => {}
                }
                notify = closed
                const unsubscribe = link!.subscribe(message, () =>
                  fail(new RpcError('DISCONNECTED', 'Loopback closed'))
                )
                return () => {
                  notify = undefined
                  unsubscribe()
                  fail(new RpcError('DISCONNECTED', 'Loopback unsubscribed'))
                }
              },
              close() {
                fail(new RpcError('DISCONNECTED', 'Loopback closed'))
              },
            })
          } catch (error) {
            fail(error)
          }
        },
        () => fail(new RpcError('REVOKED', 'Native document authority revoked'))
      )
      if (ended) remove()
      else off = remove
    } catch (error) {
      fail(error)
    }
  })
}
