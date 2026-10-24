import { RpcError } from '../../contracts/src/rpc.ts'

export const MAX_NATIVE_RPC_PACKET = 24 * 1024
const typedArray = Object.getPrototypeOf(Uint8Array.prototype)
const byteLength = Object.getOwnPropertyDescriptor(typedArray, 'byteLength')!.get!
const backingBuffer = Object.getOwnPropertyDescriptor(typedArray, 'buffer')!.get!
const encode = Uint8Array.prototype.toHex
const decode = Uint8Array.fromHex

/** Private-pipe encoding only; the binary packet, limits and wire grammar are unchanged. */
export function nativePacketHex(packet: Uint8Array): string {
  try {
    if (!(packet instanceof Uint8Array)) throw new TypeError('Invalid packet')
    const length: number = byteLength.call(packet)
    if (
      length < 1 ||
      length > MAX_NATIVE_RPC_PACKET ||
      !(backingBuffer.call(packet) instanceof ArrayBuffer)
    )
      throw new TypeError('Invalid packet')
    // Intrinsic conversion respects the actual view offset/length and does not
    // invoke a producer's iterator, byteLength getter or replacement toHex method.
    return encode.call(packet)
  } catch {
    throw new RpcError('PROTOCOL_ERROR', 'Native RPC packet size denied')
  }
}

export function nativePacketBytes(value: unknown): Uint8Array {
  if (
    typeof value !== 'string' ||
    value.length < 2 ||
    value.length % 2 ||
    value.length > MAX_NATIVE_RPC_PACKET * 2 ||
    !/^[0-9a-f]+$/.test(value)
  )
    throw new RpcError('PROTOCOL_ERROR', 'Invalid native RPC packet encoding')
  // Keep the stricter lowercase wire grammar above; fromHex itself also accepts
  // uppercase. It allocates one exact owned Uint8Array, not a pooled Buffer view.
  return decode.call(Uint8Array, value)
}
