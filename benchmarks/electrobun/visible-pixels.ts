/** A decoded capture; pixels are packed 0xRRGGBB, as in tests/native/png.ts. */
export interface CapturePixels {
  readonly width: number
  readonly height: number
  rgb(x: number, y: number): number
}

/**
 * Count changed pixels inside one pre-calibrated top-left pixel rectangle.
 * This is a detection signal only: the caller must separately verify the
 * owned window, the final text, and a stable negative control.
 */
export function compareVisiblePixels(
  before: CapturePixels,
  after: CapturePixels,
  region: readonly [number, number, number, number],
  channelThreshold = 16
) {
  const [x, y, width, height] = region
  if (
    ![before.width, before.height, after.width, after.height, x, y, width, height].every(
      Number.isSafeInteger
    ) ||
    before.width < 1 ||
    before.height < 1 ||
    before.width !== after.width ||
    before.height !== after.height ||
    x < 0 ||
    y < 0 ||
    width < 1 ||
    height < 1 ||
    x + width > before.width ||
    y + height > before.height ||
    width * height > 2_000_000 ||
    !Number.isSafeInteger(channelThreshold) ||
    channelThreshold < 0 ||
    channelThreshold > 255
  )
    throw new Error('Invalid capture comparison geometry or threshold')
  let changedPixels = 0
  let maxChannelChange = 0
  for (let row = y; row < y + height; row++) {
    for (let column = x; column < x + width; column++) {
      const a = before.rgb(column, row)
      const b = after.rgb(column, row)
      if (
        !Number.isSafeInteger(a) ||
        !Number.isSafeInteger(b) ||
        a < 0 ||
        b < 0 ||
        a > 0xffffff ||
        b > 0xffffff
      )
        throw new Error('Invalid decoded pixel')
      const difference = Math.max(
        Math.abs(((a >> 16) & 255) - ((b >> 16) & 255)),
        Math.abs(((a >> 8) & 255) - ((b >> 8) & 255)),
        Math.abs((a & 255) - (b & 255))
      )
      if (difference > channelThreshold) changedPixels++
      maxChannelChange = Math.max(maxChannelChange, difference)
    }
  }
  return { changedPixels, totalPixels: width * height, maxChannelChange }
}
