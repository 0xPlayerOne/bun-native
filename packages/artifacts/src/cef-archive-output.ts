/** Hash compressed bytes under stream backpressure; metadata requires a completed writer. */
import { createHash } from 'node:crypto'
import { Readable, Transform, type Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createGzip } from 'node:zlib'
import { CEF_MAX_BYTES, cefError } from './cef-manifest.ts'

export async function writeCefArchive(
  source: AsyncIterable<Uint8Array>,
  destination: Writable,
  signal: AbortSignal,
  maxBytes = CEF_MAX_BYTES
): Promise<{ size: number; sha256: string }> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > CEF_MAX_BYTES)
    cefError('BAD_MANIFEST', 'Invalid compressed archive limit')
  let size = 0
  const hash = createHash('sha256')
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      if (chunk.length > maxBytes - size) {
        callback(new Error('Compressed runtime archive exceeds byte limit'))
        return
      }
      size += chunk.length
      hash.update(chunk)
      callback(null, chunk)
    },
  })
  await pipeline(
    Readable.from(source, { objectMode: false, highWaterMark: 65536 }),
    createGzip({ level: 6 }),
    meter,
    destination,
    { signal }
  )
  // This binds the manifest to bytes emitted by gzip and accepted by the writer.
  // It is not a read-back of storage, an fsync guarantee, or a publication step.
  return { size, sha256: hash.digest('hex') }
}
