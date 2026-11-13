/**
 * Maximum command frame (runtime to host) in UTF-8 JSON bytes, excluding the
 * newline. One transaction is one batch, so this bounds a full-window mount.
 */
export const MAX_FRAME_BYTES = 16_777_216
/** Maximum event frame (host to runtime): one text value or service result. */
export const MAX_EVENT_FRAME_BYTES = 65_536
/** Decoder capacity kept between frames; a larger frame borrows memory while it is read. */
const RETAINED_FRAME_BYTES = 65_536

export class ProtocolError extends Error {
  override readonly name = 'ProtocolError'
}

const encoder = new TextEncoder()

/** Encodes one JSON value. This does not validate a command or event schema. */
export function encodeFrame(value: unknown): Uint8Array {
  let json: string | undefined
  try {
    json = JSON.stringify(value)
  } catch (error) {
    throw new ProtocolError('Frame is not a JSON value', { cause: error })
  }
  if (json === undefined) throw new ProtocolError('Frame is not a JSON value')
  // Each UTF-16 code unit encodes to at least one UTF-8 byte.
  if (json.length > MAX_FRAME_BYTES) throw new ProtocolError('Frame exceeds byte limit')
  const encoded = encoder.encode(`${json}\n`)
  if (encoded.byteLength - 1 > MAX_FRAME_BYTES) throw new ProtocolError('Frame exceeds byte limit')
  return encoded
}

/**
 * Incremental, bounded JSON-lines decoder for a native process pipe. `limit`
 * is the largest frame payload it accepts: the runtime reads events with
 * `MAX_EVENT_FRAME_BYTES`; a peer reading commands keeps the default.
 * A protocol error poisons the decoder; the caller must terminate that session.
 * Successful finish closes the decoder and is idempotent.
 */
export class FrameDecoder {
  private buffer = new Uint8Array(0)
  // Preserve a leading BOM so JSON.parse rejects it, matching Rust serde_json.
  private readonly utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
  private length = 0
  private state: 'open' | 'finished' | 'failed' = 'open'

  constructor(private readonly limit: number = MAX_FRAME_BYTES) {}

  /** Append a partial frame, growing the buffer geometrically up to the limit. */
  private append(bytes: Uint8Array): void {
    const length = this.length + bytes.length
    if (length > this.buffer.length) {
      const grown = new Uint8Array(
        Math.min(this.limit, Math.max(length, 2 * this.buffer.length, 4_096))
      )
      grown.set(this.buffer.subarray(0, this.length))
      this.buffer = grown
    }
    this.buffer.set(bytes, this.length)
    this.length = length
  }

  push(chunk: Uint8Array): unknown[] {
    if (this.state !== 'open')
      throw new ProtocolError(
        this.state === 'failed'
          ? 'Decoder is closed after a protocol error'
          : 'Decoder is closed after end of stream'
      )
    const frames: unknown[] = []
    let start = 0
    try {
      while (start < chunk.length) {
        const newline = chunk.indexOf(10, start)
        const end = newline === -1 ? chunk.length : newline
        const size = end - start
        if (this.length + size > this.limit) throw new ProtocolError('Frame exceeds byte limit')
        if (newline !== -1 && this.length === 0) {
          // A frame wholly inside this chunk decodes in place, without a copy.
          if (size === 0) throw new ProtocolError('Empty frame')
          frames.push(JSON.parse(this.utf8.decode(chunk.subarray(start, end))) as unknown)
          start = newline + 1
          continue
        }
        this.append(chunk.subarray(start, end))
        if (newline === -1) break
        const json = this.utf8.decode(this.buffer.subarray(0, this.length))
        this.length = 0
        if (this.buffer.length > RETAINED_FRAME_BYTES) this.buffer = new Uint8Array(0)
        frames.push(JSON.parse(json) as unknown)
        start = newline + 1
      }
    } catch (error) {
      this.state = 'failed'
      if (error instanceof ProtocolError) throw error
      throw new ProtocolError('Invalid UTF-8 or JSON in native frame', { cause: error })
    }
    return frames
  }

  finish(): void {
    if (this.state === 'failed') throw new ProtocolError('Decoder is closed after a protocol error')
    if (this.length !== 0) {
      this.state = 'failed'
      throw new ProtocolError('Native stream ended inside a frame')
    }
    this.state = 'finished'
  }
}
