import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { Writable } from 'node:stream'
import { gunzipSync } from 'node:zlib'
import { writeCefArchive } from '../packages/artifacts/src/cef-archive-output.ts'

async function* source() {
  yield Buffer.from('header:')
  for (let i = 0; i < 17; i++) yield Buffer.alloc(65536, i)
  yield Buffer.from(':footer')
}
function deferred<T = void>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

test('archive metadata describes the exact compressed bytes and complete payload', async () => {
  const chunks: Buffer[] = []
  const destination = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(Buffer.from(chunk))
      callback()
    },
  })
  const result = await writeCefArchive(source(), destination, AbortSignal.timeout(5000))
  const compressed = Buffer.concat(chunks)
  expect(result.size).toBe(compressed.length)
  expect(result.sha256).toBe(createHash('sha256').update(compressed).digest('hex'))
  const expected: Uint8Array[] = []
  for await (const chunk of source()) expected.push(chunk)
  expect(gunzipSync(compressed)).toEqual(Buffer.concat(expected))
  expect(destination.writableFinished).toBe(true)
})

test('receiving all bytes cannot publish metadata before the writer completes', async () => {
  const entered = deferred(),
    release = deferred()
  let settled = false
  const destination = new Writable({
    write(_chunk, _encoding, callback) {
      callback()
    },
    final(callback) {
      entered.resolve()
      void release.promise.then(() => callback())
    },
  })
  const task = writeCefArchive(source(), destination, AbortSignal.timeout(5000)).then((value) => {
    settled = true
    return value
  })
  try {
    await entered.promise
    expect(settled).toBe(false)
  } finally {
    release.resolve()
  }
  expect((await task).size).toBeGreaterThan(0)
})

test('a late writer failure cannot produce successful archive metadata', async () => {
  let received = 0
  const destination = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      received += chunk.length
      callback()
    },
    final(callback) {
      callback(new Error('fixture-write-completion-failure'))
    },
  })
  await expect(writeCefArchive(source(), destination, AbortSignal.timeout(5000))).rejects.toThrow(
    'fixture-write-completion-failure'
  )
  expect(received).toBeGreaterThan(0)
  expect(destination.destroyed).toBe(true)
})

test('source verification failure discards a partial archive result', async () => {
  async function* changedSource() {
    yield Buffer.alloc(65536, 1)
    throw new Error('fixture-source-changed')
  }
  const destination = new Writable({
    write(_chunk, _encoding, callback) {
      callback()
    },
  })
  await expect(
    writeCefArchive(changedSource(), destination, AbortSignal.timeout(5000))
  ).rejects.toThrow('fixture-source-changed')
  expect(destination.destroyed).toBe(true)
})

test('cancellation destroys a blocked output instead of returning a digest', async () => {
  const entered = deferred(),
    controller = new AbortController()
  let unblock: (() => void) | undefined
  const destination = new Writable({
    write(_chunk, _encoding, callback) {
      unblock = callback
      entered.resolve()
    },
  })
  const task = writeCefArchive(source(), destination, controller.signal)
  const rejected = task.catch((error: unknown) => error)
  try {
    await entered.promise
    controller.abort()
    // In-flight writes acknowledge settlement before pipeline teardown completes.
    unblock?.()
    expect(await rejected).toBeInstanceOf(Error)
    expect(destination.destroyed).toBe(true)
  } finally {
    unblock?.()
  }
})

test('compressed output bounds apply before oversized data reaches the destination', async () => {
  let received = 0
  const destination = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      received += chunk.length
      callback()
    },
  })
  await expect(
    writeCefArchive(source(), destination, AbortSignal.timeout(5000), 1)
  ).rejects.toThrow('byte limit')
  expect(received).toBe(0)
  expect(destination.destroyed).toBe(true)
})
