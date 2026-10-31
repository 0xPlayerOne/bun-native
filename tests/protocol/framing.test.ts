import { describe, expect, test } from 'bun:test'
import { encodeFrame, FrameDecoder, MAX_FRAME_BYTES, ProtocolError } from '@bun-native/protocol'

describe('bounded native pipe framing', () => {
  test('decodes split UTF-8 and multiple frames without losing order', () => {
    const first = encodeFrame({ text: 'Hola, 世界 👋' })
    const second = encodeFrame({ event: 'closed' })
    const input = new Uint8Array(first.length + second.length)
    input.set(first)
    input.set(second, first.length)
    const decoder = new FrameDecoder()
    const frames: unknown[] = []
    for (const byte of input) frames.push(...decoder.push(Uint8Array.of(byte)))
    expect(frames).toEqual([{ text: 'Hola, 世界 👋' }, { event: 'closed' }])
    expect(() => decoder.finish()).not.toThrow()
  })

  test('accepts the exact byte limit and rejects one byte more', () => {
    const valid = 'a'.repeat(MAX_FRAME_BYTES - 2)
    const encoded = encodeFrame(valid)
    expect(encoded.byteLength).toBe(MAX_FRAME_BYTES + 1)
    expect(new FrameDecoder().push(encoded)).toEqual([valid])
    expect(() => encodeFrame(`${valid}a`)).toThrow(ProtocolError)
    expect(() => new FrameDecoder().push(new Uint8Array(MAX_FRAME_BYTES + 1).fill(97))).toThrow(
      'Frame exceeds byte limit'
    )
  })

  test('checks the combined size across chunks', () => {
    const decoder = new FrameDecoder()
    decoder.push(new Uint8Array(MAX_FRAME_BYTES).fill(97))
    expect(() => decoder.push(Uint8Array.of(97))).toThrow('Frame exceeds byte limit')
    expect(() => decoder.push(encodeFrame({ ok: true }))).toThrow('Decoder is closed')
  })

  test.each([
    ['empty', Uint8Array.of(10)],
    ['invalid UTF-8', Uint8Array.of(34, 255, 34, 10)],
    ['invalid JSON', new TextEncoder().encode('{broken}\n')],
  ])('rejects %s frames', (_name, input) => {
    expect(() => new FrameDecoder().push(input)).toThrow(ProtocolError)
  })

  test('rejects EOF inside a frame', () => {
    const decoder = new FrameDecoder()
    decoder.push(new TextEncoder().encode('{"ok":true}'))
    expect(() => decoder.finish()).toThrow('Native stream ended inside a frame')
    expect(() => decoder.finish()).toThrow('Decoder is closed after a protocol error')
    expect(() => decoder.push(encodeFrame({ ok: true }))).toThrow('Decoder is closed')
  })

  test.each([undefined, Symbol('value'), () => 1])(
    'rejects values JSON cannot encode: %s',
    (value) => {
      expect(() => encodeFrame(value)).toThrow('Frame is not a JSON value')
    }
  )

  test('normalizes JSON serialization errors and preserves their cause', () => {
    const circular: { self?: unknown } = {}
    circular.self = circular
    for (const value of [1n, circular]) {
      let caught: unknown
      try {
        encodeFrame(value)
      } catch (error) {
        caught = error
      }
      expect(caught).toBeInstanceOf(ProtocolError)
      expect(caught instanceof ProtocolError && caught.cause).toBeInstanceOf(TypeError)
    }
    const failure = new Error('application serializer failed')
    try {
      encodeFrame({
        toJSON() {
          throw failure
        },
      })
      throw new Error('Expected serialization to fail')
    } catch (error) {
      expect(error).toBeInstanceOf(ProtocolError)
      expect(error instanceof ProtocolError && error.cause).toBe(failure)
    }
  })

  test('rejects a leading UTF-8 BOM even when split across chunks', () => {
    const decoder = new FrameDecoder()
    expect(decoder.push(Uint8Array.of(239))).toEqual([])
    expect(decoder.push(Uint8Array.of(187, 191))).toEqual([])
    expect(() => decoder.push(encodeFrame({ ok: true }))).toThrow('Invalid UTF-8 or JSON')
    expect(() => decoder.push(encodeFrame({ ok: true }))).toThrow('Decoder is closed')
    expect(new FrameDecoder().push(encodeFrame({ text: '\uFEFF' }))).toEqual([{ text: '\uFEFF' }])
  })

  test('successful EOF is terminal and repeated finish is harmless', () => {
    const decoder = new FrameDecoder()
    expect(decoder.push(encodeFrame({ ok: true }))).toEqual([{ ok: true }])
    decoder.finish()
    expect(() => decoder.finish()).not.toThrow()
    expect(() => decoder.push(encodeFrame({ ok: true }))).toThrow(
      'Decoder is closed after end of stream'
    )
    expect(() => decoder.push(new Uint8Array())).toThrow('Decoder is closed after end of stream')
  })

  test('empty stream can finish but cannot be reused', () => {
    const decoder = new FrameDecoder()
    decoder.finish()
    expect(() => decoder.push(encodeFrame(null))).toThrow('Decoder is closed after end of stream')
  })
})
