import { RpcError, type RpcTransport } from './rpc.ts'

const MAGIC = 0x424c4652 // BLFR: an adapter record, not an application RPC envelope.
const HEADER = 16
export const NATIVE_RPC_CHUNK_BYTES = 24 * 1024
export const NATIVE_RPC_MESSAGE_BYTES = 96 * 1024

/** Shared by every server-side adapter in a backend, not renewed per reconnect. */
export class RpcFragmentBudget {
  #bytes = 0
  #peak = 0
  constructor(readonly maximum = 3 * 1024 * 1024) {
    if (
      !Number.isSafeInteger(maximum) ||
      maximum < NATIVE_RPC_MESSAGE_BYTES ||
      maximum > 256 * 1024 * 1024
    )
      throw new TypeError('Invalid fragment byte budget')
  }
  reserve(bytes: number): () => void {
    if (
      !Number.isSafeInteger(bytes) ||
      bytes < 1 ||
      bytes > NATIVE_RPC_MESSAGE_BYTES ||
      this.#bytes + bytes > this.maximum
    )
      throw new RpcError('OVERLOADED', 'Fragment byte budget exceeded')
    this.#bytes += bytes
    this.#peak = Math.max(this.#peak, this.#bytes)
    let active = true
    return () => {
      if (active) {
        active = false
        this.#bytes -= bytes
      }
    }
  }
  diagnostics() {
    return {
      retainedBytes: this.#bytes,
      peakRetainedBytes: this.#peak,
      maxRetainedBytes: this.maximum,
    }
  }
}

/** Transparent bounded fragmentation over the existing 24 KiB native transport.
 * Small packets retain their original encoding. Larger #18 envelopes retain the
 * exact application bytes while splitting only this adapter's framing. Native
 * pipe and process-message ceilings remain unchanged; this is not zero-copy.
 */
export function fragmentedRpcTransport(
  link: RpcTransport,
  budget = new RpcFragmentBudget()
): RpcTransport {
  let ended = false,
    subscribed = false,
    sent = 0,
    received = 0
  let remove: (() => void) | undefined
  let notify: (() => void) | undefined
  let outbound:
    | { bytes: Uint8Array | undefined; release: () => void; reject: (error: Error) => void }
    | undefined
  let incoming:
    | {
        bytes: Uint8Array
        offset: number
        sequence: number
        release: () => void
        timer: ReturnType<typeof setTimeout>
      }
    | undefined
  function stop(tellPeer: boolean) {
    if (ended) return
    ended = true
    if (incoming) {
      clearTimeout(incoming.timer)
      incoming.release()
      incoming = undefined
    }
    if (outbound) {
      outbound.bytes = undefined
      outbound.release()
      outbound.reject(new RpcError('DISCONNECTED', 'Fragment transport closed'))
      outbound = undefined
    }
    const off = remove
    remove = undefined
    off?.()
    if (tellPeer) link.close()
    const closed = notify
    notify = undefined
    closed?.()
  }
  return {
    send(packet) {
      if (ended) return Promise.reject(new RpcError('DISCONNECTED', 'Fragment transport closed'))
      if (outbound)
        return Promise.reject(new RpcError('OVERLOADED', 'Fragment packet already in flight'))
      if (
        !(packet instanceof Uint8Array) ||
        !(packet.buffer instanceof ArrayBuffer) ||
        packet.byteLength < 1 ||
        packet.byteLength > NATIVE_RPC_MESSAGE_BYTES
      )
        return Promise.reject(new RpcError('PROTOCOL_ERROR', 'Invalid fragmented message size'))
      let release: () => void
      try {
        release = budget.reserve(packet.byteLength)
      } catch (error) {
        return Promise.reject(error)
      }
      return new Promise<void>((resolve, reject) => {
        let owned: Uint8Array
        try {
          owned = new Uint8Array(packet)
        } catch (error) {
          release()
          reject(error)
          return
        }
        const pending = { bytes: owned as Uint8Array | undefined, release, reject }
        outbound = pending
        const large = owned.byteLength > NATIVE_RPC_CHUNK_BYTES
        if (large && sent >= 0xffffffff) {
          stop(true)
          return
        }
        const sequence = large ? ++sent : 0
        // Each handed-off chunk is an independent bounded copy; after logical
        // close, a stalled lower-level send cannot retain the entire envelope.
        void (async () => {
          let offset = 0
          const total = owned.byteLength
          // The pending owner is the sole retained reference to the full copy.
          // Clear this temporary reference before awaiting the lower layer.
          owned = new Uint8Array()
          while (offset < total) {
            if (ended || outbound !== pending || !pending.bytes)
              throw new RpcError('DISCONNECTED', 'Fragment message retired')
            // The full envelope is accessed only in a synchronous helper scope;
            // no local full-buffer reference survives the lower-layer await.
            const chunk = (() => {
              const bytes = pending.bytes!
              if (!large) {
                offset = total
                return new Uint8Array(bytes)
              }
              const length = Math.min(NATIVE_RPC_CHUNK_BYTES - HEADER, total - offset)
              const value = new Uint8Array(HEADER + length)
              const view = new DataView(value.buffer)
              view.setUint32(0, MAGIC)
              view.setUint32(4, sequence)
              view.setUint32(8, total)
              view.setUint32(12, offset)
              value.set(bytes.subarray(offset, offset + length), HEADER)
              offset += length
              return value
            })()
            await link.send(chunk)
          }
          if (ended || outbound !== pending)
            throw new RpcError('DISCONNECTED', 'Fragment transport closed')
          outbound = undefined
          pending.bytes = undefined
          release()
          resolve()
        })().catch((error) => {
          pending.bytes = undefined
          release()
          if (outbound === pending) outbound = undefined
          reject(error)
          stop(true)
        })
      })
    },
    subscribe(message, closed) {
      if (subscribed) throw new TypeError('Fragment transport permits one subscriber')
      subscribed = true
      notify = closed
      if (ended) {
        notify = undefined
        closed()
        return () => {}
      }
      const off = link.subscribe(
        (packet) => {
          if (ended) return
          try {
            if (
              !(packet instanceof Uint8Array) ||
              !(packet.buffer instanceof ArrayBuffer) ||
              packet.byteLength < 1 ||
              packet.byteLength > NATIVE_RPC_CHUNK_BYTES
            )
              throw new RpcError('PROTOCOL_ERROR', 'Invalid fragment size')
            const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength)
            if (packet.byteLength < 4 || view.getUint32(0) !== MAGIC) {
              if (incoming) throw new RpcError('PROTOCOL_ERROR', 'Unfinished fragmented message')
              message(packet)
              return
            }
            if (packet.byteLength <= HEADER)
              throw new RpcError('PROTOCOL_ERROR', 'Truncated fragment')
            const sequence = view.getUint32(4),
              total = view.getUint32(8),
              offset = view.getUint32(12),
              length = packet.byteLength - HEADER
            if (
              sequence !== received + 1 ||
              total <= NATIVE_RPC_CHUNK_BYTES ||
              total > NATIVE_RPC_MESSAGE_BYTES ||
              offset + length > total ||
              (offset + length < total && packet.byteLength !== NATIVE_RPC_CHUNK_BYTES)
            )
              throw new RpcError('PROTOCOL_ERROR', 'Invalid fragment metadata')
            if (!incoming) {
              if (offset !== 0) throw new RpcError('PROTOCOL_ERROR', 'Missing first fragment')
              const release = budget.reserve(total)
              try {
                incoming = {
                  bytes: new Uint8Array(total),
                  offset: 0,
                  sequence,
                  release,
                  timer: setTimeout(() => stop(true), 10000),
                }
              } catch (error) {
                release()
                throw error
              }
            }
            const current = incoming
            if (
              current.sequence !== sequence ||
              current.bytes.byteLength !== total ||
              current.offset !== offset
            )
              throw new RpcError('PROTOCOL_ERROR', 'Fragment sequence mismatch')
            current.bytes.set(packet.subarray(HEADER), offset)
            current.offset += length
            if (current.offset === total) {
              incoming = undefined
              clearTimeout(current.timer)
              received = sequence
              try {
                message(current.bytes)
              } finally {
                current.release()
              }
            }
          } catch (error) {
            stop(true)
            throw error
          }
        },
        () => stop(false)
      )
      if (ended) off()
      else remove = off
      return () => {
        notify = undefined
        stop(true)
      }
    },
    close() {
      stop(true)
    },
  }
}
