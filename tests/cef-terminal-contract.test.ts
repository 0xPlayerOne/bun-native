import assert from 'node:assert/strict'
import { test } from 'bun:test'
import {
  TERMINAL_COUNT,
  pageReport,
  terminalSchema,
} from '../examples/cef-terminal/terminal-contract.ts'

const checksum = 'a'.repeat(64)
const terminal = (identity: number) => ({
  terminal: identity,
  records: 1,
  bytes: 1,
  sha256: checksum,
  order: [0],
  callbacks: 1,
  callbackDurationsMs: [0],
  unicodeObserved: true,
})
const report = () => ({
  terminals: Array.from({ length: TERMINAL_COUNT }, (_, index) => terminal(index)),
  controlRoundtripsMs: [0],
  heldConsumer: true,
  rpcWhileHeld: true,
  siblingWhileHeld: true,
  parserCallbacks: true,
  totalElapsedMs: 1,
})

test('terminal fixture contract admits only fixed bounded controls', () => {
  assert.deepEqual(terminalSchema.control.input({ terminal: 0, action: 'binary', value: '-' }), {
    terminal: 0,
    action: 'binary',
    value: '-',
  })
  for (const input of [
    { terminal: 3, action: 'exit', value: '-' },
    { terminal: 0, action: 'shell', value: '-' },
    { terminal: 0, action: 'exit', value: '-', executable: '/bin/sh' },
  ])
    assert.throws(() => terminalSchema.control.input(input))
})

test('terminal page report rejects duplicate, partial and malformed consumer receipts', () => {
  assert.equal(pageReport(report()).terminals.length, TERMINAL_COUNT)
  for (const mutate of [
    (value: ReturnType<typeof report>) => value.terminals.pop(),
    (value: ReturnType<typeof report>) => (value.terminals[1]!.terminal = 0),
    (value: ReturnType<typeof report>) => (value.terminals[0]!.sha256 = 'a'.repeat(63)),
    (value: ReturnType<typeof report>) => value.terminals[0]!.callbackDurationsMs.pop(),
  ]) {
    const value = report()
    mutate(value)
    assert.throws(() => pageReport(value))
  }
})
