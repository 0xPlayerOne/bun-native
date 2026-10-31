/** Maximum UTF-8 JSON payload bytes, excluding the newline delimiter. */
export const MAX_FRAME_BYTES = 65_536

export class ProtocolError extends Error {
  override readonly name = 'ProtocolError'
}

/** Encodes one JSON value. This does not validate a command or event schema. */
export function encodeFrame(value: unknown): Uint8Array {
  const json = JSON.stringify(value)
  if (json === undefined) throw new ProtocolError('Frame is not a JSON value')
  const encoded = new TextEncoder().encode(`${json}\n`)
  if (encoded.byteLength - 1 > MAX_FRAME_BYTES) throw new ProtocolError('Frame exceeds byte limit')
  return encoded
}

/**
 * Incremental, bounded JSON-lines decoder for a native process pipe.
 * A protocol error poisons the decoder; the caller must terminate that session.
 */
export class FrameDecoder {
  private readonly buffer = new Uint8Array(MAX_FRAME_BYTES)
  private readonly utf8 = new TextDecoder('utf-8', { fatal: true })
  private length = 0
  private failed = false

  push(chunk: Uint8Array): unknown[] {
    if (this.failed) throw new ProtocolError('Decoder is closed after a protocol error')
    const frames: unknown[] = []
    let start = 0
    try {
      while (start < chunk.length) {
        const newline = chunk.indexOf(10, start)
        const end = newline === -1 ? chunk.length : newline
        const size = end - start
        if (this.length + size > MAX_FRAME_BYTES)
          throw new ProtocolError('Frame exceeds byte limit')
        this.buffer.set(chunk.subarray(start, end), this.length)
        this.length += size
        if (newline === -1) break
        if (this.length === 0) throw new ProtocolError('Empty frame')
        const json = this.utf8.decode(this.buffer.subarray(0, this.length))
        frames.push(JSON.parse(json) as unknown)
        this.length = 0
        start = newline + 1
      }
    } catch (error) {
      this.failed = true
      if (error instanceof ProtocolError) throw error
      throw new ProtocolError('Invalid UTF-8 or JSON in native frame', { cause: error })
    }
    return frames
  }

  finish(): void {
    if (this.failed) throw new ProtocolError('Decoder is closed after a protocol error')
    if (this.length !== 0) {
      this.failed = true
      throw new ProtocolError('Native stream ended inside a frame')
    }
  }
}
