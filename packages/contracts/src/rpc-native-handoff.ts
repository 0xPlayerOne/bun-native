import { RpcError } from './rpc.ts'
import { RPC_WEBSOCKET_PATH } from './rpc-websocket-wire.ts'

const MAGIC = 0x424c4c42 // BLLB, native channel only. No view/session IDs in page data.
const HEADER = 8
function endpoint(value: string): void {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new RpcError('PROTOCOL_ERROR', 'Invalid loopback endpoint')
  }
  if (
    value.length > 128 ||
    url.href !== value ||
    url.protocol !== 'ws:' ||
    url.hostname !== '127.0.0.1' ||
    !url.port ||
    Number(url.port) === 0 ||
    url.pathname !== RPC_WEBSOCKET_PATH ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  )
    throw new RpcError('PROTOCOL_ERROR', 'Loopback endpoint must be exact numeric IPv4')
}
function bytes(value: Uint8Array): void {
  if (
    !(value instanceof Uint8Array) ||
    !(value.buffer instanceof ArrayBuffer) ||
    value.length !== 32
  )
    throw new RpcError('PROTOCOL_ERROR', 'Native handoff requires exactly 32 bytes')
}
export function encodeNativeLoopbackHandoff(value: {
  readonly endpoint: string
  readonly credential: Uint8Array
}): Uint8Array {
  endpoint(value.endpoint)
  bytes(value.credential)
  const text = new TextEncoder().encode(value.endpoint)
  const output = new Uint8Array(HEADER + text.length + 32),
    view = new DataView(output.buffer)
  view.setUint32(0, MAGIC)
  view.setUint8(4, 1)
  view.setUint8(5, 1)
  view.setUint16(6, text.length)
  output.set(text, HEADER)
  output.set(value.credential, HEADER + text.length)
  return output
}
export function decodeNativeLoopbackHandoff(input: Uint8Array): {
  readonly endpoint: string
  readonly credential: Uint8Array
} {
  const view = header(input, 1)
  const size = view.getUint16(6)
  if (size < 1 || size > 128 || input.length !== HEADER + size + 32)
    throw new RpcError('PROTOCOL_ERROR', 'Invalid native offer size')
  const text = new TextDecoder('utf-8', { fatal: true }).decode(
    input.subarray(HEADER, HEADER + size)
  )
  endpoint(text)
  return { endpoint: text, credential: new Uint8Array(input.subarray(HEADER + size)) }
}
export function encodeNativeLoopbackConfirmation(challenge: Uint8Array): Uint8Array {
  bytes(challenge)
  const output = new Uint8Array(HEADER + 32),
    view = new DataView(output.buffer)
  view.setUint32(0, MAGIC)
  view.setUint8(4, 1)
  view.setUint8(5, 2)
  view.setUint16(6, 0)
  output.set(challenge, HEADER)
  return output
}
export function decodeNativeLoopbackConfirmation(input: Uint8Array): Uint8Array {
  const view = header(input, 2)
  if (input.length !== HEADER + 32 || view.getUint16(6) !== 0)
    throw new RpcError('PROTOCOL_ERROR', 'Invalid native confirmation size')
  return new Uint8Array(input.subarray(HEADER))
}
function header(input: Uint8Array, kind: number): DataView {
  if (
    !(input instanceof Uint8Array) ||
    !(input.buffer instanceof ArrayBuffer) ||
    input.length < HEADER ||
    input.length > HEADER + 128 + 32
  )
    throw new RpcError('PROTOCOL_ERROR', 'Invalid native handoff size')
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength)
  if (view.getUint32(0) !== MAGIC || view.getUint8(4) !== 1 || view.getUint8(5) !== kind)
    throw new RpcError('PROTOCOL_ERROR', 'Invalid native handoff record')
  return view
}
