import { expect, test } from 'bun:test'
import { Terminal } from '@xterm/headless'
import { ManagedTerminalConsumer } from '../examples/managed-desktop/terminal-consumer.ts'
import { byteHashText, updateByteHash } from '../examples/managed-desktop/contract.ts'

const record = (sequence: number, kind: 'ready' | 'tick' | 'ack' | 'final', revision = 0) =>
  `BUNLYM6|${sequence}|${kind}|${revision}|café-🐙`

test('managed fixture consumes displayed ConPTY VT records, repaint and split Unicode without discarding raw bytes', async () => {
  const terminal = new Terminal({ cols: 100, rows: 24, scrollback: 100, allowProposedApi: true })
  const consumer = new ManagedTerminalConsumer(terminal)
  const encoder = new TextEncoder()
  const delivered: Uint8Array[] = []
  const send = async (text: string, split = false) => {
    const bytes = encoder.encode(text)
    const chunks = split ? Array.from(bytes, (byte) => new Uint8Array([byte])) : [bytes]
    const records = []
    for (const chunk of chunks) {
      delivered.push(chunk)
      records.push(...(await consumer.consume(chunk)))
    }
    return records
  }
  try {
    // ConPTY emits terminal control operations, not a plain-text record channel.
    const initial = `\x1b[?25l\x1b[2J\x1b[m\x1b[H${record(0, 'ready')}\r\n\x1b[?25h`
    expect((await send(initial, true)).map((row) => row.sequence)).toEqual([0])
    // A cursor repaint of the identical displayed row is validated, not counted twice.
    expect(await send(`\x1b[1;1H${record(0, 'ready')}\x1b[2;1H`)).toEqual([])
    for (let revision = 0; revision <= 500; revision++)
      expect((await send(`${record(revision + 1, 'ack', revision)}\r\n`)).length).toBe(1)
    expect((await send(`${record(502, 'final')}\r\n`, true)).length).toBe(1)
    consumer.finish()
    const bytes = Buffer.concat(delivered)
    expect(consumer.bytes).toBe(bytes.length)
    expect(consumer.hash).toBe(byteHashText(updateByteHash(0x811c9dc5, bytes)))
    expect(consumer.count).toBe(503)
    expect(consumer.lastSequence).toBe(502)
    expect(consumer.acks).toBe(501)
  } finally {
    terminal.dispose()
  }
})

test('managed fixture reconstructs wrapped Unicode records after the actual xterm callback', async () => {
  const terminal = new Terminal({ cols: 17, rows: 4, scrollback: 100, allowProposedApi: true })
  const consumer = new ManagedTerminalConsumer(terminal)
  try {
    expect(await consumer.consume(new TextEncoder().encode(`${record(0, 'ready')}\r\n`))).toEqual([
      { sequence: 0, kind: 'ready', revision: 0 },
    ])
    expect(await consumer.consume(new TextEncoder().encode(`${record(1, 'ack')}\r\n`))).toEqual([
      { sequence: 1, kind: 'ack', revision: 0 },
    ])
    expect(consumer.count).toBe(2)
    expect(consumer.acks).toBe(1)
  } finally {
    terminal.dispose()
  }
})

test('managed terminal credit is held until the xterm processing callback', async () => {
  const terminal = new Terminal({ cols: 100, rows: 24, scrollback: 100, allowProposedApi: true })
  let release!: () => void
  const consumer = new ManagedTerminalConsumer({
    buffer: terminal.buffer,
    write(bytes, complete) {
      release = () => terminal.write(bytes, complete)
    },
  })
  try {
    let settled = false
    const consuming = consumer.consume(new TextEncoder().encode(`${record(0, 'ready')}\r\n`))
    void consuming.then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(consumer.bytes).toBe(0)
    release()
    expect((await consuming).length).toBe(1)
    expect(settled).toBe(true)
  } finally {
    terminal.dispose()
  }
})

test('coalesced terminal output is validated before records leave bounded xterm scrollback', async () => {
  const terminal = new Terminal({ cols: 100, rows: 24, scrollback: 100, allowProposedApi: true })
  const consumer = new ManagedTerminalConsumer(terminal)
  const rows = [record(0, 'ready')]
  for (let index = 1; index < 150; index++) rows.push(record(index, 'tick'))
  for (let revision = 0; revision <= 500; revision++)
    rows.push(record(rows.length, 'ack', revision))
  rows.push(record(rows.length, 'final'))
  // EOF is also a completion boundary: ConPTY need not preserve a final CRLF.
  const bytes = new TextEncoder().encode(rows.join('\r\n'))
  try {
    expect(bytes.length).toBeLessThan(32 * 1024)
    const added = await consumer.consume(bytes)
    expect(added.length).toBe(rows.length - 1)
    consumer.finish()
    expect(consumer.count).toBe(rows.length)
    expect(consumer.acks).toBe(501)
    expect(consumer.bytes).toBe(bytes.length)
    expect(consumer.hash).toBe(byteHashText(updateByteHash(0x811c9dc5, bytes)))
    expect(terminal.buffer.active.length).toBe(124)
  } finally {
    terminal.dispose()
  }
})

test('a coalesced chunk receives no credit until its final internal xterm write completes', async () => {
  const terminal = new Terminal({ cols: 100, rows: 24, scrollback: 100, allowProposedApi: true })
  const pending: Array<{ bytes: Uint8Array; release: () => Promise<void> }> = []
  const consumer = new ManagedTerminalConsumer({
    buffer: terminal.buffer,
    write(bytes, complete) {
      pending.push({
        bytes,
        release: () =>
          new Promise<void>((resolve) =>
            terminal.write(bytes, () => {
              complete()
              resolve()
            })
          ),
      })
    },
  })
  const bytes = new TextEncoder().encode(
    Array.from({ length: 150 }, (_, index) => record(index, index ? 'tick' : 'ready')).join(
      '\r\n'
    ) + '\r\n'
  )
  try {
    let settled = false
    const consuming = consumer.consume(bytes)
    void consuming.then(() => {
      settled = true
    })
    let processed = 0,
      writes = 0
    while (pending[0] && processed + pending[0].bytes.length < bytes.length) {
      const write = pending.shift()!
      processed += write.bytes.length
      writes++
      await write.release()
    }
    expect(writes).toBeGreaterThan(1)
    expect(pending).toHaveLength(1)
    expect(settled).toBe(false)
    expect(consumer.bytes).toBe(processed)
    await pending.shift()!.release()
    expect(await consuming).toHaveLength(150)
    expect(settled).toBe(true)
    expect(consumer.bytes).toBe(bytes.length)
    expect(consumer.hash).toBe(byteHashText(updateByteHash(0x811c9dc5, bytes)))
  } finally {
    terminal.dispose()
  }
})

test('a complete-looking active row cannot hide a later malformed suffix', async () => {
  const terminal = new Terminal({ cols: 100, rows: 24, scrollback: 100, allowProposedApi: true })
  const consumer = new ManagedTerminalConsumer(terminal)
  try {
    expect(await consumer.consume(new TextEncoder().encode(record(0, 'ready')))).toEqual([])
    expect(consumer.count).toBe(0)
    await expect(consumer.consume(new TextEncoder().encode('CORRUPTED\r\n'))).rejects.toThrow(
      'TERMINAL_RECORD_INVALID'
    )
  } finally {
    terminal.dispose()
  }
})

test('a malformed active row fails before wrapping can erase its beginning', async () => {
  const terminal = new Terminal({ cols: 100, rows: 24, scrollback: 100, allowProposedApi: true })
  const consumer = new ManagedTerminalConsumer(terminal)
  try {
    await expect(
      consumer.consume(new TextEncoder().encode(record(0, 'ready') + 'x'.repeat(18 * 1024)))
    ).rejects.toThrow('TERMINAL_TEXT_BOUND')
    expect(consumer.count).toBe(0)
    expect(consumer.bytes).toBeLessThan(1024)
  } finally {
    terminal.dispose()
  }
})

test('managed displayed records reject gaps, duplicates, changed repaints and wrong acknowledgement revisions', async () => {
  const cases = [
    [`${record(2, 'tick')}\r\n`, 'TERMINAL_RECORD_ORDER'],
    [`${record(0, 'ready')}\r\n`, 'TERMINAL_RECORD_DUPLICATE'],
    [`\x1b[1;1H\x1b[2K${record(0, 'tick')}\r\n`, 'TERMINAL_RECORD_CHANGED'],
    [`${record(1, 'ack', 1)}\r\n`, 'TERMINAL_ACK_ORDER'],
    [`${record(1, 'final')}\r\n`, 'TERMINAL_INCOMPLETE'],
  ] as const
  for (const [bytes, failure] of cases) {
    const terminal = new Terminal({ cols: 100, rows: 24, scrollback: 100, allowProposedApi: true })
    const consumer = new ManagedTerminalConsumer(terminal)
    try {
      await consumer.consume(new TextEncoder().encode(`${record(0, 'ready')}\r\n`))
      await expect(consumer.consume(new TextEncoder().encode(bytes))).rejects.toThrow(failure)
    } finally {
      terminal.dispose()
    }
  }
})

test('managed terminal completion requires the final record, every acknowledgement and complete UTF-8', async () => {
  const terminal = new Terminal({ cols: 100, rows: 24, scrollback: 100, allowProposedApi: true })
  const consumer = new ManagedTerminalConsumer(terminal)
  try {
    await consumer.consume(new TextEncoder().encode(`${record(0, 'ready')}\r\n`))
    for (let revision = 0; revision <= 500; revision++)
      await consumer.consume(
        new TextEncoder().encode(`${record(revision + 1, 'ack', revision)}\r\n`)
      )
    expect(() => consumer.finish()).toThrow('TERMINAL_INCOMPLETE')
    await consumer.consume(new TextEncoder().encode(`${record(502, 'final')}\r\n`))
    consumer.finish()
    await consumer.consume(new Uint8Array([0xf0, 0x9f]))
    expect(() => consumer.finish()).toThrow()
  } finally {
    terminal.dispose()
  }
})

test('managed terminal retention stays finite and rejects replay outside its validated screen history', async () => {
  const terminal = new Terminal({ cols: 100, rows: 24, scrollback: 100, allowProposedApi: true })
  const consumer = new ManagedTerminalConsumer(terminal)
  try {
    await consumer.consume(new TextEncoder().encode(`${record(0, 'ready')}\r\n`))
    for (let start = 1; start <= 1000; start += 20) {
      const text =
        Array.from({ length: 20 }, (_, offset) => record(start + offset, 'tick')).join('\r\n') +
        '\r\n'
      await consumer.consume(new TextEncoder().encode(text))
    }
    expect(consumer.count).toBe(1001)
    expect(terminal.buffer.active.length).toBe(124)
    await expect(
      consumer.consume(new TextEncoder().encode(`\x1b[3J\x1b[2J\x1b[H${record(0, 'ready')}\r\n`))
    ).rejects.toThrow('TERMINAL_RECORD_CHANGED')
  } finally {
    terminal.dispose()
  }
})
