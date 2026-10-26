import { test, expect } from 'bun:test'
import { OwnerTerminalConsumer, ownerFixtureExitInput } from './fixtures/terminal-owner-consumer.ts'
const receipt = { event: 'ready', server: 123, shell: 122, port: 456, emptyArgPreserved: true }
const framed = 'BUNLYOWN|' + Buffer.from(JSON.stringify(receipt)).toString('base64') + '|END'
test('owner fixture uses real terminal parsing across VT setup, wraps and split callbacks', async () => {
  const seen: unknown[] = []
  const terminal = new OwnerTerminalConsumer((record) => seen.push(record))
  try {
    const output = Buffer.from(
      '\x1b[?25l\x1b[2J\x1b[H' + framed + '\r\nFINAL-' + 'x'.repeat(8192) + '\r\n'
    )
    for (let offset = 0; offset < output.length; offset += 37)
      await terminal.consume(output.subarray(offset, offset + 37))
    expect(seen).toEqual([receipt])
    expect(terminal.final).toBe(true)
  } finally {
    terminal.dispose()
  }
})
test('partial and duplicated owner readiness or incomplete trailing output cannot qualify', async () => {
  const seen: unknown[] = []
  const terminal = new OwnerTerminalConsumer((record) => seen.push(record))
  try {
    await terminal.consume(Buffer.from(framed.slice(0, -3)))
    expect(seen).toEqual([])
    await terminal.consume(Buffer.from('END\r\nFINAL-' + 'x'.repeat(8191)))
    expect(terminal.final).toBe(false)
    await expect(terminal.consume(Buffer.from('\r\n' + framed))).rejects.toThrow('Duplicate')
  } finally {
    terminal.dispose()
  }
})
test('owner fixture output admission rejects an unbounded callback before terminal parsing', async () => {
  const terminal = new OwnerTerminalConsumer(() => {})
  try {
    await expect(terminal.consume(new Uint8Array(128 * 1024 + 1))).rejects.toThrow('bound')
  } finally {
    terminal.dispose()
  }
})

test('owner console fixture uses CR Enter on Windows without changing raw application bytes', () => {
  expect([...ownerFixtureExitInput('win32')]).toEqual([101, 120, 105, 116, 13])
  expect([...ownerFixtureExitInput('darwin')]).toEqual([101, 120, 105, 116, 10])
  expect([...ownerFixtureExitInput('linux')]).toEqual([101, 120, 105, 116, 10])
})
