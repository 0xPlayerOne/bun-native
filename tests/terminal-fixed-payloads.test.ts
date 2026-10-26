import { test, expect } from 'bun:test'
import { verifyFixedRecordPayloads } from '../examples/cef-terminal/terminal-records.ts'
const records = () =>
  Array.from({ length: 32 }, (_, index) => ({
    sequence: index,
    value: { type: 'record', index, text: `fixed-${index}-café-🐙` },
  }))
test('fixed terminal content checks every index and Unicode payload independently of raw checksums', () => {
  expect(verifyFixedRecordPayloads(records(), 32)).toBe(true)
  for (const mutate of [
    (rows: ReturnType<typeof records>) => {
      rows[7]!.value.index = 8
    },
    (rows: ReturnType<typeof records>) => {
      rows[7]!.value.text = 'wrong-but-consistently-hashed'
    },
    (rows: ReturnType<typeof records>) => {
      rows[7]!.value.type = 'unexpected'
    },
    (rows: ReturnType<typeof records>) => {
      rows.pop()
    },
    (rows: ReturnType<typeof records>) => {
      rows.push(rows[0]!)
    },
    (rows: ReturnType<typeof records>) => {
      Object.assign(rows[0]!.value, { extra: true })
    },
  ]) {
    const rows = records()
    mutate(rows)
    expect(() => verifyFixedRecordPayloads(rows, 32)).toThrow()
  }
})
