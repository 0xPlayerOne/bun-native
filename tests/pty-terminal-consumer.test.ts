import { test, expect } from 'bun:test'
import { QualificationTerminal } from '../benchmarks/pty/terminal-consumer.ts'
const marker = (sequence: number, value: Record<string, unknown>) =>
  `BUNLYPTY|${sequence}|${Buffer.from(JSON.stringify(value)).toString('base64')}|END`
const bytes = (text: string) => new TextEncoder().encode(text)
test('real xterm parser handles split UTF-8, wrapping and cursor repaints without counting old rows twice', async () => {
  const received: Record<string, unknown>[] = []
  const terminal = new QualificationTerminal((record) => received.push(record))
  try {
    const first = marker(0, { type: 'ready', value: 'a'.repeat(120) })
    const input = bytes(first + '\r\nUNICODE café-🐙\r\n')
    for (let i = 0; i < input.length; i++) await terminal.consume(input.subarray(i, i + 1))
    expect(received).toEqual([{ type: 'ready', value: 'a'.repeat(120) }])
    expect(terminal.unicodeObserved).toBe(true)
    terminal.resize(110, 37)
    await terminal.consume(
      bytes('\x1b[2J\x1b[H' + first + '\r\n' + marker(1, { type: 'size' }) + '\r\n')
    )
    expect(received).toEqual([{ type: 'ready', value: 'a'.repeat(120) }, { type: 'size' }])
  } finally {
    terminal.dispose()
  }
})
test('missing, reordered, duplicated or changed displayed receipts fail rather than become redraw tolerance', async () => {
  for (const input of [
    marker(1, { type: 'future' }),
    marker(0, { type: 'ready' }) + '\r\n' + marker(0, { type: 'ready' }),
  ]) {
    const terminal = new QualificationTerminal(() => {})
    try {
      await expect(terminal.consume(bytes(input))).rejects.toThrow()
    } finally {
      terminal.dispose()
    }
  }
  const terminal = new QualificationTerminal(() => {})
  try {
    await terminal.consume(bytes(marker(0, { type: 'ready' })))
    await expect(
      terminal.consume(bytes('\x1b[2J\x1b[H' + marker(0, { type: 'changed' })))
    ).rejects.toThrow()
  } finally {
    terminal.dispose()
  }
})
