import { RpcError } from './rpc.ts'

export const RPC_WEBSOCKET_HEADER_BYTES = 12
export const RPC_WEBSOCKET_CREDENTIAL_BYTES = 32
export const RPC_WEBSOCKET_PATH = '/.bunly/rpc/v1'
const MAGIC = 0x424c5753 // BLWS
const VERSION = 1

export type RpcWebSocketRecord =
  | { readonly kind: 'auth'; readonly credential: Uint8Array }
  | { readonly kind: 'ready' }
  | { readonly kind: 'challenge'; readonly challenge: Uint8Array }
  | { readonly kind: 'packet'; readonly sequence: number; readonly packet: Uint8Array }
  | { readonly kind: 'ack'; readonly sequence: number }
  | { readonly kind: 'close' }

const kinds = { auth: 1, ready: 2, packet: 3, ack: 4, close: 5, challenge: 6 } as const

function record(kind: number, sequence: number, payload?: Uint8Array): Uint8Array<ArrayBuffer> {
  const body = payload ?? new Uint8Array()
  const output = new Uint8Array(RPC_WEBSOCKET_HEADER_BYTES + body.byteLength)
  const view = new DataView(output.buffer)
  view.setUint32(0, MAGIC)
  view.setUint8(4, VERSION)
  view.setUint8(5, kind)
  view.setUint16(6, 0)
  view.setUint32(8, sequence)
  output.set(body, RPC_WEBSOCKET_HEADER_BYTES)
  return output
}

export function encodeRpcWebSocketRecord(value: RpcWebSocketRecord): Uint8Array<ArrayBuffer> {
  switch (value.kind) {
    case 'auth':
      if (
        !(value.credential instanceof Uint8Array) ||
        !(value.credential.buffer instanceof ArrayBuffer) ||
        value.credential.byteLength !== RPC_WEBSOCKET_CREDENTIAL_BYTES
      )
        throw new TypeError('Invalid loopback credential')
      return record(kinds.auth, 0, value.credential)
    case 'ready':
      return record(kinds.ready, 0)
    case 'challenge':
      if (
        !(value.challenge instanceof Uint8Array) ||
        !(value.challenge.buffer instanceof ArrayBuffer) ||
        value.challenge.byteLength !== 32
      )
        throw new TypeError('Invalid native confirmation challenge')
      return record(kinds.challenge, 0, value.challenge)
    case 'packet':
      if (
        !Number.isSafeInteger(value.sequence) ||
        value.sequence < 1 ||
        value.sequence > 0xffffffff
      )
        throw new TypeError('Invalid loopback packet sequence')
      return record(kinds.packet, value.sequence, value.packet)
    case 'ack':
      if (
        !Number.isSafeInteger(value.sequence) ||
        value.sequence < 1 ||
        value.sequence > 0xffffffff
      )
        throw new TypeError('Invalid loopback acknowledgement sequence')
      return record(kinds.ack, value.sequence)
    case 'close':
      return record(kinds.close, 0)
  }
}

export function decodeRpcWebSocketRecord(
  input: Uint8Array,
  maxPacketBytes: number
): RpcWebSocketRecord {
  if (
    !(input instanceof Uint8Array) ||
    !(input.buffer instanceof ArrayBuffer) ||
    input.byteLength < RPC_WEBSOCKET_HEADER_BYTES ||
    input.byteLength > RPC_WEBSOCKET_HEADER_BYTES + maxPacketBytes
  )
    throw new RpcError('PROTOCOL_ERROR', 'Invalid loopback record size')
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength)
  if (view.getUint32(0) !== MAGIC || view.getUint8(4) !== VERSION || view.getUint16(6) !== 0)
    throw new RpcError('PROTOCOL_ERROR', 'Invalid loopback record header')
  const kind = view.getUint8(5)
  const sequence = view.getUint32(8)
  const payload = input.subarray(RPC_WEBSOCKET_HEADER_BYTES)
  if (
    kind === kinds.auth &&
    sequence === 0 &&
    payload.byteLength === RPC_WEBSOCKET_CREDENTIAL_BYTES
  )
    return { kind: 'auth', credential: new Uint8Array(payload) }
  if (kind === kinds.challenge && sequence === 0 && payload.byteLength === 32)
    return { kind: 'challenge', challenge: new Uint8Array(payload) }
  if (kind === kinds.ready && sequence === 0 && payload.byteLength === 0) return { kind: 'ready' }
  if (kind === kinds.packet && sequence > 0 && payload.byteLength > 0)
    return { kind: 'packet', sequence, packet: new Uint8Array(payload) }
  if (kind === kinds.ack && sequence > 0 && payload.byteLength === 0)
    return { kind: 'ack', sequence }
  if (kind === kinds.close && sequence === 0 && payload.byteLength === 0) return { kind: 'close' }
  throw new RpcError('PROTOCOL_ERROR', 'Invalid loopback record')
}
