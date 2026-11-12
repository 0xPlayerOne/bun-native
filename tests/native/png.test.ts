import { expect, test } from 'bun:test'
import { deflateSync } from 'node:zlib'
import { decodePng } from './png.ts'

const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
function crc32(bytes: Uint8Array) {
  let c = 0xffffffff
  for (const byte of bytes) c = CRC[(c ^ byte) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function chunk(type: string, body: Uint8Array) {
  const out = new Uint8Array(12 + body.length)
  const view = new DataView(out.buffer)
  view.setUint32(0, body.length)
  out.set(new TextEncoder().encode(type), 4)
  out.set(body, 8)
  view.setUint32(8 + body.length, crc32(out.subarray(4, 8 + body.length)))
  return out
}

/** Encode samples with the given filter on every row, as a PNG encoder may. */
function encode(
  width: number,
  height: number,
  colour: 0 | 2 | 4 | 6,
  depth: 8 | 16,
  samples: number[],
  filter: number
) {
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colour]
  const bytesPer = depth / 8
  const step = channels * bytesPer
  const stride = width * step
  const plain = new Uint8Array(height * stride)
  samples.forEach((value, index) => {
    if (depth === 16) {
      plain[index * 2] = value
      plain[index * 2 + 1] = 0x7f
    } else plain[index] = value
  })
  const filtered = new Uint8Array(height * (stride + 1))
  for (let row = 0; row < height; row++) {
    filtered[row * (stride + 1)] = filter
    for (let i = 0; i < stride; i++) {
      const at = row * stride + i
      const left = i >= step ? plain[at - step]! : 0
      const up = row ? plain[at - stride]! : 0
      const upLeft = row && i >= step ? plain[at - stride - step]! : 0
      const estimate = left + up - upLeft
      const [a, b, c] = [left, up, upLeft].map((v) => Math.abs(estimate - v))
      const paeth = a! <= b! && a! <= c! ? left : b! <= c! ? up : upLeft
      const predictor = [0, left, up, (left + up) >> 1, paeth][filter]!
      filtered[row * (stride + 1) + 1 + i] = (plain[at]! - predictor) & 0xff
    }
  }
  const header = new Uint8Array(13)
  new DataView(header.buffer).setUint32(0, width)
  new DataView(header.buffer).setUint32(4, height)
  header.set([depth, colour, 0, 0, 0], 8)
  const compressed = deflateSync(filtered)
  return Uint8Array.from([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    ...chunk('IHDR', header),
    ...chunk('tEXt', new TextEncoder().encode('Software\0test')),
    // Image data may be split across several IDAT chunks.
    ...chunk('IDAT', compressed.subarray(0, 5)),
    ...chunk('IDAT', compressed.subarray(5)),
    ...chunk('IEND', new Uint8Array()),
  ])
}

const WIDTH = 5
const HEIGHT = 4
const colourAt = (x: number, y: number) => [
  (x * 53 + y * 7) & 0xff,
  (y * 61) & 0xff,
  (x * y * 17 + 3) & 0xff,
]

test('every row filter decodes 8-bit RGB and RGBA pixels exactly', () => {
  for (const [colour, channels] of [
    [2, 3],
    [6, 4],
  ] as const)
    for (let filter = 0; filter <= 4; filter++) {
      const samples: number[] = []
      for (let y = 0; y < HEIGHT; y++)
        for (let x = 0; x < WIDTH; x++) {
          samples.push(...colourAt(x, y))
          if (channels === 4) samples.push(0xff)
        }
      const png = decodePng(encode(WIDTH, HEIGHT, colour, 8, samples, filter))
      expect([png.width, png.height]).toEqual([WIDTH, HEIGHT])
      for (let y = 0; y < HEIGHT; y++)
        for (let x = 0; x < WIDTH; x++) {
          const [r, g, b] = colourAt(x, y)
          expect(png.rgb(x, y)).toBe((r! << 16) | (g! << 8) | b!)
        }
    }
})

test('16-bit and grayscale captures read their high byte', () => {
  const rgb = decodePng(encode(1, 1, 2, 16, [0x12, 0x34, 0x56], 1))
  expect(rgb.rgb(0, 0)).toBe(0x123456)
  const gray = decodePng(encode(2, 1, 4, 8, [0x40, 0xff, 0x80, 0xff], 4))
  expect(gray.rgb(1, 0)).toBe(0x808080)
})

test('malformed or out-of-range input is rejected, never guessed', () => {
  expect(() => decodePng(new Uint8Array([1, 2, 3]))).toThrow('Not a PNG file')
  const png = encode(2, 2, 2, 8, Array(12).fill(0), 0)
  expect(() => decodePng(png.subarray(0, png.length - 20))).toThrow()
  const decoded = decodePng(png)
  expect(() => decoded.rgb(2, 0)).toThrow('outside')
  expect(() => decoded.rgb(0.5, 0)).toThrow('outside')
  const interlaced = Uint8Array.from(png)
  // IHDR's interlace byte follows the signature, length, type and 12 bytes.
  interlaced[8 + 8 + 12] = 1
  expect(() => decodePng(interlaced)).toThrow('interlace')
})
