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
  })

  test('does not accept values JSON cannot encode', () => {
    expect(() => encodeFrame(undefined)).toThrow('Frame is not a JSON value')
  })
})
