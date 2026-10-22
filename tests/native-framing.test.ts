import { test, expect } from 'bun:test'
import { PassThrough, Readable } from 'node:stream'
import { NativeTransport } from '../packages/runtime/src/native-transport.ts'
import type { NativeEvent } from '../packages/runtime/src/native-transport.ts'
const ready = Buffer.from('{"v":1,"event":"ready","abi":1}\n')
const shutdown = Buffer.from('{"v":1,"event":"shutdown"}\n')
function frame(title: string) {
  return Buffer.from(
    JSON.stringify({ v: 1, event: 'view.title', target: 1, data: { title } }) + '\n'
  )
}
function split(bytes: Buffer, size: number) {
  const chunks: Buffer[] = []
  for (let offset = 0; offset < bytes.length; offset += size)
    chunks.push(bytes.subarray(offset, offset + size))
  return chunks
}
async function observe(chunks: Buffer[]) {
  const input = Readable.from(chunks),
    output = new PassThrough()
  const transport = new NativeTransport(input, output)
  const events: NativeEvent[] = []
  transport.onEvent((event) => events.push(event))
  await transport.closed
  expect(input.destroyed).toBe(true)
  expect(output.destroyed).toBe(true)
  return { failure: transport.failure, events }
}

for (const size of [1, 2, 7, 64, 16383, 16384, 65536]) {
  test(`maximum native UTF-8 frame survives actual ${size}-byte stream chunks`, async () => {
    let title = 'λ'.repeat(32700)
    title += 'x'.repeat(65536 - frame(title).length)
    const expected = frame(title)
    expect(expected.length).toBe(65536) // 65535 frame bytes plus LF.
    const result = await observe(split(Buffer.concat([ready, expected, shutdown]), size))
    expect(result.failure).toBeNull()
    expect(result.events.map((event) => event.event)).toEqual(['ready', 'view.title', 'shutdown'])
    expect(result.events[1]!.data?.['title']).toBe(title)
  })
}

test('batched frames and split trailing headers preserve order across decode windows', async () => {
  const titles = Array.from({ length: 400 }, (_, i) => `${i}:` + '🦋'.repeat(37))
  const bytes = Buffer.concat([ready, ...titles.map(frame), shutdown])
  for (const size of [127, 16384, bytes.length]) {
    const result = await observe(split(bytes, size))
    expect(result.failure).toBeNull()
    expect(
      result.events
        .filter((event) => event.event === 'view.title')
        .map((event) => event.data?.['title'])
    ).toEqual(titles)
  }
})

test('oversized and unterminated native frames are rejected before further dispatch', async () => {
  for (const suffix of [
    Buffer.from('x'.repeat(65536)),
    Buffer.from('x'.repeat(65536) + '\n'),
    Buffer.alloc(1024 * 1024, 120),
  ]) {
    const result = await observe([ready, suffix, shutdown])
    expect(result.failure?.message).toMatch(/exceeds limit/)
    expect(result.events.map((event) => event.event)).toEqual(['ready'])
  }
})

test('native framing rejects invalid UTF-8 at LF, partial EOF, and BOM after the first frame', async () => {
  for (const tail of [
    Buffer.from([0xc3, 10]),
    Buffer.from([0xf0, 0x9f]),
    Buffer.from('{"v":1'),
    Buffer.from('\ufeff' + shutdown.toString()),
    Buffer.from('\n'),
  ]) {
    const result = await observe([ready, tail])
    expect(result.failure).toBeInstanceOf(Error)
  }
  const result = await observe([Buffer.from('\ufeff'), ready, frame('λ'), shutdown])
  expect(result.failure).toBeNull()
})

test('native event batches yield to the event loop rather than starving scheduled work', async () => {
  let yielded = false
  const callback = new Promise<void>((resolve) =>
    setImmediate(() => {
      yielded = true
      resolve()
    })
  )
  const result = await observe([
    Buffer.concat([ready, ...Array.from({ length: 2048 }, () => frame('event')), shutdown]),
  ])
  expect(result.failure).toBeNull()
  expect(yielded).toBe(true)
  await callback
})
