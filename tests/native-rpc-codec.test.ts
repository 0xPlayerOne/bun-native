import assert from 'node:assert/strict'
import { test, expect } from 'bun:test'
import {
  MAX_NATIVE_RPC_PACKET,
  nativePacketHex,
  nativePacketBytes,
} from '../packages/runtime/src/native-rpc-codec.ts'

const protocolError = { code: 'PROTOCOL_ERROR' }

test('native codec preserves all byte values and exact maximum wire size', () => {
  const every = Uint8Array.from({ length: 256 }, (_, index) => index)
  const expected = Array.from(every, (byte) => byte.toString(16).padStart(2, '0')).join('')
  expect(nativePacketHex(every)).toBe(expected)
  expect(nativePacketBytes(expected)).toEqual(every)
  const maximum = new Uint8Array(MAX_NATIVE_RPC_PACKET).fill(255)
  expect(nativePacketHex(maximum)).toBe('ff'.repeat(MAX_NATIVE_RPC_PACKET))
  expect(nativePacketBytes(nativePacketHex(maximum))).toEqual(maximum)
  assert.throws(() => nativePacketHex(new Uint8Array(MAX_NATIVE_RPC_PACKET + 1)), protocolError)
  assert.throws(() => nativePacketBytes('00'.repeat(MAX_NATIVE_RPC_PACKET + 1)), protocolError)
})

test('native codec encodes only the declared slice and decodes exact independent storage', () => {
  const large = new Uint8Array(1024 * 1024).fill(99)
  const slice = large.subarray(100, 105)
  slice.set([0, 1, 127, 128, 255])
  const encoded = nativePacketHex(slice)
  large.fill(0)
  expect(encoded).toBe('00017f80ff')
  const first = nativePacketBytes(encoded),
    second = nativePacketBytes(encoded)
  expect(first.constructor).toBe(Uint8Array)
  expect(first.byteOffset).toBe(0)
  expect(first.buffer.byteLength).toBe(5)
  expect(first.buffer).not.toBe(second.buffer)
  first.fill(33)
  expect(second).toEqual(new Uint8Array([0, 1, 127, 128, 255]))
  expect(nativePacketHex(Buffer.from([0, 255]))).toBe('00ff')
})

test('native codec keeps the strict lowercase bounded grammar before decoding', () => {
  for (const value of [
    '',
    '0',
    'fff',
    'FF',
    'aF',
    'gg',
    '0x00',
    ' 00',
    '00 ',
    '00\n',
    '00\0',
    0,
    null,
    undefined,
    new String('aa'),
  ])
    assert.throws(() => nativePacketBytes(value), protocolError)
  for (const text of ['00', 'ff', '0123456789abcdef'])
    expect(nativePacketHex(nativePacketBytes(text))).toBe(text)
})

test('producer overrides cannot change admitted size, bytes or conversion behavior', () => {
  const bytes = new Uint8Array([0, 16, 255])
  Object.defineProperty(bytes, 'byteLength', {
    get() {
      throw new Error('private getter')
    },
  })
  bytes.toHex = () => {
    throw new Error('private replacement')
  }
  bytes[Symbol.iterator] = () => {
    throw new Error('private iterator')
  }
  expect(nativePacketHex(bytes)).toBe('0010ff')
  const excessive = new Uint8Array(MAX_NATIVE_RPC_PACKET + 1)
  Object.defineProperty(excessive, 'byteLength', { value: 1 })
  assert.throws(() => nativePacketHex(excessive), protocolError)
})

test('detached, shared, wrong-kind and forged views never enter the native wire', () => {
  const detached = new Uint8Array([1])
  structuredClone(detached, { transfer: [detached.buffer] })
  const revoked = Proxy.revocable(new Uint8Array([1]), {})
  revoked.revoke()
  for (const input of [
    new Uint8Array(),
    detached,
    new Uint8Array(new SharedArrayBuffer(1)),
    new Int8Array([1]),
    new Uint16Array([1]),
    new DataView(new ArrayBuffer(1)),
    Object.create(Uint8Array.prototype),
    new Proxy(new Uint8Array([1]), {}),
    revoked.proxy,
    { byteLength: 1 },
    null,
  ])
    assert.throws(() => nativePacketHex(input as Uint8Array), protocolError)
})
