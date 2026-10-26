import { test } from 'bun:test'
import assert from 'node:assert/strict'
import { TerminalRecords } from '../examples/cef-terminal/terminal-records.ts'
const marker = (seq: number, type = 'ready') =>
  `BUNLYTERM|${seq}|${btoa(JSON.stringify({ type }))}|END`
const screen = (lines: readonly { text: string; wrapped?: boolean }[]) => ({
  length: lines.length,
  getLine: (i: number) => ({
    isWrapped: lines[i]?.wrapped === true,
    translateToString: () => lines[i]!.text,
  }),
})
test('terminal screen parsing preserves wrapped frames, checks old rows and observes Unicode', () => {
  const reader = new TerminalRecords(),
    frame = marker(0)
  const rows = [
    { text: 'café-🐙' },
    { text: frame.slice(0, 20) },
    { text: frame.slice(20), wrapped: true },
  ]
  assert.equal(reader.update(screen(rows)).length, 1)
  assert.equal(reader.update(screen(rows)).length, 0)
  assert.equal(reader.unicodeObserved, true)
  assert.equal(reader.update(screen([...rows, { text: marker(1, 'final') }])).length, 1)
  assert.equal(reader.records.length, 2)
})
test('terminal screen parsing rejects duplicates, changed prior rows, gaps and oversized screens', () => {
  assert.throws(() =>
    new TerminalRecords().update(screen([{ text: marker(0) }, { text: marker(0) }]))
  )
  assert.throws(() => new TerminalRecords().update(screen([{ text: marker(1) }])))
  const reader = new TerminalRecords()
  reader.update(screen([{ text: marker(0) }]))
  assert.throws(() => reader.update(screen([{ text: marker(0, 'changed') }])))
  assert.throws(() => reader.update(screen(Array.from({ length: 601 }, () => ({ text: '' })))))
  assert.throws(() => reader.update(screen([{ text: 'x'.repeat(1001) }])))
})
