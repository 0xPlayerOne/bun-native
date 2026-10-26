import { RpcError, type RpcTransport } from '../../contracts/src/rpc.ts'
import type { NativeTransport } from './native-transport.ts'
import { FairWorkScheduler, type FairWorkHandle } from './fair-scheduler.ts'

const MAX_NATIVE_RPC_PACKET = 24 * 1024
const typedArray = Object.getPrototypeOf(Uint8Array.prototype)
const byteLength = Object.getOwnPropertyDescriptor(typedArray, 'byteLength')!.get!
const byteOffset = Object.getOwnPropertyDescriptor(typedArray, 'byteOffset')!.get!
const backingBuffer = Object.getOwnPropertyDescriptor(typedArray, 'buffer')!.get!

function hex(packet: Uint8Array): string {
  if (!(packet instanceof Uint8Array))
    throw new RpcError('PROTOCOL_ERROR', 'Native RPC packet size denied')
  const length: number = byteLength.call(packet)
  const offset: number = byteOffset.call(packet)
  const buffer: unknown = backingBuffer.call(packet)
  if (!(buffer instanceof ArrayBuffer) || length < 1 || length > MAX_NATIVE_RPC_PACKET)
    throw new RpcError('PROTOCOL_ERROR', 'Native RPC packet size denied')
  // Read intrinsic slots, then encode the exact bounded view at handoff. The
  // scheduled task retains only this immutable snapshot, never caller storage.
  let result = ''
  for (const byte of new Uint8Array(buffer, offset, length))
    result += byte.toString(16).padStart(2, '0')
  return result
}
/** Internal lane adapter; callers must authenticate native identity before delivery. */
export class CefLaneTransport implements RpcTransport {
  #message: ((packet: Uint8Array) => void) | undefined
  #closed: (() => void) | undefined
  #ended = false
  readonly #scheduler: FairWorkScheduler | undefined
  readonly #owner: object | undefined
  readonly #scheduled = new Set<FairWorkHandle>()
  constructor(
    readonly native: Pick<NativeTransport, 'call'>,
    readonly identity: Readonly<{ connection: number; context: number; generation: number }>,
    readonly lane: 'rpc' | 'stream',
    scheduler?: FairWorkScheduler,
    owner?: object
  ) {
    this.#scheduler = scheduler
    this.#owner = owner
  }
  send(packet: Uint8Array): Promise<void> {
    if (this.#ended)
      return Promise.reject(new RpcError('DISCONNECTED', 'Native RPC transport closed'))
    let encoded: string
    try {
      encoded = hex(packet)
    } catch (error) {
      this.end(true)
      return Promise.reject(error)
    }
    const submit = async () => {
      try {
        await this.native.call(`${this.lane}.deliver`, { ...this.identity, packet: encoded })
      } catch (error) {
        this.end(true)
        throw error
      }
    }
    if (!this.#scheduler || !this.#owner) return submit()
    // The snapshotted wire kind is only a scheduling class. Native authority
    // and protocol validation remain unchanged; lifecycle order is in StreamLink.
    const priority = this.lane === 'stream' && encoded.slice(10, 12) !== '02' ? 'control' : 'bulk'
    return new Promise<void>((resolve, reject) => {
      let scheduled: FairWorkHandle | undefined
      const disconnected = () =>
        reject(new RpcError('DISCONNECTED', 'Native stream transport closed'))
      scheduled = this.#scheduler!.schedule(
        this.#owner!,
        () => {
          this.#scheduled.delete(scheduled!)
          if (this.#ended) {
            disconnected()
            return
          }
          void submit().then(resolve, reject)
        },
        { priority, onCancel: disconnected }
      )
      if (!scheduled) {
        reject(new RpcError('OVERLOADED', 'Native stream scheduler capacity exceeded'))
        this.end(true)
        return
      }
      this.#scheduled.add(scheduled)
    })
  }
  subscribe(message: (packet: Uint8Array) => void, closed: () => void): () => void {
    if (this.#message) throw new TypeError('Native RPC transport permits one subscriber')
    this.#message = message
    this.#closed = closed
    return () => {
      this.#message = undefined
      this.#closed = undefined
    }
  }
  receive(packet: Uint8Array, sequence: number): void {
    if (this.#ended || !this.#message) return
    let scheduled: FairWorkHandle | undefined
    const deliver = () => {
      this.#scheduled.delete(scheduled!)
      if (this.#ended || !this.#message) return
      try {
        this.#message(packet)
        if (this.#ended) return
        void this.native
          .call(`${this.lane}.ack`, { ...this.identity, sequence })
          .catch(() => this.end(true))
      } catch {
        // A failed delivery is not a receipt. Explicitly retire this lane so
        // native ownership is released through disconnect, never a false ACK.
        this.end(true)
      }
    }
    if (!this.#scheduler || !this.#owner) {
      deliver()
      return
    }
    scheduled = this.#scheduler.schedule(this.#owner, deliver, {
      priority: 'bulk',
    })
    if (!scheduled) this.end(true)
    else this.#scheduled.add(scheduled)
  }
  close(): void {
    this.end(true)
  }
  end(tellNative: boolean): void {
    if (this.#ended) return
    this.#ended = true
    for (const scheduled of this.#scheduled) scheduled.cancel()
    this.#scheduled.clear()
    const closed = this.#closed
    this.#message = undefined
    this.#closed = undefined
    try {
      if (tellNative)
        void this.native.call(`${this.lane}.disconnect`, { ...this.identity }).catch(() => {})
    } catch {
      // Native transport failure cannot prevent local cancellation/settlement.
    }
    try {
      closed?.()
    } catch {
      // A close observer cannot retain the lane or interrupt peer scheduling.
    }
  }
}
