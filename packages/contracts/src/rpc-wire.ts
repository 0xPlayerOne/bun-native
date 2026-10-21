import { RPC_VERSION, RPC_ERROR_CODES, RpcError, validProcedure } from './rpc.ts'
import type { RpcEnvelope, RpcLimits } from './rpc.ts'
const MAGIC = 0x424c5250 // BLRP, network byte order; followed by metadata/body byte lengths.
const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
function invalid(message = 'Invalid RPC packet'): never {
  throw new RpcError('PROTOCOL_ERROR', message)
}
function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return invalid()
  return value as Record<string, unknown>
}
function keys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value)
  if (actual.length !== expected.length || actual.some((key) => !expected.includes(key))) invalid()
}
/** Reject lossy/non-data serialization, excessive structure, and accessor execution. */
function jsonData(value: unknown, budget: number): void {
  const ancestors = new Set<object>()
  let nodes = 0,
    units = 0
  function visit(v: unknown, depth: number): void {
    if (++nodes > 10_000 || depth > 48) invalid('RPC JSON complexity limit')
    if (v === null || typeof v === 'boolean') {
      units += 5
    } else if (typeof v === 'number' && Number.isFinite(v) && !Object.is(v, -0)) {
      units += 1
    } else if (typeof v === 'string') {
      units += v.length
    } else if (v && typeof v === 'object') {
      if (ancestors.has(v)) invalid('Cyclic RPC JSON')
      const proto = Object.getPrototypeOf(v)
      if (
        Array.isArray(v) ? proto !== Array.prototype : proto !== Object.prototype && proto !== null
      )
        invalid('RPC expects plain JSON or a top-level Uint8Array')
      if (Array.isArray(v) && (v.length > 10_000 || Object.keys(v).length !== v.length))
        invalid('RPC arrays must be dense')
      const descriptors = Object.getOwnPropertyDescriptors(v)
      if (Object.getOwnPropertySymbols(v).length) invalid('RPC JSON cannot contain symbols')
      ancestors.add(v)
      for (const [key, property] of Object.entries(descriptors)) {
        if (Array.isArray(v) && key === 'length') continue
        if (
          !property.enumerable ||
          !('value' in property) ||
          ['__proto__', 'constructor', 'prototype'].includes(key)
        )
          invalid('RPC JSON contains an unsupported property')
        if (Array.isArray(v) && !/^(0|[1-9][0-9]*)$/.test(key)) invalid()
        units += key.length + 3
        if (units > budget) invalid('RPC metadata limit')
        visit(property.value, depth + 1)
      }
      ancestors.delete(v)
    } else invalid('RPC value is not JSON data')
    if (units > budget) invalid('RPC metadata limit')
  }
  visit(value, 0)
}
export function encodeRpc(envelope: RpcEnvelope, limits: RpcLimits): Uint8Array {
  const metadata: Record<string, unknown> = { v: RPC_VERSION, type: envelope.type, id: envelope.id }
  let body: Uint8Array | undefined
  if (envelope.type === 'request') {
    metadata['method'] = envelope.method
    metadata['timeoutMs'] = envelope.timeoutMs
  }
  if (envelope.type === 'request' || envelope.type === 'success') {
    if (envelope.value instanceof Uint8Array) {
      if (!(envelope.value.buffer instanceof ArrayBuffer))
        invalid('Shared-memory payloads are not supported')
      if (envelope.value.byteLength > limits.maxFrameBytes - 12) invalid('RPC packet too large')
      metadata['payload'] = { kind: 'bytes' }
      body = envelope.value
    } else {
      metadata['payload'] = { kind: 'json', value: envelope.value }
    }
  } else if (envelope.type === 'error') {
    metadata['code'] = envelope.code
    metadata['message'] = envelope.message
  }
  // Metadata contains only our own envelope and already-checked data. Validate the
  // envelope on both sides; trusted adapters do not get a separate permissive path.
  jsonData(metadata, limits.maxMetadataBytes)
  readEnvelope(metadata, body?.length ?? 0, limits, () => body!)
  const header = encoder.encode(JSON.stringify(metadata))
  if (
    header.length > limits.maxMetadataBytes ||
    12 + header.length + (body?.length ?? 0) > limits.maxFrameBytes
  )
    invalid('RPC packet too large')
  const packet = new Uint8Array(12 + header.length + (body?.length ?? 0))
  const view = new DataView(packet.buffer)
  view.setUint32(0, MAGIC)
  view.setUint32(4, header.length)
  view.setUint32(8, body?.length ?? 0)
  packet.set(header, 12)
  if (body) packet.set(body, 12 + header.length)
  return packet
}
export function decodeRpc(packet: Uint8Array, limits: RpcLimits): RpcEnvelope {
  if (
    !(packet instanceof Uint8Array) ||
    !(packet.buffer instanceof ArrayBuffer) ||
    packet.byteLength < 12 ||
    packet.byteLength > limits.maxFrameBytes
  )
    invalid()
  const frame = new DataView(packet.buffer, packet.byteOffset, packet.byteLength)
  const headerLength = frame.getUint32(4),
    bodyLength = frame.getUint32(8)
  if (
    frame.getUint32(0) !== MAGIC ||
    headerLength < 2 ||
    headerLength > limits.maxMetadataBytes ||
    12 + headerLength + bodyLength !== packet.byteLength
  )
    invalid()
  let raw: unknown
  try {
    raw = JSON.parse(decoder.decode(packet.subarray(12, 12 + headerLength)))
  } catch {
    return invalid('Invalid RPC UTF-8 or JSON')
  }
  jsonData(raw, limits.maxMetadataBytes)
  return readEnvelope(object(raw), bodyLength, limits, () => packet.slice(12 + headerLength))
}
function readEnvelope(
  data: Record<string, unknown>,
  bodyLength: number,
  limits: RpcLimits,
  binary: () => Uint8Array
): RpcEnvelope {
  if (data['v'] !== RPC_VERSION) throw new RpcError('VERSION_MISMATCH', 'Unsupported RPC version')
  const id = data['id']
  if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 1) invalid()
  const type = data['type']
  if (type === 'cancel') {
    keys(data, ['v', 'type', 'id'])
    if (bodyLength) invalid()
    return { type, id }
  }
  if (type === 'error') {
    keys(data, ['v', 'type', 'id', 'code', 'message'])
    if (
      bodyLength ||
      !RPC_ERROR_CODES.includes(data['code'] as (typeof RPC_ERROR_CODES)[number]) ||
      typeof data['message'] !== 'string' ||
      data['message'].length > 256
    )
      invalid()
    return {
      type,
      id,
      code: data['code'] as (typeof RPC_ERROR_CODES)[number],
      message: data['message'],
    }
  }
  if (type !== 'request' && type !== 'success') return invalid()
  keys(
    data,
    type === 'request'
      ? ['v', 'type', 'id', 'method', 'timeoutMs', 'payload']
      : ['v', 'type', 'id', 'payload']
  )
  const payload = object(data['payload'])
  let value: unknown
  if (payload['kind'] === 'json') {
    keys(payload, ['kind', 'value'])
    if (bodyLength) invalid()
    value = payload['value']
  } else if (payload['kind'] === 'bytes') {
    keys(payload, ['kind'])
    value = binary()
  } else return invalid()
  if (type === 'success') return { type, id, value }
  const method = data['method'],
    timeoutMs = data['timeoutMs']
  if (
    typeof method !== 'string' ||
    !validProcedure(method) ||
    typeof timeoutMs !== 'number' ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > limits.maxTimeoutMs
  )
    invalid()
  return { type, id, method, timeoutMs, value }
}
