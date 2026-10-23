import { test } from 'bun:test'
import assert from 'node:assert/strict'
import {
  encodeNativeLoopbackHandoff,
  decodeNativeLoopbackHandoff,
  encodeNativeLoopbackConfirmation,
  decodeNativeLoopbackConfirmation,
} from '../packages/contracts/src/rpc-native-handoff.ts'

test('native loopback control messages contain only the bounded endpoint and one-use bytes', () => {
  const credential = Uint8Array.from({ length: 32 }, (_, i) => i)
  const endpoint = 'ws://127.0.0.1:43111/.bunly/rpc/v1'
  const encoded = encodeNativeLoopbackHandoff({ endpoint, credential })
  credential.fill(255)
  const decoded = decodeNativeLoopbackHandoff(encoded)
  assert.equal(decoded.endpoint, endpoint)
  assert.equal(decoded.credential[0], 0)
  encoded.fill(0)
  assert.equal(decoded.credential[31], 31)
  const confirm = encodeNativeLoopbackConfirmation(decoded.credential)
  assert.deepEqual(decodeNativeLoopbackConfirmation(confirm), decoded.credential)
  assert.throws(() => decodeNativeLoopbackHandoff(confirm))
  assert.throws(() => decodeNativeLoopbackConfirmation(encodeNativeLoopbackHandoff(decoded)))
})
test('native control parser rejects endpoint aliases, surplus data and malformed bounded records', () => {
  const credential = new Uint8Array(32)
  for (const endpoint of [
    'ws://localhost:43111/.bunly/rpc/v1',
    'ws://127.1:43111/.bunly/rpc/v1',
    'ws://127.0.0.1:0/.bunly/rpc/v1',
    'wss://127.0.0.1:43111/.bunly/rpc/v1',
    'ws://127.0.0.1:43111/.bunly/rpc/v1?token=x',
    'ws://127.0.0.1:43111/.bunly/rpc/v1#x',
    'ws://u:p@127.0.0.1:43111/.bunly/rpc/v1',
    'ws://127.0.0.1:43111/other',
  ])
    assert.throws(() => encodeNativeLoopbackHandoff({ endpoint, credential }))
  for (const bytes of [new Uint8Array(), new Uint8Array(31), new Uint8Array(33)])
    assert.throws(() => encodeNativeLoopbackConfirmation(bytes))
  const offer = encodeNativeLoopbackHandoff({
    endpoint: 'ws://127.0.0.1:43111/.bunly/rpc/v1',
    credential,
  })
  for (let index = 0; index < offer.length; index++)
    assert.throws(() => decodeNativeLoopbackHandoff(offer.subarray(0, index)))
  for (const index of [0, 4, 5, 6, 7]) {
    const malformed = new Uint8Array(offer)
    malformed[index] = 255
    assert.throws(() => decodeNativeLoopbackHandoff(malformed))
  }
  assert.throws(() => decodeNativeLoopbackHandoff(new Uint8Array(1024 * 1024)))
  assert.throws(() => decodeNativeLoopbackHandoff(new Uint8Array([...offer, 0])))
})
