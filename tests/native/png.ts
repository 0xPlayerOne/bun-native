/**
 * A bounded PNG reader for window captures (`screencapture` on macOS):
 * grayscale, RGB, palette, gray+alpha or RGBA at any standard bit depth, not
 * interlaced. Pixels are
 * returned exactly as stored, without colour management, as the X11 lane reads
 * them through ImageMagick `txt:`.
 */
import { inflateSync } from 'node:zlib'

export interface DecodedPng {
  width: number
  height: number
  /** The stored colour at (x, y) as 0xRRGGBB; alpha is ignored. */
  rgb(x: number, y: number): number
}

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }
/** The bit depths the PNG specification allows for each colour type. */
const DEPTHS: Record<number, number[]> = {
  0: [1, 2, 4, 8, 16],
  2: [8, 16],
  3: [1, 2, 4, 8],
  4: [8, 16],
  6: [8, 16],
}
const MAX_PIXELS = 16384 * 16384

function paeth(left: number, up: number, upLeft: number) {
  const estimate = left + up - upLeft
  const toLeft = Math.abs(estimate - left)
  const toUp = Math.abs(estimate - up)
  const toUpLeft = Math.abs(estimate - upLeft)
  if (toLeft <= toUp && toLeft <= toUpLeft) return left
  return toUp <= toUpLeft ? up : upLeft
}

export function decodePng(bytes: Uint8Array): DecodedPng {
  if (bytes.length < 8 || SIGNATURE.some((value, index) => bytes[index] !== value))
    throw new Error('Not a PNG file')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let offset = 8
  let header: { width: number; height: number; depth: number; type: number } | undefined
  const data: Uint8Array[] = []
  let palette: Uint8Array | undefined
  for (;;) {
    if (offset + 12 > bytes.length) throw new Error('Truncated PNG chunk')
    const length = view.getUint32(offset)
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8))
    const body = bytes.subarray(offset + 8, offset + 8 + length)
    if (body.length !== length) throw new Error('Truncated PNG chunk body')
    offset += 12 + length
    if (type === 'IHDR') {
      const width = view.getUint32(body.byteOffset - bytes.byteOffset)
      const height = view.getUint32(body.byteOffset - bytes.byteOffset + 4)
      const [depth, colour, compression, filter, interlace] = body.subarray(8, 13)
      if (!width || !height || width * height > MAX_PIXELS) throw new Error('Unbounded PNG size')
      if (!DEPTHS[colour!]?.includes(depth!))
        throw new Error(`Unsupported PNG format: depth ${depth}, colour type ${colour}`)
      if (compression !== 0 || filter !== 0 || interlace !== 0)
        throw new Error('Unsupported PNG compression, filter or interlace method')
      header = { width, height, depth: depth!, type: colour! }
    } else if (type === 'PLTE') palette = body
    else if (type === 'IDAT') data.push(body)
    else if (type === 'IEND') break
  }
  if (!header || !data.length) throw new Error('PNG has no header or image data')
  const { width, height, depth, type } = header
  const channels = CHANNELS[type]!
  if (type === 3 && (!palette || palette.length % 3 !== 0)) throw new Error('PNG palette missing')
  const bits = channels * depth
  // Filters predict from the corresponding byte of the previous pixel, or the
  // previous byte when pixels are smaller than a byte.
  const step = Math.max(1, bits / 8)
  const stride = Math.ceil((width * bits) / 8)
  const raw = inflateSync(Buffer.concat(data))
  if (raw.length !== height * (stride + 1)) throw new Error('PNG image data has the wrong size')
  const pixels = new Uint8Array(height * stride)
  for (let row = 0; row < height; row++) {
    const filter = raw[row * (stride + 1)]!
    const source = raw.subarray(row * (stride + 1) + 1, (row + 1) * (stride + 1))
    const target = row * stride
    for (let index = 0; index < stride; index++) {
      const left = index >= step ? pixels[target + index - step]! : 0
      const up = row ? pixels[target - stride + index]! : 0
      const upLeft = row && index >= step ? pixels[target - stride + index - step]! : 0
      const value = source[index]!
      pixels[target + index] =
        filter === 0
          ? value
          : filter === 1
            ? value + left
            : filter === 2
              ? value + up
              : filter === 3
                ? value + ((left + up) >> 1)
                : filter === 4
                  ? value + paeth(left, up, upLeft)
                  : -1
      if (filter > 4) throw new Error('Unknown PNG row filter ' + filter)
    }
  }
  /** Sample `index` scaled to 8 bits (16-bit samples keep their high byte). */
  const sample = (index: number, row: number) => {
    if (depth >= 8) return pixels[row * stride + index * (depth / 8)]!
    const bit = index * depth
    const value =
      (pixels[row * stride + (bit >> 3)]! >> (8 - depth - (bit & 7))) & ((1 << depth) - 1)
    return type === 3 ? value : Math.round((value * 255) / ((1 << depth) - 1))
  }
  return {
    width,
    height,
    rgb(x, y) {
      if (
        !Number.isInteger(x) ||
        !Number.isInteger(y) ||
        x < 0 ||
        y < 0 ||
        x >= width ||
        y >= height
      )
        throw new Error(`PNG pixel ${x},${y} is outside ${width}x${height}`)
      const at = x * channels
      if (type === 3) {
        const entry = sample(at, y) * 3
        if (entry + 2 >= palette!.length) throw new Error('PNG palette index out of range')
        return (palette![entry]! << 16) | (palette![entry + 1]! << 8) | palette![entry + 2]!
      }
      if (channels < 3) return sample(at, y) * 0x010101
      return (sample(at, y) << 16) | (sample(at + 1, y) << 8) | sample(at + 2, y)
    },
  }
}
