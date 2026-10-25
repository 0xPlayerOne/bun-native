import type { RpcTransport } from '../../contracts/src/rpc.ts'
import { StreamError } from '../../contracts/src/stream-wire.ts'

const MAX_NATIVE_STREAM_PACKET = 24 * 1024
const READY_EVENT = 'bunly:streams-ready'
const typedArray = Object.getPrototypeOf(Uint8Array.prototype)
const intrinsicLength = Object.getOwnPropertyDescriptor(typedArray, 'byteLength')!.get!
const intrinsicOffset = Object.getOwnPropertyDescriptor(typedArray, 'byteOffset')!.get!
const intrinsicBuffer = Object.getOwnPropertyDescriptor(typedArray, 'buffer')!.get!
const arrayBufferLength = Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength')!.get!

/** Bound native slots before allocating, not producer-overridable properties. */
function snapshotPacket(input: Uint8Array): ArrayBuffer {
  try {
    if (!(input instanceof Uint8Array)) throw new TypeError()
    const length = intrinsicLength.call(input) as number
    const offset = intrinsicOffset.call(input) as number
    const buffer = intrinsicBuffer.call(input) as ArrayBuffer
    const capacity = arrayBufferLength.call(buffer) as number
    if (length < 1 || length > MAX_NATIVE_STREAM_PACKET || offset + length > capacity)
      throw new TypeError()
    return new Uint8Array(new Uint8Array(buffer, offset, length)).buffer
  } catch {
    throw new StreamError('PROTOCOL_ERROR', 'Native stream packet size or ownership denied')
  }
}
function receivedPacket(input: ArrayBuffer): Uint8Array<ArrayBuffer> {
  const size = arrayBufferLength.call(input) as number
  if (size < 1 || size > MAX_NATIVE_STREAM_PACKET) throw new TypeError()
  return new Uint8Array(new Uint8Array(input))
}
interface NativeStreamBridge {
  send(packet: ArrayBuffer, acknowledged: (accepted: boolean) => void): void
  subscribe(receive: (packet?: ArrayBuffer) => boolean): void
  close(): void
}

/** Native closures authenticate the actual current and entered V8 context. */
export function cefStreamTransport(): RpcTransport {
  const bridge = (globalThis as typeof globalThis & { __bunlyStreams?: NativeStreamBridge })
    .__bunlyStreams
  if (
    !bridge ||
    typeof bridge.send !== 'function' ||
    typeof bridge.subscribe !== 'function' ||
    typeof bridge.close !== 'function'
  )
    throw new StreamError('FORBIDDEN', 'Native stream bridge is unavailable in this document')
  let ended = false
  let subscribed = false
  let notify: (() => void) | undefined
  let pending: { resolve(): void; reject(error: Error): void } | undefined
  const end = (tellNative: boolean): void => {
    if (ended) return
    ended = true
    const sending = pending
    pending = undefined
    sending?.reject(new StreamError('DISCONNECTED', 'Native stream bridge closed'))
    const closed = notify
    notify = undefined
    if (tellNative) {
      try {
        bridge.close()
      } catch {
        // The owning V8 context may already be gone.
      }
    }
    closed?.()
  }
  return {
    send(packet) {
      if (ended)
        return Promise.reject(new StreamError('DISCONNECTED', 'Native stream bridge closed'))
      if (pending)
        return Promise.reject(new StreamError('OVERLOADED', 'Native stream send already pending'))
      let owned: ArrayBuffer
      try {
        owned = snapshotPacket(packet)
      } catch (error) {
        return Promise.reject(error)
      }
      return new Promise<void>((resolve, reject) => {
        const sending = { resolve, reject }
        pending = sending
        try {
          bridge.send(owned, (accepted) => {
            if (pending !== sending) return
            pending = undefined
            if (accepted === true && !ended) resolve()
            else {
              reject(new StreamError('DISCONNECTED', 'Native stream packet delivery failed'))
              end(false)
            }
          })
        } catch {
          end(true)
        }
      })
    },
    subscribe(message, closed) {
      if (subscribed) throw new TypeError('Native stream bridge permits one subscriber')
      subscribed = true
      if (ended) {
        closed()
        return () => {}
      }
      notify = closed
      try {
        bridge.subscribe((buffer) => {
          if (ended) return false
          try {
            if (!(buffer instanceof ArrayBuffer)) throw new TypeError()
            message(receivedPacket(buffer))
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

/** A readiness event carries no identity; it only prompts bridge reinspection. */
export function waitForCefStreamTransport(
  timeoutMs = 5000,
  signal?: AbortSignal
): Promise<RpcTransport> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000)
    return Promise.reject(new TypeError('Invalid native stream bridge deadline'))
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
      reject(signal?.reason ?? new StreamError('CANCELLED', 'Native stream wait cancelled'))
    }
    const ready = () => {
      if (ended) return
      try {
        const transport = cefStreamTransport()
        cleanup()
        resolve(transport)
      } catch (error) {
        if (!(error instanceof StreamError) || error.code !== 'FORBIDDEN') {
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
      reject(new StreamError('DEADLINE_EXCEEDED', 'Native stream bridge readiness deadline'))
    }, timeoutMs)
    ready()
  })
}
