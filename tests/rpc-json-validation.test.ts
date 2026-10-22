import { expect, test } from 'bun:test'
import { decodeRpc, encodeRpc } from '../packages/contracts/src/rpc-wire.ts'
import { rpcLimits } from '../packages/contracts/src/rpc.ts'
const limits = rpcLimits()
function raw(value: string) {
  const bytes = new TextEncoder().encode(
    `{"v":1,"type":"success","id":1,"payload":{"kind":"json","value":${value}}}`
  )
  const packet = new Uint8Array(12 + bytes.length),
    header = new DataView(packet.buffer)
  header.setUint32(0, 0x424c5250)
  header.setUint32(4, bytes.length)
  packet.set(bytes, 12)
  return packet
}
for (const value of [
  '-0',
  '1e400',
  '{"__proto__":{"polluted":true}}',
  '[{"constructor":{}}]',
  '{"safe":{"prototype":0}}',
  '['.repeat(50) + '0' + ']'.repeat(50),
  '[' + '0,'.repeat(10000) + '0]',
]) {
  test(`parsed JSON keeps value, key and complexity limits: ${value.slice(0, 40)}`, () => {
    expect(() => decodeRpc(raw(value), limits)).toThrow()
  })
}
test('nested JSON corpus preserves all values and never introduces binary authority', () => {
  for (let i = 0; i < 64; i++) {
    const value = {
      index: i,
      labels: ['λ', '🦋', '\u0000'],
      active: i % 2 === 0,
      children: Array.from({ length: i }, (_, n) => ({
        name: 'item-' + n,
        size: n / 3,
        empty: null,
        flags: [true, false],
      })),
    }
    expect(decodeRpc(encodeRpc({ type: 'success', id: i + 1, value }, limits), limits)).toEqual({
      type: 'success',
      id: i + 1,
      value,
    })
  }
})
test('outbound accessors and nonenumerable data still fail without invoking a getter', () => {
  let reads = 0
  for (const enumerable of [false, true]) {
    const value = Object.defineProperty({}, 'sensitive', {
      enumerable,
      get() {
        reads++
        return 'unexpected'
      },
    })
    expect(() => encodeRpc({ type: 'success', id: 1, value }, limits)).toThrow()
  }
  expect(reads).toBe(0)
  expect(() =>
    encodeRpc(
      { type: 'success', id: 1, value: Object.defineProperty({}, 'hidden', { value: 1 }) },
      limits
    )
  ).toThrow()
})

test('the parsed-data path does not invoke a later ambient parser replacement', () => {
  const packet = raw('{"safe":true}')
  const original = JSON.parse
  let called = false
  let result: unknown
  try {
    JSON.parse = () => {
      called = true
      throw new Error('ambient parser must not execute')
    }
    result = decodeRpc(packet, limits)
  } finally {
    JSON.parse = original
  }
  expect(called).toBe(false)
  expect(result).toEqual({ type: 'success', id: 1, value: { safe: true } })
})
